import { createHash } from "node:crypto";
import { PosixLoomError } from "../core/errors.js";

export interface Receipt { status: number; body: Record<string, unknown> }
interface Entry { fingerprint: string; expires: number; receipt?: Receipt; bytes: number; pending: boolean; retryable?: boolean }
export function requestFingerprint(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

/** Bounded process-local receipts. Capacity exhaustion rejects NEW keys, never forgets protected keys. */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(private readonly maximum: number, private readonly ttlMs: number, private readonly maxBytes: number, private readonly now = Date.now) {
    if ([maximum, ttlMs, maxBytes].some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid idempotency limits");
  }
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (!entry.pending && entry.expires <= this.now()) { this.entries.delete(key); this.bytes -= entry.bytes; }
    }
  }
  begin(key: string, fingerprint: string): { replayed: boolean; receipt?: Receipt } {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new PosixLoomError("HTTP_IDEMPOTENCY_INVALID", "Idempotency-Key requires 1 to 128 ASCII letters, digits, dots, colons, hyphens or underscores");
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PosixLoomError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was used for a different execution");
      if (existing.pending) throw new PosixLoomError("IDEMPOTENCY_IN_PROGRESS", "Original execution is still running", { retryAfterMs: 1000 });
      if (existing.retryable) {
        existing.pending = true;
        existing.retryable = false;
        existing.expires = Infinity;
        return { replayed: false };
      }
      if (!existing.receipt) throw new PosixLoomError("IDEMPOTENCY_RESULT_UNAVAILABLE", "Execution already finished; its result exceeded receipt storage limits. It will not be re-executed.");
      return { replayed: true, receipt: structuredClone(existing.receipt) };
    }
    if (this.entries.size >= this.maximum) throw new PosixLoomError("SERVER_BUSY", "Idempotency receipt capacity exhausted", { retryAfterMs: 1000 });
    this.entries.set(key, { fingerprint, expires: Infinity, pending: true, bytes: 0 });
    return { replayed: false };
  }
  /** Only the transport's explicit pre-admission boundary may release a rejected attempt. */
  retryAfterRejection(key: string): void {
    const entry = this.entries.get(key);
    if (!entry?.pending) return;
    entry.pending = false;
    entry.retryable = true;
    entry.expires = this.now() + this.ttlMs;
  }
  complete(key: string, receipt: Receipt): void {
    const entry = this.entries.get(key);
    if (!entry?.pending) return;
    entry.pending = false;
    entry.expires = this.now() + this.ttlMs;
    const bytes = Buffer.byteLength(JSON.stringify(receipt));
    if (bytes <= this.maxBytes - this.bytes) {
      entry.receipt = structuredClone(receipt);
      entry.bytes = bytes;
      this.bytes += bytes;
    }
  }
  snapshot(): Record<string, number> {
    this.prune();
    return { entries: this.entries.size, bytes: this.bytes, pending: [...this.entries.values()].filter((entry) => entry.pending).length, ttlMs: this.ttlMs };
  }
}
