/**
 * service.ts -- PosixLoomService：整个 PosixLoom 的命令执行编排核心。
 *
 * 职责：
 * - 把 RuntimeManager、NativeRegistry、PolicyGate、SessionStateStore、TraceRecorder
 *   和进程执行层（runProcess，优先经 Rust Native Host）串成一条完整的执行管道；
 * - 将用户输入分类（simple / builtin / shell-required / explicit-shell）并路由到两种后端：
 *   native 快路径（Windows 原生可执行文件 + 适配器翻译参数）与 msys2 shell 路径
 *   （bash --noprofile --norc -s 从 stdin 执行生成的包装脚本）；
 * - 为 shell 路径生成包装脚本：挂载 MSYS 挂载点、导出 POSIX 环境、cd 到虚拟 cwd、
 *   执行用户命令，再通过临时文件 StateReport 回传会话状态（退出码 / 物理 pwd / 全量环境）；
 * - 逐字节严格解析并校验 StateReport，把 cwd 与环境差量以乐观锁（baseStateVersion）
 *   提交回会话。
 *
 * 设计意图：
 * - 状态回报走临时文件（DataRoot/tmp/posixloom-<commandId>.report）而不是 stdout 或专用 fd
 *   （见 docs/protocols/state-report-v1.md）：MSYS 进程对高编号 Windows fd
 *   的继承不可靠，无法稳定借用一条回传管道；而在 stdout 上打 magic delimiter 会与
 *   用户自身输出混淆，还要求全量缓冲才能切分。临时文件 + 固定协议
 *   （__POSIXLOOM_REPORT_V1 头 / __POSIXLOOM_REPORT_END 尾）使用户 stdout 保持原样，
 *   报告边界完全由文件内容决定。
 * - 包装脚本用固定退出码区分失败阶段：240=StateReport 写入失败、242=挂载失败、
 *   243=cd 失败；脚本其余部分 set +e，用户命令自身的退出码在报告成功后原样透传，
 *   Node 侧无需解析 stderr 即可定位失败发生在哪个阶段。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PosixLoomError, asPosixLoomError } from "./errors.js";
import { buildNativeEnv, buildPosixEnv, canonicalEnvKey, diffExportedEnv } from "./env.js";
import { classify } from "./classifier.js";
import { PolicyGate } from "./policy.js";
import { NativeRegistry } from "./registry.js";
import { runProcess, type ProcessRunResult } from "./process.js";
import { RuntimeManager } from "./runtime.js";
import { isSafeExistingDirectory, normalizeVirtual } from "./path.js";
import { SessionStateStore } from "./session.js";
import { TraceRecorder, type TraceEvent } from "./trace.js";
import type {
  CommandCompletion,
  CommandOutcome,
  MountBootstrap,
  NativeExecutionPlan,
  ResolutionTemplate,
  SessionState,
  ShellExecutionPlan,
  StateOutcome,
  StatePatch,
} from "./types.js";

/**
 * parseStateReport 成功解析 StateReport 后的结果：
 * - exitCode：用户命令的业务退出码（非报告写入状态）；
 * - cwd：报告回传的物理 pwd（Base64 解码后的 POSIX 虚拟路径）；
 * - exportedEnv：报告中 NUL 分隔的全量环境（键已做 Windows 大小写折叠）。
 */
export interface ParsedStateReport {
  exitCode: number;
  cwd: string;
  exportedEnv: Record<string, string>;
}

/**
 * 用 POSIX 单引号包裹任意字符串，确保嵌入 shell 脚本后不发生分词、展开或注入；
 * 单引号字面量用 '\'' 序列转义（关闭引号 + 转义后的单引号 + 重新开启引号）。
 */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * 生成喂给 `bash --noprofile --norc -s`（stdin）的一次性包装脚本。
 *
 * 脚本按固定顺序分为六个阶段，失败阶段各有独立退出码，便于 Node 侧定位：
 *   1. set +e：关闭 errexit，各阶段失败由显式退出码表达；
 *   2. 定义并执行 __posixloom_mount：用 mount -f 逐项重建 MSYS 挂载视图（失败 exit 242）；
 *   3. 导出 POSIX 环境（export 本身不会失败，无独立退出码）；
 *   4. cd 进入虚拟 cwd（失败 exit 243，例如目录被并发删除）；
 *   5. 用户命令包在 __posixloom_user_command 函数中执行并捕获退出码；
 *   6. __posixloom_emit_report 把退出码、pwd -P（Base64）、env -0 全量环境写入
 *      $POSIXLOOM_STATE_REPORT_PATH（协议见 docs/protocols/state-report-v1.md）；
 *      报告失败 exit 240，成功则以用户命令退出码退出。
 *
 * 注意：脚本字符串属于 StateReport / 退出码协议的一部分，内容不得改动。
 */
