/**
 * env.ts -- 会话环境变量的生命周期管理。
 *
 * 职责：
 * 覆盖环境变量从用户输入 delta 到最终注入子进程的全链路：键名规范化与
 * 合法性校验、Windows 大小写不敏感碰撞检测、差量合并、native/msys2 两套
 * 后端视图的环境构建、以及命令结束后只保留用户可变键的状态回写校验。
 *
 * 设计意图：
 * - 环境变量按“归属权”分级（EnvMutationClass）而非一视同仁地透传：
 *   runtime-immutable（POSIXLOOM_* 协议变量，运行时的身份标识与状态管道）、
 *   backend-controlled（MSYS 路径转换开关，由后端行为决定）、
 *   runtime-derived（HOME/TMP/PWD/SHELL 等由运行时按视图派生）、
 *   user-mutable（用户可自由增删改）。分级的意义在于：状态回写
 *   （diffExportedEnv / validateStatePatch）只接受用户层改动，防止 shell
 *   进程把 HOME、POSIXLOOM_* 等运行时赖以工作的变量改写进持久化状态。
 * - PATH 单列为 special-policy：它既不是纯用户变量，也不允许整体替换，
 *   只能在完整保留 /posixloom/bin:/usr/bin 前缀的前提下扩展（validateSessionPath），
 *   否则命令解析会退化为宿主 PATH 语义，运行时自带的命令将不可达。
 * - msys2 后端强制 MSYS2_ARG_CONV_EXCL=* / MSYS2_ENV_CONV_EXCL=*：
 *   MSYS 会把 POSIX 风格的参数与环境值自动改写成 Windows 路径，破坏以
 *   虚拟路径为输入的命令语义，因此整体禁用，路径翻译交由 PosixLoom 自己的
 *   路径决策层完成。
 */
import { PosixLoomError } from "./errors.js";
import type { SessionState, StatePatch, StatePolicy } from "./types.js";

/** 运行时不可变：POSIXLOOM_* 协议变量（运行时根、命令体、状态/报告管道等），任何来源都不得改写。 */
const RUNTIME_IMMUTABLE = new Set([
  "POSIXLOOM_RUNTIME_ROOT",
  "POSIXLOOM_COMMAND_BODY",
  "POSIXLOOM_COMMAND_ID",
  "POSIXLOOM_SESSION_ID",
  "POSIXLOOM_STATE_FD",
  "POSIXLOOM_REPORT_FD",
  "POSIXLOOM_STATE_REPORT_PATH",
]);
/** 后端受控：MSYS 路径/环境转换开关，取值由运行时按后端统一决定，不接受用户覆盖。 */
const BACKEND_CONTROLLED = new Set(["MSYS2_ARG_CONV_EXCL", "MSYS2_ENV_CONV_EXCL", "MSYS_NO_PATHCONV"]);
/** 运行时派生：HOME/TMP/PWD/SHELL 等随会话视图（native/posix）变化的变量，不进入持久化状态。 */
const RUNTIME_DERIVED = new Set(["HOME", "TMP", "TMPDIR", "PWD", "SHELL", "POSIXLOOM_RUNTIME", "HOST_PLATFORM", "RUNTIME_PLATFORM"]);

/**
 * 环境变量变更分级（约束力度从松到紧）：
 * - user-mutable: 用户可自由增删改，可持久化；
 * - runtime-derived: 运行时按视图派生，禁止写入持久状态；
 * - runtime-immutable: 运行时协议变量，任何来源都不可改；
 * - backend-controlled: 由后端（MSYS）行为决定，用户不可覆盖；
 * - special-policy: PATH，只允许在保留前缀的前提下修改。
 */
export type EnvMutationClass = "user-mutable" | "runtime-derived" | "runtime-immutable" | "backend-controlled" | "special-policy";

