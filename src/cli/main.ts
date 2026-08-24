/**
 * PosixLoom CLI 入口：解析命令行参数并分发到对应子命令。
 *
 * 命令集：
 * - exec：argv 精确模式，`--` 之后的参数原样透传给命令，不做 Shell 解析；
 * - shell：`-c <script>` 执行脚本文本，或 `--stdin` 从标准输入读取脚本；
 * - repl：逐行读取 stdin，在单一会话中连续执行（保留跨行状态）；
 * - serve --stdio：启动 Harness 控制平面（见 src/core/control.ts）；
 * - runtime doctor / update / rollback：运行时体检、更新与回滚；
 * - version / help：版本与用法。
 *
 * 自愈流程：RuntimeManager.create 失败时--若当前本身就是 runtime 恢复类
 * 命令，则以 allowInvalidRuntime 重试（用户显式要求修复，允许带病管理）；
 * 否则检查更新配置（enabled + autoApply + feedUrl 齐备），满足时以恢复
 * 管理器强制 RuntimeUpdater.update() 重建运行时，成功后重新 create 并继续
 * 执行原命令（输出 “[PosixLoom UPDATE] Recovered Runtime ...”）。此后常规命令在
 * autoApply 开启时还会尝试一次静默更新，失败仅告警不中断。
 *
 * 退出码约定：命令正常退出透传其 exitCode；timed-out -> 124（对齐 GNU
 * timeout）；cancelled -> 130（128 + SIGINT 惯例）；其余异常形态 -> 1；
 * usage 类错误与 doctor 不健康 -> 2。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { asPosixLoomError } from "../core/errors.js";
import { PosixLoomService } from "../core/service.js";
import { RuntimeManager } from "../core/runtime.js";
import { RuntimeUpdater } from "../core/updater.js";
import { serveControlPlane } from "../core/control.js";

// dist/src/cli/main.js → project root is three levels up.
// 应用根目录：从编译产物（dist/src/cli/main.js）向上三级回到项目根，
// RuntimeManager 依赖它定位 runtime 目录与配置。
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** 打印用法帮助到 stdout；不设置退出码，供 help 与未知命令两个分支共用。 */
function printUsage(): void {
  console.log(`PosixLoom Runtime\n\nUsage:\n  posixloom exec -- <program> [args...]\n  posixloom exec [--cwd /path] [--isolated] [--timeout ms] -- <program> [args...]\n  posixloom shell [--cwd /path] [--isolated] [--timeout ms] -c <script>\n  posixloom shell [--cwd /path] [--isolated] [--timeout ms] --stdin\n  posixloom repl\n  posixloom serve --stdio\n  posixloom runtime doctor [--json]\n  posixloom runtime update [--check] [--force] [--json]\n  posixloom runtime rollback [--json]\n  posixloom version`);
}

/** exec / shell 共享的命令行选项。 */
interface ParsedCommandOptions {
  /** 工作目录覆盖（虚拟路径）。 */
  cwd?: string;
  /** 隔离模式：命令结束后的 cwd / 导出环境改动不提交回会话状态。 */
  isolated: boolean;
  /** 命令超时（毫秒）。 */
  timeoutMs?: number;
}

/**
 * 解析 `posixloom exec` 的参数：`--` 之前识别 --cwd / --isolated / --timeout 三个
 * 选项，之后的参数全部原样收集为 argv（未写 `--` 时也宽松接受裸参数）。
 * argv 不做任何 Shell 解析--这是 exec 精确模式与 shell 的本质区别。
 *
 * @returns argv 为待执行的程序与参数。
 * @throws 缺少命令或 --timeout 非正数时抛 Error（由顶层 catch 以退出码 1 兜底）。
 */