export function buildShellScript(plan: ShellExecutionPlan): string {
  // __posixloom_mount：mount -f 把宿主目录绑定到 MSYS 虚拟路径；/tmp 特例容忍失败--
  // MSYS/Cygwin 可能把 /tmp 提供为系统级固定挂载，无法按会话替换。
  const mountFunction = [
    "__posixloom_mount() {",
    "  mount -f \"$1\" \"$2\" >/dev/null 2>&1 && return 0",
    "  # MSYS/Cygwin may provide /tmp as a fixed system mount that cannot be replaced per session.",
    "  [ \"$2\" = /tmp ] && [ -d /tmp ] && return 0",
    "  return 1",
    "}",
  ].join("\n");
  // 逐挂载点调用 __posixloom_mount：宿主路径先转混合路径（正斜杠），任一挂载失败立即
  // exit 242，阻止用户命令在缺失挂载的视图下执行。
  const mounts = plan.mountBootstrap.map((mount) =>
    `__posixloom_mount ${quotePosix(toMixedPath(mount.hostPath))} ${quotePosix(mount.virtualPath)} || exit 242`,
  ).join("\n");
  // 导出 POSIX 环境；PWD 被刻意跳过--真实值应由下方 cd 之后由 bash 自行维护。
  const exports = Object.entries(plan.envPosix)
    .filter(([key]) => key !== "PWD")
    .map(([key, value]) => `export ${key}=${quotePosix(value)}`)
    .join("\n");
  return [
    // 阶段 1：关闭 errexit。
    "set +e",
    // 阶段 2：挂载函数定义 + 逐项挂载（失败 exit 242）。
    mountFunction,
    mounts,
    // 阶段 3：导出环境。
    exports,
    // 阶段 4：进入虚拟 cwd（失败 exit 243）。
    `cd -- ${quotePosix(plan.cwdVirtual)} || exit 243`,
    // 阶段 5：用户命令包成函数整体解析后调用，退出码立即捕获到 __posixloom_command_code。
    "__posixloom_user_command() {",
    plan.commandBody,
    "}",
    "__posixloom_user_command",
    "__posixloom_command_code=$?",
    // 阶段 6：__posixloom_emit_report 收集并写入 StateReport--pwd -P 取物理路径做 Base64、
    // env -0 取全量环境并统计字节数；任何一步失败函数返回非零。
    "__posixloom_emit_report() {",
    "  local __posixloom_code=\"$1\"",
    "  local __posixloom_cwd64 __posixloom_env_bytes",
    "  __posixloom_cwd64=\"$(pwd -P | tr -d '\\n' | base64 -w 0 2>/dev/null)\" || return 1",
    "  __posixloom_env_bytes=\"$(env -0 | wc -c | tr -d '[:space:]')\" || return 1",
    "  : > \"$POSIXLOOM_STATE_REPORT_PATH\" || return 1",
    "  printf '__POSIXLOOM_REPORT_V1\\nexit-code=%s\\ncwd-b64=%s\\nenv-bytes=%s\\n' \"$__posixloom_code\" \"$__posixloom_cwd64\" \"$__posixloom_env_bytes\" > \"$POSIXLOOM_STATE_REPORT_PATH\"",
    "  env -0 >> \"$POSIXLOOM_STATE_REPORT_PATH\" || return 1",
    "  printf '__POSIXLOOM_REPORT_END\\n' >> \"$POSIXLOOM_STATE_REPORT_PATH\"",
    "}",
    // 报告成功 -> 透传用户命令退出码；报告失败 -> exit 240（与用户命令自身失败区分）。
    "if __posixloom_emit_report \"$__posixloom_command_code\"; then exit \"$__posixloom_command_code\"; else exit 240; fi",
    "",
  ].join("\n");
}

/**
 * Windows 路径 -> MSYS "混合"路径（正斜杠形式）：
 * UNC 路径 \\server\share 映射为 //server/share，其余仅把反斜杠替换为正斜杠。
 * 反斜杠在 shell 中是转义字符，宿主路径必须先转成此形态才能安全嵌入脚本
 * （挂载源路径与 POSIXLOOM_STATE_REPORT_PATH 的值）。
 */
function toMixedPath(path: string): string {
  if (path.startsWith("\\\\")) return `//${path.slice(2).replaceAll("\\", "/")}`;
  return path.replaceAll("\\", "/");
}

/**
 * 逐字节严格解析 StateReport v1（协议见 docs/protocols/state-report-v1.md）。
 *
 * 文件结构：__POSIXLOOM_REPORT_V1 头行 + exit-code/cwd-b64/env-bytes 三个元数据行 +
 * env-bytes 字节的 NUL 分隔 NAME=value 环境块 + __POSIXLOOM_REPORT_END 尾行。
 * 全部校验失败都抛 STATE_PROTOCOL_FAILED：头部/元数据标签不匹配、行截断、数值
 * 非安全整数或越界、环境块越过报告边界、尾标记缺失或存在尾随数据、cwd 非规范
 * Base64、cwd 或环境块非合法 UTF-8、环境键按 Windows 大小写折叠后冲突。
 * 调用方（shellCompletion）把这些异常转为 state=protocol-failed，会话状态保持不变。
 *
 * @param report StateReport 文件的原始字节
 * @returns 解析结果；报告为空（未产生，例如命令被 set -e/exit/exec 短路）时返回 undefined
 */
