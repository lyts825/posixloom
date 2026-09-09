import { appendFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

// Serialize rotation for embedded Runtime instances that share a data root in this process.
const fileLanes = new Map<string, Promise<void>>();
function withFileLane(path: string, operation: () => Promise<void>): Promise<void> {
  const absolute = resolve(path);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const task = (fileLanes.get(key) ?? Promise.resolve()).then(operation);
  const settled = task.catch(() => undefined).finally(() => { if (fileLanes.get(key) === settled) fileLanes.delete(key); });
  fileLanes.set(key, settled);
  return task;
}

export interface TraceWriterOptions {
  traceMaxFileBytes: number;
  traceRetainedFiles: number;
  traceMaxPendingBytes: number;
  traceFlushIntervalMs: number;
}

/** A single Runtime owns a writer shared by all of its services/transports. */
export class RotatingTraceWriter {
  private readonly options: TraceWriterOptions;
  private pending: string[] = [];
  private pendingBytes = 0;
  private queuedBytes = 0;
  private timer?: NodeJS.Timeout;
  private lane: Promise<void> = Promise.resolve();
  private closed = false;
  private dropped = 0;
  private written = 0;
  private lastErrorCode?: string;
  constructor(private readonly path: string, options: Partial<TraceWriterOptions> = {}) {
    this.options = {
      traceMaxFileBytes: options.traceMaxFileBytes ?? 10 * 1024 * 1024,
      traceRetainedFiles: options.traceRetainedFiles ?? 3,
      traceMaxPendingBytes: options.traceMaxPendingBytes ?? 1024 * 1024,
      traceFlushIntervalMs: options.traceFlushIntervalMs ?? 100,
    };
    for (const [key, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value < (key === "traceRetainedFiles" ? 0 : 1) || (key === "traceFlushIntervalMs" && value > 2147483647)) throw new Error(`Invalid trace option: ${key}`);
    }
  }
  snapshot(): Record<string, unknown> {
    return { enabled: true, pendingBytes: this.pendingBytes + this.queuedBytes, dropped: this.dropped, written: this.written, lastErrorCode: this.lastErrorCode };
  }
  enqueue(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.closed || bytes > this.options.traceMaxFileBytes || this.pendingBytes + this.queuedBytes + bytes > this.options.traceMaxPendingBytes) {
      this.dropped += 1; return;
    }
    this.pending.push(line);
    this.pendingBytes += bytes;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.options.traceFlushIntervalMs);
  }
  private async rotate(): Promise<void> {
    const count = this.options.traceRetainedFiles;
    if (count === 0) { await rm(this.path, { force: true }); return; }
    await rm(`${this.path}.${count}`, { force: true });
    for (let index = count - 1; index >= 0; index -= 1) {
      const source = index === 0 ? this.path : `${this.path}.${index}`;
      try { await rename(source, `${this.path}.${index + 1}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.pending.length === 0) { await this.lane; return; }
    const lines = this.pending;
    const bytes = this.pendingBytes;
    this.pending = []; this.pendingBytes = 0; this.queuedBytes += bytes;
    this.lane = this.lane.then(() => withFileLane(this.path, async () => {
      let size = 0;
      try {
        size = (await stat(this.path)).size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let batch = "";
      let batchBytes = 0;
      for (const line of lines) {
        const length = Buffer.byteLength(line);
        if (size + batchBytes + length > this.options.traceMaxFileBytes) {
          if (batch) { await appendFile(this.path, batch, "utf8"); batch = ""; batchBytes = 0; }
          await this.rotate(); size = 0;
        }
        batch += line;
        batchBytes += length;
      }
      if (batch) await appendFile(this.path, batch, "utf8");
      this.written += lines.length;
      this.lastErrorCode = undefined;
    })).catch((error: NodeJS.ErrnoException) => {
      this.lastErrorCode = error.code ?? "TRACE_WRITE_FAILED";
      this.dropped += lines.length;
    }).finally(() => { this.queuedBytes -= bytes; });
    await this.lane;
  }
  async close(): Promise<void> { this.closed = true; await this.flush(); }
}
