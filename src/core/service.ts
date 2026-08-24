/**
 * service.ts -- PosixLoomService：整个 PosixLoom 的命令执行编排核心。
 *
 * 职责：
 * - 把 RuntimeManager 的插件能力图与 PolicyGate、SessionStateStore、TraceRecorder
 *   串成一条完整的执行管道；
 * - 通过 classifier / resolver / planner / backend 扩展点路由用户输入：
 *   native 快路径（Windows 原生可执行文件 + 适配器翻译参数）与 msys2 shell 路径
 *   （bash --noprofile --norc -s 从 stdin 执行生成的包装脚本）；
 * - 由内置 shell 插件生成包装脚本：挂载 MSYS 挂载点、导出 POSIX 环境、cd 到虚拟 cwd、
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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PosixLoomError, asPosixLoomError } from "./errors.js";
import { diffExportedEnv } from "./env.js";
import { PolicyGate } from "./policy.js";
import { NativeRegistry } from "./registry.js";
import type { InteractiveProcessController, ProcessOutputEvent, ProcessRunResult } from "./process.js";
import { RuntimeManager } from "./runtime.js";
import { parseStateReport, quotePosix, toMixedPath } from "./shell.js";
import { isSafeExistingDirectory, normalizeVirtual } from "./path.js";
import { SessionStateStore } from "./session.js";
import { TraceRecorder, type TraceEvent } from "./trace.js";
import {
  COMMAND_CLASSIFIERS,
  COMMAND_RESOLVERS,
  EXECUTION_BACKENDS,
  EXECUTION_HOOKS,
  EXECUTION_PLANNERS,
  type RuntimeCommandInput,
} from "../plugins/contracts.js";
import type {
  CommandCompletion,
  CommandKind,
  CommandOutcome,
  ClassifiedCommand,
  ExecutionPlan,
  ExecutionPreview,
  NativeExecutionPlan,
  ResolutionTemplate,
  SessionState,
  ShellExecutionPlan,
  StateOutcome,
  StatePatch,
  StatePolicy,
  TerminalSize,
} from "./types.js";

/** Shell quoting and StateReport helpers remain public through the service API. */
export { parseStateReport, quotePosix };
export { buildShellScript } from "./shell.js";
export type { ParsedStateReport } from "./shell.js";

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
  /** 创建伪终端并使命令以交互模式运行。 */
  terminal?: TerminalSize;
  /** terminal 模式的运行期输入/缩放通道。 */
  interactive?: InteractiveProcessController;
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

/** execute 生命周期观察器；控制协议用它发送 started 与流式输出事件。 */
export interface ExecuteObserver {
  onStarted?: (preview: ExecutionPreview) => void | Promise<void>;
  onOutput?: (event: ProcessOutputEvent) => void | Promise<void>;
}

/** 经过完整预检、可直接交给进程层执行的内部计划。 */
interface PreparedExecution {
  plan: ExecutionPlan;
  hostPath?: string;
  cwdVirtual: string;
  cwdHost: string;
  commandKind: CommandKind;
  reason: string;
  sessionVersion: bigint;
  statePolicy: StatePolicy;
}

