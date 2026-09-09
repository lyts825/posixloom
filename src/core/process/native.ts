import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { PosixLoomError } from "../errors.js";
import type { CommandOutcome } from "../types.js";
import type { ProcessRunOptions, ProcessRunResult } from "./contracts.js";
import { OutputCollector, ProcessOutputForwarder, DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS, DEFAULT_MAX_REPORT_BYTES } from "./output.js";
import { readAndRemoveReport } from "./report.js";
import { makeResult } from "./result.js";
import { encodeNativeFrame, NativeFrameDecoder, NativeEventValidator, NATIVE_PROTOCOL_VERSION } from "./protocol.js";

/**
 * 原生执行路径：spawn Rust 宿主 `posixloom __exec-host --protocol-v1`，
 * 通过 stdin/stdout 上的帧协议驱动一次子进程执行。
 *
 * 时序：发送 exec 帧（program/args/cwd/env/timeoutMs/inputBase64）->
 * 接收 hello -> started -> stdout/stderr... -> exit（或 error）-> 宿主退出。
 * 子进程的创建与进程树终止都在宿主内完成（CreateProcessW 挂起创建 +
 * Job Object + TerminateJobObject），TS 侧只解释事件流并以看门狗兜底。
 *
 * 取消流程：向宿主发 cancel 帧请求其终止进程树；若宽限期（cancelGraceMs，
 * 默认 2000ms）内宿主仍无响应，直接 kill 宿主并判 cancelled。
 *
 * 宿主异常的结果映射（一律收敛为 crashed/spawn-failed，fail-closed）：
 * - spawn 失败 -> spawn-failed（错误码取系统 errno，缺省 HOST_SPAWN_FAILED）；
 * - 协议违规 / 流断在半帧 / 宿主 stderr 有输出 -> crashed + NATIVE_HOST_PROTOCOL_FAILED；
 * - 全程未见 hello -> crashed + NATIVE_HOST_HELLO_MISSING；
 * - 收到 hello 但无 exit -> crashed + NATIVE_HOST_EXIT_MISSING；
 * - 看门狗超时（timeoutMs + 宽限期仍未收敛）-> crashed +
 *   NATIVE_HOST_TIMEOUT_WATCHDOG_<阶段>。
 *
 * @throws {PosixLoomError} NATIVE_HOST_MISSING - 未提供 hostPath（分派方应保证不触发）。
 */
