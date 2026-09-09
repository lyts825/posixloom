import { PosixLoomError } from "../errors.js";
import { MAX_STREAM_CHUNK_BYTES } from "./output.js";
import type { TerminalSize } from "../types.js";

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
