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
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { asPosixLoomError } from "../core/errors.js";
import { loadConfig, resolveConfigPaths } from "../core/config.js";
import { PosixLoomService } from "../core/service.js";
import { RuntimeManager } from "../core/runtime.js";
import { RuntimeUpdater } from "../core/updater.js";
import { serveControlPlane } from "../core/control.js";
import { readTraceEvents, traceFilePath } from "../core/trace.js";
import { InteractiveProcessController } from "../core/process.js";
import { PluginMarketplace } from "../plugins/marketplace.js";
import { startRemoteHttpServer, type RemoteHttpServer } from "../http/server.js";
import { startGuiServer, type GuiServer } from "../gui/server.js";
import { createPluginMarketplaceHttpExtension } from "../composition/plugin-http.js";
import type { CommandCompletion, TerminalSize } from "../core/types.js";

// dist/src/cli/main.js → project root is three levels up.
// 应用根目录：从编译产物（dist/src/cli/main.js）向上三级回到项目根，
// RuntimeManager 依赖它定位 runtime 目录与配置。
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** 打印用法帮助到 stdout；不设置退出码，供 help 与未知命令两个分支共用。 */
function printUsage(): void {
  console.log(`PosixLoom Runtime\n\nUsage:\n  posixloom exec [--dry-run] [--json] -- <program> [args...]\n  posixloom exec [--pty] [--cols n] [--rows n] [--cwd /path] [--isolated] [--timeout ms] -- <program> [args...]\n  posixloom shell [--dry-run] [--json] [--cwd /path] [--isolated] [--timeout ms] -c <script>\n  posixloom shell [--pty] [--cols n] [--rows n] [--cwd /path] [--isolated] [--timeout ms] -c <script>\n  posixloom shell [--cwd /path] [--isolated] [--timeout ms] --stdin\n  posixloom explain [--json] exec [options] -- <program> [args...]\n  posixloom explain [--json] shell [options] -c <script>\n  posixloom repl\n  posixloom serve --stdio\n  posixloom serve --http [--host host] [--port n] [--token token] [--cors-origin origin] [--marketplace url]\n  posixloom gui [--host host] [--port n] [--api-url url] [--api-host host] [--api-port n] [--token token] [--marketplace url] [--no-open]\n  posixloom plugin search [query] [--marketplace url] [--json]\n  posixloom plugin list|install <id>|uninstall <id>|run <id> <command> [--json]\n  posixloom config path|show|validate [--json]\n  posixloom runtime doctor|info [--json]\n  posixloom runtime update [--check] [--force] [--json]\n  posixloom runtime rollback [--json]\n  posixloom trace list [--limit n] [--json]\n  posixloom version`);
}

/** 把 explain 预览打印为紧凑的人类可读摘要。 */
function printPreview(preview: Awaited<ReturnType<PosixLoomService["explain"]>>): void {
  console.log(`plan: ${preview.planId}`);
  console.log(`route: ${preview.commandKind} -> ${preview.backend} (${preview.reason})`);
  console.log(`program: ${preview.executable}`);
  console.log(`argv: ${JSON.stringify(preview.argv)}`);
  console.log(`cwd: ${preview.cwdVirtual} -> ${preview.cwdHost}`);
  console.log(`policy: ${preview.policyProfile}; state: ${preview.statePolicy}; timeout: ${preview.timeoutMs}ms`);
  if (preview.terminal) console.log(`terminal: ${preview.terminal.columns}x${preview.terminal.rows}`);
  for (const decision of preview.pathDecisions) {
    console.log(`path[${decision.argumentIndex}]: ${decision.virtualInput ?? "-"} -> ${decision.hostOutput ?? "-"} (${decision.intent}/${decision.physicalCheck})`);
  }
  for (const limitation of preview.limitations) console.log(`limitation: ${limitation}`);
}

