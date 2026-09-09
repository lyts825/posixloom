import type { TraceEvent } from "./trace.js";

interface Distribution { count: number; p50: number; p95: number; max: number }
function distribution(values: number[]): Distribution | undefined {
  if (!values.length) return undefined;
  values.sort((a, b) => a - b);
  return { count: values.length, p50: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1], max: values[values.length - 1] };
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

/** Aggregate only the supplied bounded sample. Observed command time is NOT estimated adapter savings. */
export function summarizeTraces(events: readonly TraceEvent[]): Record<string, unknown> {
  const executions = events.filter((event) => event.operation === "execute");
  const resolved = executions.filter((event) => event.backend === "native" || event.backend === "msys2");
  const phases: Record<string, number[]> = {};
  const routes: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const candidates = new Map<string, number[]>();
  const durations: number[] = [];
  let commandNames = 0;
  for (const event of executions) {
    if (finite(event.durationMs)) durations.push(event.durationMs);
    if (typeof event.backend === "string") routes[event.backend] = (routes[event.backend] ?? 0) + 1;
    if (typeof event.failureStage === "string") failures[event.failureStage] = (failures[event.failureStage] ?? 0) + 1;
    if (event.timings && typeof event.timings === "object") {
      for (const [name, value] of Object.entries(event.timings)) {
        if (finite(value)) (phases[name] ??= []).push(value);
      }
    }
    if (typeof event.commandName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(event.commandName)) continue;
    commandNames += 1;
    if (event.fallbackReason !== "native-miss" || !finite(event.durationMs)) continue;
    const samples = candidates.get(event.commandName) ?? [];
    samples.push(event.durationMs);
    candidates.set(event.commandName, samples);
  }
  return {
    sample: { events: events.length, executions: executions.length, explanations: events.filter((event) => event.operation === "explain").length, namedExecutions: commandNames },
    routes, failures,
    nativeHitRate: resolved.length ? (routes.native ?? 0) / resolved.length : null,
    durationMs: distribution(durations) ?? null,
    phases: Object.fromEntries(Object.entries(phases).map(([name, samples]) => [name, distribution(samples)])),
    fallbackCandidates: [...candidates].map(([command, samples]) => ({
      command, samples: samples.length, durationMs: distribution(samples), observedTotalMs: samples.reduce((sum, value) => sum + value, 0),
    })).sort((a, b) => b.observedTotalMs - a.observedTotalMs || a.command.localeCompare(b.command)).slice(0, 20),
    notes: [
      "Sampled diagnostics, not an exhaustive audit. Phase intervals may overlap and must not be summed.",
      "Command names are opt-in. No arguments, script bodies, paths or environment values are collected.",
      "Candidates are unregistered simple commands. Review semantics and real usage before adding adapters; command duration is not potential time saved.",
    ],
  };
}
