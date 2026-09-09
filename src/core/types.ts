/**
 * =============================================================================
 * PosixLoom 核心类型字典（纯类型契约，本文件不含任何运行时逻辑）
 * =============================================================================
 *
 * 【职责】
 * 为 core/ 下所有模块（config / path / policy / env / session / trace /
 * classifier / registry / runtime / updater / control / process / service）
 * 提供统一的数据结构词汇表：路径、命令、运行时、执行计划、会话状态与执行
 * 结果都只在此处定义一次，避免各模块自行定义导致契约漂移。
 *
 * 【设计意图（为什么这样设计）】
 *
 * 1. 路径双轨制（VirtualPath / HostPath）
 *    用户命令、cwd 与策略根工作在 POSIX 风格的"虚拟命名空间"中；真正 spawn
 *    进程时才需要 Windows 宿主路径。两条轨道用类型别名在编译期区分"业务侧
 *    输入"与"执行侧输出"，所有翻译必须经过 MountTable（path.ts），从源头
 *    杜绝把宿主路径混入虚拟命名空间。
 *
 * 2. 判别联合（CommandInput / ExecutionPlan / CommandOutcome / StateOutcome）
 *    以 kind / mode 字段做编译期判别：调用方必须先收窄类型才能访问分支专属
 *    字段，switch 分支不全时编译器直接报错。因此命令五态终态与状态五态
 *    结果都能被穷尽处理，不会漏掉某个分支。
 *
 * 3. PathDecision 做参数级路径审计
 *    每个被识别为路径的命令行参数都单独留下"词法判定 + 物理校验"证据：
 *    词法层只看字符串（可能被符号链接 / TOCTOU 欺骗），物理层在 realpath
 *    归一化后比对允许根。参数级粒度让"哪个参数被翻译成了什么、为何放行或
 *    拒绝"可逐条复核，也是策略拒绝错误的 details 来源。
 *
 * 4. RuntimeSnapshot 不可变
 *    snapshotId 由 runtimeId + manifestHash + registryHash + pluginsHash +
 *    mountsHash + policyHash 六要素复合哈希合成；任一要素变化都会得到全新的快照 id。
 *    ExecutionPlan 携带 snapshotId 即锁定"计划基于哪份运行时指纹生成"，
 *    命令执行期间的运行时热更新 / 篡改因此可被精确检测。
 *
 * 5. 会话状态乐观锁（baseStateVersion 使用 bigint）
 *    状态版本号使用 bigint，避免长会话中 number 的 2^53 精度边界；StatePatch
 *    与 ShellExecutionPlan 均携带 baseStateVersion，提交时与当前版本做 CAS
 *    比对，不一致即抛 STATE_CONFLICT，保证并发命令不会静默覆盖彼此写出的
 *    cwd / 导出环境。
 *
 * 【与相邻模块的关系】
 * - config.ts / runtime.ts 读取并校验 RuntimeConfig / RuntimeManifest，并合成
 *   RuntimeSnapshot；
 * - classifier.ts 产出 ClassifiedCommand，registry.ts 据此产出
 *   ResolutionTemplate（内含 PathDecision 审计记录）；
 * - service.ts 组装 ExecutionPlan，执行后返回 CommandCompletion；
 * - env.ts / session.ts 消费 SessionState / StatePatch 并产出 StateOutcome。
 */

/** 虚拟路径：POSIX 风格路径（以 "/" 开头，如 "/workspace/src"），是面向用户命令与策略的命名空间。 */
export type VirtualPath = string;
/** 宿主路径：真实 Windows 文件系统路径（如 "D:\posixloom\runtime\node\node.exe"），仅出现在路径翻译与进程执行层。 */
export type HostPath = string;

/**
 * 命令四级分类（classifier.ts 的 classify 产物），决定命令走哪条执行路线：
 * - "simple"          无 shell 语法的纯 argv 命令，优先匹配原生注册表走 native 后端；
 * - "builtin"         shell 内建（cd / export / unset / source 等），必须交给 bash 解释；
 * - "shell-required"  含管道、重定向、变量展开、glob 或 shell 关键字，无法安全拆分为
 *                     argv，必须经 bash 解释；
 * - "explicit-shell"  用户显式调用 shell（如 bash -c "..." 或执行 .sh 脚本），命令体
 *                     原样透传给 bash，不做 argv 级改写。
 * 分级的目的：能绕开 MSYS2 的命令尽量绕开（进程边界清晰、输出可控、免二次路径
 * 转换），只有真正依赖 shell 语义的命令才落入 msys2 后端。
 */