export function parseStateReport(report: Buffer): ParsedStateReport | undefined {
  const header = Buffer.from("__POSIXLOOM_REPORT_V1\n");
  // 空报告 = 未产生，不算协议错误；与"产生了但内容非法"严格区分开。
  if (!report.length) return undefined;
  if (!report.subarray(0, header.length).equals(header)) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport header is invalid");
  let offset = header.length;
  // 行读取器：定位下一个 \n 并推进游标；找不到换行说明报告被截断。
  const readLine = (): string => {
    const end = report.indexOf(0x0a, offset);
    if (end < 0) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport line is truncated");
    const line = report.subarray(offset, end).toString("utf8");
    offset = end + 1;
    return line;
  };
  // 三行元数据：退出码 / Base64 cwd / 环境块字节数；标签必须逐字精确匹配。
  const exitLine = readLine();
  const cwdLine = readLine();
  const bytesLine = readLine();
  if (!exitLine.startsWith("exit-code=") || !cwdLine.startsWith("cwd-b64=") || !bytesLine.startsWith("env-bytes=")) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport metadata labels are invalid");
  }
  const exitCode = Number(exitLine.slice("exit-code=".length));
  const cwd64 = cwdLine.slice("cwd-b64=".length);
  const envBytes = Number(bytesLine.slice("env-bytes=".length));
  // 数值合法性：退出码必须落在 0..255；env-bytes 必须是非负安全整数且环境块
  // 不得越过报告末尾（拒绝截断的环境数据，也让解析无需猜测 NUL 块边界）。
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255 || !Number.isSafeInteger(envBytes) || envBytes < 0 || offset + envBytes > report.length) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport metadata is invalid");
  }
  const envBlock = report.subarray(offset, offset + envBytes);
  offset += envBytes;
  // 尾标记必须紧跟环境块，且其后不得有任何多余字节（防报告被拼接或篡改）。
  const endMarker = Buffer.from("__POSIXLOOM_REPORT_END\n");
  if (!report.subarray(offset, offset + endMarker.length).equals(endMarker)) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport end marker is missing");
  }
  if (offset + endMarker.length !== report.length) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport contains trailing data");
  // cwd 必须是规范 Base64：先校验字符集与填充，再要求"解码后重编码"得到完全
  // 相同的串（拒绝非规范编码，例如多余的填充位或非法长度）。
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cwd64)) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not canonical Base64");
  }
  const cwdBytes = Buffer.from(cwd64, "base64");
  if (cwdBytes.toString("base64") !== cwd64) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not canonical Base64");
  // 解码后的 cwd 字节必须是严格 UTF-8（fatal 模式，非法序列直接抛错）。
  let cwd: string;
  try {
    cwd = new TextDecoder("utf-8", { fatal: true }).decode(cwdBytes);
  } catch (error) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not valid UTF-8", { cause: String(error) });
  }
  // 逐条解析 NUL 分隔的环境条目；整个环境块也必须是严格 UTF-8。
  const exportedEnv: Record<string, string> = {};
  const sourceKeys = new Map<string, string>();
  let envText: string;
  try {
    envText = new TextDecoder("utf-8", { fatal: true }).decode(envBlock);
  } catch (error) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport environment is not valid UTF-8", { cause: String(error) });
  }
  // 每条 NAME=value：键经 canonicalEnvKey 做 Windows 大小写折叠；折叠后冲突
  //（同一 POSIX 环境出现 Windows 视角下无法区分的重复键）使整份报告失败。
  for (const entry of envText.split("\0")) {
    if (!entry) continue;
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const sourceKey = entry.slice(0, equals);
    const key = canonicalEnvKey(sourceKey);
    const prior = sourceKeys.get(key);
    if (prior) throw new PosixLoomError("STATE_PROTOCOL_FAILED", `StateReport environment keys are duplicated or collide on Windows: ${prior} / ${sourceKey}`);
    sourceKeys.set(key, sourceKey);
    exportedEnv[key] = entry.slice(equals + 1);
  }
  return { exitCode, cwd, exportedEnv };
}

/**
 * execute 的公共参数。
 * statePolicy 决定命令结束后是否把 cwd/环境提交回会话：
 * "isolated" 一次性执行、不落状态；"cwd-env" 走会话状态管道（读快照 + 提交补丁）。
 */