/**
 * PosixLoomService -- PosixLoom 命令执行编排核心，把各模块串成完整执行管道。
 *
 * 持有并连接插件微内核与状态/安全组件：
 * - RuntimeManager：运行时完整性校验、bash / Native Host 查找、挂载表、配置与快照；
 * - SessionStateStore：会话状态（cwd + exportedEnv + 乐观锁版本号）与串行 lane；
 * - PluginKernel：分类器、解析器、计划器、执行后端与只读 hook 的有序能力图；
 * - NativeRegistry：由插件贡献合成的命令与 argv 适配器索引；
 * - PolicyGate：cwd 与可执行文件路径的策略断言（trusted / workspace-guard）；
 * - TraceRecorder：命令级 trace 的环形缓冲与可选落盘。
 *
 * 管道概览（executeOnce）：完整性预检 -> 会话快照与虚拟 cwd -> 策略与存在性检查
 * -> 插件分类 -> 插件解析 -> 插件计划 -> 插件后端
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
  async execute(options: ExecuteOptions, observer: ExecuteObserver = {}): Promise<CommandCompletion> {
    const statePolicy = options.statePolicy ?? this.runtime.config.runtime.session.defaultStatePolicy;
    const operation = async (): Promise<CommandCompletion> => this.executeOnce(options, statePolicy, observer);
    const completion = statePolicy === "cwd-env" ? await this.sessions.inStateLane(options.sessionId, operation) : await operation();
    completion.trace = await this.traceRecorder.record(completion.trace);
    return completion;
  }

  /**
   * 构建但不执行命令，返回经过脱敏的执行计划预览。
   * cwd-env 预览也进入会话 lane，保证它读取的是前序命令提交后的最新状态。
   */
  async explain(options: ExecuteOptions): Promise<ExecutionPreview> {
    const statePolicy = options.statePolicy ?? this.runtime.config.runtime.session.defaultStatePolicy;
    const operation = async (): Promise<ExecutionPreview> => this.preview(await this.prepareExecution(options, statePolicy));
    return statePolicy === "cwd-env" ? this.sessions.inStateLane(options.sessionId, operation) : operation();
  }

  /**
   * 单次命令执行管道（execute 的内部实现，一条命令走完全程）。
   *
   * 阶段顺序：
   *   1. 命令前运行时完整性断言（release 模式校验 manifest 与组件树，防篡改扩散）；
   *   2. 输入形态分派（argv / text）与空命令短路；
   *   3. 会话快照 -> 虚拟 cwd（请求覆盖优先）-> 宿主路径 -> 策略断言 -> 存在性检查；
   *   4. 按优先级咨询 classifier 插件；
   *   5. 按优先级咨询 resolver 插件，得到 ResolutionTemplate；
   *   6. 校验超时并定位 Native Host（release 模式缺失即失败）；
   *   7a. native 快路径：planner -> backend -> nativeCompletion（状态不适用）；
   *   7b. shell 路径：planner -> backend（bash -s + stdin 脚本）->
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
  private async executeOnce(options: ExecuteOptions, statePolicy: StatePolicy, observer: ExecuteObserver): Promise<CommandCompletion> {
    // 空命令保持既有短路语义：完成完整性预检后不构建计划、不启动进程。
    const exactArgv = options.kind === "argv" ? options.argv : undefined;
    const raw = options.kind === "argv" ? undefined : options.raw;
    if ((exactArgv && exactArgv.length === 0) || (!exactArgv && !raw?.trim())) {
      await this.runtime.assertRuntimeIntegrity("pre-command");
      return this.emptyCompletion();
    }
    const started = Date.now();
    const prepared = await this.prepareExecution(options, statePolicy);
    await observer.onStarted?.(this.preview(prepared));
    const { plan } = prepared;
    const backend = this.runtime.plugins.extensions(EXECUTION_BACKENDS).find((candidate) => candidate.mode === plan.mode);
    if (!backend) {
      throw new PosixLoomError("PLUGIN_CAPABILITY_MISSING", `No execution backend accepts ${plan.mode} plans`, { extensionPoint: EXECUTION_BACKENDS.id, mode: plan.mode });
    }
    const hookContext = { runtime: this.runtime, input: this.pluginInput(options), sessionId: options.sessionId };
    try {
      const result = await backend.execute({
        plan,
        runtime: this.runtime,
        hostPath: prepared.hostPath,
        signal: options.signal,
        onOutput: observer.onOutput,
        interactive: options.interactive,
      });
      await this.runtime.assertRuntimeIntegrity("post-command");
      for (const hook of this.runtime.plugins.extensions(EXECUTION_HOOKS)) {
        await hook.afterExecute?.({ ...hookContext, plan, result });
      }
      return plan.mode === "native"
        ? this.nativeCompletion(plan, result, prepared.reason, started)
        : this.shellCompletion(plan, result, prepared.reason, started);
    } catch (error) {
      for (const hook of this.runtime.plugins.extensions(EXECUTION_HOOKS)) {
        await hook.onError?.({ ...hookContext, error });
      }
      throw error;
    }
  }

  /** 运行完整预检并构建唯一的内部执行计划，供 explain 与 execute 共用。 */
  private async prepareExecution(options: ExecuteOptions, statePolicy: StatePolicy): Promise<PreparedExecution> {
    await this.runtime.assertRuntimeIntegrity("pre-command");
    const exactArgv = options.kind === "argv" ? options.argv : undefined;
    const raw = options.kind === "argv" ? undefined : options.raw;
    if ((exactArgv && exactArgv.length === 0) || (!exactArgv && !raw?.trim())) {
      throw new PosixLoomError("COMMAND_EMPTY", "Cannot explain an empty command");
    }
    const hookContext = { runtime: this.runtime, input: this.pluginInput(options), sessionId: options.sessionId };
    for (const hook of this.runtime.plugins.extensions(EXECUTION_HOOKS)) await hook.beforePrepare?.(hookContext);
    const commandId = randomUUID();
    const state = this.sessions.snapshot(options.sessionId);
    const virtualCwd = options.cwd ?? state.cwd;
    const cwdHost = this.runtime.mountTable.toHost(virtualCwd);
    this.policy.assertCwd(virtualCwd, cwdHost);
    if (!existsSync(cwdHost)) throw new PosixLoomError("CWD_NOT_FOUND", `Working directory does not exist: ${virtualCwd}`, { cwdHost });
    // 阶段 4：按优先级咨询分类器。内置 argv 插件精确保留参数边界；内置 text
    // 插件识别 simple / builtin / shell-required / explicit-shell。
    let classified: ClassifiedCommand | undefined;
    for (const classifier of this.runtime.plugins.extensions(COMMAND_CLASSIFIERS)) {
      classified = await classifier.classify({ input: hookContext.input });
      if (classified) break;
    }
    if (!classified) {
      throw new PosixLoomError("PLUGIN_CAPABILITY_MISSING", "No command classifier accepted the request", { extensionPoint: COMMAND_CLASSIFIERS.id, inputKind: hookContext.input.kind });
    }
    this.assertClassification(classified);
    // 命令身份：argv 模式用规范化 JSON、text 模式用原文，作为模板 ID 的哈希输入。
    const commandIdentity = exactArgv ? JSON.stringify({ argv: exactArgv }) : raw ?? "";
    // 命令体：argv 模式逐个单引号包裹后拼接（防注入），text 模式原样交给 bash。
    const commandBody = exactArgv ? exactArgv.map(quotePosix).join(" ") : raw ?? "";
    // 阶段 5：解析执行模板（simple 先查 native 注册表，未命中回落 MSYS2 bash）。
    const template = await this.resolveTemplate(commandIdentity, classified);
    // 阶段 6：超时参数（非法值直接抛 TIMEOUT_INVALID）；定位 Native Host，
    // release Runtime 不允许缺失（不可回落到 Node 直接 spawn）。
    const timeoutMs = options.timeoutMs ?? this.runtime.config.runtime.process.defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new PosixLoomError("TIMEOUT_INVALID", "timeoutMs must be a positive integer", { timeoutMs });
    const hostPath = this.runtime.findNativeHost();
    if (!hostPath && this.runtime.snapshot.manifest.mode === "release") throw new PosixLoomError("NATIVE_HOST_MISSING", "Release Runtime requires its packaged Native Host");

    let plan: ExecutionPlan | undefined;
    for (const planner of this.runtime.plugins.extensions(EXECUTION_PLANNERS)) {
      plan = await planner.build({
        commandId,
        commandBody,
        sessionId: options.sessionId,
        envDelta: options.envDelta,
        terminal: options.terminal,
        state,
        statePolicy,
        template,
        virtualCwd,
        cwdHost,
        timeoutMs,
        runtime: this.runtime,
        policy: this.policy,
      });
      if (plan) break;
    }
    if (!plan) throw new PosixLoomError("PLUGIN_CAPABILITY_MISSING", `No execution planner accepted ${template.backend}`, { extensionPoint: EXECUTION_PLANNERS.id, backend: template.backend });
    this.assertPlanInvariants(plan, { commandId, sessionId: options.sessionId, virtualCwd, cwdHost, timeoutMs, state, statePolicy });
    for (const hook of this.runtime.plugins.extensions(EXECUTION_HOOKS)) await hook.afterPrepare?.({ ...hookContext, plan });

    return {
      plan,
      hostPath,
      cwdVirtual: virtualCwd,
      cwdHost,
      commandKind: classified.kind,
      reason: template.reason,
      sessionVersion: state.version,
      statePolicy,
    };
  }

  /** Convert the public request union to the immutable view consumed by classifiers and hooks. */
  private pluginInput(options: ExecuteOptions): RuntimeCommandInput {
    return options.kind === "argv"
      ? { kind: "argv", argv: Object.freeze([...options.argv]) }
      : { kind: "text", raw: options.raw };
  }

  /** Validate runtime values from trusted-but-fallible classifier plugins. */
  private assertClassification(classified: ClassifiedCommand): void {
    const kinds: readonly CommandKind[] = ["simple", "builtin", "shell-required", "explicit-shell"];
    const argvValid = classified.argv === null
      || (Array.isArray(classified.argv) && classified.argv.every((argument) => typeof argument === "string"));
    if (!kinds.includes(classified.kind)
      || typeof classified.reason !== "string"
      || !classified.reason.trim()
      || !argvValid
      || (classified.kind === "simple" && (!classified.argv || classified.argv.length === 0))) {
      throw new PosixLoomError("PLUGIN_CLASSIFICATION_INVALID", "Command classifier returned an invalid classification", { classified });
    }
  }

  /** Keep identity, state, cwd, policy, and report-file invariants inside the microkernel. */
  private assertPlanInvariants(plan: ExecutionPlan, expected: {
    commandId: string;
    sessionId: string;
    virtualCwd: string;
    cwdHost: string;
    timeoutMs: number;
    state: SessionState;
    statePolicy: StatePolicy;
  }): void {
    const commonValid = plan.commandId === expected.commandId
      && plan.sessionId === expected.sessionId
      && plan.snapshotId === this.runtime.snapshot.snapshotId
      && plan.timeoutMs === expected.timeoutMs
      && plan.policyProfile === this.runtime.config.runtime.policy.defaultProfile
      && plan.detached === false
      && Boolean(plan.planId);
    if (!commonValid) {
      throw new PosixLoomError("PLUGIN_PLAN_INVALID", "Execution planner changed a microkernel-owned plan invariant", {
        commandId: plan.commandId,
        sessionId: plan.sessionId,
        snapshotId: plan.snapshotId,
      });
    }
    if (plan.mode === "native") {
      if (plan.cwdHost !== expected.cwdHost) {
        throw new PosixLoomError("PLUGIN_PLAN_INVALID", "Native planner changed the validated working directory", { expected: expected.cwdHost, actual: plan.cwdHost });
      }
      this.policy.assertExecutable(plan.executable);
      return;
    }
    const expectedReport = join(this.runtime.config.dataRoot, "tmp", `posixloom-${expected.commandId}.report`);
    if (plan.cwdVirtual !== expected.virtualCwd
      || plan.baseStateVersion !== expected.state.version
      || plan.statePolicy !== expected.statePolicy
      || plan.stateReportPath !== expectedReport
      || plan.envPosix.POSIXLOOM_STATE_REPORT_PATH !== toMixedPath(expectedReport)) {
      throw new PosixLoomError("PLUGIN_PLAN_INVALID", "Shell planner changed a microkernel-owned state or path invariant", {
        expectedCwd: expected.virtualCwd,
        actualCwd: plan.cwdVirtual,
      });
    }
    const expectedMounts = this.runtime.mountTable.entries.map((entry) => ({ virtualPath: entry.virtualPath, hostPath: entry.hostPath }));
    if (JSON.stringify(plan.mountBootstrap) !== JSON.stringify(expectedMounts)) {
      throw new PosixLoomError("PLUGIN_PLAN_INVALID", "Shell planner changed the validated mount table");
    }
    this.policy.assertExecutable(plan.bashExecutable);
  }

  /** 把内部计划裁剪成不含环境值、脚本文本与临时路径的公开预览。 */
  private preview(prepared: PreparedExecution): ExecutionPreview {
    const { plan } = prepared;
    const native = plan.mode === "native";
    return {
      planId: plan.planId,
      commandId: plan.commandId,
      sessionId: plan.sessionId,
      snapshotId: plan.snapshotId,
      sessionVersion: prepared.sessionVersion.toString(),
      mode: plan.mode,
      backend: native ? "native" : "msys2",
      commandKind: prepared.commandKind,
      reason: prepared.reason,
      executable: native ? plan.executable : plan.bashExecutable,
      argv: native ? [...plan.argv] : plan.terminal ? ["--noprofile", "--norc", "-c", "<generated-wrapper>"] : ["--noprofile", "--norc", "-s"],
      cwdVirtual: prepared.cwdVirtual,
      cwdHost: prepared.cwdHost,
      timeoutMs: plan.timeoutMs,
      statePolicy: prepared.statePolicy,
      policyProfile: plan.policyProfile,
      pathDecisions: native ? plan.pathDecisions.map((decision) => ({ ...decision })) : [],
      environmentKeys: Object.keys(native ? plan.envHost : plan.envPosix).sort(),
      checks: { runtimeIntegrity: "passed", cwdPolicy: "passed", executablePolicy: "passed" },
      limitations: native
        ? ["The preview is non-binding; execution replans and revalidates against current runtime and session state."]
        : [
          "Shell syntax is interpreted at runtime; paths produced by expansion, substitution, globbing, or scripts cannot be enumerated statically.",
          "The preview is non-binding; execution replans and revalidates against current runtime and session state.",
        ],
      replayable: false,
      terminal: plan.terminal ? { ...plan.terminal } : undefined,
    };
  }

  /**
   * 把命令身份解析为 ResolutionTemplate，决定执行后端（native 或 msys2）。
   *
   * templateId = SHA-256(identity + 命令种类 + runtimeId + registryHash)：模板 ID
   * 绑定运行时与注册表版本，同一命令在不同版本下得到不同 ID，保证可观测性与审计安全。
   *
   * resolver 插件按优先级依次接受或跳过请求；内置 native resolver 先查注册表，
   * 内置 MSYS2 resolver 以最低优先级兜底。返回模板必须绑定当前 templateId、
   * runtimeId、registryHash 与 commandKind，否则由微内核拒绝。
   *
   * @param identity 命令身份（argv 的规范化 JSON 或原始文本）
   * @param classified 分类结果
   * @returns ResolutionTemplate（backend、templateId、argv、executable、pathDecisions 等）
   */
  private async resolveTemplate(identity: string, classified: ClassifiedCommand): Promise<ResolutionTemplate> {
    const templateId = createHash("sha256").update(JSON.stringify({ identity, kind: classified.kind, runtime: this.runtime.snapshot.runtimeId, registry: this.runtime.snapshot.registryHash, plugins: this.runtime.snapshot.pluginsHash })).digest("hex");
    for (const resolver of this.runtime.plugins.extensions(COMMAND_RESOLVERS)) {
      const template = await resolver.resolve({
        identity,
        classified,
        templateId,
        runtime: this.runtime,
        registry: this.registry,
        policy: this.policy,
      });
      if (!template) continue;
      if (template.templateId !== templateId || template.runtimeId !== this.runtime.snapshot.runtimeId || template.registryHash !== this.runtime.snapshot.registryHash || template.commandKind !== classified.kind) {
        throw new PosixLoomError("PLUGIN_RESOLUTION_INVALID", `Resolver ${resolver.id} returned a template for a different command or runtime`, { resolverId: resolver.id });
      }
      this.assertResolutionTemplate(template, resolver.id);
      return template;
    }
    throw new PosixLoomError("PLUGIN_CAPABILITY_MISSING", "No command resolver accepted the classified command", { extensionPoint: COMMAND_RESOLVERS.id, commandKind: classified.kind });
  }

  private assertResolutionTemplate(template: ResolutionTemplate, resolverId: string): void {
    const argvValid = template.argv === null
      || (Array.isArray(template.argv) && template.argv.every((argument) => typeof argument === "string"));
    const commonValid = (template.backend === "native" || template.backend === "msys2")
      && typeof template.adapterId === "string"
      && Boolean(template.adapterId)
      && typeof template.reason === "string"
      && Boolean(template.reason.trim())
      && typeof template.shellEquivalent === "boolean"
      && Array.isArray(template.pathDecisions)
      && argvValid;
    const backendValid = template.backend === "native"
      ? typeof template.executable === "string" && Boolean(template.executable) && Array.isArray(template.argv) && template.argv.length > 0
      : template.executable === null;
    if (!commonValid || !backendValid) {
      throw new PosixLoomError("PLUGIN_RESOLUTION_INVALID", `Resolver ${resolverId} returned a malformed template`, { resolverId, backend: template.backend });
    }
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