export type CommandKind = "simple" | "builtin" | "shell-required" | "explicit-shell";

/**
 * 执行后端双轨："native" 直接 spawn Windows 可执行文件（参数经适配器翻译）；
 * "msys2" 通过 MSYS2 Bash 解释执行（命令体经 stdin 脚本注入）。
 */
export type Backend = "native" | "msys2";

/**
 * 会话状态回写策略：
 * - "isolated" 命令执行后不回写会话状态（cwd 与导出环境保持不变，适合一次性任务）；
 * - "cwd-env"  依据命令产出的 StateReport 回写 cwd 与导出环境（模拟交互式 shell
 *              的持久效果）。
 * 每个会话可独立选择，RuntimeConfig.session.defaultStatePolicy 提供默认值。
 */
export type StatePolicy = "isolated" | "cwd-env";

/** 伪终端视口大小，单位为字符单元。 */
export interface TerminalSize {
  columns: number;
  rows: number;
}

/** 一条虚拟到宿主的挂载映射，是 MountTable（path.ts）的最小组成单元。 */
export interface MountSpec {
  /** 虚拟侧挂载点（POSIX 绝对路径，如 "/workspace"）。 */
  virtualPath: VirtualPath;
  /** 宿主侧真实目录（Windows 绝对路径）。 */
  hostPath: HostPath;
}

/**
 * PosixLoom 运行时配置：config/defaults.json 与用户配置深度合并后的规范化形态，
 * 由 config.ts 加载并校验。共六大配置块：runtime/mounts（运行时与挂载）、
 * session（会话）、process（进程）、policy（策略）、observability（可观测
 * 性）、updates（更新）。
 */
export interface RuntimeConfig {
  /** 配置结构版本号，供将来配置演进时做兼容性判定。 */
  version: number;
  /** 工作区块：workspace 为默认挂载到 /workspace 的宿主目录（可被 POSIXLOOM_WORKSPACE 覆盖）。 */
  runtime: { workspace: string };
  /** 挂载表：虚拟挂载点 -> 宿主目录；值支持 $RUNTIME_ROOT / $DATA / $RUN 等变量替换。 */
  mounts: Record<string, string>;
  /** 会话块：默认状态策略与进程内会话资源边界。 */
  session: {
    /** 新建会话默认使用的 StatePolicy。 */
    defaultStatePolicy: StatePolicy;
    /** 单个服务进程最多保留的会话数。 */
    maxSessions: number;
    /** 会话无活动多久后可被回收（毫秒）。 */
    idleTimeoutMs: number;
  };
  /** 进程块：超时、取消宽限与数据限额，构成命令执行的资源安全边界。 */
  process: {
    maxConcurrent: number;
    maxConcurrentPerClient: number;
    maxQueued: number;
    maxQueuedPerClient: number;
    queueTimeoutMs: number;
    /** 单命令默认超时（毫秒），可被 VirtualCommand.timeoutMs 覆盖。 */
    defaultTimeoutMs: number;
    /** 发出取消信号后的宽限期（毫秒），到期升级为强制终止。 */
    cancelGraceMs: number;
    /** stdout / stderr 各自的缓存字节上限，超出即截断并置 truncated。 */
    maxOutputBytes: number;
    /** 命令退出后等待实时输出接收器排空的最长时间（毫秒）。 */
    outputDrainTimeoutMs: number;
    /** 单份 StateReport 的最大字节数。 */
    maxReportBytes: number;
  };
  /** 策略块：默认档案与 trusted / workspace-guard 两个档案的定义。 */
  policy: {
    /** 启动时默认启用的策略档案。 */
    defaultProfile: "trusted" | "workspace-guard";
    /** 档案定义表，键为档案名，与 defaultProfile 对应。 */
    profiles: Record<"trusted" | "workspace-guard", PolicyProfile>;
  };
  /** 可观测性块：trace 环形缓冲容量与是否落盘 trace 文件。 */
  observability: { traceBufferSize: number; writeTraceFile: boolean; traceMaxFileBytes: number; traceRetainedFiles: number; traceMaxPendingBytes: number; traceFlushIntervalMs: number; collectCommandNames: boolean };
  protocol: { maxPendingRequests: number; replayWindowSize: number; replayWindowTtlMs: number; idempotencyMaxEntries: number; idempotencyTtlMs: number; idempotencyMaxBytes: number };
  /** 更新块：更新通道、签名校验与下载限额（由 updater.ts 消费）。 */
  updates: {
    /** 是否启用运行时更新检查。 */
    enabled: boolean;
    /** 发现新版本后自动应用（否则只提示不安装）。 */
    autoApply: boolean;
    /** 更新通道名（如 "stable"）。 */
    channel: string;
    /** 更新源 URL；缺省时退回内置 / 本地 feed。 */
    feedUrl?: string;
    /** 两次更新检查的最小间隔（毫秒）。 */
    checkIntervalMs: number;
    /** 更新网络请求的超时（毫秒）。 */
    requestTimeoutMs: number;
    /** 单次下载字节上限，防御超大或恶意载荷。 */
    maxDownloadBytes: number;
    /** 是否强制要求更新包必须带有效签名。 */
    requireSignature: boolean;
    /** 受信公钥表（key id -> PEM 公钥），requireSignature 为真时用于验签。 */
    trustedKeys: Record<string, string>;
  };
}

