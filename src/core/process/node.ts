import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { PosixLoomError } from "../errors.js";
import type { CommandOutcome } from "../types.js";
import type { ProcessRunOptions, ProcessRunResult } from "./contracts.js";
import { OutputCollector, ProcessOutputForwarder, DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS, DEFAULT_MAX_REPORT_BYTES } from "./output.js";
import { readAndRemoveReport } from "./report.js";
import { makeResult } from "./result.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { pipeReadable } from "./output.js";
import { reportTooLarge } from "./report.js";

/**
 * Node 回退执行路径：直接用 node:child_process 启动目标程序。
 *
 * 触发条件：宿主缺失，或命令需要 reportFd（fd=3 报告管道）--报告通道由
 * Node 自建管道并收集，结束后由 service 层消费（reportPath 文件优先）。
 *
 * 与原生路径的关键差异：Windows 上 Node 的 child.kill() 只能终止直接子进程，
 * 杀不掉孙进程，因此取消/超时改用 `taskkill /PID <pid> /T /F` 终止整棵进程树
 * （/T 递归、/F 强制），taskkill 不可用时退回 child.kill()；非 Windows 平台则
 * 走 SIGTERM -> 宽限期 -> SIGKILL 的两级终止。
 *
 * 结果映射：spawn 失败 -> spawn-failed；超时 -> timed-out；取消 -> cancelled；
 * 正常退出 -> exited（拿不到退出码时按 1 处理）。
 */
export async function runViaNode(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const started = performance.now();
  const timings: Record<string, number> = {};
  return new Promise<ProcessRunResult>((resolve) => {
    // 前三个 fd 为 stdin/stdout/stderr；reportFd 时把 fd=3 开成报告管道，否则忽略。
    const stdio: any[] = ["pipe", "pipe", "pipe", options.reportFd ? "pipe" : "ignore"];
    // 直接 spawn 目标程序（不走 shell，参数不做二次解释），隐藏控制台窗口。
    const child = spawn(options.program, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio,
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    child.once("spawn", () => { timings.spawnMs = performance.now() - started; });
    child.once("exit", () => { timings.exitMs = performance.now() - started; });
    const stdout = new OutputCollector(options.maxOutputBytes);
    const stderr = new OutputCollector(options.maxOutputBytes);
    const maximumReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
    // 报告通道按独立上限收集，避免 fd=3 被恶意子进程用于无界占用内存。
    const reportChunks: Buffer[] = [];
    let reportBytes = 0;
    let reportFailure: unknown;
    const grace = options.cancelGraceMs ?? 2000;
    // finished 保证 Promise 只 resolve 一次；forced 记录是被取消还是超时强制
    // 终止，供 close 事件决定最终 outcome；graceTimer 为宽限期强杀定时器。
    let finished = false;
    let forced: "cancelled" | "timed-out" | undefined;
    let inputFailure: unknown;
    let graceTimer: NodeJS.Timeout | undefined;
    const outputForwarder = new ProcessOutputForwarder(
      options.onOutput,
      () => {
        child.stdout.pause();
        child.stderr.pause();
      },
      () => {
        if (!child.stdout.destroyed) child.stdout.resume();
        if (!child.stderr.destroyed) child.stderr.resume();
      },
      () => child.kill(),
    );
    // 统一收口：清两个定时器、解绑 abort 监听、组装结果（报告文件优先，
    // 不存在则回退 fd 管道收集到的内容），幂等。
    const finish = (outcome: CommandOutcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", abort);
      void outputForwarder.drain(options.outputDrainTimeoutMs ?? DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS).then(() => {
        const report = readAndRemoveReport(options.reportPath, Buffer.concat(reportChunks), maximumReportBytes, reportFailure);
        const processOutcome = inputFailure && outcome.kind === "exited"
          ? { kind: "crashed" as const, errorCode: "INPUT_WRITE_FAILED" }
          : outcome;
        const finalOutcome = outputForwarder.failed
          ? { kind: "crashed" as const, errorCode: "OUTPUT_SINK_FAILED" }
          : report.error
            ? { kind: "crashed" as const, errorCode: "REPORT_IO_FAILED" }
            : processOutcome;
        resolve({ ...makeResult(finalOutcome, stdout, stderr, report.data, "node-fallback"), timings: { ...timings, processTotalMs: performance.now() - started } });
      });
    };
    // 两级终止：先温和终止（Windows: taskkill 杀整棵进程树；其他平台:
    // SIGTERM），宽限期后仍未退出则 SIGKILL 强杀并按触发原因收场。
    const terminate = (reason: "cancelled" | "timed-out"): void => {
      if (finished || forced) return;
      forced = reason;
      // Windows：/T 递归终止整棵进程树、/F 强制（child.kill 杀不掉孙进程）；
      // taskkill 自身启动失败时退回 child.kill()，至少杀掉直接子进程。
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill());
      } else child.kill("SIGTERM");
      // 宽限期兜底：SIGKILL 无法被进程捕获/忽略，之后直接按取消/超时收场。
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ kind: reason });
      }, grace);
    };
    // 超时定时器。
    const timer = setTimeout(() => terminate("timed-out"), options.timeoutMs);
    // 外部取消信号。
    const abort = (): void => terminate("cancelled");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    // 三个输出通道分流：stdout/stderr 进截断收集器，报告 fd 原样收集。
    pipeReadable(child.stdout, {
      push: (chunk: Buffer) => {
        if (chunk.length) timings.firstByteMs ??= performance.now() - started;
        stdout.push(chunk);
        outputForwarder.push("stdout", chunk);
      },
    });
    pipeReadable(child.stderr, {
      push: (chunk: Buffer) => {
        if (chunk.length) timings.firstByteMs ??= performance.now() - started;
        stderr.push(chunk);
        outputForwarder.push("stderr", chunk);
      },
    });
    if (options.reportFd) pipeReadable(child.stdio[3] as Readable | null, {
      push: (chunk: Buffer) => {
        reportBytes += chunk.length;
        if (reportBytes > maximumReportBytes) {
          reportFailure ??= reportTooLarge(reportBytes, maximumReportBytes);
          return;
        }
        reportChunks.push(chunk);
      },
    });
    // stdin may reject a buffered write after the child has already closed its read end.
    // Always consume that error; when input was requested, fail the command deterministically.
    child.stdin.on("error", (error) => {
      if (options.input === undefined) return;
      inputFailure ??= error;
      if (!finished) child.kill();
    });
    // spawn 失败（程序不存在、权限不足等）：收敛为 spawn-failed，错误码取系统 errno。
    child.once("error", (error) => finish({ kind: "spawn-failed", errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED" }));
    // 正常退出：若是被强制终止（forced）则 outcome 取终止原因而非退出码。
    child.once("close", (code) => finish(forced ? { kind: forced } : { kind: "exited", exitCode: code ?? 1 }));
    // 注入 stdin 后关闭写入端，让子进程读到 EOF。
    child.stdin.end(options.input);
  });
}