export async function runViaNativeHost(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const started = performance.now();
  const timings: Record<string, number> = {};
  if (!options.hostPath) throw new PosixLoomError("NATIVE_HOST_MISSING", "Native Host path is required");
  // exec 帧：一次性下发全部启动参数；stdin 输入序列化为 Base64（帧 payload 是 JSON，无法内嵌二进制）。
  const execFrame = encodeNativeFrame({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    type: "exec",
    program: options.program,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    inputBase64: options.input === undefined ? undefined : Buffer.from(options.input).toString("base64"),
    tty: Boolean(options.terminal),
    columns: options.terminal?.columns,
    rows: options.terminal?.rows,
    shellNamespace: options.shellNamespace,
  });
  // 预先编码 cancel 帧，abort 时直接复用（提前编码也能在执行前暴露超限错误）。
  const cancelFrame = encodeNativeFrame({ protocolVersion: NATIVE_PROTOCOL_VERSION, type: "cancel" });
  // 启动宿主：三个标准流全走管道、隐藏窗口，命令行固定为 __exec-host --protocol-v1。
  const host = spawn(options.hostPath, ["__exec-host", "--protocol-v1"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // stdout/stderr 各自独立限额的头尾截断收集器。
  const stdout = new OutputCollector(options.maxOutputBytes);
  const stderr = new OutputCollector(options.maxOutputBytes);
  const decoder = new NativeFrameDecoder();
  const validator = new NativeEventValidator(Boolean(options.shellNamespace));
  let executionSent = false;
  // 取消宽限期：cancel 帧发出后给宿主这么多时间优雅收尾。
  const grace = options.cancelGraceMs ?? 2000;
  // 收敛状态：settled 保证 Promise 只 resolve 一次；hello 标记握手是否完成；
  // lastStage 记录协议推进到的最后阶段（spawned/hello/started/exit），供看门狗
  // 错误码定位宿主卡在哪一步；exitOutcome 为 exit 事件映射出的终局；
  // protocolError 汇集协议违规信息与宿主 stderr 输出。
  let settled = false;
  let hello = false;
  let lastStage = "spawned";
  let exitOutcome: CommandOutcome | undefined;
  let protocolError: string | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let resolvePromise!: (result: ProcessRunResult) => void;
  const promise = new Promise<ProcessRunResult>((resolve) => { resolvePromise = resolve; });
  const outputForwarder = new ProcessOutputForwarder(
    options.onOutput,
    () => host.stdout.pause(),
    () => {
      if (!host.stdout.destroyed) host.stdout.resume();
    },
    (error) => {
      protocolError = `Output sink failed: ${String(error)}`;
      host.kill();
    },
  );

  // 统一收口：清看门狗、解绑 abort 监听、读报告文件并 resolve（幂等）。
  const complete = (outcome: CommandOutcome): void => {
    if (settled) return;
    settled = true;
    if (watchdog) clearTimeout(watchdog);
    options.signal?.removeEventListener("abort", abort);
    options.interactive?.terminate();
    void outputForwarder.drain(options.outputDrainTimeoutMs ?? DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS).then(() => {
      const report = readAndRemoveReport(options.reportPath, Buffer.alloc(0), options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES);
      const finalOutcome = outputForwarder.failed
        ? { kind: "crashed" as const, errorCode: "OUTPUT_SINK_FAILED" }
        : report.error
          ? { kind: "crashed" as const, errorCode: "REPORT_IO_FAILED" }
          : outcome;
      resolvePromise({ ...makeResult(finalOutcome, stdout, stderr, report.data, "native-host"), timings: { ...timings, processTotalMs: performance.now() - started } });
    });
  };
  // 写一帧到宿主 stdin；宿主可能已退出，先确认管道未销毁。
  const send = (frame: Buffer): void => {
    if (!host.stdin.destroyed) host.stdin.write(frame);
  };
  // 取消流程：先发 cancel 帧让宿主优雅终止整棵进程树，同时把看门狗重设为
  // 宽限期；到点宿主仍无响应则强杀宿主并按 cancelled 收场。
  const abort = (): void => {
    if (settled) return;
    if (!executionSent) { host.kill(); complete({ kind: "cancelled" }); return; }
    send(cancelFrame);
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      host.kill();
      complete({ kind: "cancelled" });
    }, grace);
  };

  // 吞掉 stdin 写入错误：宿主早退时会产生 EPIPE，不应演变为未捕获异常。
  host.stdin.on("error", () => undefined);
  // 事件流主循环：字节 -> 帧解码 -> 状态机校验 -> 按事件类型分派。
  host.stdout.on("data", (chunk: Buffer | string) => {
    try {
      for (const value of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        const event = validator.accept(value);
        if (event.type === "hello") {
          // hello 只推进阶段标记，不产生结果。
          hello = true;
          lastStage = "hello";
          if (options.shellNamespace) {
            if (!Array.isArray(event.capabilities) || !event.capabilities.includes("shell-namespace-v1")) {
              host.kill();
              complete({ kind: "crashed", errorCode: "NATIVE_HOST_CAPABILITY_MISSING" });
              return;
            }
            startExecution();
          }
        } else if (event.type === "stdout" && event.data !== undefined) {
          const data = event.decodedData ?? Buffer.alloc(0);
          if (data.length) timings.firstByteMs ??= performance.now() - started;
          stdout.push(data);
          outputForwarder.push("stdout", data);
        } else if (event.type === "stderr" && event.data !== undefined) {
          const data = event.decodedData ?? Buffer.alloc(0);
          if (data.length) timings.firstByteMs ??= performance.now() - started;
          stderr.push(data);
          outputForwarder.push("stderr", data);
        } else if (event.type === "exit") {
          // 把宿主 outcome 映射为 CommandOutcome：宿主侧进程崩溃统一映射为
          // NATIVE_HOST_PROCESS_FAILED 错误码；exited 之外的终局按各自 kind 归位。
          lastStage = "exit";
          timings.exitMs = performance.now() - started;
          exitOutcome = event.outcome === "timed-out"
            ? { kind: "timed-out" }
            : event.outcome === "cancelled"
              ? { kind: "cancelled" }
              : event.outcome === "crashed"
                ? { kind: "crashed", errorCode: "NATIVE_HOST_PROCESS_FAILED" }
              : { kind: "exited", exitCode: event.code ?? 1 };
        } else if (event.type === "started") { lastStage = "started"; timings.spawnMs = performance.now() - started; }
        // 宿主侧 error 事件：先记下消息，待宿主退出后统一收敛为 crashed。
        else if (event.type === "error") protocolError = event.message ?? "Native Host protocol error";
      }
    } catch (error) {
      // 帧解码或状态机校验抛错：记录诊断信息并立即 kill 宿主，结果由 close 收敛。
      protocolError = String(error);
      host.kill();
    }
  });
  // 宿主自身 stderr：作为诊断信息记录（仅在还没有更有力的错误信息时）。
  host.stderr.on("data", (chunk: Buffer | string) => {
    protocolError ??= Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  });
  // 宿主进程未能启动（如路径错误、权限不足）：直接收敛为 spawn-failed。
  host.once("error", (error) => complete({ kind: "spawn-failed", errorCode: (error as NodeJS.ErrnoException).code ?? "HOST_SPAWN_FAILED" }));
  // 宿主退出：最终收敛点。依次判定--断流在半帧/协议违规 -> PROTOCOL_FAILED；
  // 从未握手 -> HELLO_MISSING；握手了但没有 exit -> EXIT_MISSING；
  // 否则采用 exit 事件映射出的终局。
  host.once("close", () => {
    if (settled) return;
    try { decoder.finish(); } catch (error) { protocolError ??= String(error); }
    if (protocolError) complete({ kind: "crashed", errorCode: "NATIVE_HOST_PROTOCOL_FAILED" });
    else if (!hello) complete({ kind: "crashed", errorCode: "NATIVE_HOST_HELLO_MISSING" });
    else complete(exitOutcome ?? { kind: "crashed", errorCode: "NATIVE_HOST_EXIT_MISSING" });
  });

  // 下发 exec 帧；写入失败（如宿主刚启动就死亡）则 kill 后原样抛出。
  const startExecution = (): void => {
    if (settled || executionSent) return;
    send(execFrame);
    executionSent = true;
    options.interactive?.attach(async (event) => {
      const value = event.type === "input"
        ? { protocolVersion: NATIVE_PROTOCOL_VERSION, type: "input", data: event.data.toString("base64") }
        : event.type === "resize"
          ? { protocolVersion: NATIVE_PROTOCOL_VERSION, type: "resize", columns: event.columns, rows: event.rows }
          : { protocolVersion: NATIVE_PROTOCOL_VERSION, type: "eof" };
      const frame = encodeNativeFrame(value);
      await new Promise<void>((resolve, reject) => {
        if (host.stdin.destroyed) {
          reject(new PosixLoomError("TERMINAL_CLOSED", "Native Host input is unavailable"));
          return;
        }
        host.stdin.write(frame, (error) => error ? reject(error) : resolve());
      });
    });
  };
  if (!options.shellNamespace) {
    try { startExecution(); }
    catch (error) { host.kill(); throw error; }
  }
  // 看门狗：timeout + 宽限期后仍未收敛，说明宿主自身挂死（不发事件也不退出），
  // 强制 kill 并以 crashed 收场；错误码携带卡住的阶段（如 ..._WATCHDOG_HELLO）。
  watchdog = setTimeout(() => {
    host.kill();
    complete({ kind: "crashed", errorCode: `NATIVE_HOST_TIMEOUT_WATCHDOG_${lastStage.toUpperCase()}` });
  }, options.timeoutMs + grace);
  // 外部取消信号：进入时已 abort 则立即取消，否则挂一次性监听。
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return promise;
}
