/**
 * PosixLoom 配置加载与 Runtime 指针选择。
 *
 * 本模块是宿主进程的"启动期装配器"：把包内只读默认配置（config/defaults.json）与
 * 用户可写配置（<dataRoot>/config/config.json）深合并，一次性解析出三类信息：
 *   1. 数据目录（dataRoot）：所有可写状态（home/tmp/cache/logs/runtime/updates）的归宿；
 *   2. Runtime 版本（selectRuntime）：经三级指针链决定实际使用的 POSIX 运行时根目录；
 *   3. 规范化 RuntimeConfig：挂载表、会话/进程/策略/可观测性/更新等运行参数，
 *      所有数值与枚举均经校验并兜底默认值，下游消费方无需再做防御性判断。
 *
 * 设计意图：
 * - 便携优先：优先使用随包的 <runRoot>/data 作为数据目录，写探测失败才回退到
 *   %LOCALAPPDATA%\PosixLoom\data；POSIXLOOM_DATA_ROOT 环境变量提供显式覆盖（测试/高级部署）。
 *   这样"解压即用"（U 盘场景）与"安装到本机"（只读卷场景）都能工作。
 * - Runtime 指针是安全边界：指针文件内容会被拼进宿主路径，isSafeRuntimeId 用
 *   白名单正则拒绝路径分隔符与 ..，防止指针被篡改后造成路径穿越。
 * - 配置分层（包内默认 -> 用户覆盖 -> 环境变量）让默认值随软件包升级，
 *   用户配置只写关心的字段，避免全量拷贝导致升级后缺失新字段。
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PosixLoomError } from "./errors.js";
import type { PolicyProfile, RuntimeConfig, RuntimeSnapshot } from "./types.js";

// 包内只读默认配置的相对路径（相对 runRoot）。
const DEFAULT_CONFIG = "config/defaults.json";

/** 配置诊断所需的路径集；它不要求当前 Runtime 清单有效。 */
export interface ConfigPaths {
  runRoot: string;
  dataRoot: string;
  defaultConfigPath: string;
  userConfigPath: string;
}

/**
 * 递归深合并两个配置对象，右侧（用户配置）优先。
 * 嵌套普通对象逐层合并；数组与标量整体替换（数组语义是"覆盖"而非"拼接"，
 * 挂载表、策略根等列表都应整体生效）；undefined 字段视为未提供，不覆盖左侧。
 */
function deepMerge<T extends Record<string, any>>(left: T, right: Partial<T>): T {
  const output: Record<string, any> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object") {
      output[key] = deepMerge(output[key], value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}

/**
 * 读取 JSON 配置文件：文件不存在返回 undefined，让调用方区分"没有用户配置"
 * 与"配置损坏"；读取或解析失败抛 CONFIG_INVALID（携带路径与原因）——
 * 坏配置不应被静默吞掉后以默认值运行，那会掩盖用户意图。
 */
async function readJsonIfPresent(path: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw new PosixLoomError("CONFIG_INVALID", `Unable to read JSON config: ${path}`, { path, cause: String(error) });
  }
}

/**
 * 三级数据目录选择：POSIXLOOM_DATA_ROOT 环境变量 -> <runRoot>/data（便携式）->
 * %LOCALAPPDATA%\PosixLoom\data（本机回退，再退到 ~/.local/share）。
 * 环境变量分支信任用户显式指定（mkdir 后直接返回，失败即抛错）；
 * 便携分支必须通过写探测确认卷真正可写（U 盘写保护、权限受限等场景），
 * 探测失败静默降级到本机回退目录；回退目录探测失败才向上抛错。
 */
async function chooseDataRoot(runRoot: string): Promise<string> {
  const requested = process.env.POSIXLOOM_DATA_ROOT;
  if (requested) {
    await mkdir(requested, { recursive: true });
    return resolve(requested);
  }

  const portable = join(runRoot, "data");
  try {
    await probeWritableDirectory(portable);
    return portable;
  } catch {
    const base = process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
    const fallback = join(base, "PosixLoom", "data");
    await probeWritableDirectory(fallback);
    return fallback;
  }
}

