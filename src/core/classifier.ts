/**
 * 命令分类器：把原始命令文本划分为四类之一，决定后续执行路径。
 *
 * 职责：在不执行任何代码的前提下，对输入做一次纯函数式的词法预判，
 * 判断命令能否安全地以 Native Fast Path（直接按 argv spawn）执行。
 *
 * 设计意图：
 * - fail-safe 到 shell：任何无法确认安全的输入（shell 运算符、变量/通配
 *   展开、复合语法、内建命令等）一律归类为 shell-required / explicit-shell
 *   / builtin，交给真正的 Bash 执行。宁可慢一点，也不能让 native 路径
 *   悄悄改变语义（例如把 "$x" 当字面量、把 * 当普通字符）。
 * - 只有确信是"简单命令"（纯 argv、无任何 shell 语法）才归类为 simple，
 *   这是 Native Fast Path 的唯一准入条件，也是正确性红线。
 */
import type { ClassifiedCommand, CommandKind } from "./types.js";

/** shell 内建命令：会改变会话状态（cwd / exportedEnv），必须由 shell harness 执行并产出 StateReport，native spawn 无法复现其副作用。 */
const BUILTINS = new Set(["cd", "export", "unset", "source", ".", "alias", "set", "shopt", "trap", "umask", "ulimit"]);
/** shell 复合语法关键字：首 token 命中即说明输入不是单条简单命令，只能由 shell 解析。 */
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "then", "else", "elif", "fi", "case", "esac", "function", "select", "time", "coproc"]);

/**
 * 检测文本中是否存在未被引号包裹的 shell 语法字符。
 * 逐字符扫描并跟踪单/双引号与反斜杠转义状态，只有"引号外"（即真正会被
 * shell 解释）的位置才判定为语法：管道/逻辑/重定向/命令替换（|&;<>`）、
 * 变量与命令展开（$）、通配符（* ?）以及字符组（[）都意味着必须交给
 * 真实 shell 执行——native 路径按字面量处理会改变语义。
 * 注意 [ 采取保守判定：只要出现（无论是否成对）就视为 shell 语法。
 * @param raw 原始命令文本
 * @returns true 表示检测到 shell 语法
 */
function hasShellSyntax(raw: string): boolean {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    // 前一个字符是转义符：当前字符按字面量处理，跳过判定
    if (escaped) { escaped = false; continue; }
    // 反斜杠转义下一个字符（单引号内不转义，与 POSIX 规则一致）
    if (char === "\\" && quote !== "single") { escaped = true; continue; }
    // 单/双引号成对开合；引号字符本身不参与内容
    if (char === "'" && quote !== "double") { quote = quote === "single" ? undefined : "single"; continue; }
    if (char === '"' && quote !== "single") { quote = quote === "double" ? undefined : "double"; continue; }
    // 引号内的字符不会被 shell 解释，直接跳过
    if (quote) continue;
    if ("|&;<>`".includes(char) || char === "$" || char === "*" || char === "?" || char === "[") return true;
  }
  return false;
}

/**
 * 按近似 POSIX shell 的引号/转义规则把原始文本切分为 argv。
 * 采用保守策略：凡是本函数无法忠实表达的输入一律返回 null——引号外出现
 * 运算符字符（|&;<>）、结尾仍有未闭合的引号或悬空转义符、以及切分结果
 * 为空，都视为"不可安全切分"，交由上层改走 shell 路径。
 * 注意：$、*、?、`、[ 等字符不会在这里被拒绝（它们可能合法地出现在
 * token 中），是否构成 shell 语法由 hasShellSyntax 单独判定。
 * @param raw 原始命令文本
 * @returns argv 数组；无法安全切分时返回 null
 */
