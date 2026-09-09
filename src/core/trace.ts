/** Bounded in-memory traces and non-blocking, size-rotated diagnostic persistence. */
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PosixLoomError } from "./errors.js";
import { RotatingTraceWriter, type TraceWriterOptions } from "./trace-writer.js";

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
  // Read newest files first, but return all selected events in chronological order.
  let names: string[];
  try { names = await readdir(join(dataRoot, "logs")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rotations = names.filter((name) => /^posixloom-trace\.jsonl\.[1-9][0-9]*$/.test(name))
    .sort((left, right) => Number(left.split(".").at(-1)) - Number(right.split(".").at(-1)));
  const result: TraceEvent[] = [];
  for (const name of ["posixloom-trace.jsonl", ...rotations]) {
    const events = await readFileTail(join(dataRoot, "logs", name), limit - result.length);
    result.unshift(...events);
    if (result.length >= limit) break;
  }
  return result;
}

async function readFileTail(target: string, limit: number): Promise<TraceEvent[]> {
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


export class TraceRecorder {
  private readonly buffer: (TraceEvent | undefined)[];
  private next = 0;
  private count = 0;
  private serializationErrors = 0;
  private readonly writer?: RotatingTraceWriter;
  constructor(private readonly capacity: number, writeTraceFile: boolean, dataRoot: string, options: Partial<TraceWriterOptions> = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new PosixLoomError("TRACE_OPTIONS_INVALID", "Trace capacity must be non-negative");
    this.buffer = new Array(capacity);
    if (writeTraceFile) this.writer = new RotatingTraceWriter(traceFilePath(dataRoot), options);
  }

  /** Disk failure never changes the already-executed command's outcome. Inspect diagnostics(). */
  async record(value: Record<string, unknown>): Promise<TraceEvent> {
    let event: TraceEvent;
    let line: string;
    const timestamp = new Date().toISOString();
    try {
      event = structuredClone({ ...value, timestamp });
      line = `${JSON.stringify(event)}\n`;
    } catch {
      this.serializationErrors += 1;
      event = { timestamp, errorCode: "TRACE_SERIALIZATION_FAILED" };
      line = `${JSON.stringify(event)}\n`;
    }
    if (this.capacity > 0) {
      this.buffer[this.next] = event;
      this.next = (this.next + 1) % this.capacity;
      this.count = Math.min(this.count + 1, this.capacity);
    }
    this.writer?.enqueue(line);
    return structuredClone(event);
  }

  snapshot(limit = this.count): TraceEvent[] {
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(this.count, Math.floor(limit))) : this.count;
    return Array.from({ length: count }, (_, index) => {
      const position = (this.next - count + index + this.capacity) % this.capacity;
      return structuredClone(this.buffer[position]!);
    });
  }
  diagnostics(): Record<string, unknown> {
    return { buffered: this.count, capacity: this.capacity, serializationErrors: this.serializationErrors, persistence: this.writer?.snapshot() ?? { enabled: false } };
  }
  async flush(): Promise<void> { await this.writer?.flush(); }
  async close(): Promise<void> { await this.writer?.close(); }
}
