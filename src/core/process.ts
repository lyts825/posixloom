/**
 * process.ts —— PosixLoom 进程执行引擎（双后端：Rust Native Host / Node 回退）。
 *
 * 职责：
 * - 提供统一入口 runProcess()，把一次命令执行分派到原生宿主路径或 Node 回退路径；
 * - 负责子进程的创建、stdin 注入、stdout/stderr 采集、超时与取消、进程树终止；
 * - 把执行结果归一化为 ProcessRunResult（outcome / 输出缓冲 / 真实字节数 /
 *   截断标记 / 后端模式），供 service 等上层无差别消费。
 *
 * 设计意图：
 *
 * 1. 为什么用帧协议：宿主事件需要携带二进制输出，而 JSON 不能内嵌任意字节，
 *    管道本身又是无边界的字节流。因此约定「4 字节小端长度 + UTF-8 JSON
 *    payload」的定界帧（encodeNativeFrame / NativeFrameDecoder）：长度前缀让
 *    解码无需扫描分隔符，也能在读到长度头时立刻拒绝超限帧；二进制数据以
 *    规范 Base64 嵌入 JSON 字段（decodeCanonicalBase64）。
 *
 * 2. 为什么是严格事件状态机、fail-closed（NativeEventValidator）：Native Host
 *    的输出属于不可信边界——宿主可能损坏、被替换或与本侧版本不一致。协议
 *    规定唯一合法序列 hello -> started -> (stdout|stderr)* -> (exit|error)，
 *    任何乱序、重复、缺字段、未知类型都立即抛 NATIVE_PROTOCOL_INVALID。
 *    宁可判失败也绝不静默容忍畸形输入，避免把半截输出或伪造的退出码当成
 *    真实结果交给上层。
 *
 * 3. 为什么输出做头尾截断（OutputCollector）：命令输出可能无限大（如 cat 一个
 *    巨型文件），全量缓存会拖垮内存。收集器在恒定内存占用下保留前半（head）
 *    + 后半（tail），中间插入 "\n[PosixLoom OUTPUT TRUNCATED]\n" 让下游明确感知
 *    中间被丢弃；totalBytes 另行累计真实总量，因此 stdoutBytes/stderrBytes
 *    反映进程真实产出规模而非截断后大小。
 *
 * 4. 为什么分派双后端（runProcess）：优先走 Rust 宿主，由宿主负责
 *    CreateProcessW(CREATE_SUSPENDED) 挂起创建子进程、放入 Job Object
 *    （AssignProcessToJobObject），超时/取消时 TerminateJobObject 强杀整棵
 *    进程树，可靠杜绝孤儿进程；TypeScript 只负责协议与结果解释。当宿主缺失，
 *    或命令需要 reportFd（报告描述符管道，由 service 层消费）时，回退到
 *    Node spawn 路径；Windows 上该路径用 taskkill /T /F 近似实现进程树终止。
 *
 * 5. 为什么需要看门狗：宿主本身也可能挂死（不发事件也不退出）。TS 侧用
 *    timeoutMs + 宽限期的定时器兜底，到点强制 kill 宿主并以 crashed 收场，
 *    保证 runProcess 永远会 settle，不会把调用方吊死。
 */
import { spawn } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readSync, rmSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { PosixLoomError } from "./errors.js";
import type { CommandOutcome, HostPath, TerminalSize } from "./types.js";

/**
 * Native Host 帧协议版本。双方在每个事件帧的 protocolVersion 字段上互验，
 * 不一致立即报 NATIVE_PROTOCOL_MISMATCH，防止新旧版本的宿主二进制混用。
 */
export const NATIVE_PROTOCOL_VERSION = 1;

/**
 * 单帧 payload 的硬上限（16 MB）。编码侧与解码侧都以此为边界，
 * 超限即抛 NATIVE_FRAME_TOO_LARGE，杜绝用伪造长度头放大内存占用。
 */
export const NATIVE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * 进程执行请求。
 *
 * - program/args/cwd/env：目标程序、参数、工作目录与最小环境变量集。
 * - timeoutMs：硬超时；到期终止进程树（native 路径由宿主执行，node 路径本地执行）。
 * - cancelGraceMs：取消/超时后先温和终止，超过宽限期仍存活则强杀；默认 2000ms。
 * - input：写入子进程 stdin 的内容，写完即关闭写入端（EOF）。
 * - reportFd：为子进程开放 fd=3 作为报告通道（state-report 用，仅 Node 路径支持）。
 * - reportPath：报告文件路径（部分命令把报告落盘而非走 fd），结束时读取并删除。
 * - hostPath：Rust Native Host 可执行文件路径；提供且无需 reportFd 时走原生路径。
 * - signal：外部取消信号，触发即取消整次执行。
 * - maxOutputBytes：stdout/stderr 各自的采集上限，超出按头尾截断策略丢弃。
 * - outputDrainTimeoutMs：进程退出后等待异步输出接收器的硬上限。
 * - maxReportBytes：StateReport 文件或 fd 数据的硬上限。
 */
export interface ProcessRunOptions {
  program: HostPath;
  args: string[];
  cwd: HostPath;
  env: Record<string, string>;
  timeoutMs: number;
  cancelGraceMs?: number;
  input?: string | Buffer;
  reportFd?: boolean;
  reportPath?: string;
  hostPath?: HostPath;
  signal?: AbortSignal;
  maxOutputBytes: number;
  outputDrainTimeoutMs?: number;
  maxReportBytes?: number;
  /**
   * 可选的实时输出接收器。返回的 Promise 在读取更多子进程输出前被等待，
   * 从而把下游写入速度作为背压传回进程管道。
   */
  onOutput?: (event: ProcessOutputEvent) => void | Promise<void>;
  /** 伪终端初始大小；提供时必须同时提供 Native Host。 */
  terminal?: TerminalSize;
  /** 运行期标准输入/EOF/窗口大小控制通道。 */
  interactive?: InteractiveProcessController;
}

/** 实时输出事件；sequence 在 stdout/stderr 两路之间统一单调递增。 */
export interface ProcessOutputEvent {
  sequence: number;
  stream: "stdout" | "stderr";
  data: Buffer;
}