export function tokenizeSimple(raw: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let started = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    // 转义符的下一个字符按字面量计入当前 token
    if (escaped) { token += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "single") { escaped = true; started = true; continue; }
    // 引号开合切换词法状态；引号字符本身不进入 token，但标记 token 已开始
    if (char === "'" && quote !== "double") { quote = quote === "single" ? undefined : "single"; started = true; continue; }
    if (char === '"' && quote !== "single") { quote = quote === "double" ? undefined : "double"; started = true; continue; }
    // 引号外的空白作为 token 分隔符（空 token 不产生）
    if (!quote && /\s/.test(char)) {
      if (started) { tokens.push(token); token = ""; started = false; }
      continue;
    }
    // 引号外的运算符字符：存在管道/重定向等语法，本函数无法表达，放弃切分
    if (!quote && "|&;<>".includes(char)) return null;
    token += char;
    started = true;
  }
  // 结尾残留未闭合的引号或转义：输入不完整，拒绝切分
  if (escaped || quote) return null;
  if (started) tokens.push(token);
  return tokens.length ? tokens : null;
}

/**
 * 命令分类入口：对原始文本执行一棵自上而下的决策树，首个命中的分支即定类。
 * 各分支（自上而下，越靠前优先级越高，命中即返回）：
 *  1. 空命令 -> simple + 空 argv，上游按无操作处理；
 *  2. bash/sh 显式携带 -c/-lc -> explicit-shell：用户明确要求用 shell 执行，
 *     命令体整体交给 shell，不做二次拆解；
 *  3. 首 token 是 .sh 脚本或 ./xxx 形式的脚本路径 -> explicit-shell：
 *     脚本需要解释器语义（shebang、相对路径解析），不能直接 spawn；
 *  4. 含未加引号的 shell 语法（运算符/展开/通配） -> shell-required：
 *     fail-safe 兜底，native 路径无法还原这些语义；
 *  5. 首 token 是 shell 关键字（for/while/if/case...） -> shell-required：
 *     复合命令结构只能由 shell 解析；
 *  6. 首 token 是 shell 内建（cd/export/unset...） -> builtin：副作用要落在
 *     会话状态上，由 shell harness 执行并产出 StateReport；
 *  7. 其余 -> simple + argv：唯一允许进入 Native Fast Path 的类别。
 * @param raw 原始命令文本
 * @returns 分类结果；reason 描述判定依据（同时进入 trace，便于审计）
 */
export function classify(raw: string): ClassifiedCommand {
  const trimmed = raw.trim();
  // 空命令：直接按简单命令处理（空 argv）
  if (!trimmed) return { kind: "simple", argv: [], reason: "empty command" };
  const argv = tokenizeSimple(trimmed);
  // 显式 shell 调用（bash -c / sh -lc）：命令体整体交给 shell，不再拆解
  if (argv && (argv[0] === "bash" || argv[0] === "sh") && (argv[1] === "-c" || argv[1] === "-lc")) {
    return { kind: "explicit-shell", argv, reason: "explicit shell invocation" };
  }
  // 脚本路径调用：.sh 后缀或 ./相对路径形式，需要 shell 解释器执行
  if (argv && (argv[0].endsWith(".sh") || argv[0].includes("/") && argv[0].startsWith("./"))) {
    return { kind: "explicit-shell", argv, reason: "script path invocation" };
  }
  // shell 运算符/展开/通配：必须由真实 shell 解释（fail-safe 分支）
  if (hasShellSyntax(trimmed)) return { kind: "shell-required", argv: null, reason: "shell operator, expansion or glob detected" };
  // shell 关键字开头：复合命令，结构只能由 shell 解析
  if (argv && SHELL_KEYWORDS.has(argv[0])) return { kind: "shell-required", argv, reason: "shell keyword" };
  // shell 内建命令：会修改会话状态（cwd/env），须由 shell harness 执行
  if (argv && BUILTINS.has(argv[0])) return { kind: "builtin", argv, reason: `shell builtin: ${argv[0]}` };
  // 纯 argv 简单命令：Native Fast Path 的唯一候选
  return { kind: "simple", argv, reason: "simple argv command" };
}

/**
 * 判断某个命令类别是否必须经由 shell（Bash/MSYS2 后端）执行。
 * 只有 simple 类别可以走 native 直接 spawn；builtin、shell-required、
 * explicit-shell 三类都需要 shell 语义兜底。本函数是 Native Fast Path
 * 的准入判据，判断口径刻意从宽（kind !== "simple"）以保持 fail-safe。
 * @param kind 命令类别
 * @returns true 表示该类别需要 shell 后端执行
 */
export function isCommandKindShell(kind: CommandKind): boolean {
  return kind !== "simple";
}