/**
 * 单个策略档案：由 PolicyGate（policy.ts）在命令执行前强制执行，本质是
 * "允许读的虚拟根 + 允许写的虚拟根 + 运行时目录只读位"三件套。
 */
export interface PolicyProfile {
  /** 档案模式："trusted" 基本放开限制；"guardrail" 严格按下方根集合收口。 */
  mode: "trusted" | "guardrail";
  /** 允许读取的虚拟根列表（如 /workspace、/home、/tmp）。 */
  knownReadRoots: VirtualPath[];
  /** 允许写入 / 创建的虚拟根列表，通常是读根的子集。 */
  knownWriteRoots: VirtualPath[];
  /** 运行时自身目录是否只读，防止命令篡改运行时实现自我提权。 */
  runtimeReadOnly: boolean;
}

/**
 * 运行时内单个组件（node / msys2 / mingit / ripgrep / posixloom / shims）的清单
 * 条目，供 runtime.ts 做结构校验与 release 模式下的完整性比对。
 */
export interface RuntimeComponentManifest {
  /** 组件标识（如 "node"）。 */
  id: string;
  /** 组件版本（自由格式字符串，取组件自身版本号）。 */
  version: string;
  /** 组件在 RuntimeRoot 内的相对根目录（如 "node"）。 */
  root: string;
  /** 组件主入口的相对路径（如 "node/node.exe"）。 */
  entrypoint: string;
  /** 入口文件 SHA-256（release 模式用于启动与执行后完整性校验）。 */
  sha256?: string;
  /** 组件整棵文件树的清单哈希，比单文件哈希更强的完整性证据。 */
  treeSha256?: string;
  /** 组件应包含的文件数，用于与磁盘扫描结果对账。 */
  fileCount?: number;
}

/**
 * Runtime 清单（位于 RuntimeRoot 的 manifest.json）：一个已安装运行时的
 * 身份、版本、组件构成与供应链元数据，由 runtime.ts 在启动时加载并按模式
 * 分级校验（release 要求远比 development 严格的供应链证据）。
 */