/** Native Host 在进程运行期接受的交互控制事件。 */
export type InteractiveControlEvent =
  | { type: "input"; data: Buffer }
  | { type: "resize"; columns: number; rows: number }
  | { type: "eof" };

type InteractiveSink = (event: InteractiveControlEvent) => void | Promise<void>;

interface PendingInteractiveEvent {
  event: InteractiveControlEvent;
  bytes: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const MAX_PENDING_INTERACTIVE_BYTES = 1024 * 1024;
const MAX_PENDING_INTERACTIVE_EVENTS = 256;

/**
 * 可在命令启动前接收输入的交互控制器。
 * CLI/Harness 与进程启动是并发的，因此在 Native Host 附加 sink 前
 * 到达的少量输入会有界缓冲；附加后所有事件经 Promise lane 严格保序，
 * 且未送达的输入在整个生命周期内都受 1 MiB / 256 事件双重上限约束。
 */
export class InteractiveProcessController {
  private sink?: InteractiveSink;
  private readonly pending: PendingInteractiveEvent[] = [];
  private pendingBytes = 0;
  private pendingEvents = 0;
  private lane: Promise<void> = Promise.resolve();
  private inputEnded = false;
  private endPromise?: Promise<void>;
  private terminalError?: Error;

  private enqueue(event: InteractiveControlEvent, bytes = 0): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pendingBytes + bytes > MAX_PENDING_INTERACTIVE_BYTES || this.pendingEvents >= MAX_PENDING_INTERACTIVE_EVENTS) {
      return Promise.reject(new PosixLoomError(
        "TERMINAL_INPUT_BUFFER_FULL",
        "Interactive input exceeded the pending delivery limit",
        { pendingBytes: this.pendingBytes, pendingEvents: this.pendingEvents },
      ));
    }
    this.pendingBytes += bytes;
    this.pendingEvents += 1;
    if (this.sink) return this.deliver(event, bytes);
    return new Promise<void>((resolve, reject) => this.pending.push({ event, bytes, resolve, reject }));
  }

  private deliver(event: InteractiveControlEvent, bytes: number): Promise<void> {
    const sink = this.sink;
    if (!sink) return Promise.reject(new PosixLoomError("TERMINAL_NOT_ATTACHED", "Interactive process is not attached"));
    const delivery = this.lane.then(() => sink(event));
    const tracked = delivery.finally(() => {
      this.pendingBytes -= bytes;
      this.pendingEvents -= 1;
    });
    this.lane = tracked.catch(() => undefined);
    return tracked;
  }

  /** 写入一段原始终端输入（单次上限 64 KiB）。 */
  write(data: Buffer | string): Promise<void> {
    if (this.inputEnded) return Promise.reject(new PosixLoomError("TERMINAL_INPUT_CLOSED", "Interactive input is already closed"));
    const chunk = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data);
    if (!chunk.length) return Promise.resolve();
    if (chunk.length > MAX_STREAM_CHUNK_BYTES) {
      return Promise.reject(new PosixLoomError("TERMINAL_INPUT_TOO_LARGE", "A terminal input event cannot exceed 64 KiB", { bytes: chunk.length }));
    }
    return this.enqueue({ type: "input", data: chunk }, chunk.length);
  }

  /** 通知子进程终端输入已结束。 */
  end(): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.inputEnded = true;
    const attempt = this.enqueue({ type: "eof" });
    const tracked = attempt.catch((error) => {
      if (this.endPromise === tracked) {
        this.inputEnded = false;
        this.endPromise = undefined;
      }
      throw error;
    });
    this.endPromise = tracked;
    return tracked;
  }

  /** 更新伪终端字符视口。 */
  resize(columns: number, rows: number): Promise<void> {
    validateTerminalSize({ columns, rows });
    return this.enqueue({ type: "resize", columns, rows });
  }

  /** @internal 由进程后端附加唯一 sink，并冲刷启动前队列。 */
  attach(sink: InteractiveSink): void {
    if (this.sink) throw new PosixLoomError("TERMINAL_ALREADY_ATTACHED", "Interactive controller is already attached");
    if (this.terminalError) throw this.terminalError;
    this.sink = sink;
    for (const pending of this.pending.splice(0)) {
      void this.deliver(pending.event, pending.bytes).then(pending.resolve, pending.reject);
    }
  }

  /** @internal 终止控制器并拒绝所有尚未送达的输入。 */
  terminate(error: Error = new PosixLoomError("TERMINAL_CLOSED", "Interactive process has ended")): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.sink = undefined;
    for (const pending of this.pending.splice(0)) {
      this.pendingBytes -= pending.bytes;
      this.pendingEvents -= 1;
      pending.reject(error);
    }
  }
}

/** 校验 ConPTY 支持的正整数字符视口。 */
export function validateTerminalSize(size: TerminalSize): void {
  if (!Number.isSafeInteger(size.columns) || !Number.isSafeInteger(size.rows) || size.columns <= 0 || size.rows <= 0 || size.columns > 32767 || size.rows > 32767) {
    throw new PosixLoomError("TERMINAL_SIZE_INVALID", "Terminal columns and rows must be integers between 1 and 32767", { ...size });
  }
}

/**
 * 进程执行结果。两种后端产出同一形状，上层无需感知差异。
 */
export interface ProcessRunResult {
  /** 终局判定：exited / timed-out / cancelled / crashed / spawn-failed。 */
  outcome: CommandOutcome;
  /** 截断后的 stdout（若发生截断，内含 [PosixLoom OUTPUT TRUNCATED] 分隔标记）。 */
  stdout: Buffer;
  /** 截断后的 stderr。 */
  stderr: Buffer;
  /** 报告数据：优先读 reportPath 文件，否则回退 reportFd 管道内容，皆无则为空 Buffer。 */
  report: Buffer;
  /** stdout 真实总字节数（截断前口径），反映进程实际产出规模。 */
  stdoutBytes: number;
  /** stderr 真实总字节数（截断前口径）。 */
  stderrBytes: number;
  /** stdout 或 stderr 任一发生截断即为 true。 */
  truncated: boolean;
  /** 实际使用的后端：native-host（Rust 宿主）或 node-fallback（Node 直启）。 */
  processMode: "native-host" | "node-fallback";
}