function parseExec(args: string[]): ParsedCommandOptions & { argv: string[] } {
  let cwd: string | undefined;
  let isolated = false;
  let timeoutMs: number | undefined;
  const command: string[] = [];
  // 见到 `--` 后停止选项解析，其余参数一律进入 command。
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!afterSeparator && arg === "--") { afterSeparator = true; continue; }
    if (!afterSeparator && arg === "--cwd") { cwd = args[++index]; continue; }
    if (!afterSeparator && arg === "--isolated") { isolated = true; continue; }
    if (!afterSeparator && arg === "--timeout") { timeoutMs = Number(args[++index]); continue; }
    command.push(arg);
  }
  if (!command.length) throw new Error("Missing command. Use: posixloom exec -- <command>");
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("--timeout must be a positive number");
  return { argv: command, cwd, isolated, timeoutMs };
}

/**
 * 解析 `posixloom shell` 的参数：接受 --cwd / --isolated / --timeout 与二选一的
 * 脚本来源（-c <script> 或 --stdin）。与 exec 不同，这里对未知选项直接报错，
 * 避免把脚本内容误当成选项解析。
 *
 * @returns raw 为 -c 提供的脚本文本；stdin 为真表示脚本来自标准输入。
 * @throws 脚本来源缺失或冲突、--stdin 之后还有参数、-c 带多余参数、
 *         未知选项、--timeout 非正数时抛 Error。
 */
function parseShell(args: string[]): ParsedCommandOptions & { raw?: string; stdin: boolean } {
  let cwd: string | undefined;
  let isolated = false;
  let timeoutMs: number | undefined;
  let raw: string | undefined;
  let stdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cwd") { cwd = args[++index]; continue; }
    if (arg === "--isolated") { isolated = true; continue; }
    if (arg === "--timeout") { timeoutMs = Number(args[++index]); continue; }
    // --stdin 必须是最后一个选项：其后不允许再出现任何参数。
    if (arg === "--stdin") {
      stdin = true;
      if (index + 1 < args.length) throw new Error("--stdin must be the final shell option");
      break;
    }
    // -c 只接受恰好一个脚本参数，防止多段拼接产生歧义。
    if (arg === "-c" || arg === "--command") {
      raw = args[++index];
      if (index + 1 < args.length) throw new Error("posixloom shell -c accepts exactly one script argument");
      break;
    }
    throw new Error(`Unknown shell option: ${arg}`);
  }
  // 脚本来源必须且只能选一个：-c 与 --stdin 互斥。
  if (raw === undefined && !stdin) throw new Error("Missing script. Use: posixloom shell -c <script> or posixloom shell --stdin");
  if (raw !== undefined && stdin) throw new Error("Use either shell -c or shell --stdin, not both");
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("--timeout must be a positive number");
  return { raw, stdin, cwd, isolated, timeoutMs };
}

/**
 * 读取全部标准输入为 UTF-8 文本（`posixloom shell --stdin` 的脚本来源）。
 * 逐块累积后一次性合并，避免大输入反复拼接字符串；同时剥离开头的 BOM。
 */
async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

