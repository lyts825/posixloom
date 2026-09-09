import type { Readable } from "node:stream";
import { PosixLoomError } from "../errors.js";
import type { ProcessRunOptions, ProcessOutputEvent } from "./contracts.js";

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
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head?: Buffer;
  private tail?: Buffer;
  private headBytes = 0;
  private tailBytes = 0;
  private tailOffset = 0;
  totalBytes = 0;
  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new PosixLoomError("OUTPUT_LIMIT_INVALID", "maxOutputBytes must be positive", { maxBytes });
    this.headLimit = Math.ceil(maxBytes / 2);
    this.tailLimit = Math.floor(maxBytes / 2);
  }
  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.totalBytes += chunk.length;
    const headCount = Math.min(chunk.length, this.headLimit - this.headBytes);
    if (headCount) {
      this.head ??= Buffer.allocUnsafe(this.headLimit);
      chunk.copy(this.head, this.headBytes, 0, headCount);
      this.headBytes += headCount;
    }
    const remainder = chunk.subarray(headCount);
    if (!remainder.length || this.tailLimit === 0) return;
    this.tail ??= Buffer.allocUnsafe(this.tailLimit);
    if (remainder.length >= this.tailLimit) {
      remainder.copy(this.tail, 0, remainder.length - this.tailLimit);
      this.tailOffset = 0; this.tailBytes = this.tailLimit;
      return;
    }
    const first = Math.min(remainder.length, this.tailLimit - this.tailOffset);
    remainder.copy(this.tail, this.tailOffset, 0, first);
    remainder.copy(this.tail, 0, first);
    this.tailOffset = (this.tailOffset + remainder.length) % this.tailLimit;
    this.tailBytes = Math.min(this.tailLimit, this.tailBytes + remainder.length);
  }
  finish(): { data: Buffer; truncated: boolean } {
    const truncated = this.totalBytes > this.maxBytes;
    const head = this.head?.subarray(0, this.headBytes) ?? Buffer.alloc(0);
    const tail = !this.tail ? Buffer.alloc(0) : this.tailBytes < this.tailLimit
      ? this.tail.subarray(0, this.tailBytes)
      : Buffer.concat([this.tail.subarray(this.tailOffset), this.tail.subarray(0, this.tailOffset)]);
    return { data: Buffer.concat(truncated ? [head, Buffer.from("\n[PosixLoom OUTPUT TRUNCATED]\n"), tail] : [head, tail]), truncated };
  }
}

/**
 * 把可读流的 data 事件转发给收集器；chunk 可能是字符串（未设置编码时），
 * 统一转成 Buffer。也可传入自定义 push 复用本函数（如报告 fd 的无截断收集）。
 */
export function pipeReadable(stream: Readable | null, collector: { push(chunk: Buffer): void }): void {
  if (!stream) return;
  stream.on("data", (chunk: Buffer | string) => collector.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
}

/** 单个控制协议输出事件的最大原始字节数，Base64 后仍远低于 16 MiB 帧上限。 */
export const MAX_STREAM_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_OUTPUT_DRAIN_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_REPORT_BYTES = 1024 * 1024;

/**
 * 把同步到达的 stdout/stderr 分片串行转发给异步接收器。
 *
 * 第一个待发送事件入队时暂停上游；队列完全排空后恢复。这样慢 Harness
 * 不会让 Promise 写队列无限积累。接收器异常只通知一次，由进程后端终止
 * 子进程并把结果收敛为 OUTPUT_SINK_FAILED。
 */
export class ProcessOutputForwarder {
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