/**
 * 头尾截断式输出收集器。
 *
 * 为什么头尾截断：诊断价值往往集中在输出开头（命令头、配置回显、早期错误）
 * 与结尾（错误摘要、退出信息），只保留头部会丢掉最有价值的尾部，全量保留又
 * 会爆内存。因此在恒定内存占用下保留 headLimit + tailLimit 字节，超出部分
 * 丢弃，并在 finish() 时于两段之间插入 "\n[PosixLoom OUTPUT TRUNCATED]\n" 标记，
 * 让下游能明确感知中间有内容被丢弃。
 *
 * totalBytes 始终按真实字节数累计（与保留策略无关），因此结果里的
 * stdoutBytes/stderrBytes 反映进程真实产出规模而非截断后大小。
 */
export class OutputCollector {
  /** 头部保留上限（maxBytes 上取整一半）。 */
  private readonly headLimit: number;
  /** 尾部保留上限（maxBytes 下取整一半，保证 head+tail 不超过 maxBytes）。 */
  private readonly tailLimit: number;
  /** 头部分片缓冲（只追加最前面的 headLimit 字节）。 */
  private readonly head: Buffer[] = [];
  /** 尾部滚动窗口：始终只保留最近 tailLimit 字节。 */
  private tail = Buffer.alloc(0);
  /** 头部已累积的字节数。 */
  private headBytes = 0;
  /** 真实总字节数（未截断口径）。 */
  totalBytes = 0;

  /**
   * @param maxBytes stdout/stderr 各自的采集上限（正整数）。
   * @throws {PosixLoomError} OUTPUT_LIMIT_INVALID - maxBytes 不是正整数时。
   */
  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new PosixLoomError("OUTPUT_LIMIT_INVALID", "maxOutputBytes must be a positive integer", { maxBytes });
    this.headLimit = Math.ceil(maxBytes / 2);
    this.tailLimit = Math.floor(maxBytes / 2);
  }

  /**
   * 追加一段输出。头部配额未满时尽量吸收（可能整段收下）；头部已满后，
   * 后续数据只滚动更新尾部窗口，被挤出的中间字节即被丢弃。
   */
  push(chunk: Buffer): void {
    // 空分片无信息量，跳过以免白做一次窗口平移。
    if (!chunk.length) return;
    // 无论是否保留都计入真实总量。
    this.totalBytes += chunk.length;
    let remainder = chunk;
    if (this.headBytes < this.headLimit) {
      // 头部配额还剩 headLimit - headBytes 字节，本段最多吸收这么多。
      const takeLength = Math.min(remainder.length, this.headLimit - this.headBytes);
      const take = remainder.subarray(0, takeLength);
      this.head.push(take);
      this.headBytes += take.length;
      remainder = remainder.subarray(takeLength);
    }
    // 剩余部分并入尾部窗口后只留最近 tailLimit 字节（滚动截断）。
    if (remainder.length && this.tailLimit > 0) this.tail = Buffer.concat([this.tail, remainder]).subarray(-this.tailLimit);
  }

  /**
   * 结束采集并拼装最终数据。
   * @returns data 为拼接结果；truncated 表示真实总量超过 maxBytes
   *          （此时在 head 与 tail 之间插入截断标记，否则两段恰好无缝衔接）。
   */
  finish(): { data: Buffer; truncated: boolean } {
    const truncated = this.totalBytes > this.maxBytes;
    if (!truncated) return { data: Buffer.concat([...this.head, this.tail]), truncated: false };
    return { data: Buffer.concat([...this.head, Buffer.from("\n[PosixLoom OUTPUT TRUNCATED]\n"), this.tail]), truncated: true };
  }
}

/**
 * 把任意可 JSON 序列化的值编码为一帧：4 字节小端长度头 + UTF-8 JSON payload。
 * 长度前缀让对端无需分隔符扫描即可定界，同时也是 NATIVE_MAX_FRAME_BYTES
 * 的编码侧强制点。
 * @throws {PosixLoomError} NATIVE_FRAME_TOO_LARGE - payload 超过协议单帧上限。
 */
export function encodeNativeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  // 发送侧同样受限，避免构造出对端必然拒绝的帧。
  if (payload.length > NATIVE_MAX_FRAME_BYTES) throw new PosixLoomError("NATIVE_FRAME_TOO_LARGE", "Native Host frame exceeds the protocol limit", { bytes: payload.length });
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * 流式帧解码器：把宿主 stdout 上连续到达的字节切回一组 JSON 值。
 *
 * 管道是无边界的字节流，解码器在内部缓冲区中凑满完整的
 * 「4 字节长度 + payload」才解析一帧，不足一帧则留待下一个 chunk；
 * 流结束时用 finish() 断言没有残留的半帧。
 */
export class NativeFrameDecoder {
  /** 跨 chunk 的残留字节（可能含一个不完整的帧）。 */
  private buffer = Buffer.alloc(0);

  /**
   * 喂入新字节，返回本批次完整解出的全部 JSON 值（可能为空数组）。
   * @throws {PosixLoomError} NATIVE_FRAME_TOO_LARGE - 长度头声明超过协议上限。
   * @throws {PosixLoomError} NATIVE_FRAME_INVALID - payload 不是合法 JSON。
   */
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    // 只要缓冲区还容得下一个 4 字节长度头，就继续尝试切帧。
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      // 长度头先行校验：无需等到 payload 到齐就能拒绝超大帧（fail-closed）。
      if (length > NATIVE_MAX_FRAME_BYTES) throw new PosixLoomError("NATIVE_FRAME_TOO_LARGE", "Native Host sent an oversized frame", { bytes: length });
      // 帧体还没收全：跳出，等下一个 chunk 补齐。
      if (this.buffer.length < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4);
      // 消费掉这一帧，缓冲区只剩残余字节。
      this.buffer = this.buffer.subarray(length + 4);
      try {
        frames.push(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        throw new PosixLoomError("NATIVE_FRAME_INVALID", "Native Host sent invalid JSON", { cause: String(error) });
      }
    }
    return frames;
  }

  /**
   * 流结束时的完整性检查。
   * @throws {PosixLoomError} NATIVE_FRAME_TRUNCATED - 宿主在半帧处断流，缓冲区有残留。
   */
  finish(): void {
    if (this.buffer.length) throw new PosixLoomError("NATIVE_FRAME_TRUNCATED", "Native Host closed with a partial frame", { bytes: this.buffer.length });
  }
}