export interface RuntimeManifest {
  /** 清单结构版本。 */
  manifestVersion: number;
  /** 运行时标识，必须与 runtime/current 指针一致（否则 RUNTIME_ID_MISMATCH）。 */
  runtimeId: string;
  /** 运行时语义化版本；与 updateSequence 一起决定更新优先级。 */
  runtimeSemver: string;
  /** 单调递增序号：semver 相同时用它判断新旧，防止更新源重发同版本或回滚。 */
  updateSequence?: number;
  /**
   * 构建模式："development" 允许从开发源码树宽松启动；"release" 必须来自
   * bundled / data 来源，且要求完整组件清单、sourceLock 及其哈希等供应链
   * 证据。模式与来源不匹配会在启动时被 RUNTIME_MODE_MISMATCH 拒绝。
   */
  mode: "development" | "release";
  /** 必需组件列表：纯字符串即组件 id；对象形式可覆盖该组件的 entrypoint。 */
  required: Array<string | { id: string; entrypoint?: string }>;
  /** 组件清单（release 模式必填），用于逐组件完整性校验。 */
  components?: RuntimeComponentManifest[];
  /** 许可证声明列表。 */
  licenses?: string[];
  /** SBOM（软件物料清单）引用，供应链透明度要求的一部分。 */
  sbom?: string;
  /** 组件源码锁文件在 RuntimeRoot 内的相对路径（锁定各组件的精确来源版本）。 */
  sourceLock?: string;
  /** sourceLock 文件的 SHA-256（release 模式必填，防止源锁本身被篡改）。 */
  sourceLockSha256?: string;
  /** 构建时间戳。 */
  buildTimestamp?: string;
  /** 自由备注字段。 */
  notes?: string;
}

/**
 * 运行时快照：不可变的运行时指纹。为什么不可变——snapshotId 是五要素
 * （runtimeId + manifestHash + registryHash + pluginsHash + mountsHash + policyHash）的
 * 复合哈希，组件、注册表、挂载、策略任一变化都会生成全新快照；计划与命令
 * 绑定 snapshotId 后即可检测"计划生成之后运行时是否被热更新或篡改"，保证
 * 审计链可追溯。
 */
export interface RuntimeSnapshot {
  /** 六要素复合 SHA-256 指纹（由 runtime.ts 在装载运行时时合成）。 */
  snapshotId: string;
  /** 运行时标识（同 RuntimeManifest.runtimeId）。 */
  runtimeId: string;
  /** 宿主侧运行时根目录。 */
  runtimeRoot: HostPath;
  /** RuntimeManifest 规范化后的哈希。 */
  runtimeManifestHash: string;
  /** 原生命令注册表哈希。 */
  registryHash: string;
  /** 已激活插件身份、版本、依赖与扩展点声明的哈希。 */
  pluginsHash: string;
  /** 挂载表哈希。 */
  mountsHash: string;
  /** 策略配置哈希。 */
  policyHash: string;
  /** 加载到的完整清单（含组件与供应链元数据）。 */
  manifest: RuntimeManifest;
  /** 运行时来源："bundled" 随安装包携带 / "data" 经更新器安装 / "development" 开发源码树。 */
  source: "bundled" | "data" | "development";
}

/** 面向 CLI / Harness 的只读运行时摘要。 */
export interface RuntimeInfo {
  initializationTimings: Record<string, number>;
  runtimeId: string;
  runtimeSemver: string;
  updateSequence?: number;
  mode: "development" | "release";
  source: RuntimeSnapshot["source"];
  snapshotId: string;
  pluginsHash: string;
  runtimeRoot: HostPath;
  dataRoot: HostPath;
  workspace: HostPath;
  policyProfile: "trusted" | "workspace-guard";
  mounts: MountSpec[];
  bash?: HostPath;
  nativeHost?: HostPath;
  nativeCommands: string[];
  /** Activated in-process capability plugins; functions and private state are never exposed. */
  plugins: Array<{
    id: string;
    version: string;
    description: string;
    requires: string[];
    provides: string[];
    state: "registered" | "active" | "stopped" | "failed";
  }>;
  recoveryRequired: boolean;
}

/**
 * 一次待执行命令的请求视图（面向调用方的公共契约）：在分类与解析之前就
 * 固定了命令文本、目标会话、超时与状态策略等执行上下文。
 */