/** exec / shell 共享的命令行选项。 */
interface ParsedCommandOptions {
  /** 工作目录覆盖（虚拟路径）。 */
  cwd?: string;
  /** 隔离模式：命令结束后的 cwd / 导出环境改动不提交回会话状态。 */
  isolated: boolean;
  /** 命令超时（毫秒）。 */
  timeoutMs?: number;
  /** 只构建并打印执行计划，不创建子进程。 */
  dryRun: boolean;
  /** 诊断结果使用 JSON 输出（仅与 dry-run 搭配）。 */
  json: boolean;
  /** 使用 ConPTY 交互终端。 */
  pty: boolean;
  columns?: number;
  rows?: number;
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
  let dryRun = false;
  let json = false;
  let pty = false;
  let columns: number | undefined;
  let rows: number | undefined;
  const command: string[] = [];
  // 见到 `--` 后停止选项解析，其余参数一律进入 command。
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!afterSeparator && arg === "--") { afterSeparator = true; continue; }
    if (!afterSeparator && arg === "--cwd") { cwd = args[++index]; continue; }
    if (!afterSeparator && arg === "--isolated") { isolated = true; continue; }
    if (!afterSeparator && arg === "--timeout") { timeoutMs = Number(args[++index]); continue; }
    if (!afterSeparator && arg === "--dry-run") { dryRun = true; continue; }
    if (!afterSeparator && arg === "--json") { json = true; continue; }
    if (!afterSeparator && (arg === "--pty" || arg === "--interactive")) { pty = true; continue; }
    if (!afterSeparator && arg === "--cols") { columns = Number(args[++index]); continue; }
    if (!afterSeparator && arg === "--rows") { rows = Number(args[++index]); continue; }
    command.push(arg);
  }
  if (!command.length) throw new Error("Missing command. Use: posixloom exec -- <command>");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new Error("--timeout must be a positive integer");
  if (json && !dryRun) throw new Error("--json is only valid with --dry-run");
  if ((columns !== undefined || rows !== undefined) && !pty) throw new Error("--cols/--rows require --pty");
  if (columns !== undefined && (!Number.isSafeInteger(columns) || columns <= 0 || columns > 32767)) throw new Error("--cols must be an integer between 1 and 32767");
  if (rows !== undefined && (!Number.isSafeInteger(rows) || rows <= 0 || rows > 32767)) throw new Error("--rows must be an integer between 1 and 32767");
  return { argv: command, cwd, isolated, timeoutMs, dryRun, json, pty, columns, rows };
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
  let dryRun = false;
  let json = false;
  let pty = false;
  let columns: number | undefined;
  let rows: number | undefined;
  let raw: string | undefined;
  let stdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cwd") { cwd = args[++index]; continue; }
    if (arg === "--isolated") { isolated = true; continue; }
    if (arg === "--timeout") { timeoutMs = Number(args[++index]); continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--pty" || arg === "--interactive") { pty = true; continue; }
    if (arg === "--cols") { columns = Number(args[++index]); continue; }
    if (arg === "--rows") { rows = Number(args[++index]); continue; }
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
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new Error("--timeout must be a positive integer");
  if (json && !dryRun) throw new Error("--json is only valid with --dry-run");
  if (stdin && pty) throw new Error("shell --stdin cannot be combined with --pty; use -c so stdin remains attached to the terminal");
  if ((columns !== undefined || rows !== undefined) && !pty) throw new Error("--cols/--rows require --pty");
  if (columns !== undefined && (!Number.isSafeInteger(columns) || columns <= 0 || columns > 32767)) throw new Error("--cols must be an integer between 1 and 32767");
  if (rows !== undefined && (!Number.isSafeInteger(rows) || rows <= 0 || rows > 32767)) throw new Error("--rows must be an integer between 1 and 32767");
  return { raw, stdin, cwd, isolated, timeoutMs, dryRun, json, pty, columns, rows };
}

/** 把 CLI 选项解析为带合理缺省值的字符视口。 */
function terminalSize(options: ParsedCommandOptions): TerminalSize | undefined {
  if (!options.pty) return undefined;
  return {
    columns: options.columns ?? process.stdout.columns ?? 80,
    rows: options.rows ?? process.stdout.rows ?? 24,
  };
}