/**
 * 把可读流的 data 事件转发给收集器；chunk 可能是字符串（未设置编码时），
 * 统一转成 Buffer。也可传入自定义 push 复用本函数（如报告 fd 的无截断收集）。
 */
function pipeReadable(stream: Readable | null, collector: { push(chunk: Buffer): void }): void {
  if (!stream) return;
  stream.on("data", (chunk: Buffer | string) => collector.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
}

/** 单个控制协议输出事件的最大原始字节数，Base64 后仍远低于 16 MiB 帧上限。 */
const MAX_STREAM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS = 5000;
const DEFAULT_MAX_REPORT_BYTES = 1024 * 1024;

/**
 * 把同步到达的 stdout/stderr 分片串行转发给异步接收器。
 *
 * 第一个待发送事件入队时暂停上游；队列完全排空后恢复。这样慢 Harness
 * 不会让 Promise 写队列无限积累。接收器异常只通知一次，由进程后端终止
 * 子进程并把结果收敛为 OUTPUT_SINK_FAILED。
 */
class ProcessOutputForwarder {
  private sequence = 0;
  private pending = 0;
  private lane: Promise<void> = Promise.resolve();
  private sinkFailure: unknown;

  constructor(
    private readonly sink: ProcessRunOptions["onOutput"],
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  private fail(error: unknown): void {
    if (this.sinkFailure !== undefined) return;
    this.sinkFailure = error;
    this.onFailure(error);
  }

  push(stream: ProcessOutputEvent["stream"], data: Buffer): void {
    if (!this.sink || !data.length || this.sinkFailure) return;
    for (let offset = 0; offset < data.length; offset += MAX_STREAM_CHUNK_BYTES) {
      const chunk = Buffer.from(data.subarray(offset, Math.min(offset + MAX_STREAM_CHUNK_BYTES, data.length)));
      const event: ProcessOutputEvent = { sequence: this.sequence++, stream, data: chunk };
      this.pending += 1;
      if (this.pending === 1) this.pause();
      this.lane = this.lane
        .then(() => this.sinkFailure === undefined ? this.sink?.(event) : undefined)
        .catch((error) => {
          this.fail(error);
        })
        .then(() => {
          this.pending -= 1;
          if (this.pending === 0) this.resume();
        });
    }
  }

  async drain(timeoutMs: number): Promise<void> {
    if (this.pending === 0) {
      await this.lane;
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.lane,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.fail(new PosixLoomError("OUTPUT_SINK_TIMEOUT", "Output sink did not drain before the configured deadline", { timeoutMs }));
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  get failed(): boolean {
    return this.sinkFailure !== undefined;
  }
}

/**
 * 读取并删除报告文件。报告是一次性产物（state-report 落盘后即被消费），
 * 无论读取成功与否都尽力清理，避免临时目录残留；文件不存在时返回
 * fallback（例如 reportFd 管道已收集到的内容）。IO 失败作为数据返回，
 * 由执行收口映射为 REPORT_IO_FAILED，不能让结果 Promise 悬空。
 */
function reportTooLarge(bytes: number, maximum: number): PosixLoomError {
  return new PosixLoomError("REPORT_TOO_LARGE", "StateReport exceeds the configured byte limit", { bytes, maximum });
}

function readAndRemoveReport(
  path: string | undefined,
  fallback = Buffer.alloc(0),
  maximum = DEFAULT_MAX_REPORT_BYTES,
  fallbackError?: unknown,
): { data: Buffer; error?: unknown } {
  let data = fallback;
  let failure = fallbackError;
  if (fallback.length > maximum) {
    data = Buffer.alloc(0);
    failure ??= reportTooLarge(fallback.length, maximum);
  }
  if (!path) return { data, error: failure };
  let descriptor: number | undefined;
  let missing = false;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) throw new PosixLoomError("REPORT_FILE_INVALID", "StateReport path must be a regular file", { path });
    if (metadata.size > maximum) throw reportTooLarge(metadata.size, maximum);
    descriptor = openSync(path, "r");
    const openedMetadata = fstatSync(descriptor);
    if (!openedMetadata.isFile()) throw new PosixLoomError("REPORT_FILE_INVALID", "StateReport path must open as a regular file", { path });
    if (openedMetadata.size > maximum) throw reportTooLarge(openedMetadata.size, maximum);
    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1));
    let bytes = 0;
    while (true) {
      const read = readSync(descriptor, scratch, 0, scratch.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > maximum) throw reportTooLarge(bytes, maximum);
      chunks.push(Buffer.from(scratch.subarray(0, read)));
    }
    data = Buffer.concat(chunks, bytes);
    failure = undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
    else failure = error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  if (missing) return { data, error: failure };
  try {
    // 读没读到都要删，防止下次执行读到上一次的旧报告。
    rmSync(path, { force: true });
  } catch (error) {
    failure ??= error;
  }
  return { data, error: failure };
}

/**
 * 宿主事件帧的宽松形状（字段全部可选，仅作类型收窄用）；
 * 每个字段的合法性由 NativeEventValidator 状态机逐帧裁决。
 * decodedData 是校验 stdout/stderr 事件时解出的二进制输出（非协议字段）。
 */
interface NativeEvent {
  protocolVersion?: number;
  type?: string;
  pid?: number;
  data?: string;
  code?: number;
  outcome?: "exited" | "timed-out" | "cancelled" | "crashed";
  message?: string;
  maxFrameBytes?: number;
  decodedData?: Buffer;
}

/**
 * 解码「规范 Base64」并对输入做双向验证。
 *
 * Base64 存在多种等价写法（可省略填充、可插入换行、URL-safe 字母表等），
 * 接受非规范形式会引入歧义与绕过空间。因此先用正则限定标准字母表 +
 * 严格填充，再做「解码 -> 重编码」往返比对，两道都通过才认作规范。
 * @param value 事件里的 data 字段（unknown，按不可信输入对待）。
 * @returns 解码后的二进制输出。
 * @throws {PosixLoomError} NATIVE_PROTOCOL_INVALID - 非字符串 / 长度非 4 的倍数 /
 *                   字符或填充不合规 / 重编码结果与原文不一致。
 */
function decodeCanonicalBase64(value: unknown): Buffer {
  // 第一道：结构校验--标准字母表、4 字节分组、正确的 = / == 填充。
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host stream data is not canonical Base64");
  }
  // 第二道：往返校验--解码后重新编码必须逐字符还原原文。
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host stream data is not canonical Base64");
  return decoded;
}