interface ExecuteBaseOptions {
  sessionId: string;
  cwd?: string;
  envDelta?: Record<string, string | null>;
  statePolicy?: "isolated" | "cwd-env";
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 文本输入形态：raw 交给分类器，可表达复合 shell 命令。 */
export interface TextExecuteOptions extends ExecuteBaseOptions {
  kind?: "text";
  raw: string;
  argv?: never;
}

/** argv 输入形态：调用方给出精确参数向量，跳过文本分类，避免调用方 shell 再解析一次。 */
export interface ArgvExecuteOptions extends ExecuteBaseOptions {
  kind: "argv";
  argv: string[];
  raw?: never;
}

/** execute 的两种输入形态（文本 / 精确 argv），二选一。 */
export type ExecuteOptions = TextExecuteOptions | ArgvExecuteOptions;

/**
 * PosixLoomService -- PosixLoom 命令执行编排核心，把各模块串成完整执行管道。
 *
 * 持有并连接五个协作组件：
 * - RuntimeManager：运行时完整性校验、bash / Native Host 查找、挂载表、配置与快照；
 * - SessionStateStore：会话状态（cwd + exportedEnv + 乐观锁版本号）与串行 lane；
 * - NativeRegistry：simple 命令 -> Windows 原生可执行文件 + 适配器的解析；
 * - PolicyGate：cwd 与可执行文件路径的策略断言（trusted / workspace-guard）；
 * - TraceRecorder：命令级 trace 的环形缓冲与可选落盘。
 *
 * 管道概览（executeOnce）：完整性预检 -> 会话快照与虚拟 cwd -> 策略与存在性检查
 * -> 命令分类 -> 模板解析（native 优先）-> native / shell 执行计划 -> runProcess
 * -> StateReport 解析与会话提交 -> 完整性复检。
 */
export class PosixLoomService {
  /** 会话状态存储；公开暴露供上层创建会话、取快照、关闭会话。 */
  readonly sessions = new SessionStateStore();
  /** native 命令注册表（与 RuntimeManager 共享同一实例）。 */
  private readonly registry: NativeRegistry;
  /** 路径 / 可执行文件策略门。 */
  private readonly policy: PolicyGate;
  /** 命令 trace 记录器。 */
  private readonly traceRecorder: TraceRecorder;

  /**
   * @param runtime 已就绪的运行时管理器；从其上取注册表、默认策略 profile、
   * 挂载表、快照、DataRoot 与可观测性配置来装配内部组件。
   */
  constructor(readonly runtime: RuntimeManager) {
    this.registry = runtime.registry;
    const profileName = runtime.config.runtime.policy.defaultProfile;
    this.policy = new PolicyGate(profileName, runtime.config.runtime.policy.profiles[profileName], runtime.mountTable, runtime.snapshot);
    this.traceRecorder = new TraceRecorder(runtime.config.runtime.observability.traceBufferSize, runtime.config.runtime.observability.writeTraceFile, runtime.config.dataRoot);
  }

  /** 创建新会话（默认虚拟 cwd 为 /workspace），返回会话 ID。 */
  createSession(cwd = "/workspace"): string {
    return this.sessions.create(cwd);
  }

  /** 取会话状态快照（cwd / 导出环境 / 版本号）；会话不存在时抛 SESSION_NOT_FOUND。 */
  sessionSnapshot(sessionId: string): SessionState {
    return this.sessions.snapshot(sessionId);
  }

  /** 取当前 trace 事件快照（诊断用）。 */
  traces(): TraceEvent[] {
    return this.traceRecorder.snapshot();
  }

  /**
   * 执行一条命令并返回 CommandCompletion（命令终态 + 会话状态结果 + 输出 + trace）。
   *
   * - statePolicy 未显式指定时回落到运行时配置的默认策略；
   * - cwd-env 策略下经 sessions.inStateLane 串行执行：同一会话的并发命令排队运行，
   *   保证"读快照 -> 执行 -> 提交补丁"期间不被其他命令穿插（快照/提交一致性的关键）；
   *   isolated 不写会话状态，无需排队；
   * - 完成后把 completion.trace 交给 traceRecorder.record 统一记录（环形缓冲 + 可选落盘）。
   *
   * @param options 命令输入（text 或 argv）及会话/策略/超时等参数
   * @returns CommandCompletion；执行层错误（CWD_NOT_FOUND 等）以异常形式抛出
   */
  async execute(options: ExecuteOptions): Promise<CommandCompletion> {
    const statePolicy = options.statePolicy ?? this.runtime.config.runtime.session.defaultStatePolicy;
    const operation = async (): Promise<CommandCompletion> => this.executeOnce(options, statePolicy);
    const completion = statePolicy === "cwd-env" ? await this.sessions.inStateLane(options.sessionId, operation) : await operation();
    completion.trace = await this.traceRecorder.record(completion.trace);
    return completion;
  }

