import { parseExecutionRequest } from "../core/execution-request.js";
import type { TerminalSize } from "../core/types.js";

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
export function parseExec(args: string[]): ParsedCommandOptions & { argv: string[] } {
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
    if (!afterSeparator && arg === "--cwd") { cwd = args[++index]; if (cwd === undefined || cwd.startsWith("--")) throw new Error("--cwd requires a value"); continue; }
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
  if (json && !dryRun) throw new Error("--json is only valid with --dry-run");
  if ((columns !== undefined || rows !== undefined) && !pty) throw new Error("--cols/--rows require --pty");
  parseExecutionRequest({ input: { kind: "argv", argv: command }, cwd, timeoutMs, terminal: pty ? { columns: columns ?? 80, rows: rows ?? 24 } : undefined }, { code: "CLI_OPTIONS_INVALID" });
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
export function parseShell(args: string[]): ParsedCommandOptions & { raw?: string; stdin: boolean } {
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
    if (arg === "--cwd") { cwd = args[++index]; if (cwd === undefined || cwd.startsWith("--")) throw new Error("--cwd requires a value"); continue; }
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
  if (json && !dryRun) throw new Error("--json is only valid with --dry-run");
  if (stdin && pty) throw new Error("shell --stdin cannot be combined with --pty; use -c so stdin remains attached to the terminal");
  if ((columns !== undefined || rows !== undefined) && !pty) throw new Error("--cols/--rows require --pty");
  parseExecutionRequest({ input: { kind: "text", raw: raw ?? "" }, cwd, timeoutMs, terminal: pty ? { columns: columns ?? 80, rows: rows ?? 24 } : undefined }, { code: "CLI_OPTIONS_INVALID" });
  return { raw, stdin, cwd, isolated, timeoutMs, dryRun, json, pty, columns, rows };
}

/** 把 CLI 选项解析为带合理缺省值的字符视口。 */
export function terminalSize(options: ParsedCommandOptions): TerminalSize | undefined {
  if (!options.pty) return undefined;
  return {
    columns: options.columns ?? process.stdout.columns ?? 80,
    rows: options.rows ?? process.stdout.rows ?? 24,
  };
}