/**
 * CLI 主入口：短路 help / version（无需运行时）-> 创建 RuntimeManager（失败时
 * 进入自愈流程）-> 处理 runtime 子命令 -> 可选的 autoApply 静默更新 ->
 * 分发 serve / repl / exec / shell。任何异常由文件末尾的 main().catch 统一
 * 以 `[CODE] message` 输出并置退出码 1。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // help 短路：只打印用法，不触碰运行时。
  if (!args.length || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }
  // version 短路：版本串硬编码，避免为拿版本号而加载运行时。
  if (args[0] === "version" || args[0] === "--version") {
    console.log("posixloom 0.1.0-dev (PosixLoom Runtime; architecture v1.7)");
    return;
  }

  // 当前命令是否为 runtime 恢复类命令：这类命令的目的就是修复运行时，
  // 因此允许在运行时无效的情况下继续执行。
  const runtimeRecoveryCommand = args[0] === "runtime" && (args[1] === "doctor" || args[1] === "update" || args[1] === "rollback");
  let runtime: RuntimeManager;
  // 标记自愈流程是否已更新过运行时，避免随后再跑一次 autoApply 静默更新。
  let runtimeUpdatedDuringRecovery = false;
  try {
    // 严格模式创建：运行时缺失 / 损坏 / 校验失败都会在这里抛错。
    runtime = await RuntimeManager.create(appRoot);
  } catch (error) {
    if (runtimeRecoveryCommand) {
      // 恢复类命令：放宽校验创建管理器，交给 doctor / update / rollback 自行处理。
      runtime = await RuntimeManager.create(appRoot, { allowInvalidRuntime: true });
    } else {
      // 自愈分支：非恢复命令时尝试强制更新以修复运行时。
      const recovery = await RuntimeManager.create(appRoot, { allowInvalidRuntime: true });
      const updates = recovery.config.runtime.updates;
      // 只有显式开启 autoApply 且配置了 feedUrl 才自愈；否则原样抛出原始错误。
      if (!updates.enabled || !updates.autoApply || !updates.feedUrl) throw error;
      // force 跳过版本比较，无条件重装当前 feed 上的运行时。
      const result = await new RuntimeUpdater(recovery).update({ force: true });
      // 更新仍未成功（如网络失败）则放弃自愈，抛回原始错误。
      if (result.status !== "installed") throw error;
      runtimeUpdatedDuringRecovery = true;
      console.error(`[PosixLoom UPDATE] Recovered Runtime ${result.runtimeId}; continuing with the new Runtime.`);
      // 自愈成功后按严格模式重建管理器，并继续执行用户的原命令。
      runtime = await RuntimeManager.create(appRoot);
    }
  }
  // runtime doctor：输出体检报告。--json 输出机器可读格式，否则逐项打印；
  // 存在异常项时以退出码 2 标记失败。
  if (args[0] === "runtime" && args[1] === "doctor") {
    const report = runtime.doctor();
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of report.checks) console.log(`[${check.level}] ${check.id}: ${check.message}`);
      console.log(report.ok ? "doctor: OK" : "doctor: FAIL");
    }
    if (!report.ok) process.exitCode = 2;
    return;
  }
  // runtime update：--check 只检查不安装，--force 忽略版本 / 频率限制强制执行。
  if (args[0] === "runtime" && args[1] === "update") {
    const updater = new RuntimeUpdater(runtime);
    const result = args.includes("--check")
      ? await updater.check({ force: args.includes("--force") })
      : await updater.update({ force: args.includes("--force") });
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else if (result.status === "available") console.log(`Runtime update available: ${result.release.runtimeId} (${result.release.runtimeSemver})`);
    else if (result.status === "installed") console.log(`Runtime ${result.runtimeId} installed; restart PosixLoom to use it.`);
    else console.log(`Runtime update: ${result.status}`);
    return;
  }
  // runtime rollback：回滚到上一个可用运行时；选择结果需重启进程后生效。
  if (args[0] === "runtime" && args[1] === "rollback") {
    const result = await new RuntimeUpdater(runtime).rollback();
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else console.log(`Runtime rollback selected ${result.runtimeId}; restart PosixLoom to use it.`);
    return;
  }

  const updates = runtime.config.runtime.updates;
  // 常规命令前的静默更新：自愈流程刚更新过则跳过；失败仅告警，不影响本次命令。
  if (!runtimeUpdatedDuringRecovery && updates.enabled && updates.autoApply && updates.feedUrl) {
    try {
      const result = await new RuntimeUpdater(runtime).update();
      if (result.status === "installed") {
        console.error(`[PosixLoom UPDATE] Installed ${result.runtimeId}; this command will use the new Runtime.`);
        // 新运行时已落盘，重建管理器让本次命令直接使用它。
        runtime = await RuntimeManager.create(appRoot);
      }
    } catch (error) {
      const updateError = asPosixLoomError(error, "UPDATE_FAILED");
      console.error(`[PosixLoom UPDATE WARN] ${updateError.code}: ${updateError.message}`);
    }
  }

  // serve：目前仅支持 stdio 传输，直接把进程标准流交给控制平面，
  // 由 serveControlPlane 负责帧协议与连接生命周期。
  if (args[0] === "serve") {
    if (!args.includes("--stdio")) throw new Error("serve requires --stdio");
    await serveControlPlane(runtime, process.stdin, process.stdout);
    return;
  }

  // repl：逐行读取 stdin，所有行共用一个会话，保留 cd / export 等跨行状态。
  if (args[0] === "repl") {
    const service = new PosixLoomService(runtime);
    const sessionId = service.createSession("/workspace");
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      // 空行直接跳过，不产生空命令。
      if (!line.trim()) continue;
      try {
        const completion = await service.execute({ raw: line, sessionId });
        if (completion.stdout.length) process.stdout.write(completion.stdout);
        if (completion.stderr.length) process.stderr.write(completion.stderr);
        // 非零退出码透传为进程退出码（最后一行生效）。
        if (completion.command.kind === "exited" && completion.command.exitCode !== 0) process.exitCode = completion.command.exitCode;
      } catch (error) {
        // 单行失败不退出 REPL：打印错误并置退出码 1，继续读下一行。
        const posixloomError = asPosixLoomError(error);
        console.error(`[${posixloomError.code}] ${posixloomError.message}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  // 其余未知命令：打印用法并以 2 退出（usage 类错误）。
  if (args[0] !== "exec" && args[0] !== "run" && args[0] !== "shell") {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const parsed = args[0] === "shell" ? parseShell(args.slice(1)) : parseExec(args.slice(1));
  // shell 的脚本文本二选一：--stdin 读全部标准输入，否则用 -c 提供的文本。
  const shellRaw = args[0] === "shell"
    ? ((parsed as ReturnType<typeof parseShell>).stdin ? await readStandardInput() : (parsed as ReturnType<typeof parseShell>).raw ?? "")
    : undefined;
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession(parsed.cwd ?? "/workspace");
  // exec 走 argv 精确模式，shell 走 text 脚本模式；--isolated 映射为
  // statePolicy:isolated（不提交会话状态），其余选项原样透传。
  const completion = await service.execute({
    ...(args[0] === "shell" ? { kind: "text" as const, raw: shellRaw! } : { kind: "argv" as const, argv: (parsed as ReturnType<typeof parseExec>).argv }),
    sessionId,
    cwd: parsed.cwd,
    statePolicy: parsed.isolated ? "isolated" : undefined,
    timeoutMs: parsed.timeoutMs,
  });
  // 命令输出原样写到对应流；trace 仅在 POSIXLOOM_RUNTIME_TRACE=1 时输出到 stderr，
  // 供排障使用。
  if (completion.stdout.length) process.stdout.write(completion.stdout);
  if (completion.stderr.length) process.stderr.write(completion.stderr);
  if (process.env.POSIXLOOM_RUNTIME_TRACE === "1") console.error(`\n[PosixLoom TRACE] ${JSON.stringify(completion.trace)}`);
  // 退出码映射：正常退出透传；超时 124（对齐 GNU timeout）；取消 130
  //（128 + SIGINT 惯例）；其余异常形态（spawn 失败 / 崩溃等）统一 1。
  if (completion.command.kind === "exited") process.exitCode = completion.command.exitCode;
  else if (completion.command.kind === "timed-out") process.exitCode = 124;
  else if (completion.command.kind === "cancelled") process.exitCode = 130;
  else process.exitCode = 1;
}

// 顶层兜底：任何未被捕获的异常统一转换为 `[CODE] message` 输出（有 details
// 时附加 JSON），并以退出码 1 结束进程。
main().catch((error) => {
  const posixloomError = asPosixLoomError(error);
  console.error(`[${posixloomError.code}] ${posixloomError.message}`);
  if (Object.keys(posixloomError.details).length) console.error(JSON.stringify(posixloomError.details));
  process.exitCode = 1;
});
