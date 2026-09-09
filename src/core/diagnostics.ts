import { platform, release, arch } from "node:os";
import type { PosixLoomService } from "./service.js";
import type { JobRecord } from "./jobs.js";

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/** Export an allowlisted support bundle. Never copy command text, env values or paths. */
export function diagnosticReport(service: PosixLoomService, job?: JobRecord): Record<string, unknown> {
  const runtime = service.runtime;
  const info = runtime.info();
  const doctor = runtime.doctor();
  const commandIds = new Set(job?.steps.map((step) => step.commandId).filter(Boolean));
  const traces = service.traces(500).filter((trace) => !job || commandIds.has(trace.commandId as string)).map((trace) => ({
    ...pick(trace, ["timestamp", "commandId", "sessionId", "snapshotId", "planId", "operation", "backend", "inputKind", "stateOutcome", "stdoutBytes", "stderrBytes", "truncated", "failureStage", "durationMs"]),
    outcome: pick(trace.outcome, ["kind", "exitCode", "signal", "errorCode"]),
    timings: Object.fromEntries(Object.entries((trace.timings ?? {}) as Record<string, unknown>).filter(([, value]) => typeof value === "number" && Number.isFinite(value))),
  }));
  const config = runtime.config.runtime;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    redaction: { mode: "allowlist", omitted: ["command text", "arguments", "environment values", "absolute and virtual paths", "tokens", "output bodies", "artifact names", "free-form errors"] },
    system: { platform: platform(), release: release(), arch: arch(), node: process.version },
    runtime: {
      ...pick(info, ["runtimeId", "runtimeSemver", "mode", "source", "snapshotId", "pluginsHash", "policyProfile", "recoveryRequired", "initializationTimings"]),
      plugins: info.plugins.map((plugin) => pick(plugin, ["id", "version", "state"])),
    },
    doctor: { ok: doctor.ok, checks: doctor.checks.map((check) => pick(check, ["id", "level"])) },
    configuration: { session: config.session, process: config.process, jobs: config.jobs, observability: config.observability, protocol: config.protocol, policyProfile: config.policy.defaultProfile },
    traces,
    ...(job ? { job: {
      ...pick(job, ["jobId", "sessionId", "status", "createdAt", "updatedAt", "completedAt", "truncated"]),
      steps: job.steps.map((step) => ({
        ...pick(step, ["id", "status", "startedAt", "completedAt", "planId", "commandId"]),
        outcome: pick((step as unknown as Record<string, unknown>).outcome, ["kind", "exitCode", "errorCode"]),
        plan: pick((step as unknown as Record<string, unknown>).preview, ["planId", "snapshotId", "backend", "commandKind", "mode", "timeoutMs", "statePolicy", "policyProfile", "checks"]),
      })),
      artifactCount: job.artifacts.length,
    } } : {}),
  };
}