export interface VirtualCommand {
  /** 命令唯一标识（由调用方或服务生成），贯穿计划、执行与 trace 全链路。 */
  commandId: string;
  /** 所属会话 id，决定初始 cwd 与导出环境。 */
  sessionId: string;
  /** 原始命令文本。 */
  raw: string;
  /** 可选虚拟 cwd；缺省使用会话状态中的 cwd。 */
  cwd?: VirtualPath;
  /** 一次性环境增量：值为 null 表示该命令执行期间删除此变量。 */
  envDelta?: Record<string, string | null>;
  /** 本命令超时（毫秒），覆盖 RuntimeConfig.process.defaultTimeoutMs。 */
  timeoutMs: number;
  /** 本命令的状态回写策略，覆盖会话默认值。 */
  statePolicy: StatePolicy;
  /** 是否脱离宿主进程生命周期独立运行。 */
  detached: boolean;
  /** false 使用普通管道；对象形式要求 Native Host 创建伪终端。 */
  tty: false | TerminalSize;
}

/**
 * 命令输入双形态判别联合："text" 把完整命令行文本交给分类器自行分词；
 * "argv" 由调用方预先拆分好（适用于宿主程序直接拼参数的场景）。
 */
export type CommandInput =
  // 文本形态：raw 为完整命令行文本。
  | { kind: "text"; raw: string }
  // argv 形态：调用方已拆分好的参数数组，argv[0] 为命令名。
  | { kind: "argv"; argv: string[] };

/**
 * 会话可变状态：当前 cwd 与导出环境。version 是状态乐观锁基准，
 * 见 StatePatch / StateOutcome。
 */
export interface SessionState {
  /** 状态版本号（bigint 防精度溢出），每次成功提交后递增。 */
  version: bigint;
  /** 当前虚拟 cwd。 */
  cwd: VirtualPath;
  /** 已导出的环境变量（经 env.ts 过滤；运行时保留 / 后端控制变量不在其中）。 */
  exportedEnv: Record<string, string>;
}

/** classifier.ts 的分类结论：kind 决定执行路线，reason 进入审计与 trace。 */
export interface ClassifiedCommand {
  /** 四级分类结果。 */
  kind: CommandKind;
  /** 安全拆分出的 argv；含 shell 语法无法安全拆分时为 null（必须整体交给 bash）。 */
  argv: string[] | null;
  /** 人类可读的分类依据（如 "shell keyword"、"empty command"）。 */
  reason: string;
}

/**
 * 原生命令注册表条目（registry.ts）：描述一个可被直接 spawn 的 Windows
 * 命令及其参数适配器。
 */
export interface NativeCommandDescriptor {
  /** 命令名（如 "git"、"rg"、"node"）。 */
  name: string;
  /** 可执行文件路径模板，支持 $RUNTIME_ROOT 等变量替换。 */
  executable: string;
  /** 参数适配器标识（如 "git-v1"），决定路径参数如何翻译。 */
  adapterId: string;
  /** 该原生实现是否与 shell 下同名命令行为等价（供审计与回退决策参考）。 */
  shellEquivalent: boolean;
}

/**
 * 命令解析模板（service.ts 的 resolveTemplate 产物）：把"命令分类 + 运行时
 * 指纹 + 注册表命中情况"固化为一个可缓存、可哈希（templateId）的中间结论，
 * 再据此构建具体 ExecutionPlan。templateId 还绑定 RuntimeSnapshot.pluginsHash，
 * 缓存有效的前提是 runtimeId、registryHash 与插件图均未变化。
 */
export interface ResolutionTemplate {
  /** 模板指纹（由调用方身份、命令分类、runtimeId、registryHash、pluginsHash 合成），可作缓存键。 */
  templateId: string;
  /** 解析所基于的运行时 id。 */
  runtimeId: string;
  /** 解析所基于的注册表哈希；注册表变化即缓存失效。 */
  registryHash: string;
  /** 触发本次解析的命令分类。 */
  commandKind: CommandKind;
  /** 判定使用的后端：注册表命中为 native，否则为 msys2。 */
  backend: Backend;
  /** 命中的适配器 id（msys2 路线固定为 "msys2-bash-v1"）。 */
  adapterId: string;
  /** 解析结论的依据说明，进入审计记录。 */
  reason: string;
  /** 适配器改写后的完整 argv（含 argv[0]）；无适配器改写时为 null。 */
  argv: string[] | null;
  /** 解析出的宿主可执行文件；shell 路线为 null（bash 由后续步骤定位）。 */
  executable: HostPath | null;
  /** 命中条目的 shellEquivalent 透传。 */
  shellEquivalent: boolean;
  /** 适配器执行路径翻译时产生的参数级审计记录（见 PathDecision）。 */
  pathDecisions: PathDecision[];
}