  /**
   * 单次命令执行管道（execute 的内部实现，一条命令走完全程）。
   *
   * 阶段顺序：
   *   1. 命令前运行时完整性断言（release 模式校验 manifest 与组件树，防篡改扩散）；
   *   2. 输入形态分派（argv / text）与空命令短路；
   *   3. 会话快照 -> 虚拟 cwd（请求覆盖优先）-> 宿主路径 -> 策略断言 -> 存在性检查；
   *   4. 命令分类（argv 模式跳过分类，直接按 simple 处理）；
   *   5. 解析 ResolutionTemplate（simple 命令先查 native 注册表，未命中回落 msys2）；
   *   6. 校验超时并定位 Native Host（release 模式缺失即失败）；
   *   7a. native 快路径：buildNativePlan -> runProcess -> nativeCompletion（状态不适用）；
   *   7b. shell 路径：buildShellPlan -> runProcess（bash -s + stdin 脚本）->
   *       shellCompletion（解析 StateReport、交叉验证退出码、按策略提交会话补丁）；
   *   8. 命令后运行时完整性断言，然后返回完成结果。
   *
   * 可能抛出的错误码：CWD_NOT_FOUND / TIMEOUT_INVALID / NATIVE_HOST_MISSING /
   * BASH_NOT_FOUND / PLAN_INVALID / STATE_CWD_INVALID / STATE_PROTOCOL_FAILED /
   * SESSION_NOT_FOUND 及策略类错误码（POLICY_*）。
   *
   * @param options 命令输入
   * @param statePolicy 已解析的状态策略（execute 层确定，含默认值回落）
   */
  private async executeOnce(options: ExecuteOptions, statePolicy: "isolated" | "cwd-env"): Promise<CommandCompletion> {
    // 阶段 1：命令前完整性断言。
    await this.runtime.assertRuntimeIntegrity("pre-command");
    // 阶段 2：输入形态分派--argv 模式直接使用精确参数向量，text 模式保留原文待分类。
    const exactArgv = options.kind === "argv" ? options.argv : undefined;
    const raw = options.kind === "argv" ? undefined : options.raw;
    // 空命令（空 argv 或空白文本）短路：不启动进程、不触碰会话状态。
    if (exactArgv && exactArgv.length === 0) return this.emptyCompletion();
    if (!exactArgv && !raw?.trim()) return this.emptyCompletion();
    const commandId = randomUUID();
    const started = Date.now();
    // 阶段 3：会话快照 -> 虚拟 cwd（请求覆盖优先于会话当前值）-> 宿主路径
    // -> 策略断言 -> 存在性检查（目录不存在抛 CWD_NOT_FOUND）。
    const state = this.sessions.snapshot(options.sessionId);
    const virtualCwd = options.cwd ?? state.cwd;
    const cwdHost = this.runtime.mountTable.toHost(virtualCwd);
    this.policy.assertCwd(virtualCwd, cwdHost);
    if (!existsSync(cwdHost)) throw new PosixLoomError("CWD_NOT_FOUND", `Working directory does not exist: ${virtualCwd}`, { cwdHost });
    // 阶段 4：命令分类。argv 模式直接按 simple 处理（调用方已完成分词，不再让
    // 文本分类器猜测）；text 模式交给 classify 识别 simple / builtin / shell 语法。
    const classified = exactArgv
      ? { kind: "simple" as const, argv: [...exactArgv], reason: "exact argv request" }
      : classify(raw ?? "");
    // 命令身份：argv 模式用规范化 JSON、text 模式用原文，作为模板 ID 的哈希输入。
    const commandIdentity = exactArgv ? JSON.stringify({ argv: exactArgv }) : raw ?? "";
    // 命令体：argv 模式逐个单引号包裹后拼接（防注入），text 模式原样交给 bash。
    const commandBody = exactArgv ? exactArgv.map(quotePosix).join(" ") : raw ?? "";
    // 阶段 5：解析执行模板（simple 先查 native 注册表，未命中回落 MSYS2 bash）。
    const template = this.resolveTemplate(commandIdentity, classified);
    // 阶段 6：超时参数（非法值直接抛 TIMEOUT_INVALID）；定位 Native Host，
    // release Runtime 不允许缺失（不可回落到 Node 直接 spawn）。
    const timeoutMs = options.timeoutMs ?? this.runtime.config.runtime.process.defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new PosixLoomError("TIMEOUT_INVALID", "timeoutMs must be a positive integer", { timeoutMs });
    const hostPath = this.runtime.findNativeHost();
    if (!hostPath && this.runtime.snapshot.manifest.mode === "release") throw new PosixLoomError("NATIVE_HOST_MISSING", "Release Runtime requires its packaged Native Host");
    // 阶段 7a：native 快路径--仅当命令为 simple 且注册表命中（模板含可执行文件与
    // 适配器翻译后的 argv）时走 Windows 原生执行；否则落入下方 shell 路径。
    if (classified.kind === "simple" && template.backend === "native" && template.argv && template.executable) {
      const native = this.buildNativePlan(commandId, options, state, statePolicy, template, virtualCwd, cwdHost, timeoutMs);
      const result = await runProcess({
        program: native.executable,
        args: native.argv,
        cwd: native.cwdHost,
        env: native.envHost,
        timeoutMs,
        cancelGraceMs: this.runtime.config.runtime.process.cancelGraceMs,
        hostPath,
        signal: options.signal,
        maxOutputBytes: this.runtime.config.runtime.process.maxOutputBytes,
      });
      // 阶段 8（native 分支）：命令后完整性断言，再组装完成结果。
      await this.runtime.assertRuntimeIntegrity("post-command");
      return this.nativeCompletion(native, result, classified.reason, started);
    }
    // 阶段 7b：shell 路径--builtin、shell 语法、explicit-shell 以及注册表未命中的
    // simple 命令统一交给 MSYS2 bash。
    const shell = this.buildShellPlan(commandId, options, commandBody, state, statePolicy, template, virtualCwd, cwdHost, timeoutMs);
    this.policy.assertExecutable(shell.bashExecutable);
    let result: ProcessRunResult;
    try {
      // bash --noprofile --norc -s 从 stdin 读脚本：避免用户 profile 污染环境；
      // 脚本由 buildShellScript 现场生成，StateReport 路径经 envPosix 注入脚本。
      result = await runProcess({
        program: shell.bashExecutable,
        args: ["--noprofile", "--norc", "-s"],
        cwd: cwdHost,
        env: shell.envPosix,
        timeoutMs,
        cancelGraceMs: this.runtime.config.runtime.process.cancelGraceMs,
        input: buildShellScript(shell),
        reportPath: shell.stateReportPath,
        hostPath,
        signal: options.signal,
        maxOutputBytes: this.runtime.config.runtime.process.maxOutputBytes,
      });
    } finally {
      // 无论成败都清理 StateReport 临时文件（force 容忍进程层已删除的情况）。
      rmSync(shell.stateReportPath, { force: true });
    }
    // 阶段 8（shell 分支）：命令后完整性断言，再解析报告并组装完成结果。
    await this.runtime.assertRuntimeIntegrity("post-command");
    return this.shellCompletion(shell, result, classified.reason, started);
  }