/**
 * 解析当前进程实际使用的默认/用户配置路径。
 * 只执行 DataRoot 的既有可写性探测，不读取配置、Runtime 指针或 manifest，
 * 因此在配置损坏时仍可用于 `config path`。
 */
export async function resolveConfigPaths(runRoot: string): Promise<ConfigPaths> {
  const root = resolve(runRoot);
  const dataRoot = await chooseDataRoot(root);
  return {
    runRoot: root,
    dataRoot,
    defaultConfigPath: join(root, DEFAULT_CONFIG),
    userConfigPath: join(dataRoot, "config", "config.json"),
  };
}

/**
 * 写探测：在目录内以独占模式（wx）创建一个带 pid+UUID 的临时文件并强制落盘，
 * 证明目录"存在且真的可写"，而不只是 mkdir 成功。finally 中无论成败都清理
 * 探测文件，不在数据目录留下垃圾。
 */
async function probeWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const probe = join(directory, `.posixloom-write-probe-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(probe, "wx");
    await handle.writeFile("posixloom");
    await handle.sync();
  } finally {
    await handle?.close();
    await rm(probe, { force: true });
  }
}

/**
 * 展开挂载模板中的占位符：${runtime.workspace}/${WORKSPACE}、$RUNTIME_ROOT、
 * $DATA、$RUN。让配置文件可以引用"启动时才能确定的目录"（workspace、runtime 根、
 * 数据目录、软件包根），而无需硬编码绝对路径。
 */
function replaceVariables(value: string, runRoot: string, dataRoot: string, workspace: string, runtimeRoot: string): string {
  return value
    .replaceAll("${runtime.workspace}", workspace)
    .replaceAll("${WORKSPACE}", workspace)
    .replaceAll("$RUNTIME_ROOT", runtimeRoot)
    .replaceAll("$DATA", dataRoot)
    .replaceAll("$RUN", runRoot);
}

/**
 * loadConfig 的完整产物：除规范化配置 runtime 外，还携带解析出的目录布局与
 * runtime 选择结果，调用方无需重复探测文件系统。
 */
export interface LoadedConfig {
  /** 软件包根目录（含可执行文件与 defaults.json），只读。 */
  runRoot: string;
  /** 可写数据目录（home/tmp/cache/logs/runtime/updates 所在地）。 */
  dataRoot: string;
  /** 会话工作区（虚拟 /workspace 对应的宿主目录），默认取启动时 cwd。 */
  workspace: string;
  /** 选中的 runtime 标识，如 "posix-1.2.0" 或开发模式 "runtime-dev"。 */
  runtimeId: string;
  /** runtime 安装根目录（<dataRoot 或 runRoot>/runtime/versions/<runtimeId>）。 */
  runtimeRoot: string;
  /** runtime 来源："data"（用户安装）/ "bundled"（随包）/ "development"（源码开发模式）。 */
  runtimeSource: RuntimeSnapshot["source"];
  /** 指针读取中发现的问题（仅 allowInvalidRuntimePointer 模式下收集，非致命）。 */
  runtimePointerIssues: RuntimePointerIssue[];
  /** 深合并 + 校验 + 默认值兜底后的规范化运行时配置。 */
  runtime: RuntimeConfig;
}

/** 单条 runtime 指针问题（诊断用，不阻断启动）。 */
export interface RuntimePointerIssue {
  /** 指针文件路径。 */
  path: string;
  /** 指针文件中读到的原始内容（读不出字符串时缺省）。 */
  value?: string;
  /** 问题描述。 */
  message: string;
}

/**
 * 校验 runtime id 是否安全：首字符限字母/数字，其余限字母数字与 . _ -，长度 1..128。
 * 指针文件内容会被拼接进 `<根>/runtime/versions/<id>` 这样的宿主路径，此白名单
 * 排除了路径分隔符、空白与 ..，从源头阻断指针文件被篡改后的路径穿越。
 */
export function isSafeRuntimeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

/**
 * 读取 runtime 指针文件（内容为单个 runtime id，前后空白会被 trim）。
 * 文件不存在返回 undefined（表示该级指针未设置，走下一级）；
 * 内容不安全抛 RUNTIME_ID_INVALID；其余错误（如权限）原样上抛。
 */
async function readRuntimePointer(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (!isSafeRuntimeId(value)) throw new PosixLoomError("RUNTIME_ID_INVALID", `Invalid runtime id in pointer: ${path}`, { path, value });
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 三级指针链选择 runtime，返回 id、安装根目录、来源与指针问题列表：
 *   1. <dataRoot>/runtime/current —— 用户经更新器安装/切换的版本，优先级最高；
 *   2. <runRoot>/runtime/current —— 随包捆绑的版本；内容为 "runtime-dev" 时视为开发模式；
 *   3. 前两级指针均未命中时，兜底为 runRoot 下的 runtime-dev（源码开发模式）。
 *
 * allowInvalidPointer 为 true 时，指针读取失败不抛错，而是记入 pointerIssues
 * 并继续向下一级降级，让诊断/恢复工具在坏指针环境下仍能启动；
 * 降级过程中已收集的问题会随最终结果一并返回。
 */
async function selectRuntime(root: string, dataRoot: string, allowInvalidPointer: boolean): Promise<{
  id: string;
  root: string;
  source: RuntimeSnapshot["source"];
  pointerIssues: RuntimePointerIssue[];
}> {
  const pointerIssues: RuntimePointerIssue[] = [];
  // 指针读取的统一包装：失败时按 allowInvalidPointer 决定上抛，还是记录问题后降级。
  const read = async (path: string): Promise<string | undefined> => {
    try {
      return await readRuntimePointer(path);
    } catch (error) {
      if (!allowInvalidPointer) throw error;
      const posixloomError = error instanceof PosixLoomError ? error : new PosixLoomError("RUNTIME_POINTER_INVALID", String(error));
      pointerIssues.push({ path, value: typeof posixloomError.details.value === "string" ? posixloomError.details.value : undefined, message: posixloomError.message });
      return undefined;
    }
  };
  // 第一级：数据目录中的指针（更新器切换版本只改写这里）。
  const dataId = await read(join(dataRoot, "runtime", "current"));
  if (dataId) return { id: dataId, root: join(dataRoot, "runtime", "versions", dataId), source: "data", pointerIssues };
  // 第二级：随包捆绑的指针。
  const bundledId = await read(join(root, "runtime", "current"));
  if (bundledId) return { id: bundledId, root: join(root, "runtime", "versions", bundledId), source: bundledId === "runtime-dev" ? "development" : "bundled", pointerIssues };
  // 第三级：兜底开发模式，直接使用 runRoot 内的 runtime-dev 源码目录。
  return { id: "runtime-dev", root: join(root, "runtime", "versions", "runtime-dev"), source: "development", pointerIssues };
}

/**
 * 数值字段校验：undefined/null 取 fallback；必须有限、>= minimum（默认 1），
 * 且默认必须为整数（integer: false 可放宽为任意有限数）。
 * 非法值抛 CONFIG_INVALID，携带字段名与原值，便于定位配置问题。
 */
function positiveNumber(value: unknown, fallback: number, name: string, options: { integer?: boolean; minimum?: number } = {}): number {
  const number = Number(value ?? fallback);
  const minimum = options.minimum ?? 1;
  if (!Number.isFinite(number) || number < minimum || (options.integer !== false && !Number.isInteger(number))) {
    throw new PosixLoomError("CONFIG_INVALID", `${name} must be a finite ${options.integer === false ? "number" : "integer"} >= ${minimum}`, { name, value });
  }
  return number;
}

/** 严格布尔值校验；禁止把字符串 "false" 按 JavaScript 真值规则误解为 true。 */
function booleanValue(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new PosixLoomError("CONFIG_INVALID", `${name} must be a boolean`, { name, value });
  return value;
}

/** 严格枚举校验；只有缺省时才使用 fallback。 */
function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new PosixLoomError("CONFIG_INVALID", `${name} must be one of: ${allowed.join(", ")}`, { name, value });
  }
  return value as T;
}

/**
 * 策略根列表校验：每项必须是绝对虚拟路径（以 / 开头且不含反斜杠），
 * 否则抛 CONFIG_INVALID。结果去重，避免冗余根干扰后续前缀判定。
 */
function virtualRoots(value: unknown, fallback: string[], name: string): string[] {
  const roots = Array.isArray(value) ? value.map(String) : fallback;
  if (roots.some((root) => !root.startsWith("/") || root.includes("\\"))) {
    throw new PosixLoomError("CONFIG_INVALID", `${name} must contain absolute virtual paths`, { name, roots });
  }
  return [...new Set(roots)];
}

/**
 * 校验并补全单个策略 profile：mode 仅接受 trusted/guardrail，其余值视为未设置
 * 并继承 fallback；读写根强制走 virtualRoots 校验；runtimeReadOnly 显式布尔化，
 * 防止脏值（如字符串）被真值判断误判。
 */
function policyProfile(value: any, fallback: PolicyProfile, name: string): PolicyProfile {
  const mode = enumValue(value?.mode, ["trusted", "guardrail"] as const, fallback.mode, `${name}.mode`);
  return {
    mode,
    knownReadRoots: virtualRoots(value?.knownReadRoots, fallback.knownReadRoots, `${name}.knownReadRoots`),
    knownWriteRoots: virtualRoots(value?.knownWriteRoots, fallback.knownWriteRoots, `${name}.knownWriteRoots`),
    runtimeReadOnly: booleanValue(value?.runtimeReadOnly, fallback.runtimeReadOnly, `${name}.runtimeReadOnly`),
  };
}

/**
 * 加载并组装完整配置（本模块主入口）。
 *
 * 流程：确定 dataRoot（chooseDataRoot 三级策略）-> 读取包内默认配置 defaults.json
 * （缺失视为打包损坏，抛 CONFIG_MISSING）-> 读取用户配置 <dataRoot>/config/config.json
 * 并深合并 -> 解析 workspace -> 经三级指针链选定 runtime -> 展开挂载模板变量 ->
 * 逐字段校验并填充默认值，产出规范化 RuntimeConfig -> 最后确保 dataRoot 目录骨架存在。
 *
 * 注意副作用：本函数会创建/探测目录（dataRoot 及其子目录），并非纯读取操作。
 *
 * @param runRoot PosixLoom 软件包根目录（含可执行文件与 config/defaults.json）
 * @param options.allowInvalidRuntimePointer 为 true 时坏指针不抛错，而是降级并记录到
 *        runtimePointerIssues，供诊断工具在异常环境下仍能启动
 * @returns 目录布局、runtime 选择结果与规范化后的运行时配置
 * @throws CONFIG_MISSING 默认配置缺失；CONFIG_INVALID JSON 损坏或字段非法；
 *         RUNTIME_ID_INVALID / RUNTIME_POINTER_INVALID 指针非法（未开启容错时）
 */
export async function loadConfig(runRoot: string, options: { allowInvalidRuntimePointer?: boolean } = {}): Promise<LoadedConfig> {
  const paths = await resolveConfigPaths(runRoot);
  const root = paths.runRoot;
  const dataRoot = paths.dataRoot;
  const defaults = await readJsonIfPresent(paths.defaultConfigPath);
  if (!defaults) throw new PosixLoomError("CONFIG_MISSING", `Missing default config: ${paths.defaultConfigPath}`);

  // 用户配置与默认配置深合并：嵌套对象逐层合并，数组与标量整体覆盖。
  const userConfig = await readJsonIfPresent(paths.userConfigPath);
  // 0.1 曾经公开过但从未实现 persistAcrossRestart。对 true 必须显式拒绝，
  // 不能继续静默地以内存会话运行；false 只表达当前已有的进程内语义，
  // 为了兼容早期整份拷贝的配置而暂时接受，但不进入规范化配置。
  const legacyPersistence = userConfig?.session?.persistAcrossRestart;
  if (legacyPersistence !== undefined && legacyPersistence !== false) {
    throw new PosixLoomError(
      "CONFIG_UNSUPPORTED",
      "session.persistAcrossRestart is not supported; sessions are process-local",
      { path: paths.userConfigPath, name: "session.persistAcrossRestart", value: legacyPersistence },
    );
  }
  const merged = deepMerge(defaults, userConfig ?? {});
  for (const section of ["runtime", "mounts", "session", "process", "policy", "observability", "updates"] as const) {
    const value = merged[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PosixLoomError("CONFIG_INVALID", `${section} must be an object`, { name: section, value });
    }
  }
  // workspace 优先级：POSIXLOOM_WORKSPACE 环境变量 > 配置 runtime.workspace > 启动 cwd；
  // 配置值中的 ${WORKSPACE} 占位符在此展开为当前 cwd。
  const configuredWorkspace = merged.runtime?.workspace;
  if (configuredWorkspace !== undefined && typeof configuredWorkspace !== "string") {
    throw new PosixLoomError("CONFIG_INVALID", "runtime.workspace must be a string", { name: "runtime.workspace", value: configuredWorkspace });
  }
  const workspaceValue = process.env.POSIXLOOM_WORKSPACE ?? configuredWorkspace ?? process.cwd();
  const workspace = resolve(workspaceValue.replace("${WORKSPACE}", process.cwd()));
  const selected = await selectRuntime(root, dataRoot, Boolean(options.allowInvalidRuntimePointer));
  const runtimeRoot = selected.root;
  // 挂载模板可能引用 $DATA/$RUN/$RUNTIME_ROOT/${WORKSPACE}，
  // 必须等 workspace 与 runtimeRoot 都解析完成后才能展开。
  if (!merged.mounts || typeof merged.mounts !== "object" || Array.isArray(merged.mounts)) {
    throw new PosixLoomError("CONFIG_INVALID", "mounts must be an object", { name: "mounts", value: merged.mounts });
  }
  const mounts: Record<string, string> = {};
  for (const [virtualPath, hostTemplate] of Object.entries(merged.mounts ?? {})) {
    if (typeof hostTemplate !== "string") throw new PosixLoomError("CONFIG_INVALID", `mounts.${virtualPath} must be a string`, { name: `mounts.${virtualPath}`, value: hostTemplate });
    mounts[virtualPath] = replaceVariables(hostTemplate, root, dataRoot, workspace, runtimeRoot);
  }

  const runtime: RuntimeConfig = {
    version: positiveNumber(merged.version, 1, "version"),
    runtime: { workspace },
    mounts,
    // 会话状态策略仅认显式 "isolated"，其余一律回落默认 "cwd-env"。
    session: {
      defaultStatePolicy: enumValue(merged.session?.defaultStatePolicy, ["isolated", "cwd-env"] as const, "cwd-env", "session.defaultStatePolicy"),
    },
    // 进程默认约束：超时 30s、取消宽限 2s、输出上限 8MB，均可被配置覆盖。
    process: {
      defaultTimeoutMs: positiveNumber(merged.process?.defaultTimeoutMs, 30000, "process.defaultTimeoutMs"),
      cancelGraceMs: positiveNumber(merged.process?.cancelGraceMs, 2000, "process.cancelGraceMs", { minimum: 0 }),
      maxOutputBytes: positiveNumber(merged.process?.maxOutputBytes, 8 * 1024 * 1024, "process.maxOutputBytes"),
    },
    // 默认 profile 为 workspace-guard（runtime 只读，读写限定在已知虚拟根内）；
    // trusted 需显式指定，且默认不设任何已知根（即无额外放行）。
    policy: {
      defaultProfile: enumValue(merged.policy?.defaultProfile, ["trusted", "workspace-guard"] as const, "workspace-guard", "policy.defaultProfile"),
      profiles: {
        trusted: policyProfile(merged.policy?.profiles?.trusted, { mode: "trusted", knownReadRoots: [], knownWriteRoots: [], runtimeReadOnly: false }, "policy.profiles.trusted"),
        "workspace-guard": policyProfile(merged.policy?.profiles?.["workspace-guard"], { mode: "guardrail", knownReadRoots: ["/workspace", "/home", "/tmp", "/cache", "/posixloom"], knownWriteRoots: ["/workspace", "/home", "/tmp", "/cache"], runtimeReadOnly: true }, "policy.profiles.workspace-guard"),
      },
    },
    observability: {
      traceBufferSize: positiveNumber(merged.observability?.traceBufferSize, 5000, "observability.traceBufferSize", { minimum: 0 }),
      writeTraceFile: booleanValue(merged.observability?.writeTraceFile, false, "observability.writeTraceFile"),
    },
    // 更新默认启用、默认自动应用并强制签名校验；channel/feedUrl 可被环境变量覆盖
    // （便于测试与私有更新源）。下载上限默认 2GB，防恶意超大包撑爆磁盘。
    updates: {
      enabled: booleanValue(merged.updates?.enabled, true, "updates.enabled"),
      autoApply: booleanValue(merged.updates?.autoApply, true, "updates.autoApply"),
      channel: String(process.env.POSIXLOOM_UPDATE_CHANNEL ?? merged.updates?.channel ?? "stable"),
      feedUrl: String(process.env.POSIXLOOM_UPDATE_FEED_URL ?? merged.updates?.feedUrl ?? "").trim() || undefined,
      checkIntervalMs: positiveNumber(merged.updates?.checkIntervalMs, 86_400_000, "updates.checkIntervalMs", { minimum: 0 }),
      requestTimeoutMs: positiveNumber(merged.updates?.requestTimeoutMs, 10_000, "updates.requestTimeoutMs"),
      maxDownloadBytes: positiveNumber(merged.updates?.maxDownloadBytes, 2_147_483_648, "updates.maxDownloadBytes"),
      requireSignature: booleanValue(merged.updates?.requireSignature, true, "updates.requireSignature"),
      trustedKeys: Object.fromEntries(Object.entries(merged.updates?.trustedKeys ?? {}).map(([key, value]) => [key, String(value)])),
    },
  };

  // 副作用：确保数据目录骨架（home/tmp/cache/logs/runtime/updates）存在。
  // 默认挂载把这些虚拟路径指到 dataRoot 下，目录缺失会让后续 IO 直接失败。
  await Promise.all([
    mkdir(join(dataRoot, "home"), { recursive: true }),
    mkdir(join(dataRoot, "tmp"), { recursive: true }),
    mkdir(join(dataRoot, "cache"), { recursive: true }),
    mkdir(join(dataRoot, "logs"), { recursive: true }),
    mkdir(join(dataRoot, "runtime", "versions"), { recursive: true }),
    mkdir(join(dataRoot, "runtime", "staging"), { recursive: true }),
    mkdir(join(dataRoot, "updates"), { recursive: true }),
  ]);

  return {
    runRoot: root,
    dataRoot,
    workspace,
    runtimeId: selected.id,
    runtimeRoot: selected.root,
    runtimeSource: selected.source,
    runtimePointerIssues: selected.pointerIssues,
    runtime,
  };
}

/**
 * 判断字符串是否为宿主（Windows）侧绝对路径：node:path 的 isAbsolute、盘符形式
 * （C:\ 或 C:/），或 UNC 前缀 \\。用于区分用户直接传入的宿主路径与虚拟路径
 * （虚拟路径一律以单个 / 开头，UNC 虚拟形式为 //server/share）。
 */
export function isHostAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