/**
 * 命令参数的词法类别，registry 适配器据此决定翻译方式：
 * - "option"      选项 / 开关，不做路径翻译；
 * - "opaque"      对工具有特殊含义的不透明 token（如 git 的 rev-range），不翻译；
 * - "path-scalar" 单个路径参数，执行虚拟到宿主翻译；
 * - "path-list"   路径列表（如冒号分隔的多个路径），逐段翻译；
 * - "pathspec"    含通配符的 pathspec 模式（如 git 的 "*.ts"），翻译时保留模式语义。
 */
export type ArgumentKind = "option" | "opaque" | "path-scalar" | "path-list" | "pathspec";

/**
 * 参数访问意图：策略层按意图选择对应的允许根做物理校验
 * （读命中读根、写 / 创建命中写根、执行校验可执行文件位置）。
 */
export type PathIntent = "read" | "write" | "create" | "execute" | "unknown";

/**
 * 参数级路径审计记录：每个被判定为路径的命令行参数都会生成一条，完整记录
 * "输入了什么虚拟路径、翻译成了什么宿主路径、词法与物理两层判定的结果"。
 * 为什么做参数级——命令级的 allow / deny 无法回答"是哪个参数、为何被翻译成
 * 这个宿主路径"，参数级粒度让每次翻译可逐条复核，也是拒绝错误的 details。
 */
export interface PathDecision {
  /** 该参数在 argv 中的下标，用于回指原始参数。 */
  argumentIndex: number;
  /** 词法类别。 */
  kind: ArgumentKind;
  /** 判定的访问意图。 */
  intent: PathIntent;
  /** 原始虚拟路径输入（非路径参数不记录）。 */
  virtualInput?: VirtualPath;
  /** 翻译后的宿主路径（非路径参数不记录）。 */
  hostOutput?: HostPath;
  /** 词法层（纯字符串规则）是否放行；词法层不含任何磁盘事实。 */
  lexicalAllowed: boolean;
  /**
   * 物理层校验结果："passed" 表示真实路径（realpath 归一化后）落在允许根内；
   * "best-effort" 表示目标尚不存在，只能校验最近存在的祖先目录；
   * "not-applicable" 表示该参数无需物理校验。
   */
  physicalCheck: "passed" | "not-applicable" | "best-effort";
}

/** 执行计划公共骨架：native 与 shell 两条执行路线共享的审计与控制字段。 */
export interface BaseExecutionPlan {
  /** 计划指纹（commandId + templateId + cwd 哈希合成），用于审计与结果关联。 */
  planId: string;
  /** 关联的命令 id。 */
  commandId: string;
  /** 关联的会话 id。 */
  sessionId: string;
  /** 计划基于的运行时快照 id（运行时指纹锁定，见 RuntimeSnapshot）。 */
  snapshotId: string;
  /** 本计划超时（毫秒）。 */
  timeoutMs: number;
  /** 是否 detached 执行。 */
  detached: boolean;
  /** 计划执行时启用的策略档案。 */
  policyProfile: "trusted" | "workspace-guard";
  /** 缺省使用普通管道；提供时由 Native Host 创建 ConPTY。 */
  terminal?: TerminalSize;
}

/**
 * 原生执行计划（判别字段 mode 为 "native"）：不经 shell，直接 spawn 一个
 * Windows 可执行文件。所有路径参数在计划期完成翻译并固化进 argv，因此该
 * 分支没有状态回写（StateOutcome 恒为 not-applicable）。
 */
