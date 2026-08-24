/**
 * PosixLoom Harness 控制平面：让 AI Harness 以子进程方式
 * （`posixloom serve --stdio`）驱动 PosixLoom。
 *
 * 本模块在一对字节流（通常是子进程的 stdin/stdout）上实现请求-响应式控制
 * 协议，覆盖会话管理（session.create / session.snapshot / session.close）、
 * 命令执行（execute）、在途命令取消（cancel）、运行时体检（runtime.doctor）
 * 与优雅关停（shutdown）。
 *
 * 设计意图：
 * - 为什么长度前缀帧协议：stdio 是无消息边界的字节流，JSON 自身无法自定界。
 *   这里复用 process.ts 与原生宿主通道一致的「4 字节小端长度 + UTF-8 JSON」
 *   帧格式（上限 NATIVE_MAX_FRAME_BYTES = 16MB），控制面与执行面共用一套
 *   编解码器，避免两套帧格式各自漂移，同时天然限制单帧内存占用。
 * - 为什么 argv 与 text 用判别联合：argv 是精确模式，参数逐个透传、永不拼接
 *   后重新做 Shell 解析；text 是唯一启用 Shell 语法的输入形态。以
 *   input.kind 判别后分别构造执行选项，从类型层面杜绝「拼字符串再解释」
 *   造成的注入面。
 * - 为什么 fail closed：控制面处理的是不可信的机器输入。未知协议版本、
 *   畸形帧、复用或超长的请求 id 一律拒绝并回错误帧，绝不猜测意图继续执行。
 * - 并发模型：每个请求派发一个 fire-and-forget 任务（tasks 集合托管），
 *   读循环不被任何单个慢命令阻塞；所有响应写入经 writeLane Promise 链
 *   串行化，保证帧与帧不交错；连接关闭或 shutdown 时统一 abort 全部在途
 *   命令，退出前用 Promise.allSettled 等待任务与写入落定。
 *
 * 帧编解码（NativeFrameDecoder / encodeNativeFrame）见 ./process.ts，
 * 会话与命令执行语义见 ./service.ts。
 */
import type { Readable, Writable } from "node:stream";
import { PosixLoomError, asPosixLoomError } from "./errors.js";
import { InteractiveProcessController, NATIVE_MAX_FRAME_BYTES, NativeFrameDecoder, encodeNativeFrame, validateTerminalSize } from "./process.js";
import { RuntimeManager } from "./runtime.js";
import { PosixLoomService, type ExecuteOptions } from "./service.js";
import type { CommandCompletion, StateOutcome } from "./types.js";

/** 控制平面协议版本。hello 帧与每个请求都会声明协议版本，与本常量不一致即拒绝（fail closed）。 */
export const CONTROL_PROTOCOL_VERSION = 1;

/**
 * 控制平面的单个请求帧（解码后的 JSON 负载，尚未校验）。
 * 所有字段声明为可选：先以宽松类型接收不可信输入，再由 validId /
 * validateExecuteRequest 等守卫逐字段收紧，全部通过后才进入分发。
 */
interface ControlRequest {
  /** 请求声明的协议版本，必须等于 CONTROL_PROTOCOL_VERSION。 */
  protocolVersion?: number;
  /** 请求类型：session.create / session.snapshot / session.close / runtime.doctor / execute / cancel / shutdown。 */
  type?: string;
  /** 请求 id：必填、1..128 字符、同一连接内不可复用；用于关联响应与幂等去重。 */
  id?: string;
  /** cancel 专用：要取消的在途 execute 请求 id，且不得与自身 id 相同。 */
  targetId?: string;
  /** 会话类请求（execute / session.snapshot / session.close）的目标会话 id。 */
  sessionId?: string;
  /** 工作目录覆盖（虚拟路径）；session.create 未提供时默认 /workspace。 */
  cwd?: string;
  /** 命令超时（毫秒），必须为正整数。 */
  timeoutMs?: number;
  /** execute 专用：显式为 true 时在最终 result 前发送 started/output 事件。 */
  stream?: boolean;
  /** trace.list 专用：返回最近多少条内存 trace。 */
  limit?: number;
  /** execute/execute.plan 的 ConPTY 初始字符视口。 */
  terminal?: { columns?: number; rows?: number };
  /** terminal.input 的规范 Base64 输入字节。 */
  dataBase64?: string;
  /** terminal.resize 的字符视口。 */
  columns?: number;
  rows?: number;
  /** 状态提交策略：isolated 不提交会话状态；cwd-env 把 cwd/导出环境提交回会话。 */
  statePolicy?: "isolated" | "cwd-env";
  /** 环境变量增量：值为 string 表示设置，null 表示删除。 */
  envDelta?: Record<string, string | null>;
  /** execute 输入（判别联合）：argv 精确透传永不重解析；text 是唯一启用 Shell 语法的形态。 */
  input?: { kind: "text"; raw: string } | { kind: "argv"; argv: string[] };
}