  /**
   * 把命令身份解析为 ResolutionTemplate，决定执行后端（native 或 msys2）。
   *
   * templateId = SHA-256(identity + 命令种类 + runtimeId + registryHash)：模板 ID
   * 绑定运行时与注册表版本，同一命令在不同版本下得到不同 ID，保证可观测性与审计安全。
   *
   * - simple 命令先查 registry.resolve（argv[0] 为命令名，路径参数被适配器翻译）：
   *   命中则用 native 后端，携带适配器翻译后的 argv、可执行文件与路径决策记录；
   * - 未命中、或本就需要 shell（builtin / shell-required / explicit-shell）一律
   *   回落 msys2 后端（adapterId 固定为 msys2-bash-v1，可执行文件为 null）。
   *
   * @param identity 命令身份（argv 的规范化 JSON 或原始文本）
   * @param classified 分类结果
   * @returns ResolutionTemplate（backend、templateId、argv、executable、pathDecisions 等）
   */
  private resolveTemplate(identity: string, classified: ReturnType<typeof classify>): ResolutionTemplate {
    const argv = classified.argv;
    const templateId = createHash("sha256").update(JSON.stringify({ identity, kind: classified.kind, runtime: this.runtime.snapshot.runtimeId, registry: this.runtime.snapshot.registryHash })).digest("hex");
    if (classified.kind === "simple" && argv?.length) {
      const native = this.registry.resolve(argv[0], argv, this.runtime.snapshot, this.runtime.mountTable, this.policy);
      if (native) {
        return {
          templateId,
          runtimeId: this.runtime.snapshot.runtimeId,
          registryHash: this.runtime.snapshot.registryHash,
          commandKind: classified.kind,
          backend: "native",
          adapterId: native.descriptor.adapterId,
          reason: `native registry hit: ${argv[0]}`,
          argv: native.adapter.argv,
          executable: native.executable,
          shellEquivalent: native.descriptor.shellEquivalent,
          pathDecisions: native.adapter.decisions,
        };
      }
    }
    return {
      templateId,
      runtimeId: this.runtime.snapshot.runtimeId,
      registryHash: this.runtime.snapshot.registryHash,
      commandKind: classified.kind,
      backend: "msys2",
      adapterId: "msys2-bash-v1",
      reason: classified.kind === "simple" ? "native registry miss; use MSYS2" : classified.reason,
      argv,
      executable: null,
      shellEquivalent: false,
      pathDecisions: [],
    };
  }

  /**
   * 组装 NativeExecutionPlan：Windows 原生可执行文件直接执行（不经 bash）。
   *
   * - 环境由 buildNativeEnv 生成（宿主视角：HOME/TMP 指向 DataRoot、PWD 为宿主 cwd、
   *   PATH 由运行时组件目录拼装）；
   * - planId = SHA-256(commandId + templateId + cwdHost)，把结果与计划关联起来；
   * - 模板不完整（缺可执行文件或 argv）抛 PLAN_INVALID；可执行文件还要过策略断言。
   *
   * statePolicy / virtualCwd 在 native 路径不参与状态管道（native 不回传 StateReport），
   * 用 void 显式标记"有意未使用"。
   */
  private buildNativePlan(commandId: string, options: ExecuteOptions, state: SessionState, statePolicy: "isolated" | "cwd-env", template: ResolutionTemplate, virtualCwd: string, cwdHost: string, timeoutMs: number): NativeExecutionPlan {
    if (!template.executable || !template.argv) throw new PosixLoomError("PLAN_INVALID", "Native template is incomplete");
    const envHost = buildNativeEnv(state, options.envDelta, this.runtime.snapshot.runtimeRoot, this.runtime.config.dataRoot, cwdHost);
    const pathDecisions = template.pathDecisions;
    void statePolicy;
    void virtualCwd;
    this.policy.assertExecutable(template.executable);
    return {
      mode: "native",
      planId: createHash("sha256").update(`${commandId}:${template.templateId}:${cwdHost}`).digest("hex"),
      commandId,
      sessionId: options.sessionId,
      snapshotId: this.runtime.snapshot.snapshotId,
      timeoutMs,
      detached: false,
      policyProfile: this.runtime.config.runtime.policy.defaultProfile,
      executable: template.executable,
      argv: template.argv.slice(1),
      cwdHost,
      envHost,
      pathDecisions,
    };
  }