export interface NativeExecutionPlan extends BaseExecutionPlan {
  mode: "native";
  /** 宿主可执行文件路径。 */
  executable: HostPath;
  /** 翻译后的参数数组（不含 argv[0]，可执行文件由 executable 单独指定）。 */
  argv: string[];
  /** 宿主侧 cwd（虚拟 cwd 已完成翻译）。 */
  cwdHost: HostPath;
  /** 宿主风格环境变量（已注入运行时派生变量，键已大写规范化）。 */
  envHost: Record<string, string>;
  /** 本计划全部参数的路径审计记录。 */
  pathDecisions: PathDecision[];
}

/** shell 引导挂载：wrapper 脚本在 bash 内重建虚拟到宿主映射所需的单条挂载。 */
export interface MountBootstrap {
  virtualPath: VirtualPath;
  hostPath: HostPath;
}

/**
 * shell 执行计划（判别字段 mode 为 "shell"）：经 MSYS2 Bash 解释执行。
 * 命令体作为脚本从 stdin 注入（bash --noprofile --norc -s），会话状态回写
 * 依赖 StateReport v1 临时文件协议（见 docs/protocols/state-report-v1.md）。
 */
export interface ShellExecutionPlan extends BaseExecutionPlan {
  mode: "shell";
  /** MSYS2 bash 可执行文件的宿主路径。 */
  bashExecutable: HostPath;
  /** 待解释执行的命令体原文（不做任何改写）。 */
  commandBody: string;
  /** 虚拟 cwd，以 POSIX 形态进入 shell 环境。 */
  cwdVirtual: VirtualPath;
  /** POSIX 风格环境变量（含 POSIXLOOM_STATE_REPORT_PATH、POSIXLOOM_SESSION_ID 等注入变量）。 */
  envPosix: Record<string, string>;
  /** 计划生成时绑定的状态版本：StateReport 提交时比对，过期即 STATE_CONFLICT。 */
  baseStateVersion: bigint;
  /** 本命令的状态回写策略。 */
  statePolicy: StatePolicy;
  /** 传给 wrapper 的挂载引导表（挂载表在计划期的快照）。 */
  mountBootstrap: MountBootstrap[];
  /** StateReport 临时文件的宿主路径（命令结束后由服务读取并删除）。 */
  stateReportPath: HostPath;
}

/** 执行计划判别联合：按 mode 收窄为原生直启或 shell 解释两条路线。 */
export type ExecutionPlan = NativeExecutionPlan | ShellExecutionPlan;

/**
 * 可安全返回给 CLI / Harness 的执行计划预览。
 *
 * 预览只包含路由、路径、策略和状态版本等审计信息，不包含完整环境变量、
 * Shell wrapper 或 StateReport 路径，避免诊断接口泄露进程环境中的敏感值。
 */
export interface ExecutionPreview {
  /** 本次预览生成的计划 id；实际重新执行时会生成新的 id。 */
  planId: string;
  /** 本次预览生成的命令 id。 */
  commandId: string;
  /** 目标会话 id。 */
  sessionId: string;
  /** 计划绑定的运行时快照。 */
  snapshotId: string;
  /** 计划读取到的会话状态版本，使用十进制字符串以便 JSON 序列化。 */
  sessionVersion: string;
  /** 最终执行路线。 */
  mode: "native" | "shell";
  /** 最终执行后端。 */
  backend: Backend;
  /** 分类器给出的命令类别。 */
  commandKind: CommandKind;
  /** 后端选择原因。 */
  reason: string;
  /** 将启动的宿主可执行文件。 */
  executable: HostPath;
  /** 传给可执行文件的参数；Shell 路线仅公开固定 Bash 启动参数。 */
  argv: string[];
  /** 虚拟工作目录。 */
  cwdVirtual: VirtualPath;
  /** 翻译后的宿主工作目录。 */
  cwdHost: HostPath;
  /** 超时限制。 */
  timeoutMs: number;
  /** 状态提交策略。 */
  statePolicy: StatePolicy;
  /** 策略档案。 */
  policyProfile: "trusted" | "workspace-guard";
  /** Native 参数适配器产生的路径审计；Shell 路线为空。 */
  pathDecisions: PathDecision[];
  /** 将注入进程的环境变量名称，仅公开名称、不公开值。 */
  environmentKeys: string[];
  /** 预检已完成的关键安全门禁；任一失败都会转为结构化错误而不产生 ready 预览。 */
  checks: {
    runtimeIntegrity: "passed";
    cwdPolicy: "passed";
    executablePolicy: "passed";
  };
  /** 审计者必须知道的静态分析边界。 */
  limitations: string[];
  /** 预览不是可重放的授权令牌；真正执行会重新规划与校验。 */
  replayable: false;
  /** 本计划是否使用伪终端，以及初始视口大小。 */
  terminal?: TerminalSize;
}

