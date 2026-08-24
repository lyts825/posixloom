/**
 * 追踪记录器（TraceRecorder）。
 *
 * 职责：为命令执行等关键事件记录结构化元数据，维护一份固定容量的内存缓冲，
 * 并可选地把事件逐行追加持久化到 dataRoot/logs/posixloom-trace.jsonl。
 *
 * 设计意图：
 * - 隐私优先：trace 只记元数据（时间戳、命令标识、结果分类等），绝不记录
 *   命令输出、环境变量取值或凭据等载荷，保证日志可以安全导出用于诊断，
 *   而不会泄漏用户数据。
 * - 内存缓冲为固定容量（默认 5000，来自 observability.traceBufferSize 配置）
 *   的滑动窗口：超出容量即丢弃最旧事件，长期运行时内存占用有上界；
 *   capacity 为 0 时可完全关闭内存缓冲。
 * - 磁盘写入经 writeLane 这条 Promise 链串行化：并发 record 触发的多次
 *   appendFile 按调用顺序逐个执行，不会交错乱序，也无需加锁。
 */
import { appendFile, open } from "node:fs/promises";
import { join } from "node:path";
import { PosixLoomError } from "./errors.js";

/**
 * 单条追踪事件：除强制字段 timestamp 外，其余字段由调用方按事件类型注入
 * （借助 Record<string, unknown> 的开放结构承载任意元数据，但不含敏感内容）。
 */
export interface TraceEvent extends Record<string, unknown> {
  /** 事件产生时间（record 时打点的 UTC ISO-8601 字符串） */
  timestamp: string;
}

/** 返回持久化 trace 的固定路径。 */
export function traceFilePath(dataRoot: string): string {
  return join(dataRoot, "logs", "posixloom-trace.jsonl");
}

/**
 * 从 JSONL 文件尾部读取最近的 trace。按块倒序读取，避免为了少量诊断事件
 * 把长期增长的整个日志载入内存。
 */
export async function readTraceEvents(dataRoot: string, limit = 50): Promise<TraceEvent[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000) {
    throw new PosixLoomError("TRACE_LIMIT_INVALID", "Trace limit must be an integer between 1 and 5000", { limit });
  }
  const target = traceFilePath(dataRoot);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, "r");
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const chunks: Buffer[] = [];
    let position = size;
    let newlineCount = 0;
    while (position > 0 && newlineCount <= limit) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const data = chunk.subarray(0, bytesRead);
      chunks.unshift(data);
      for (const byte of data) if (byte === 0x0a) newlineCount += 1;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split("\n").filter(Boolean).slice(-limit);
    return lines.map((line, index) => {
      try {
        const event = JSON.parse(line) as TraceEvent;
        if (!event || typeof event !== "object" || typeof event.timestamp !== "string") throw new Error("missing timestamp");
        return event;
      } catch (error) {
        throw new PosixLoomError("TRACE_FILE_INVALID", "Persisted trace contains an invalid JSONL entry", {
          path: target,
          lineFromTail: lines.length - index,
          cause: String(error),
        });
      }
    });
  } finally {
    await handle.close();
  }
}

/**
 * 追踪记录器：固定容量内存缓冲 + 可选 JSONL 落盘。
 * 缓冲与写文件相互独立，可只启用其一（capacity=0 或 writeTraceFile=false）。
 */
export class TraceRecorder {
  /** 内存缓冲（滑动窗口）：只保留最近 capacity 条事件，超限丢弃最旧 */
  private readonly buffer: TraceEvent[] = [];
  /** 磁盘写入串行队列：把并发的 appendFile 排成先入先出，防止行交错 */
  private writeLane: Promise<void> = Promise.resolve();

  /**
   * @param capacity 内存缓冲容量；0 表示禁用内存缓冲（默认由配置层传 5000）
   * @param writeTraceFile 是否把事件持久化到磁盘日志
   * @param dataRoot 运行时数据根目录，日志固定写入 <dataRoot>/logs/posixloom-trace.jsonl
   */
  constructor(
    private readonly capacity: number,
    private readonly writeTraceFile: boolean,
    private readonly dataRoot: string,
  ) {}

  /**
   * 记录一条事件：打上当前时间戳后写入内存缓冲，并按需追加到磁盘日志。
   * - 内存侧：capacity 为 0 时跳过缓冲；超容量时从最旧一端裁剪；
   * - 磁盘侧：序列化为单行 JSON（JSONL）追加写 trace 文件，通过 writeLane
   *   串行化保证并发 record 的落盘顺序与调用顺序一致；await 写队列使
   *   调用方能够感知到写失败（异常向上抛出）。
   * @param value 事件元数据字段（不含 timestamp，由本方法补齐）
   * @returns 已补齐时间戳的完整事件对象（原样返回，便于调用方回显或关联）
   */
  async record(value: Record<string, unknown>): Promise<TraceEvent> {
    const event: TraceEvent = { timestamp: new Date().toISOString(), ...value };
    if (this.capacity > 0) {
      this.buffer.push(event);
      // 超出容量时丢弃最旧事件，维持固定的内存上界
      if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    if (this.writeTraceFile) {
      const line = `${JSON.stringify(event)}\n`;
      const target = traceFilePath(this.dataRoot);
      // 排入写队列：与先前尚未完成的追加串行执行，避免并发交错
      this.writeLane = this.writeLane.then(() => appendFile(target, line, "utf8"));
      await this.writeLane;
    }
    return event;
  }

  /**
   * 返回内存缓冲的拷贝：逐条浅拷贝对象，调用方修改结果不会污染内部缓冲。
   * @returns 事件数组，按记录顺序排列（最多 capacity 条）
   */
  snapshot(): TraceEvent[] {
    return this.buffer.map((entry) => ({ ...entry }));
  }
}
