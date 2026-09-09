import { PosixLoomError } from "./errors.js";

export interface AdmissionOptions {
  maxConcurrent: number;
  maxConcurrentPerClient: number;
  maxQueued: number;
  maxQueuedPerClient: number;
  queueTimeoutMs: number;
}

interface Waiting {
  client: string;
  lane?: string;
  start(): void;
  cleanup(): void;
}

/** Runtime-wide admission with bounded waiting, fair client/lane eligibility and cancellation. */
export class ExecutionAdmission {
  private active = 0;
  private readonly clients = new Map<string, number>();
  private readonly lanes = new Set<string>();
  private readonly waiting: Waiting[] = [];
  private completed = 0;
  private rejected = 0;
  constructor(readonly options: AdmissionOptions) {
    for (const key of ["maxConcurrent", "maxConcurrentPerClient", "maxQueued", "maxQueuedPerClient", "queueTimeoutMs"] as const) {
      const value = options[key];
      const minimum = key === "maxQueued" || key === "maxQueuedPerClient" ? 0 : 1;
      if (!Number.isSafeInteger(value) || value < minimum || (key === "queueTimeoutMs" && value > 2147483647)) throw new PosixLoomError("ADMISSION_OPTIONS_INVALID", `Invalid ${key}`);
    }
  }

  snapshot(): { active: number; queued: number; clients: number; completed: number; rejected: number } {
    return { active: this.active, queued: this.waiting.length, clients: this.clients.size, completed: this.completed, rejected: this.rejected };
  }

  private eligible(client: string, lane?: string): boolean {
    return this.active < this.options.maxConcurrent
      && (this.clients.get(client) ?? 0) < this.options.maxConcurrentPerClient
      && (lane === undefined || !this.lanes.has(lane));
  }

  run<T>(client: string, lane: string | undefined, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(new PosixLoomError("EXECUTION_CANCELLED", "Execution was cancelled before admission"));
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const remove = (error: Error): void => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        item.cleanup();
        this.rejected += 1;
        reject(error);
        this.pump();
      };
      const abort = (): void => remove(new PosixLoomError("EXECUTION_CANCELLED", "Queued execution was cancelled"));
      const item: Waiting = {
        client, lane,
        cleanup: () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); },
        start: () => {
          item.cleanup();
          this.active += 1;
          this.clients.set(client, (this.clients.get(client) ?? 0) + 1);
          if (lane !== undefined) this.lanes.add(lane);
          const finish = (): void => {
            this.active -= 1;
            this.completed += 1;
            const remaining = (this.clients.get(client) ?? 1) - 1;
            if (remaining) this.clients.set(client, remaining); else this.clients.delete(client);
            if (lane !== undefined) this.lanes.delete(lane);
            this.pump();
          };
          void Promise.resolve().then(() => {
            if (signal?.aborted) throw new PosixLoomError("EXECUTION_CANCELLED", "Execution was cancelled before start");
            return operation();
          }).then((value) => { finish(); resolve(value); }, (error) => { finish(); reject(error); });
        },
      };
      if (this.eligible(client, lane) && !this.waiting.some((pending) => pending.client === client || (lane !== undefined && pending.lane === lane))) { item.start(); return; }
      if (this.waiting.length >= this.options.maxQueued || this.waiting.filter((pending) => pending.client === client).length >= this.options.maxQueuedPerClient) {
        this.rejected += 1;
        reject(new PosixLoomError("SERVER_BUSY", "Execution queue is full", { retryAfterMs: 1000 }));
        return;
      }
      this.waiting.push(item);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => remove(new PosixLoomError("QUEUE_TIMEOUT", "Execution expired while waiting for capacity", { retryAfterMs: 1000 })), this.options.queueTimeoutMs);
      this.pump();
    });
  }

  private pump(): void {
    // A client limit may block a session's head even when the lane itself is idle.
    // Other lanes can pass it, but later requests for that session must wait.
    const blockedLanes = new Set<string>();
    for (let index = 0; index < this.waiting.length;) {
      const item = this.waiting[index];
      if ((item.lane !== undefined && blockedLanes.has(item.lane)) || !this.eligible(item.client, item.lane)) {
        if (item.lane !== undefined) blockedLanes.add(item.lane);
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      item.start();
    }
  }
}