  /**
   * 组装 ShellExecutionPlan：经 MSYS2 bash 执行的命令包装计划。
   *
   * - 定位 bash 可执行文件（找不到抛 BASH_NOT_FOUND）；
   * - mountBootstrap：运行时挂载表全部条目，供脚本内逐项 mount -f 重建挂载视图；
   * - envPosix：POSIX 视角环境（HOME=/home、TMP=/tmp、PWD=虚拟 cwd、PATH 以
   *   /posixloom/bin:/usr/bin 前缀，并通过 MSYS2_ARG_CONV_EXCL 等禁用 MSYS 路径转换），
   *   另注入 POSIXLOOM_STATE_REPORT_PATH（DataRoot/tmp/posixloom-<commandId>.report 的混合路径）
   *   告诉脚本 StateReport 写到哪里；
   * - baseStateVersion 记录计划生成时的会话版本，供提交阶段做乐观锁校验。
   */
  private buildShellPlan(commandId: string, options: ExecuteOptions, commandBody: string, state: SessionState, statePolicy: "isolated" | "cwd-env", template: ResolutionTemplate, virtualCwd: string, cwdHost: string, timeoutMs: number): ShellExecutionPlan {
    const bash = this.runtime.findBash();
    if (!bash) throw new PosixLoomError("BASH_NOT_FOUND", "MSYS2 Bash was not found; set POSIXLOOM_BASH or install a release Runtime");
    const mounts: MountBootstrap[] = this.runtime.mountTable.entries.map((entry) => ({ virtualPath: entry.virtualPath, hostPath: entry.hostPath }));
    const envPosix = buildPosixEnv(state, options.envDelta, this.runtime.snapshot.runtimeRoot, this.runtime.config.dataRoot, virtualCwd);
    const stateReportPath = join(this.runtime.config.dataRoot, "tmp", `posixloom-${commandId}.report`);
    envPosix.POSIXLOOM_STATE_REPORT_PATH = toMixedPath(stateReportPath);
    void cwdHost;
    return {
      mode: "shell",
      planId: createHash("sha256").update(`${commandId}:${template.templateId}:${virtualCwd}`).digest("hex"),
      commandId,
      sessionId: options.sessionId,
      snapshotId: this.runtime.snapshot.snapshotId,
      timeoutMs,
      detached: false,
      policyProfile: this.runtime.config.runtime.policy.defaultProfile,
      bashExecutable: bash,
      commandBody,
      cwdVirtual: virtualCwd,
      envPosix,
      baseStateVersion: state.version,
      statePolicy,
      mountBootstrap: mounts,
      stateReportPath,
    };
  }

  /**
   * native 路径的完成结果组装：命令终态直接取进程结果；
   * 会话状态固定为 not-applicable--native 快路径不产生 StateReport，也不修改会话状态。
   */
  private nativeCompletion(plan: NativeExecutionPlan, result: ProcessRunResult, reason: string, started: number): CommandCompletion {
    return {
      command: result.outcome,
      state: { kind: "not-applicable" },
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      truncated: result.truncated,
      backend: "native",
      planId: plan.planId,
      trace: { commandId: plan.commandId, sessionId: plan.sessionId, snapshotId: plan.snapshotId, planId: plan.planId, backend: "native", reason, processMode: result.processMode, outcome: result.outcome, durationMs: Date.now() - started },
    };
  }