/** 状态结果转 JSON 负载：仅 committed 分支需要把 bigint 版本号转为字符串，避免 JSON 序列化失败。 */
function jsonStateOutcome(outcome: StateOutcome): Record<string, unknown> {
  return outcome.kind === "committed" ? { ...outcome, newVersion: outcome.newVersion.toString() } : outcome;
}

/** 会话快照转 JSON 负载：bigint 版本号转字符串，cwd / exportedEnv 原样保留。 */
function jsonSessionState(state: { version: bigint; cwd: string; exportedEnv: Record<string, string> }): Record<string, unknown> {
  return { version: state.version.toString(), cwd: state.cwd, exportedEnv: state.exportedEnv };
}

/**
 * 命令完成结果转 JSON 负载。stdout/stderr 是任意二进制（可能是非 UTF-8 字节），
 * 不能直接放进 JSON，统一转 Base64（stdoutBase64 / stderrBase64），同时保留
 * 原始字节数与截断标记，Harness 侧可无损还原字节流并感知截断。
 */
function jsonCompletion(completion: CommandCompletion): Record<string, unknown> {
  return {
    command: completion.command,
    state: jsonStateOutcome(completion.state),
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

/** id 类字段（请求 id / 会话 id / targetId）的统一守卫：非空字符串且不超过 128 字符。 */
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** 抛出 CONTROL_REQUEST_INVALID 的快捷方式；返回类型 never 便于在守卫中直接调用以收窄类型。 */
function invalidRequest(message: string, details: Record<string, unknown> = {}): never {
  throw new PosixLoomError("CONTROL_REQUEST_INVALID", message, details);
}

/** 通过 validateExecuteRequest 校验后的 execute 请求视图：sessionId 必填，input 必为合法的判别联合。 */
type ValidExecuteRequest = ControlRequest & {
  sessionId: string;
  input: { kind: "text"; raw: string } | { kind: "argv"; argv: string[] };
};

/**
 * 全字段校验 execute 请求（fail closed：任何可疑字段立即抛 CONTROL_REQUEST_INVALID）。
 * 校验通过后通过 asserts 把请求收窄为 ValidExecuteRequest，后续分发即可安全取用字段。
 * @throws {PosixLoomError} CONTROL_REQUEST_INVALID - sessionId/input 缺失或任一可选字段类型不合法。
 */
function validateExecuteRequest(request: ControlRequest): asserts request is ValidExecuteRequest {
  // sessionId 与 input 是必填项：无会话的执行会绕过状态模型，必须先拒绝。
  if (!validId(request.sessionId) || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) {
    invalidRequest("execute requires sessionId and input");
  }
  if (request.cwd !== undefined && typeof request.cwd !== "string") invalidRequest("cwd must be a string");
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    invalidRequest("timeoutMs must be a positive integer");
  }
  if (request.stream !== undefined && typeof request.stream !== "boolean") invalidRequest("stream must be a boolean");
  if (request.terminal !== undefined) {
    if (!request.terminal || typeof request.terminal !== "object" || Array.isArray(request.terminal)) invalidRequest("terminal must be an object");
    try {
      validateTerminalSize({ columns: request.terminal.columns as number, rows: request.terminal.rows as number });
    } catch (error) {
      invalidRequest("terminal columns and rows must be integers between 1 and 32767", { cause: String(error) });
    }
  }
  if (request.statePolicy !== undefined && request.statePolicy !== "isolated" && request.statePolicy !== "cwd-env") {
    invalidRequest("statePolicy must be isolated or cwd-env");
  }
  if (request.envDelta !== undefined) {
    if (!request.envDelta || typeof request.envDelta !== "object" || Array.isArray(request.envDelta)) invalidRequest("envDelta must be an object");
    for (const [key, value] of Object.entries(request.envDelta)) {
      if (typeof value !== "string" && value !== null) invalidRequest("envDelta values must be strings or null", { key });
    }
  }
  // 判别联合逐分支校验：argv 必须是非空的全字符串数组（逐参数精确透传）；
  // text 的 raw 必须是字符串；未知 kind 一律拒绝，防止被静默当作脚本处理。
  if (request.input.kind === "argv") {
    if (!Array.isArray(request.input.argv) || request.input.argv.length === 0 || request.input.argv.some((argument) => typeof argument !== "string")) {
      invalidRequest("argv input must contain at least one string");
    }
  } else if (request.input.kind === "text") {
    if (typeof request.input.raw !== "string") invalidRequest("text input requires a string raw script");
  } else invalidRequest("unsupported execute input kind");
}

/** 控制协议边界上的规范 Base64 解码，拒绝 URL-safe/省略填充等歧义形式。 */
function decodeTerminalInput(value: unknown): Buffer {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalidRequest("dataBase64 must be canonical Base64");
  }
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) invalidRequest("dataBase64 must be canonical Base64");
  if (data.length > 64 * 1024) invalidRequest("terminal input cannot exceed 64 KiB", { bytes: data.length });
  return data;
}