/**
 * Native Host 事件流状态机（fail-closed 严格校验器）。
 *
 * 合法序列唯一：hello -> started -> (stdout | stderr)* -> (exit | error)。
 * 宿主输出是不可信边界（宿主可能损坏、被替换或版本错配），因此校验策略是
 * 「凡不合法即拒绝」而不是尽力解释：
 * - hello 必须是首帧且只出现一次，并须回显一致的 maxFrameBytes；
 * - started 只出现一次，pid 必须为正安全整数；
 * - stdout/stderr 必须出现在 started 之后，data 必须是规范 Base64；
 * - exit/error 是终止事件，其后不允许再有任何事件；
 * - 未知事件类型一律拒绝--协议演进必须显式升版本，不做前向兼容。
 *
 * @throws {PosixLoomError} NATIVE_PROTOCOL_MISMATCH - 帧内 protocolVersion 与本侧不符。
 * @throws {PosixLoomError} NATIVE_PROTOCOL_INVALID - 其余一切乱序/重复/缺字段/未知类型。
 */
export class NativeEventValidator {
  /** 是否已收到 hello（协议握手完成）。 */
  private hello = false;
  /** 是否已收到 started（子进程已创建并取得 pid）。 */
  private started = false;
  /** 是否已收到终止事件（exit/error），此后事件流必须结束。 */
  private terminal = false;

  /**
   * 校验单个事件帧；通过则返回该事件（stdout/stderr 额外附带解码后的
   * decodedData）。
   * @param value 帧解码出的 JSON 值，视为不可信输入。
   */
  accept(value: unknown): NativeEvent {
    // 事件必须是 JSON 对象；数组、标量、null 都不接受。
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host event must be a JSON object");
    const event = value as NativeEvent;
    // 每一帧都必须携带正确版本号；版本不符单列 MISMATCH，便于定位宿主版本错配。
    if (event.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      throw new PosixLoomError("NATIVE_PROTOCOL_MISMATCH", `Native Host protocol mismatch: expected ${NATIVE_PROTOCOL_VERSION}, received ${event.protocolVersion ?? "missing"}`);
    }
    if (typeof event.type !== "string") throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host event type is required");
    if (event.type === "hello") {
      // hello 必须是第一帧：此前出现过任何事件（包括重复 hello）都算乱序。
      if (this.hello || this.started || this.terminal) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host hello event is duplicated or out of order");
      // 双方帧上限必须一致，否则本侧的 16MB 防线形同虚设。
      if (event.maxFrameBytes !== NATIVE_MAX_FRAME_BYTES) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host frame limit does not match protocol v1");
      this.hello = true;
      return event;
    }
    // hello 之前不允许任何其他事件；终止事件之后也不允许任何事件。
    if (!this.hello) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host sent data before protocol hello");
    if (this.terminal) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host sent data after a terminal event");
    if (event.type === "started") {
      // pid 必须是正的安全整数；重复 started 视为违规。
      if (this.started || !Number.isSafeInteger(event.pid) || (event.pid ?? 0) <= 0) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host started event is invalid or duplicated");
      this.started = true;
      return event;
    }
    if (event.type === "stdout" || event.type === "stderr") {
      // 输出事件必须在 started 之后；data 在此同步做规范 Base64 验证并解码。
      if (!this.started) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host emitted process output before started");
      return { ...event, decodedData: decodeCanonicalBase64(event.data) };
    }
    if (event.type === "exit") {
      // exit 必须在 started 之后；outcome 必须是四种终局之一；code 必须是整数。
      if (!this.started || !["exited", "timed-out", "cancelled", "crashed"].includes(event.outcome ?? "") || !Number.isSafeInteger(event.code)) {
        throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host exit event is invalid");
      }
      this.terminal = true;
      return event;
    }
    if (event.type === "error") {
      // error 是另一类终止事件：宿主侧执行失败，必须有非空 message。
      if (typeof event.message !== "string" || !event.message) throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", "Native Host error event has no message");
      this.terminal = true;
      return event;
    }
    // 未知类型：协议没有「忽略未知事件」的宽容度，直接拒绝。
    throw new PosixLoomError("NATIVE_PROTOCOL_INVALID", `Unknown Native Host event type: ${event.type}`);
  }
}