/**
 * 校验并规范化环境变量键名。
 *
 * 键名必须符合 POSIX 标识符规则（字母/下划线开头）；放宽模式（allowHostName）
 * 仅要求不含 "=" 与 NUL，用于接受宿主进程携带的非 POSIX 变量名。
 * Windows 环境变量大小写不敏感，统一转为大写作为规范形态。
 *
 * @param key 原始键名
 * @param allowHostName 是否放宽键名规则（接受宿主键名）
 * @returns 全大写规范化后的键名
 * @throws {PosixLoomError} ENV_KEY_INVALID -- 键名不符合对应规则
 */
export function canonicalEnvKey(key: string, allowHostName = false): string {
  const valid = allowHostName ? /^[^=\0]+$/.test(key) : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
  if (!valid) throw new PosixLoomError("ENV_KEY_INVALID", `Invalid environment key: ${key}`);
  return key.toUpperCase();
}

/**
 * 判定键名所属的变更分级。
 * 匹配顺序：PATH 单列 -> 运行时不可变 -> 后端受控 -> 运行时派生 -> 用户可变。
 *
 * @param key 环境变量键名（任意大小写）
 * @returns 对应的 EnvMutationClass 分级
 */
export function envMutationClass(key: string): EnvMutationClass {
  const canonical = key.toUpperCase();
  // 逐级判定：PATH 优先单列，其余按归属权集合匹配，默认为用户可变
  if (canonical === "PATH") return "special-policy";
  if (RUNTIME_IMMUTABLE.has(canonical)) return "runtime-immutable";
  if (BACKEND_CONTROLLED.has(canonical)) return "backend-controlled";
  if (RUNTIME_DERIVED.has(canonical)) return "runtime-derived";
  return "user-mutable";
}

/**
 * 规范化整张环境表：丢弃 undefined 值、键名大写化，并检测大小写碰撞。
 *
 * Windows 环境变量大小写不敏感：若同时保留 "Path" 与 "PATH" 两个键，
 * 子进程实际取值取决于实现细节（而非声明顺序），属于未定义行为，
 * 因此检测到同一规范键对应多种原始拼写时直接报 ENV_KEY_COLLISION，
 * 而不是静默合并任取其一。
 *
 * @param input 原始环境表（值为 undefined 的条目视为不存在）
 * @param allowHostNames 是否放宽键名规则（见 canonicalEnvKey）
 * @returns 键名全大写的干净环境表
 * @throws {PosixLoomError} ENV_KEY_INVALID / ENV_KEY_COLLISION
 */
export function normalizeEnv(input: Record<string, string | undefined>, allowHostNames = false): Record<string, string> {
  const output: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const canonical = canonicalEnvKey(key, allowHostNames);
    // 碰撞检测：同一规范键此前以不同拼写出现过即拒绝
    const prior = seen.get(canonical);
    if (prior && prior !== key) throw new PosixLoomError("ENV_KEY_COLLISION", `Environment keys collide on Windows: ${prior} / ${key}`);
    seen.set(canonical, key);
    output[canonical] = value;
  }
  return output;
}

/**
 * 在 base 之上应用一次性环境 delta，返回新的环境表（不改入参）。
 * 先规范化 base，再逐键规范化合并 delta；delta 值为 null 表示删除该键。
 *
 * @param base 基础环境表
 * @param delta 环境增量（值为 null 表示删除）
 * @returns 合并后的规范化环境表
 * @throws {PosixLoomError} ENV_KEY_INVALID -- delta 含非法键名
 */
export function applyEnvDelta(base: Record<string, string>, delta: Record<string, string | null> = {}): Record<string, string> {
  const output = { ...normalizeEnv(base) };
  for (const [key, value] of Object.entries(delta)) {
    const canonical = canonicalEnvKey(key);
    if (value === null) delete output[canonical];
    else output[canonical] = value;
  }
  return output;
}