  /**
   * shell 路径的完成结果组装：解析 StateReport 并按策略决定会话状态结果。
   *
   * 决策矩阵（状态层异常不向 execute 抛出，而是反映在 completion.state）：
   * - 进程终态不是 exited（cancelled / timed-out / crashed / spawn-failed）：
   *   忽略报告，state=not-produced，会话状态不变；
   * - 报告为空（未产生）：state=not-produced；
   * - 报告解析 / 校验失败：state=protocol-failed（STATE_PROTOCOL_FAILED）；
   * - 进程退出码与报告退出码不一致：state=protocol-failed（交叉验证，防报告错位或伪造）；
   * - isolated 策略：报告只用于确认退出码，state=not-applicable；
   * - cwd-env 策略：cwd 归一化 + 策略断言 + 存在性检查（STATE_CWD_INVALID / 策略
   *   拒绝都会被捕获），diffExportedEnv 求环境差量，组装 StatePatch 后经
   *   sessions.commit 乐观锁提交；版本冲突（STATE_CONFLICT）或其他拒绝 -> rejected。
   *
   * @param plan shell 执行计划（含 baseStateVersion / statePolicy / 会话与计划 ID）
   * @param result runProcess 的进程结果（含报告文件内容）
   * @param reason 模板解析原因，写入 trace
   * @param started 命令起始时间戳，用于计算 durationMs
   */
  private shellCompletion(plan: ShellExecutionPlan, result: ProcessRunResult, reason: string, started: number): CommandCompletion {
    let state: StateOutcome;
    let command: CommandOutcome = result.outcome;
    // 非正常终态：报告不可信（可能只写了一半），整体忽略，保持会话状态不变。
    if (result.outcome.kind !== "exited") {
      state = { kind: "not-produced", reason: `StateReport ignored because command outcome was ${result.outcome.kind}` };
      return this.completedShellResult(plan, result, reason, started, command, state);
    }
    try {
      // 解析并严格校验 StateReport；空报告（未产生）与协议失败分别处理。
      const report = parseStateReport(result.report);
      if (!report) {
        // 空报告：正常退出但报告未产生（如被 set -e/exit/exec 短路）记为 not-produced；
        // 分支里的另一形态在该入口不可达（上面已排除非 exited），保留兜底。
        state = { kind: result.outcome.kind === "exited" ? "not-produced" : "protocol-failed", reason: "StateReport was not produced" };
      } else {
        // 交叉验证：进程实际退出码必须与报告记录一致，防止报告与命令错位或被伪造。
        if (result.outcome.exitCode !== report.exitCode) {
          state = { kind: "protocol-failed", reason: "Process exit code disagrees with StateReport" };
        } else {
          // 退出码一致：以报告记录的退出码为准（脚本在报告成功后原样透传用户退出码）。
          command = { kind: "exited", exitCode: report.exitCode };
          if (plan.statePolicy === "isolated") {
            // isolated：不提交任何状态。
            state = { kind: "not-applicable" };
          } else {
            // cwd-env：报告 cwd 必须已是归一化的绝对虚拟路径
            //（归一化改变原值或非 / 开头即非法，抛 STATE_CWD_INVALID）。
            const normalizedCwd = normalizeVirtual(report.cwd);
            if (normalizedCwd !== report.cwd || !normalizedCwd.startsWith("/")) throw new PosixLoomError("STATE_CWD_INVALID", "StateReport cwd must be a normalized absolute virtual path", { cwd: report.cwd });
            // 归一化 cwd 转回宿主路径后再走策略断言与安全存在性检查
            //（不通过会被外层 catch 转为 protocol-failed，会话状态不变）。
            const cwdHost = this.runtime.mountTable.toHost(normalizedCwd);
            this.policy.assertCwd(normalizedCwd, cwdHost);
            if (!isSafeExistingDirectory(cwdHost)) throw new PosixLoomError("STATE_CWD_INVALID", "StateReport cwd does not resolve to an existing directory", { cwd: normalizedCwd, cwdHost });
            // 以提交前的最新快照为基准求环境差量（只采纳用户可变键与 PATH，
            // 运行时派生/不可变键的改动不会被提交）。
            const before = this.sessions.snapshot(plan.sessionId);
            const diff = diffExportedEnv(before.exportedEnv, report.exportedEnv);
            const patch: StatePatch = { baseStateVersion: plan.baseStateVersion, cwd: normalizedCwd, ...diff };
            // 乐观锁提交：baseStateVersion 绑定计划生成时刻，期间若有并发提交则过期。
            try {
              const committed = this.sessions.commit(plan.sessionId, patch, plan.statePolicy);
              state = { kind: "committed", newVersion: committed.version };
            } catch (error) {
              // STATE_CONFLICT（版本过期）或其他补丁校验拒绝都映射为 rejected 并附原因。
              const posixloomError = asPosixLoomError(error, "STATE_PATCH_REJECTED");
              state = { kind: posixloomError.code === "STATE_CONFLICT" ? "rejected" : "rejected", reason: `${posixloomError.code}: ${posixloomError.message}` };
            }
          }
        }
      }
    } catch (error) {
      // 状态校验异常（STATE_CWD_INVALID / STATE_PROTOCOL_FAILED / 策略拒绝等）转为
      // 协议失败结果，不向上抛出--命令本身的输出与终态仍需正常返回。
      const posixloomError = asPosixLoomError(error, "STATE_PROTOCOL_FAILED");
      state = { kind: "protocol-failed", reason: `${posixloomError.code}: ${posixloomError.message}` };
    }
    return this.completedShellResult(plan, result, reason, started, command, state);
  }

  /** shell 路径最终的 CommandCompletion 组装：透传输出、命令终态、状态结果与 trace。 */
  private completedShellResult(plan: ShellExecutionPlan, result: ProcessRunResult, reason: string, started: number, command: CommandOutcome, state: StateOutcome): CommandCompletion {
    return {
      command,
      state,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      truncated: result.truncated,
      backend: "msys2",
      planId: plan.planId,
      trace: { commandId: plan.commandId, sessionId: plan.sessionId, snapshotId: plan.snapshotId, planId: plan.planId, backend: "msys2", reason, processMode: result.processMode, outcome: result.outcome, stateOutcome: state.kind, durationMs: Date.now() - started },
    };
  }

  /**
   * 空命令（空 argv / 空白文本）的完成结果：按"成功且无状态影响"处理，
   * 不创建进程与执行计划（planId 固定为 "empty"）。
   */
  private emptyCompletion(): CommandCompletion {
    return {
      command: { kind: "exited", exitCode: 0 },
      state: { kind: "not-applicable" },
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      backend: "msys2",
      planId: "empty",
      trace: { backend: "msys2", reason: "empty command" },
    };
  }
}