/**
 * 原生执行路径：spawn Rust 宿主 `posixloom __exec-host --protocol-v1`，
 * 通过 stdin/stdout 上的帧协议驱动一次子进程执行。
 *
 * 时序：发送 exec 帧（program/args/cwd/env/timeoutMs/inputBase64）->
 * 接收 hello -> started -> stdout/stderr... -> exit（或 error）-> 宿主退出。
 * 子进程的创建与进程树终止都在宿主内完成（CreateProcessW 挂起创建 +
 * Job Object + TerminateJobObject），TS 侧只解释事件流并以看门狗兜底。
 *
 * 取消流程：向宿主发 cancel 帧请求其终止进程树；若宽限期（cancelGraceMs，
 * 默认 2000ms）内宿主仍无响应，直接 kill 宿主并判 cancelled。
 *
 * 宿主异常的结果映射（一律收敛为 crashed/spawn-failed，fail-closed）：
 * - spawn 失败 -> spawn-failed（错误码取系统 errno，缺省 HOST_SPAWN_FAILED）；
 * - 协议违规 / 流断在半帧 / 宿主 stderr 有输出 -> crashed + NATIVE_HOST_PROTOCOL_FAILED；
 * - 全程未见 hello -> crashed + NATIVE_HOST_HELLO_MISSING；
 * - 收到 hello 但无 exit -> crashed + NATIVE_HOST_EXIT_MISSING；
 * - 看门狗超时（timeoutMs + 宽限期仍未收敛）-> crashed +
 *   NATIVE_HOST_TIMEOUT_WATCHDOG_<阶段>。
 *
 * @throws {PosixLoomError} NATIVE_HOST_MISSING - 未提供 hostPath（分派方应保证不触发）。
 */
async function runViaNativeHost(options: ProcessRunOptions): Promise<ProcessRunResult> {
  if (!options.hostPath) throw new PosixLoomError("NATIVE_HOST_MISSING", "Native Host path is required");
  // exec 帧：一次性下发全部启动参数；stdin 输入序列化为 Base64（帧 payload 是 JSON，无法内嵌二进制）。
  const execFrame = encodeNativeFrame({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    type: "exec",
    program: options.program,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    inputBase64: options.input === undefined ? undefined : Buffer.from(options.input).toString("base64"),
    tty: Boolean(options.terminal),
    columns: options.terminal?.columns,
    rows: options.terminal?.rows,
  });
  // 预先编码 cancel 帧，abort 时直接复用（提前编码也能在执行前暴露超限错误）。
  const cancelFrame = encodeNativeFrame({ protocolVersion: NATIVE_PROTOCOL_VERSION, type: "cancel" });
  // 启动宿主：三个标准流全走管道、隐藏窗口，命令行固定为 __exec-host --protocol-v1。
  const host = spawn(options.hostPath, ["__exec-host", "--protocol-v1"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // stdout/stderr 各自独立限额的头尾截断收集器。
  const stdout = new OutputCollector(options.maxOutputBytes);
  const stderr = new OutputCollector(options.maxOutputBytes);
  const decoder = new NativeFrameDecoder();
  const validator = new NativeEventValidator();
  // 取消宽限期：cancel 帧发出后给宿主这么多时间优雅收尾。
  const grace = options.cancelGraceMs ?? 2000;
  // 收敛状态：settled 保证 Promise 只 resolve 一次；hello 标记握手是否完成；
  // lastStage 记录协议推进到的最后阶段（spawned/hello/started/exit），供看门狗
  // 错误码定位宿主卡在哪一步；exitOutcome 为 exit 事件映射出的终局；
  // protocolError 汇集协议违规信息与宿主 stderr 输出。
  let settled = false;
  let hello = false;
  let lastStage = "spawned";
  let exitOutcome: CommandOutcome | undefined;
  let protocolError: string | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let resolvePromise!: (result: ProcessRunResult) => void;
  const promise = new Promise<ProcessRunResult>((resolve) => { resolvePromise = resolve; });
  const outputForwarder = new ProcessOutputForwarder(
    options.onOutput,
    () => host.stdout.pause(),
    () => {
      if (!host.stdout.destroyed) host.stdout.resume();
    },
    (error) => {
      protocolError = `Output sink failed: ${String(error)}`;
      host.kill();
    },
  );

  // 统一收口：清看门狗、解绑 abort 监听、读报告文件并 resolve（幂等）。
  const complete = (outcome: CommandOutcome): void => {
    if (settled) return;
    settled = true;
    if (watchdog) clearTimeout(watchdog);
    options.signal?.removeEventListener("abort", abort);
    options.interactive?.terminate();
    void outputForwarder.drain(options.outputDrainTimeoutMs ?? DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS).then(() => {
      const report = readAndRemoveReport(options.reportPath, Buffer.alloc(0), options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES);
      const finalOutcome = outputForwarder.failed
        ? { kind: "crashed" as const, errorCode: "OUTPUT_SINK_FAILED" }
        : report.error
          ? { kind: "crashed" as const, errorCode: "REPORT_IO_FAILED" }
          : outcome;
      resolvePromise(makeResult(finalOutcome, stdout, stderr, report.data, "native-host"));
    });
  };
  // 写一帧到宿主 stdin；宿主可能已退出，先确认管道未销毁。
  const send = (frame: Buffer): void => {
    if (!host.stdin.destroyed) host.stdin.write(frame);
  };
  // 取消流程：先发 cancel 帧让宿主优雅终止整棵进程树，同时把看门狗重设为
  // 宽限期；到点宿主仍无响应则强杀宿主并按 cancelled 收场。
  const abort = (): void => {
    if (settled) return;
    send(cancelFrame);
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      host.kill();
      complete({ kind: "cancelled" });
    }, grace);
  };

  // 吞掉 stdin 写入错误：宿主早退时会产生 EPIPE，不应演变为未捕获异常。
  host.stdin.on("error", () => undefined);
  // 事件流主循环：字节 -> 帧解码 -> 状态机校验 -> 按事件类型分派。
  host.stdout.on("data", (chunk: Buffer | string) => {
    try {
      for (const value of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        const event = validator.accept(value);
        if (event.type === "hello") {
          // hello 只推进阶段标记，不产生结果。
          hello = true;
          lastStage = "hello";
        } else if (event.type === "stdout" && event.data !== undefined) {
          const data = event.decodedData ?? Buffer.alloc(0);
          stdout.push(data);
          outputForwarder.push("stdout", data);
        } else if (event.type === "stderr" && event.data !== undefined) {
          const data = event.decodedData ?? Buffer.alloc(0);
          stderr.push(data);
          outputForwarder.push("stderr", data);
        } else if (event.type === "exit") {
          // 把宿主 outcome 映射为 CommandOutcome：宿主侧进程崩溃统一映射为
          // NATIVE_HOST_PROCESS_FAILED 错误码；exited 之外的终局按各自 kind 归位。
          lastStage = "exit";
          exitOutcome = event.outcome === "timed-out"
            ? { kind: "timed-out" }
            : event.outcome === "cancelled"
              ? { kind: "cancelled" }
              : event.outcome === "crashed"
                ? { kind: "crashed", errorCode: "NATIVE_HOST_PROCESS_FAILED" }
              : { kind: "exited", exitCode: event.code ?? 1 };
        } else if (event.type === "started") lastStage = "started";
        // 宿主侧 error 事件：先记下消息，待宿主退出后统一收敛为 crashed。
        else if (event.type === "error") protocolError = event.message ?? "Native Host protocol error";
      }
    } catch (error) {
      // 帧解码或状态机校验抛错：记录诊断信息并立即 kill 宿主，结果由 close 收敛。
      protocolError = String(error);
      host.kill();
    }
  });
  // 宿主自身 stderr：作为诊断信息记录（仅在还没有更有力的错误信息时）。
  host.stderr.on("data", (chunk: Buffer | string) => {
    protocolError ??= Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  });
  // 宿主进程未能启动（如路径错误、权限不足）：直接收敛为 spawn-failed。
  host.once("error", (error) => complete({ kind: "spawn-failed", errorCode: (error as NodeJS.ErrnoException).code ?? "HOST_SPAWN_FAILED" }));
  // 宿主退出：最终收敛点。依次判定--断流在半帧/协议违规 -> PROTOCOL_FAILED；
  // 从未握手 -> HELLO_MISSING；握手了但没有 exit -> EXIT_MISSING；
  // 否则采用 exit 事件映射出的终局。
  host.once("close", () => {
    if (settled) return;
    try { decoder.finish(); } catch (error) { protocolError ??= String(error); }
    if (protocolError) complete({ kind: "crashed", errorCode: "NATIVE_HOST_PROTOCOL_FAILED" });
    else if (!hello) complete({ kind: "crashed", errorCode: "NATIVE_HOST_HELLO_MISSING" });
    else complete(exitOutcome ?? { kind: "crashed", errorCode: "NATIVE_HOST_EXIT_MISSING" });
  });

  // 下发 exec 帧；写入失败（如宿主刚启动就死亡）则 kill 后原样抛出。
  try {
    send(execFrame);
    options.interactive?.attach(async (event) => {
      const value = event.type === "input"
        ? { protocolVersion: NATIVE_PROTOCOL_VERSION, type: "input", data: event.data.toString("base64") }
        : event.type === "resize"
          ? { protocolVersion: NATIVE_PROTOCOL_VERSION, type: "resize", columns: event.columns, rows: event.rows }
          : { protocolVersion: NATIVE_PROTOCOL_VERSION, type: "eof" };
      const frame = encodeNativeFrame(value);
      await new Promise<void>((resolve, reject) => {
        if (host.stdin.destroyed) {
          reject(new PosixLoomError("TERMINAL_CLOSED", "Native Host input is unavailable"));
          return;
        }
        host.stdin.write(frame, (error) => error ? reject(error) : resolve());
      });
    });
  } catch (error) {
    host.kill();
    throw error;
  }
  // 看门狗：timeout + 宽限期后仍未收敛，说明宿主自身挂死（不发事件也不退出），
  // 强制 kill 并以 crashed 收场；错误码携带卡住的阶段（如 ..._WATCHDOG_HELLO）。
  watchdog = setTimeout(() => {
    host.kill();
    complete({ kind: "crashed", errorCode: `NATIVE_HOST_TIMEOUT_WATCHDOG_${lastStage.toUpperCase()}` });
  }, options.timeoutMs + grace);
  // 外部取消信号：进入时已 abort 则立即取消，否则挂一次性监听。
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return promise;
}