/**
 * 构建 native（Windows 宿主）后端的子进程环境。
 *
 * 流程：校验 delta 不得删除 PATH -> 合并导出环境与 delta -> 校验合并后
 * PATH 保留必需前缀 -> 以宿主 process.env（放宽键名规则）为底、用户导出
 * 环境覆盖其上 -> 强制注入运行时派生变量（HOME 指向 DataRoot\home、TMP/
 * TMPDIR 指向 DataRoot\tmp、PWD 为宿主 cwd、POSIXLOOM_* 标识）-> PATH 由
 * runtimeRoot 下各组件目录重合成（组件优先，见 nativePath）。
 * 用户侧 PATH 会被丢弃（delete merged.PATH），不会透传给 native 子进程，
 * 避免宿主 PATH 遮蔽运行时自带组件。
 *
 * @param state 会话状态（提供 exportedEnv 基线）
 * @param delta 本次命令的环境增量
 * @param runtimeRoot RuntimeRoot 宿主路径
 * @param dataRoot DataRoot 宿主路径（派生 HOME/TMP 的基点）
 * @param cwdHost 命令的宿主工作目录（作为 PWD）
 * @returns 传给 native 子进程的环境表
 * @throws {PosixLoomError} STATE_PATCH_REJECTED -- PATH 被删除或前缀被破坏
 * @throws {PosixLoomError} ENV_KEY_INVALID / ENV_KEY_COLLISION -- 键名非法或碰撞
 */
export function buildNativeEnv(
  state: SessionState,
  delta: Record<string, string | null> | undefined,
  runtimeRoot: string,
  dataRoot: string,
  cwdHost: string,
): Record<string, string> {
  validatePathDelta(delta);
  const merged = applyEnvDelta(state.exportedEnv, delta);
  validateSessionPath(merged.PATH);
  // native 视图不透传用户 PATH，改由 nativePath 以 RuntimeRoot 组件优先重合成
  delete merged.PATH;
  const native = { ...normalizeEnv(process.env, true), ...merged };
  native.HOME = `${dataRoot}\\home`;
  native.TMP = `${dataRoot}\\tmp`;
  native.TMPDIR = native.TMP;
  native.PWD = cwdHost;
  native.POSIXLOOM_RUNTIME_ROOT = runtimeRoot;
  native.POSIXLOOM_RUNTIME = "portable-posix";
  native.HOST_PLATFORM = "win32";
  native.RUNTIME_PLATFORM = "posix-win32";
  native.PATH = nativePath(runtimeRoot);
  return native;
}

/**
 * 构建 msys2（POSIX）后端的子进程环境。
 *
 * 与 native 视图的关键差异：HOME/TMP 使用 POSIX 根（/home、/tmp）、PWD 取
 * 虚拟 cwd、SHELL 固定为 /posixloom/bin/bash、PATH 以 /posixloom/bin:/usr/bin 为默认值
 * （允许在保留前缀的前提下扩展）。核心约束是强制
 * MSYS2_ARG_CONV_EXCL=* 与 MSYS2_ENV_CONV_EXCL=*：禁用 MSYS 对参数与
 * 环境值的自动路径改写（POSIX -> Windows），因为改写会破坏虚拟路径语义，
 * 路径翻译必须由 PosixLoom 的路径决策层统一完成。
 *
 * @param state 会话状态（提供 exportedEnv 基线）
 * @param delta 本次命令的环境增量
 * @param runtimeRoot RuntimeRoot 宿主路径（以 POSIXLOOM_RUNTIME_ROOT 透传供脚本自寻位）
 * @param dataRoot DataRoot 宿主路径（POSIX 视图不使用，仅为保持与 buildNativeEnv 对称的签名）
 * @param cwdVirtual 命令的虚拟工作目录（作为 PWD）
 * @returns 传给 msys2 子进程的环境表
 * @throws {PosixLoomError} STATE_PATCH_REJECTED -- PATH 被删除或前缀被破坏
 * @throws {PosixLoomError} ENV_KEY_INVALID / ENV_KEY_COLLISION -- 键名非法或碰撞
 */