/**
 * 启动 Harness 控制平面：在 input / output 之间以帧协议处理请求，直至对端
 * 关闭、收到 shutdown 或输出侧失效。
 *
 * @param runtime 已就绪的运行时管理器（控制平面自身不做运行时恢复，恢复逻辑在 CLI 入口）。
 * @param input   Harness -> PosixLoom 的请求流（通常为子进程 stdin）。
 * @param output  PosixLoom -> Harness 的响应流（通常为子进程 stdout）。
 * @returns 连接正常结束（输入 EOF 或 shutdown）时 resolve；读循环或输出侧
 *          出现致命错误时 reject（如 CONTROL_OUTPUT_CLOSED），由 CLI 入口
 *          兜底并映射为进程退出码。
 *
 * 生命周期：先发 hello 帧（帧上限 + 能力集）完成握手 -> 循环解码输入并为
 * 每个请求派发独立任务 -> 收尾时 abort 全部在途命令、等待任务与写入落定，
 * 最后向调用方抛出读 / 写两侧记录到的致命错误。
 */
export async function serveControlPlane(runtime: RuntimeManager, input: Readable, output: Writable): Promise<void> {
  const service = new PosixLoomService(runtime);
  const decoder = new NativeFrameDecoder();
  // 写通道串行化：writeLane 永远指向「最后一个已排队的写入」，所有响应帧按
  // 到达顺序依次写出，保证帧与帧之间不交错。
  let writeLane = Promise.resolve();
  // 置位后停止接收新请求，进入收尾阶段（shutdown / 输出失效 / 输入结束）。
  let closing = false;
  // 在途 execute：请求 id -> AbortController；cancel / shutdown / 断连时统一触发。
  const inflight = new Map<string, AbortController>();
  // 当前连接上的交互终端：execute 请求 id -> 运行期输入控制器。
  const terminals = new Map<string, InteractiveProcessController>();
  // 本连接已用过的请求 id，用于同连接去重（重试语义由 Harness 换新 id 保证）。
  const requestIds = new Set<string>();
  // 全部在途请求任务（fire-and-forget），退出前用 allSettled 等待落定。
  const tasks = new Set<Promise<void>>();
  // 首个输出侧致命错误；一经记录即视为连接已死，后续写入全部拒绝。
  let outputFailure: Error | undefined;
  // 中止全部在途命令（Harness 已不可达，继续执行只会浪费资源并留下孤儿进程）。
  const abortInflight = (): void => {
    for (const controller of inflight.values()) controller.abort();
  };
  // 输出侧失效的唯一入口：只记录首个错误（幂等），随后 abort 在途命令并销毁
  // 输入流，让读循环尽快退出。
  const failOutput = (error: unknown): void => {
    if (outputFailure) return;
    outputFailure = error instanceof Error ? error : new Error(String(error));
    closing = true;
    abortInflight();
    input.destroy();
  };
  // 输出流关闭（Harness 主动断开）同样视作输出失效。
  const outputClosed = (): void => failOutput(new PosixLoomError("CONTROL_OUTPUT_CLOSED", "Harness control output closed"));
  output.on("error", failOutput);
  output.on("close", outputClosed);
  /**
   * 发送一帧响应：先在 writeLane 队尾排队实现写入串行化，再以回调式 write
   * 确认落盘。输出已失效则直接拒绝；底层写入出错会触发 failOutput 并向上抛。
   * 每帧自动附加当前协议版本，Harness 侧可据此校验。
   */
  const send = (value: Record<string, unknown>): Promise<void> => {
    const write = writeLane.then(async () => {
      if (outputFailure || output.destroyed) throw outputFailure ?? new PosixLoomError("CONTROL_OUTPUT_CLOSED", "Harness control output is unavailable");
      const frame = encodeNativeFrame({ protocolVersion: CONTROL_PROTOCOL_VERSION, ...value });
      await new Promise<void>((resolve, reject) => {
        output.write(frame, (error) => {
          if (error) {
            failOutput(error);
            reject(error);
          } else resolve();
        });
      });
    });
    // 队列指针无条件前移（吞掉错误）：单个帧写失败不应阻塞后续帧的尝试。
    writeLane = write.catch(() => undefined);
    return write;
  };

  /**
   * 处理单个已解码的请求：先依次通过 id 合法性、同连接去重、协议版本、
   * type 必填四道门禁，再按 type 分发。分发体内任何异常都由末尾 catch 统一
   * 转为带请求 id 的 error 帧，单个请求失败不会拖垮整个连接。
   */
  const handle = async (request: ControlRequest): Promise<void> => {
    const id = request.id;
    // id 必填且 1..128 字符：它是响应关联与去重的唯一依据，不可妥协。
    if (!validId(id)) {
      await send({ type: "error", id, code: "CONTROL_REQUEST_INVALID", message: "Request id is required and must be at most 128 characters" });
      return;
    }
    // 同连接 id 去重：重试必须换新 id，复用旧 id 视为协议错误（fail closed）。
    if (requestIds.has(id)) {
      await send({ type: "error", id, code: "CONTROL_REQUEST_DUPLICATE_ID", message: "Request id was already used on this connection" });
      return;
    }
    // 先登记再继续校验：即使后续字段非法导致失败，这个 id 也已消耗，重发必须换新 id。
    requestIds.add(id);
    // 协议版本不匹配直接拒绝，避免新旧协议语义混淆。
    if (request.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
      await send({ type: "error", id, code: "CONTROL_PROTOCOL_MISMATCH", message: "Unsupported control protocol version" });
      return;
    }
    if (!request.type) {
      await send({ type: "error", id, code: "CONTROL_REQUEST_INVALID", message: "Request type is required" });
      return;
    }
    try {
      // 会话管理类请求：cwd 合法时透传给服务层，未提供则默认 /workspace。
      if (request.type === "session.create") {
        if (request.cwd !== undefined && typeof request.cwd !== "string") invalidRequest("cwd must be a string");
        const sessionId = service.createSession(request.cwd ?? "/workspace");
        await send({ type: "result", id, result: { sessionId, state: jsonSessionState(service.sessionSnapshot(sessionId)) } });
        return;
      }
      // 会话快照：bigint 版本号转字符串后再入 JSON。
      if (request.type === "session.snapshot") {
        if (!validId(request.sessionId)) invalidRequest("sessionId is required");
        const state = service.sessionSnapshot(request.sessionId);
        await send({ type: "result", id, result: { ...state, version: state.version.toString() } });
        return;
      }
      // 关闭会话：由服务层负责清理当前进程内的 cwd / exported env 状态。
      if (request.type === "session.close") {
        if (!validId(request.sessionId)) invalidRequest("sessionId is required");
        service.sessions.close(request.sessionId);
        await send({ type: "result", id, result: { closed: true } });
        return;
      }
      // 运行时体检：直接透传 doctor 报告，Harness 据此决定是否触发更新/回滚。
      if (request.type === "runtime.doctor") {
        await send({ type: "result", id, result: runtime.doctor() });
        return;
      }
      // 运行时摘要：不执行外部命令，返回快照、挂载、后端路径与注册表命令。
      if (request.type === "runtime.info") {
        await send({ type: "result", id, result: runtime.info() });
        return;
      }
      // 当前服务进程的内存 trace；持久化 trace 由 CLI 从 JSONL 尾部读取。
      if (request.type === "trace.list") {
        const limit = request.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000) invalidRequest("limit must be an integer between 1 and 5000");
        await send({ type: "result", id, result: { events: service.traces().slice(-limit) } });
        return;
      }
      // 计划预览与 execute 共用服务层准备管道，但不会创建子进程或提交会话状态。
      if (request.type === "execute.plan") {
        validateExecuteRequest(request);
        const options: ExecuteOptions = request.input.kind === "argv"
          ? { kind: "argv", argv: request.input.argv, sessionId: request.sessionId, cwd: request.cwd, envDelta: request.envDelta, statePolicy: request.statePolicy, timeoutMs: request.timeoutMs, terminal: request.terminal as { columns: number; rows: number } | undefined }
          : { kind: "text", raw: request.input.raw, sessionId: request.sessionId, cwd: request.cwd, envDelta: request.envDelta, statePolicy: request.statePolicy, timeoutMs: request.timeoutMs, terminal: request.terminal as { columns: number; rows: number } | undefined };
        await send({ type: "result", id, result: await service.explain(options) });
        return;
      }
      // 交互终端的运行期输入：targetId 指向尚在运行的 execute 请求。
      if (request.type === "terminal.input") {
        if (!validId(request.targetId)) invalidRequest("terminal.input requires targetId");
        const terminal = terminals.get(request.targetId);
        if (!terminal) throw new PosixLoomError("TERMINAL_NOT_FOUND", `No interactive terminal for request: ${request.targetId}`);
        const data = decodeTerminalInput(request.dataBase64);
        await terminal.write(data);
        await send({ type: "result", id, result: { targetId: request.targetId, acceptedBytes: data.length } });
        return;
      }
      if (request.type === "terminal.resize") {
        if (!validId(request.targetId)) invalidRequest("terminal.resize requires targetId");
        const terminal = terminals.get(request.targetId);
        if (!terminal) throw new PosixLoomError("TERMINAL_NOT_FOUND", `No interactive terminal for request: ${request.targetId}`);
        try {
          validateTerminalSize({ columns: request.columns as number, rows: request.rows as number });
        } catch (error) {
          invalidRequest("columns and rows must be integers between 1 and 32767", { cause: String(error) });
        }
        await terminal.resize(request.columns!, request.rows!);
        await send({ type: "result", id, result: { targetId: request.targetId, resized: true } });
        return;
      }
      if (request.type === "terminal.eof") {
        if (!validId(request.targetId)) invalidRequest("terminal.eof requires targetId");
        const terminal = terminals.get(request.targetId);
        if (!terminal) throw new PosixLoomError("TERMINAL_NOT_FOUND", `No interactive terminal for request: ${request.targetId}`);
        await terminal.end();
        await send({ type: "result", id, result: { targetId: request.targetId, closed: true } });
        return;
      }
      // execute：核心命令执行。先做全字段校验，再注册取消句柄，最后按输入
      // 形态构造执行选项（argv 与 text 是判别联合，各自映射到对应的执行选项）。
      if (request.type === "execute") {
        validateExecuteRequest(request);
        if (request.terminal && request.stream !== true) invalidRequest("interactive terminal execution requires stream=true");
        // 注册 AbortController，使 cancel / shutdown / 断连都能中止这条在途命令。
        const controller = new AbortController();
        inflight.set(id, controller);
        const interactive = request.terminal ? new InteractiveProcessController() : undefined;
        if (interactive) terminals.set(id, interactive);
        // argv：逐参数精确透传；text：脚本文本，唯一启用 Shell 语法。其余选项原样透传。
        const options: ExecuteOptions = request.input.kind === "argv"
          ? { kind: "argv", argv: request.input.argv, sessionId: request.sessionId, cwd: request.cwd, envDelta: request.envDelta, statePolicy: request.statePolicy, timeoutMs: request.timeoutMs, signal: controller.signal, terminal: request.terminal as { columns: number; rows: number } | undefined, interactive }
          : { kind: "text", raw: request.input.raw, sessionId: request.sessionId, cwd: request.cwd, envDelta: request.envDelta, statePolicy: request.statePolicy, timeoutMs: request.timeoutMs, signal: controller.signal, terminal: request.terminal as { columns: number; rows: number } | undefined, interactive };
        try {
          const completion = await service.execute(options, request.stream
            ? {
              onStarted: async (preview) => send({
                type: "event",
                id,
                event: "started",
                planId: preview.planId,
                backend: preview.backend,
              }),
              onOutput: async (event) => send({
                type: "event",
                id,
                event: "output",
                sequence: event.sequence,
                stream: event.stream,
                dataBase64: event.data.toString("base64"),
              }),
            }
            : {});
          // 输出统一走 jsonCompletion：stdout/stderr 转 Base64、bigint 版本转字符串。
          await send({ type: "result", id, result: jsonCompletion(completion) });
        } finally {
          // 命令结束（完成或失败）后注销取消句柄，避免 cancel 命中已完成的请求。
          inflight.delete(id);
          terminals.delete(id);
          interactive?.terminate();
        }
        return;
      }
      // cancel：中止另一条在途 execute。targetId 必填且不得等于自身 id
      //（自取消没有意义，且容易形成无意义的请求对）。
      if (request.type === "cancel") {
        if (!validId(request.targetId)) invalidRequest("cancel requires targetId");
        if (request.targetId === id) invalidRequest("cancel id must differ from targetId");
        const target = inflight.get(request.targetId);
        // 目标不存在（已结束或从未存在）则幂等地返回 cancelling:false。
        target?.abort();
        await send({ type: "result", id, result: { targetId: request.targetId, cancelling: Boolean(target) } });
        return;
      }
      // shutdown：停止接收新请求、中止全部在途命令，并回执确认帧（尽力送达）。
      if (request.type === "shutdown") {
        closing = true;
        for (const controller of inflight.values()) controller.abort();
        await send({ type: "result", id, result: { shuttingDown: true } });
        return;
      }
      // 未知请求类型 fail closed，回 CONTROL_REQUEST_UNKNOWN。
      await send({ type: "error", id, code: "CONTROL_REQUEST_UNKNOWN", message: `Unknown request type: ${request.type}` });
    } catch (error) {
      // 统一异常出口：包装为 PosixLoomError 后回 error 帧（默认码 CONTROL_REQUEST_FAILED）。
      const posixloomError = asPosixLoomError(error, "CONTROL_REQUEST_FAILED");
      await send({ type: "error", id, code: posixloomError.code, message: posixloomError.message, details: posixloomError.details });
    }
  };

  // 读循环自身的致命错误（解码器抛错等），与输出侧错误分开记录。
  let serviceError: unknown;
  try {
    // 握手帧：宣告帧上限与能力集，Harness 在发送第一个请求前即可完成协商。
    await send({
      type: "hello",
      maxFrameBytes: NATIVE_MAX_FRAME_BYTES,
      capabilities: ["session", "argv", "shell", "cancel", "runtime-doctor", "runtime-info", "execute-plan", "stream-output-v1", "trace-list", "pty-v1"],
    });
    controlLoop: for await (const chunk of input) {
      // 已进入收尾（shutdown / 输出失效）则不再读取新数据。
      if (closing) break;
      // 逐块喂给帧解码器：一个 chunk 可能解出多个帧，也可能暂时凑不满一个帧。
      const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      for (const frame of frames) {
        // 畸形帧（非 JSON 对象）fail closed：拒绝该帧但不断开连接，给 Harness 纠错机会。
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
          await send({ type: "error", code: "CONTROL_REQUEST_INVALID", message: "Control frame must be a JSON object" });
          continue;
        }
        // fire-and-forget：请求处理与读循环解耦，慢命令不会阻塞后续请求的接收。
        const task = handle(frame as ControlRequest);
        tasks.add(task);
        void task.then(() => tasks.delete(task), () => tasks.delete(task));
        if (closing) break controlLoop;
      }
    }
    // 输入自然结束时校验解码器无半帧残留（残留则抛 NATIVE_FRAME_TRUNCATED）。
    decoder.finish();
  } catch (error) {
    serviceError = error;
  } finally {
    // 收尾三步：不再接收请求 -> abort 全部在途命令 -> 等待任务与写入落定。
    closing = true;
    abortInflight();
    await Promise.allSettled(tasks);
    // 等待最后一个已排队的写入完成，尽量把已生成的响应送达对端。
    await writeLane;
    // 移除输出监听，避免进程退出阶段的 close 事件再触发 failOutput。
    output.off("error", failOutput);
    output.off("close", outputClosed);
  }
  // 读 / 写两侧任一致命错误都向上抛，由 CLI 入口决定进程退出码。
  if (serviceError) throw serviceError;
  if (outputFailure) throw outputFailure;
}