/**
 * Node 回退执行路径：直接用 node:child_process 启动目标程序。
 *
 * 触发条件：宿主缺失，或命令需要 reportFd（fd=3 报告管道）--报告通道由
 * Node 自建管道并收集，结束后由 service 层消费（reportPath 文件优先）。
 *
 * 与原生路径的关键差异：Windows 上 Node 的 child.kill() 只能终止直接子进程，
 * 杀不掉孙进程，因此取消/超时改用 `taskkill /PID <pid> /T /F` 终止整棵进程树
 * （/T 递归、/F 强制），taskkill 不可用时退回 child.kill()；非 Windows 平台则
 * 走 SIGTERM -> 宽限期 -> SIGKILL 的两级终止。
 *
 * 结果映射：spawn 失败 -> spawn-failed；超时 -> timed-out；取消 -> cancelled；
 * 正常退出 -> exited（拿不到退出码时按 1 处理）。
 */
async function runViaNode(options: ProcessRunOptions): Promise<ProcessRunResult> {
  return new Promise<ProcessRunResult>((resolve) => {
    // 前三个 fd 为 stdin/stdout/stderr；reportFd 时把 fd=3 开成报告管道，否则忽略。
    const stdio: any[] = ["pipe", "pipe", "pipe", options.reportFd ? "pipe" : "ignore"];
    // 直接 spawn 目标程序（不走 shell，参数不做二次解释），隐藏控制台窗口。
    const child = spawn(options.program, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio,
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    const stdout = new OutputCollector(options.maxOutputBytes);
    const stderr = new OutputCollector(options.maxOutputBytes);
    const maximumReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
    // 报告通道按独立上限收集，避免 fd=3 被恶意子进程用于无界占用内存。
    const reportChunks: Buffer[] = [];
    let reportBytes = 0;
    let reportFailure: unknown;
    const grace = options.cancelGraceMs ?? 2000;
    // finished 保证 Promise 只 resolve 一次；forced 记录是被取消还是超时强制
    // 终止，供 close 事件决定最终 outcome；graceTimer 为宽限期强杀定时器。
    let finished = false;
    let forced: "cancelled" | "timed-out" | undefined;
    let inputFailure: unknown;
    let graceTimer: NodeJS.Timeout | undefined;
    const outputForwarder = new ProcessOutputForwarder(
      options.onOutput,
      () => {
        child.stdout.pause();
        child.stderr.pause();
      },
      () => {
        if (!child.stdout.destroyed) child.stdout.resume();
        if (!child.stderr.destroyed) child.stderr.resume();
      },
      () => child.kill(),
    );
    // 统一收口：清两个定时器、解绑 abort 监听、组装结果（报告文件优先，
    // 不存在则回退 fd 管道收集到的内容），幂等。
    const finish = (outcome: CommandOutcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", abort);
      void outputForwarder.drain(options.outputDrainTimeoutMs ?? DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS).then(() => {
        const report = readAndRemoveReport(options.reportPath, Buffer.concat(reportChunks), maximumReportBytes, reportFailure);
        const processOutcome = inputFailure && outcome.kind === "exited"
          ? { kind: "crashed" as const, errorCode: "INPUT_WRITE_FAILED" }
          : outcome;
        const finalOutcome = outputForwarder.failed
          ? { kind: "crashed" as const, errorCode: "OUTPUT_SINK_FAILED" }
          : report.error
            ? { kind: "crashed" as const, errorCode: "REPORT_IO_FAILED" }
            : processOutcome;
        resolve(makeResult(finalOutcome, stdout, stderr, report.data, "node-fallback"));
      });
    };
    // 两级终止：先温和终止（Windows: taskkill 杀整棵进程树；其他平台:
    // SIGTERM），宽限期后仍未退出则 SIGKILL 强杀并按触发原因收场。
    const terminate = (reason: "cancelled" | "timed-out"): void => {
      if (finished || forced) return;
      forced = reason;
      // Windows：/T 递归终止整棵进程树、/F 强制（child.kill 杀不掉孙进程）；
      // taskkill 自身启动失败时退回 child.kill()，至少杀掉直接子进程。
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill());
      } else child.kill("SIGTERM");
      // 宽限期兜底：SIGKILL 无法被进程捕获/忽略，之后直接按取消/超时收场。
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ kind: reason });
      }, grace);
    };
    // 超时定时器。
    const timer = setTimeout(() => terminate("timed-out"), options.timeoutMs);
    // 外部取消信号。
    const abort = (): void => terminate("cancelled");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    // 三个输出通道分流：stdout/stderr 进截断收集器，报告 fd 原样收集。
    pipeReadable(child.stdout, {
      push: (chunk: Buffer) => {
        stdout.push(chunk);
        outputForwarder.push("stdout", chunk);
      },
    });
    pipeReadable(child.stderr, {
      push: (chunk: Buffer) => {
        stderr.push(chunk);
        outputForwarder.push("stderr", chunk);
      },
    });
    if (options.reportFd) pipeReadable(child.stdio[3] as Readable | null, {
      push: (chunk: Buffer) => {
        reportBytes += chunk.length;
        if (reportBytes > maximumReportBytes) {
          reportFailure ??= reportTooLarge(reportBytes, maximumReportBytes);
          return;
        }
        reportChunks.push(chunk);
      },
    });
    // stdin may reject a buffered write after the child has already closed its read end.
    // Always consume that error; when input was requested, fail the command deterministically.
    child.stdin.on("error", (error) => {
      if (options.input === undefined) return;
      inputFailure ??= error;
      if (!finished) child.kill();
    });
    // spawn 失败（程序不存在、权限不足等）：收敛为 spawn-failed，错误码取系统 errno。
    child.once("error", (error) => finish({ kind: "spawn-failed", errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED" }));
    // 正常退出：若是被强制终止（forced）则 outcome 取终止原因而非退出码。
    child.once("close", (code) => finish(forced ? { kind: forced } : { kind: "exited", exitCode: code ?? 1 }));
    // 注入 stdin 后关闭写入端，让子进程读到 EOF。
    child.stdin.end(options.input);
  });
}