export function buildPosixEnv(
  state: SessionState,
  delta: Record<string, string | null> | undefined,
  runtimeRoot: string,
  dataRoot: string,
  cwdVirtual: string,
): Record<string, string> {
  validatePathDelta(delta);
  const merged = applyEnvDelta(state.exportedEnv, delta);
  validateSessionPath(merged.PATH);
  const posix = { ...merged };
  posix.HOME = "/home";
  posix.TMP = "/tmp";
  posix.TMPDIR = "/tmp";
  posix.PWD = cwdVirtual;
  posix.PATH = merged.PATH ?? "/posixloom/bin:/usr/bin";
  posix.SHELL = "/posixloom/bin/bash";
  posix.POSIXLOOM_RUNTIME_ROOT = runtimeRoot;
  posix.POSIXLOOM_RUNTIME = "portable-posix";
  posix.HOST_PLATFORM = "win32";
  posix.RUNTIME_PLATFORM = "posix-win32";
  // 禁用 MSYS 的参数/环境自动路径改写，路径翻译由 PosixLoom 路径决策层负责
  posix.MSYS2_ARG_CONV_EXCL = "*";
  posix.MSYS2_ENV_CONV_EXCL = "*";
  void dataRoot;
  return posix;
}

/**
 * 求执行前后环境表的差量，仅保留允许持久化的键（user-mutable 与 PATH）。
 *
 * 运行时派生/不可变/后端受控键的取值差异是“视图差异”而非用户意图，
 * 不允许写入 StatePatch；不符合 POSIX 标识符规则的键名直接忽略，
 * 防止宿主残留的怪异键名污染会话状态。
 *
 * @param before 执行前的会话导出环境（exportedEnv）
 * @param after 执行后子进程报告的环境
 * @returns StatePatch 的 setEnv/removeEnv 片段（setEnv 仅含值有变化的键）
 */
export function diffExportedEnv(before: Record<string, string>, after: Record<string, string>): Pick<StatePatch, "setEnv" | "removeEnv"> {
  const setEnv: Record<string, string> = {};
  const removeEnv: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const canonical = canonicalEnvKey(key);
    if (envMutationClass(canonical) === "user-mutable" || canonical === "PATH") {
      if (before[canonical] !== value) setEnv[canonical] = value;
    }
  }
  for (const key of Object.keys(before)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const canonical = canonicalEnvKey(key);
    if (!(canonical in after) && (envMutationClass(canonical) === "user-mutable" || canonical === "PATH")) removeEnv.push(canonical);
  }
  return { setEnv, removeEnv };
}

/**
 * 校验状态补丁能否提交到会话状态（乐观锁 + 变更分级双校验）。
 *
 * isolated 策略下无共享状态，直接放行；否则要求：
 * 1) patch.baseStateVersion 必须等于当前 state.version（乐观锁：基于过期
 *    版本生成的补丁一律拒绝，防止并发命令相互覆盖）；
 * 2) setEnv/removeEnv 不得触及 runtime-immutable / backend-controlled /
 *    runtime-derived 键（这些不属于用户可提交的改动）；
 * 3) PATH 不可删除；若 setEnv 中出现 PATH，必须通过 validateSessionPath
 *    的前缀校验。
 *
 * @param patch 待提交的状态补丁
 * @param state 当前会话状态
 * @param policy 会话状态策略（isolated | cwd-env）
 * @throws {PosixLoomError} STATE_CONFLICT -- 补丁基于过期的状态版本
 * @throws {PosixLoomError} STATE_PATCH_REJECTED -- 触及受限键、删除 PATH 或 PATH 前缀不合法
 */