/**
 * 会话状态补丁：shell 命令的 StateReport 解析结果（或 API 直接修改请求）。
 * 提交走乐观锁 CAS：baseStateVersion 必须等于会话当前 version，否则抛
 * STATE_CONFLICT（见 env.ts / session.ts）。
 */
export interface StatePatch {
  /** 乐观锁基准版本，必须等于目标会话的当前 version。 */
  baseStateVersion: bigint;
  /** 新 cwd（缺省不变）；必须是已挂载且合法的虚拟路径。 */
  cwd?: VirtualPath;
  /** 新增或更新的环境变量。 */
  setEnv: Record<string, string>;
  /** 要删除的环境变量名（PATH 不可删除，见 env.ts 校验）。 */
  removeEnv: string[];
}

/**
 * 命令终态五态判别联合。建模为数据而非异常，使 control 协议可将终态原样
 * 序列化转发给上层宿主：exited / cancelled / timed-out / spawn-failed /
 * crashed。
 */
export type CommandOutcome =
  // 正常退出：exitCode 为业务退出码（须与 StateReport 的 exit-code 一致）。
  | { kind: "exited"; exitCode: number }
  // 被外部取消（取消信号 + 宽限期后强杀），没有可用的退出码。
  | { kind: "cancelled" }
  // 超过 timeoutMs 被终止。
  | { kind: "timed-out" }
  // 进程未能启动（可执行文件缺失 / 权限不足等），errorCode 为平台错误码。
  | { kind: "spawn-failed"; errorCode: string }
  // 进程异常终止（崩溃或被信号杀死），errorCode 为平台错误码。
  | { kind: "crashed"; errorCode: string };

/**
 * 会话状态结果五态判别联合（与命令终态解耦：命令失败不等于状态一定未提交，
 * 反之正常退出也可能不产生状态）：
 * committed 已提交 / rejected 补丁被拒 / not-produced 未产出报告 /
 * protocol-failed 报告协议错误 / not-applicable native 路线不涉及回写。
 */
export type StateOutcome =
  // 已提交：newVersion 为提交后的新状态版本。
  | { kind: "committed"; newVersion: bigint }
  // 已拒绝：reason 说明违反的校验规则（如破坏 PATH 完整性）。
  | { kind: "rejected"; reason: string }
  // 未产出：命令终态非 exited 或没有写出 StateReport，状态保持不变。
  | { kind: "not-produced"; reason: string }
  // 协议失败：报告存在但格式非法或与进程终态不一致。
  | { kind: "protocol-failed"; reason: string }
  // 不适用：native 路线没有状态回写。
  | { kind: "not-applicable" };

/** 单命令执行完成的全量结果：进程终态 + 状态结果 + 输出 + 审计元数据。 */
export interface CommandCompletion {
  /** 进程终态（五态）。 */
  command: CommandOutcome;
  /** 会话状态结果（五态）。 */
  state: StateOutcome;
  /** stdout 内容；被截断时保留开头与结尾各一半，中间丢弃并插入截断标记。 */
  stdout: Buffer;
  /** stderr 内容；截断策略同 stdout。 */
  stderr: Buffer;
  /** stdout 实际产出的字节总量（截断时大于 Buffer 长度，用于报告真实规模）。 */
  stdoutBytes: number;
  /** stderr 实际产出的字节总量。 */
  stderrBytes: number;
  /** 输出是否因超过 maxOutputBytes 而被截断。 */
  truncated: boolean;
  /** 实际使用的执行后端（native / msys2）。 */
  backend: Backend;
  /** 关联的执行计划 id。 */
  planId: string;
  /** 自由结构 trace 元数据（commandId / sessionId / snapshotId / 耗时等）。 */
  trace: Record<string, unknown>;
}
