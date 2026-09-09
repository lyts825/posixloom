import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CommandCompletion } from "./types.js";

/** Timings are monotonic. No command bodies, argument values, paths or environment values. */
export class ExecutionTelemetry {
  readonly commandId = randomUUID();
  readonly started = performance.now();
  readonly timings: Record<string, number> = {};
  readonly metadata: Record<string, unknown> = {};
  stage = "admission";
  failureStage?: string;
  measureSync<T>(stage: string, operation: () => T): T {
    this.stage = stage;
    const start = performance.now();
    try { return operation(); }
    catch (error) { this.failureStage ??= stage; throw error; }
    finally { this.timings[stage + "Ms"] = performance.now() - start; }
  }
  async measure<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
    this.stage = stage;
    const start = performance.now();
    try { return await operation(); }
    catch (error) { this.failureStage ??= stage; throw error; }
    finally { this.timings[stage + "Ms"] = performance.now() - start; }
  }
  finish(sessionId: string, operation: "execute" | "explain", completion?: CommandCompletion, errorCode?: string): Record<string, unknown> {
    return {
      commandId: this.commandId, sessionId, operation, ...this.metadata,
      outcome: completion?.command ?? { kind: errorCode ? "rejected" : "planned", errorCode },
      stateOutcome: completion?.state.kind,
      stdoutBytes: completion?.stdoutBytes, stderrBytes: completion?.stderrBytes, truncated: completion?.truncated,
      failureStage: errorCode ? this.failureStage ?? this.stage : undefined,
      durationMs: performance.now() - this.started,
      timings: Object.fromEntries(Object.entries(this.timings).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
    };
  }
}