export function validateStatePatch(patch: StatePatch, state: SessionState, policy: StatePolicy): void {
  if (policy === "isolated") return;
  if (patch.baseStateVersion !== state.version) throw new PosixLoomError("STATE_CONFLICT", "StatePatch base version is stale", { expected: state.version.toString(), actual: patch.baseStateVersion.toString() });
  for (const key of [...Object.keys(patch.setEnv), ...patch.removeEnv]) {
    const mutation = envMutationClass(key);
    if (mutation === "runtime-immutable" || mutation === "backend-controlled" || mutation === "runtime-derived") {
      throw new PosixLoomError("STATE_PATCH_REJECTED", `Environment key cannot be committed: ${key}`, { key, mutation });
    }
  }
  if (patch.removeEnv.some((key) => canonicalEnvKey(key) === "PATH")) throw new PosixLoomError("STATE_PATCH_REJECTED", "PATH cannot be removed");
  const pathEntry = Object.entries(patch.setEnv).find(([key]) => canonicalEnvKey(key) === "PATH");
  validateSessionPath(pathEntry?.[1]);
}

/**
 * 构建会话初始 exportedEnv：继承宿主进程环境（剔除 PATH 与非 POSIX 键名），
 * 并把 PATH 重置为最小 POSIX 前缀 /posixloom/bin:/usr/bin，保证新会话的命令
 * 解析不依赖宿主 PATH。
 */
export function initialSessionEnv(): Record<string, string> {
  const posixEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "PATH" && value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) posixEnv[key] = value;
  }
  return { ...normalizeEnv(posixEnv), PATH: "/posixloom/bin:/usr/bin" };
}

/**
 * 校验会话 PATH 的形状：必须恰好等于或以 "/posixloom/bin:/usr/bin" 开头
 * （两个条目必须完整保留、顺序固定），且按 ":" 切分后不含空段
 * （空段意味着出现 "::" 或首尾多余的 ":"，会被 shell 展开为当前目录）。
 *
 * @param value 待校验的 PATH；undefined 表示未提供，直接放行
 * @throws {PosixLoomError} STATE_PATCH_REJECTED -- 前缀被破坏或存在空段
 */
function validateSessionPath(value: string | undefined): void {
  if (value === undefined) return;
  const required = "/posixloom/bin:/usr/bin";
  if ((value !== required && !value.startsWith(`${required}:`)) || value.split(":").some((entry) => entry.length === 0)) {
    throw new PosixLoomError("STATE_PATCH_REJECTED", "PATH must preserve complete /posixloom/bin and /usr/bin entries and cannot contain an empty segment");
  }
}

/**
 * 校验命令级 env delta：不允许通过 null（删除）的方式去掉 PATH，
 * 因为删除 PATH 等价于破坏运行时命令解析的前缀前提。
 *
 * @param delta 命令的环境增量
 * @throws {PosixLoomError} STATE_PATCH_REJECTED -- delta 试图删除 PATH
 */
function validatePathDelta(delta: Record<string, string | null> | undefined): void {
  if (!delta) return;
  for (const [key, value] of Object.entries(delta)) {
    if (canonicalEnvKey(key) === "PATH" && value === null) throw new PosixLoomError("STATE_PATCH_REJECTED", "PATH cannot be removed");
  }
}

/**
 * 合成 native 后端的 PATH：RuntimeRoot 下各组件目录（node、mingit、rg、
 * msys/usr/bin）置于最前，宿主 process.env.PATH 追加其后；逐条按小写
 * 去重并过滤空段，保证运行时自带组件始终优先解析，同时宿主工具仍可达。
 *
 * @param runtimeRoot RuntimeRoot 宿主路径
 * @returns 以 ";" 连接的 Windows PATH
 */
function nativePath(runtimeRoot: string): string {
  // 运行时组件目录优先，宿主 PATH 兜底；split/flatMap 展开所有条目后过滤空串
  const entries = [
    `${runtimeRoot}\\node`,
    `${runtimeRoot}\\native\\mingit\\cmd`,
    `${runtimeRoot}\\native\\rg`,
    `${runtimeRoot}\\msys\\usr\\bin`,
    process.env.PATH ?? "",
  ].flatMap((entry) => entry.split(";")).filter(Boolean);
  // Windows 路径大小写不敏感，按小写形式去重
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(";");
}