/** 将一段子进程输出写到当前终端，并把 drain 背压传回进程层。 */
async function writeTerminalOutput(data: Buffer): Promise<void> {
  if (process.stdout.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const cleanup = (): void => {
      process.stdout.off("drain", onDrain);
      process.stdout.off("error", onError);
    };
    process.stdout.once("drain", onDrain);
    process.stdout.once("error", onError);
  });
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

interface HttpCliOptions {
  mode: "stdio" | "http";
  host: string;
  port: number;
  token?: string;
  corsOrigins: string[];
  marketplaceUrl?: string;
  plugins: boolean;
}

interface GuiCliOptions {
  host: string;
  port: number;
  apiUrl?: string;
  apiHost: string;
  apiPort: number;
  token?: string;
  marketplaceUrl?: string;
  open: boolean;
  plugins: boolean;
}

function requiredOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function cliPort(value: string | undefined, fallback: number, name: string): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return port;
}

function parseServeOptions(args: string[]): HttpCliOptions {
  let mode: "stdio" | "http" | undefined;
  let host = process.env.POSIXLOOM_HTTP_HOST ?? "127.0.0.1";
  let portValue = process.env.POSIXLOOM_HTTP_PORT;
  let token = process.env.POSIXLOOM_HTTP_TOKEN;
  let marketplaceUrl = process.env.POSIXLOOM_MARKETPLACE_URL;
  let plugins = true;
  const corsOrigins: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stdio") { if (mode) throw new Error("Choose exactly one serve transport"); mode = "stdio"; continue; }
    if (argument === "--http") { if (mode) throw new Error("Choose exactly one serve transport"); mode = "http"; continue; }
    if (argument === "--host") { host = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--port") { portValue = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--token") { token = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--cors-origin") { corsOrigins.push(requiredOptionValue(args, index, argument)); index += 1; continue; }
    if (argument === "--marketplace") { marketplaceUrl = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--no-plugins") { plugins = false; continue; }
    throw new Error(`Unknown serve option: ${argument}`);
  }
  if (!mode) throw new Error("serve requires --stdio or --http");
  if (mode === "stdio" && (args.length !== 1 || args[0] !== "--stdio")) throw new Error("serve --stdio cannot be combined with HTTP options");
  return { mode, host, port: cliPort(portValue, 7331, "--port"), token, corsOrigins, marketplaceUrl, plugins };
}

function parseGuiOptions(args: string[]): GuiCliOptions {
  let host = process.env.POSIXLOOM_GUI_HOST ?? "127.0.0.1";
  let portValue = process.env.POSIXLOOM_GUI_PORT;
  let apiUrl: string | undefined;
  let apiHost = process.env.POSIXLOOM_HTTP_HOST ?? "127.0.0.1";
  let apiPortValue = process.env.POSIXLOOM_HTTP_PORT;
  let token = process.env.POSIXLOOM_HTTP_TOKEN;
  let marketplaceUrl = process.env.POSIXLOOM_MARKETPLACE_URL;
  let open = true;
  let plugins = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--host") { host = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--port") { portValue = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--api-url") { apiUrl = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--api-host") { apiHost = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--api-port") { apiPortValue = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--token") { token = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--marketplace") { marketplaceUrl = requiredOptionValue(args, index, argument); index += 1; continue; }
    if (argument === "--no-open") { open = false; continue; }
    if (argument === "--no-plugins") { plugins = false; continue; }
    throw new Error(`Unknown gui option: ${argument}`);
  }
  if (apiUrl && (args.includes("--api-host") || args.includes("--api-port") || args.includes("--token") || args.includes("--marketplace") || args.includes("--no-plugins"))) {
    throw new Error("--api-url connects to an existing service and cannot be combined with embedded API options");
  }
  return {
    host,
    port: cliPort(portValue, 7330, "--port"),
    apiUrl,
    apiHost,
    apiPort: cliPort(apiPortValue, 7331, "--api-port"),
    token,
    marketplaceUrl,
    open,
    plugins,
  };
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function openBrowser(url: string): void {
  const target = process.platform === "win32"
    ? { program: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
    : process.platform === "darwin"
      ? { program: "open", args: [url] }
      : { program: "xdg-open", args: [url] };
  try {
    const child = spawn(target.program, target.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (error) => console.error(`[GUI OPEN WARN] ${error.message}`));
    child.unref();
  } catch (error) {
    console.error(`[GUI OPEN WARN] ${String(error)}`);
  }
}

async function waitForNetworkServices(services: Array<RemoteHttpServer | GuiServer>): Promise<void> {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled(services.map((service) => service.close()));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await Promise.race(services.map((service) => service.closed));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.allSettled(services.map((service) => service.close()));
  }
}

function marketplaceFor(dataRoot: string, marketplaceUrl?: string): PluginMarketplace {
  return new PluginMarketplace(dataRoot, { marketplaceUrl });
}

function cliJsonCompletion(completion: CommandCompletion): Record<string, unknown> {
  return {
    command: completion.command,
    state: completion.state.kind === "committed" ? { ...completion.state, newVersion: completion.state.newVersion.toString() } : completion.state,
    stdoutBase64: completion.stdout.toString("base64"),
    stderrBase64: completion.stderr.toString("base64"),
    stdoutBytes: completion.stdoutBytes,
    stderrBytes: completion.stderrBytes,
    truncated: completion.truncated,
    backend: completion.backend,
    planId: completion.planId,
    trace: completion.trace,
  };
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
    console.log("posixloom 0.1.0-dev (PosixLoom Runtime; architecture v2.0 plugin kernel)");
    return;
  }

  // 配置诊断必须早于 RuntimeManager 创建：即使用户配置或
  // Runtime manifest 损坏，config path/validate 仍然要能定位并报告问题。
  if (args[0] === "config") {
    const command = args[1];
    const json = args.includes("--json");
    if (!command || !["path", "show", "validate"].includes(command)) {
      throw new Error("Use: posixloom config path|show|validate [--json]");
    }
    const paths = await resolveConfigPaths(appRoot);
    if (command === "path") {
      if (json) console.log(JSON.stringify({ ...paths, userConfigExists: existsSync(paths.userConfigPath) }, null, 2));
      else console.log(paths.userConfigPath);
      return;
    }
    try {
      const loaded = await loadConfig(appRoot, { allowInvalidRuntimePointer: true });
      if (command === "show") {
        console.log(JSON.stringify(loaded.runtime, null, 2));
      } else if (json) {
        console.log(JSON.stringify({ valid: true, path: paths.userConfigPath, runtimePointerIssues: loaded.runtimePointerIssues }, null, 2));
      } else {
        console.log(`config: OK (${paths.userConfigPath})`);
        for (const issue of loaded.runtimePointerIssues) console.log(`[WARN] runtime pointer: ${issue.message}`);
      }
    } catch (error) {
      const configError = asPosixLoomError(error, "CONFIG_INVALID");
      if (command !== "validate") throw error;
      if (json) console.log(JSON.stringify({ valid: false, path: paths.userConfigPath, error: { code: configError.code, message: configError.message, details: configError.details } }, null, 2));
      else console.error(`[${configError.code}] ${configError.message}`);
      process.exitCode = 2;
    }
    return;
  }

  // 当前命令是否为 runtime 恢复类命令：这类命令的目的就是修复运行时，
  // 因此允许在运行时无效的情况下继续执行。
  const runtimeRecoveryCommand = args[0] === "runtime" && (args[1] === "doctor" || args[1] === "info" || args[1] === "update" || args[1] === "rollback");
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
  // runtime info：输出不执行外部命令的运行时、挂载、策略与后端摘要。
  if (args[0] === "runtime" && args[1] === "info") {
    const info = runtime.info();
    if (args.includes("--json")) console.log(JSON.stringify(info, null, 2));
    else {
      console.log(`Runtime: ${info.runtimeId} ${info.runtimeSemver} (${info.mode}/${info.source})`);
      console.log(`Snapshot: ${info.snapshotId}`);
      console.log(`Plugin graph: ${info.pluginsHash}`);
      console.log(`Runtime root: ${info.runtimeRoot}`);
      console.log(`Data root: ${info.dataRoot}`);
      console.log(`Workspace: ${info.workspace}`);
      console.log(`Policy: ${info.policyProfile}`);
      console.log(`Bash: ${info.bash ?? "not found"}`);
      console.log(`Native Host: ${info.nativeHost ?? "not found"}`);
      console.log(`Native commands: ${info.nativeCommands.join(", ") || "none"}`);
      console.log(`Plugins: ${info.plugins.length} (${info.plugins.filter((plugin) => plugin.state === "active").length} active) - ${info.plugins.map((plugin) => plugin.id).join(", ") || "none"}`);
    }
    return;
  }
  // trace list 从持久化 JSONL 尾部读取；未开启落盘或文件不存在时返回空列表。
  if (args[0] === "trace") {
    if (args[1] !== "list") throw new Error("Use: posixloom trace list [--limit n] [--json]");
    const limitIndex = args.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 50;
    const events = await readTraceEvents(runtime.config.dataRoot, limit);
    if (args.includes("--json")) console.log(JSON.stringify({ path: traceFilePath(runtime.config.dataRoot), events }, null, 2));
    else if (!events.length) console.log(`No persisted traces at ${traceFilePath(runtime.config.dataRoot)}.`);
    else for (const event of events) console.log(JSON.stringify(event));
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

  // 插件市场是独立的声明式安装面；只有 plugin run 会显式把已安装命令交给
  // PosixLoomService，安装/浏览本身不执行插件内容。
  if (args[0] === "plugin") {
    let marketplaceUrl = process.env.POSIXLOOM_MARKETPLACE_URL;
    let json = false;
    let cwd: string | undefined;
    const positional: string[] = [];
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--json") { json = true; continue; }
      if (argument === "--marketplace") { marketplaceUrl = requiredOptionValue(args, index, argument); index += 1; continue; }
      if (argument === "--cwd") { cwd = requiredOptionValue(args, index, argument); index += 1; continue; }
      if (argument.startsWith("--")) throw new Error(`Unknown plugin option: ${argument}`);
      positional.push(argument);
    }
    const command = positional[0];
    const marketplace = marketplaceFor(runtime.config.dataRoot, marketplaceUrl);
    if (command === "search") {
      const plugins = await marketplace.catalog(positional.slice(1).join(" "));
      if (json) console.log(JSON.stringify({ plugins }, null, 2));
      else if (!plugins.length) console.log("No marketplace plugins matched the query.");
      else for (const plugin of plugins) console.log(`${plugin.installedVersion ? "[installed]" : "[available]"} ${plugin.manifest.id} ${plugin.manifest.version} - ${plugin.manifest.name}`);
      return;
    }
    if (command === "list") {
      if (positional.length !== 1) throw new Error("Use: posixloom plugin list [--json]");
      const plugins = await marketplace.installed();
      if (json) console.log(JSON.stringify({ plugins }, null, 2));
      else if (!plugins.length) console.log("No plugins are installed.");
      else for (const plugin of plugins) console.log(`${plugin.manifest.id} ${plugin.manifest.version} - ${plugin.manifest.name}`);
      return;
    }
    if (command === "install") {
      if (positional.length !== 2) throw new Error("Use: posixloom plugin install <id> [--marketplace url] [--json]");
      const installed = await marketplace.install(positional[1]);
      if (json) console.log(JSON.stringify({ plugin: installed }, null, 2));
      else console.log(`Installed ${installed.manifest.name} ${installed.manifest.version}. Commands are inert until explicitly run.`);
      return;
    }
    if (command === "uninstall" || command === "remove") {
      if (positional.length !== 2) throw new Error("Use: posixloom plugin uninstall <id> [--json]");
      await marketplace.uninstall(positional[1]);
      if (json) console.log(JSON.stringify({ removed: true, pluginId: positional[1] }, null, 2));
      else console.log(`Uninstalled ${positional[1]}.`);
      return;
    }
    if (command === "run") {
      if (positional.length !== 3) throw new Error("Use: posixloom plugin run <id> <command> [--cwd /path] [--json]");
      const recipe = await marketplace.command(positional[1], positional[2]);
      const service = new PosixLoomService(runtime);
      const sessionId = service.createSession(cwd ?? recipe.cwd ?? "/workspace");
      const common = { sessionId, cwd: cwd ?? recipe.cwd, timeoutMs: recipe.timeoutMs };
      const completion = recipe.input.kind === "argv"
        ? await service.execute({ ...common, kind: "argv", argv: recipe.input.argv })
        : await service.execute({ ...common, kind: "text", raw: recipe.input.raw });
      if (json) console.log(JSON.stringify(cliJsonCompletion(completion), null, 2));
      else {
        if (completion.stdout.length) process.stdout.write(completion.stdout);
        if (completion.stderr.length) process.stderr.write(completion.stderr);
      }
      if (completion.command.kind === "exited") process.exitCode = completion.command.exitCode;
      else if (completion.command.kind === "timed-out") process.exitCode = 124;
      else if (completion.command.kind === "cancelled") process.exitCode = 130;
      else process.exitCode = 1;
      return;
    }
    throw new Error("Use: posixloom plugin search|list|install|uninstall|run ...");
  }

  // GUI 与远程 API 是两个独立服务器。gui 默认在 CLI 组合根同时启动两者；
  // --api-url 则只启动静态 GUI，并连接一个已有的远程服务。
  if (args[0] === "gui") {
    const guiOptions = parseGuiOptions(args.slice(1));
    const services: Array<RemoteHttpServer | GuiServer> = [];
    try {
      if (guiOptions.apiUrl) {
        const gui = await startGuiServer({ host: guiOptions.host, port: guiOptions.port, apiBaseUrl: guiOptions.apiUrl });
        services.push(gui);
        console.log(`PosixLoom GUI: ${gui.origin}`);
        console.log(`Remote API: ${new URL(guiOptions.apiUrl).origin} (external)`);
      } else {
        const clientApiHost = guiOptions.apiHost === "0.0.0.0" ? "127.0.0.1" : guiOptions.apiHost === "::" ? "::1" : guiOptions.apiHost;
        const apiBaseUrl = `http://${urlHost(clientApiHost)}:${guiOptions.apiPort}`;
        const gui = await startGuiServer({ host: guiOptions.host, port: guiOptions.port, apiBaseUrl });
        services.push(gui);
        const plugins = guiOptions.plugins ? marketplaceFor(runtime.config.dataRoot, guiOptions.marketplaceUrl) : undefined;
        const api = await startRemoteHttpServer(runtime, {
          host: guiOptions.apiHost,
          port: guiOptions.apiPort,
          token: guiOptions.token,
          corsOrigins: [gui.origin],
          extensions: plugins ? [createPluginMarketplaceHttpExtension(plugins)] : undefined,
        });
        services.push(api);
        console.log(`PosixLoom GUI: ${gui.origin}`);
        console.log(`Remote API: ${api.origin}${guiOptions.token ? " (Bearer auth)" : " (loopback only)"}`);
      }
      if (guiOptions.open) openBrowser(services[0].origin);
      await waitForNetworkServices(services);
    } catch (error) {
      await Promise.allSettled(services.map((service) => service.close()));
      throw error;
    }
    return;
  }

  // serve 传输彼此独立：stdio 继续使用帧协议；HTTP 只提供 JSON API，不托管 GUI。
  if (args[0] === "serve") {
    const serveOptions = parseServeOptions(args.slice(1));
    if (serveOptions.mode === "stdio") {
      await serveControlPlane(runtime, process.stdin, process.stdout);
      return;
    }
    const plugins = serveOptions.plugins ? marketplaceFor(runtime.config.dataRoot, serveOptions.marketplaceUrl) : undefined;
    const server = await startRemoteHttpServer(runtime, {
      host: serveOptions.host,
      port: serveOptions.port,
      token: serveOptions.token,
      corsOrigins: serveOptions.corsOrigins,
      extensions: plugins ? [createPluginMarketplaceHttpExtension(plugins)] : undefined,
    });
    console.log(`PosixLoom HTTP API listening at ${server.origin}`);
    console.log(`Authentication: ${serveOptions.token ? "Bearer token required" : "disabled (loopback binding)"}`);
    await waitForNetworkServices([server]);
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
  // explain：复用 exec/shell 参数解析与服务层计划构建，但不创建子进程。
  if (args[0] === "explain") {
    let offset = 1;
    const json = args[offset] === "--json";
    if (json) offset += 1;
    const mode = args[offset];
    if (mode !== "exec" && mode !== "shell") throw new Error("Use: posixloom explain [--json] exec|shell ...");
    const parsed = mode === "shell" ? parseShell(args.slice(offset + 1)) : parseExec(args.slice(offset + 1));
    const shellRaw = mode === "shell"
      ? ((parsed as ReturnType<typeof parseShell>).stdin ? await readStandardInput() : (parsed as ReturnType<typeof parseShell>).raw ?? "")
      : undefined;
    const service = new PosixLoomService(runtime);
    const sessionId = service.createSession(parsed.cwd ?? "/workspace");
    const preview = await service.explain({
      ...(mode === "shell" ? { kind: "text" as const, raw: shellRaw! } : { kind: "argv" as const, argv: (parsed as ReturnType<typeof parseExec>).argv }),
      sessionId,
      cwd: parsed.cwd,
      statePolicy: parsed.isolated ? "isolated" : undefined,
      timeoutMs: parsed.timeoutMs,
      terminal: terminalSize(parsed),
    });
    if (json) console.log(JSON.stringify(preview, null, 2));
    else printPreview(preview);
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
  if (parsed.dryRun) {
    const preview = await service.explain({
      ...(args[0] === "shell" ? { kind: "text" as const, raw: shellRaw! } : { kind: "argv" as const, argv: (parsed as ReturnType<typeof parseExec>).argv }),
      sessionId,
      cwd: parsed.cwd,
      statePolicy: parsed.isolated ? "isolated" : undefined,
      timeoutMs: parsed.timeoutMs,
      terminal: terminalSize(parsed),
    });
    if (parsed.json) console.log(JSON.stringify(preview, null, 2));
    else printPreview(preview);
    return;
  }
  // exec 走 argv 精确模式，shell 走 text 脚本模式；--isolated 映射为
  // statePolicy:isolated（不提交会话状态），其余选项原样透传。
  const terminal = terminalSize(parsed);
  let completion;
  if (terminal) {
    const interactive = new InteractiveProcessController();
    const abort = new AbortController();
    const input = process.stdin;
    const wasRaw = Boolean(input.isRaw);
    const onData = (chunk: Buffer | string): void => {
      input.pause();
      void interactive.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).then(
        () => input.resume(),
        () => abort.abort(),
      );
    };
    const onEnd = (): void => { void interactive.end().catch(() => undefined); };
    const onResize = (): void => {
      void interactive.resize(process.stdout.columns ?? terminal.columns, process.stdout.rows ?? terminal.rows).catch(() => undefined);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    process.stdout.on("resize", onResize);
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();
    try {
      completion = await service.execute({
        ...(args[0] === "shell" ? { kind: "text" as const, raw: shellRaw! } : { kind: "argv" as const, argv: (parsed as ReturnType<typeof parseExec>).argv }),
        sessionId,
        cwd: parsed.cwd,
        statePolicy: parsed.isolated ? "isolated" : undefined,
        timeoutMs: parsed.timeoutMs,
        terminal,
        interactive,
        signal: abort.signal,
      }, { onOutput: (event) => writeTerminalOutput(event.data) });
    } finally {
      input.off("data", onData);
      input.off("end", onEnd);
      process.stdout.off("resize", onResize);
      if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(wasRaw);
      input.pause();
    }
  } else {
    completion = await service.execute({
      ...(args[0] === "shell" ? { kind: "text" as const, raw: shellRaw! } : { kind: "argv" as const, argv: (parsed as ReturnType<typeof parseExec>).argv }),
      sessionId,
      cwd: parsed.cwd,
      statePolicy: parsed.isolated ? "isolated" : undefined,
      timeoutMs: parsed.timeoutMs,
    });
  }
  // 命令输出原样写到对应流；trace 仅在 POSIXLOOM_RUNTIME_TRACE=1 时输出到 stderr，
  // 供排障使用。
  if (!terminal && completion.stdout.length) process.stdout.write(completion.stdout);
  if (!terminal && completion.stderr.length) process.stderr.write(completion.stderr);
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