/**
 * 把两个输出收集器与报告数据组装成统一的 ProcessRunResult。
 * stdoutBytes/stderrBytes 采用截断前的真实总量（totalBytes）；
 * truncated 为两路输出中任一发生截断的标记。
 */
function makeResult(
  outcome: CommandOutcome,
  stdout: OutputCollector,
  stderr: OutputCollector,
  report: Buffer,
  processMode: ProcessRunResult["processMode"],
): ProcessRunResult {
  const stdoutResult = stdout.finish();
  const stderrResult = stderr.finish();
  return {
    outcome,
    stdout: stdoutResult.data,
    stderr: stderrResult.data,
    report,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    truncated: stdoutResult.truncated || stderrResult.truncated,
    processMode,
  };
}

/**
 * 进程执行统一入口。
 *
 * 分派规则：提供 hostPath 且不需要 reportFd 时走 Rust Native Host（可靠的
 * Job Object 进程树管理）；否则走 Node 回退。reportFd 场景
 * （shell 内建命令的报告通道）目前仅 Node 路径支持--fd=3 由 Node 建管道，
 * 报告文件/数据由 service 层在进程结束后读取。
 */
export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const outputDrainTimeoutMs = options.outputDrainTimeoutMs ?? DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS;
  const maxReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  if (!Number.isSafeInteger(outputDrainTimeoutMs) || outputDrainTimeoutMs <= 0) {
    throw new PosixLoomError("OUTPUT_DRAIN_TIMEOUT_INVALID", "outputDrainTimeoutMs must be a positive integer", { outputDrainTimeoutMs });
  }
  if (!Number.isSafeInteger(maxReportBytes) || maxReportBytes <= 0) {
    throw new PosixLoomError("REPORT_LIMIT_INVALID", "maxReportBytes must be a positive integer", { maxReportBytes });
  }
  if (options.terminal) {
    validateTerminalSize(options.terminal);
    if (!options.hostPath) throw new PosixLoomError("PTY_UNAVAILABLE", "Interactive terminal execution requires the Native Host");
  }
  if (options.interactive && !options.terminal) throw new PosixLoomError("TERMINAL_MODE_REQUIRED", "Interactive input requires terminal mode");
  if (options.hostPath && !options.reportFd) return runViaNativeHost(options);
  return runViaNode(options);
}
