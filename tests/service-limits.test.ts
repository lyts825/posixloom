import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { traceFilePath } from "../src/core/trace.js";
import { PosixLoomService } from "../src/core/service.js";
import { EXECUTION_BACKENDS, EXECUTION_HOOKS, NATIVE_COMMANDS } from "../src/plugins/contracts.js";
import type { RuntimePlugin } from "../src/plugins/kernel.js";
import { deferred, runtimeFixture } from "./helpers/runtime-fixture.js";

const result = { outcome: { kind: "exited" as const, exitCode: 0 }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), report: Buffer.alloc(0), stdoutBytes: 0, stderrBytes: 0, truncated: false, processMode: "node-fallback" as const };

test("services sharing a Runtime share admission and trace buffers", async (context) => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const plugin: RuntimePlugin = {
    manifest: { id: "test.blocking-backend", version: "1.0.0", description: "Deterministic test fixture", provides: [EXECUTION_BACKENDS.id] },
    activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "test.backend", mode: "native", async execute() { calls += 1; entered.resolve(); await release.promise; return result; } }, { priority: 10000 }); },
  };
  const { runtime } = await runtimeFixture(context, { process: { maxConcurrent: 1, maxConcurrentPerClient: 1, maxQueued: 1, maxQueuedPerClient: 1 } }, [plugin]);
  const one = new PosixLoomService(runtime), two = new PosixLoomService(runtime);
  const a = one.createSession(), b = two.createSession();
  const running = one.execute({ kind: "argv", argv: ["node", "-p", "1"], sessionId: a, clientId: "a", statePolicy: "isolated" });
  assert.throws(() => one.sessions.close(a), (error: any) => error.code === "SESSION_BUSY");
  await entered.promise;
  const abort = new AbortController();
  const queued = two.execute({ kind: "argv", argv: ["node", "-p", "2"], sessionId: b, clientId: "b", signal: abort.signal });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(runtime.admission.snapshot().active, 1); assert.equal(runtime.admission.snapshot().queued, 1);
  assert.throws(() => one.sessions.close(a), (error: any) => error.code === "SESSION_BUSY");
  assert.throws(() => two.sessions.close(b), (error: any) => error.code === "SESSION_BUSY");
  await assert.rejects(two.execute({ kind: "argv", argv: ["node"], sessionId: b, clientId: "c" }), (error: any) => error.code === "SERVER_BUSY");
  abort.abort();
  assert.equal((await queued).command.kind, "cancelled");
  two.sessions.close(b);
  release.resolve(); await running;
  one.sessions.close(a);
  assert.equal(calls, 1);
  assert.equal(one.traces().length, 3);
  assert.deepEqual(one.traces(), two.traces());
  assert.equal(runtime.admission.snapshot().active, 0);
});

test("validation, policy and plugin failures produce phase traces without sensitive input", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime), sessionId = service.createSession();
  const secret = "never-collect-secret-argument";
  await assert.rejects(service.execute({ sessionId, raw: secret, envDelta: { TOKEN: secret }, timeoutMs: -1 }), (error: any) => error.code === "EXECUTE_REQUEST_INVALID");
  assert.equal(service.traces(1)[0].failureStage, "validate");
  await assert.rejects(service.explain({ sessionId, raw: secret, cwd: "/outside-not-mounted" }));
  assert.equal(service.traces(1)[0].failureStage, "policy");
  assert.equal(JSON.stringify(service.traces()).includes(secret), false);
  const hook: RuntimePlugin = {
    manifest: { id: "test.failing-hook", version: "1.0.0", description: "Deterministic test fixture", provides: [EXECUTION_HOOKS.id] },
    activate(ctx) { ctx.provide(EXECUTION_HOOKS, { id: "failing", beforePrepare() { throw new Error(secret); } }); },
  };
  const other = await runtimeFixture(context, {}, [hook]);
  const hooked = new PosixLoomService(other.runtime);
  await assert.rejects(hooked.execute({ sessionId: hooked.createSession(), raw: secret }), /never-collect/);
  assert.equal(hooked.traces(1)[0].failureStage, "hooksBeforePrepare");
  assert.equal(JSON.stringify(hooked.traces()).includes(secret), false);
});

test("successful execution reports process phases and command names remain opt-in", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime), sessionId = service.createSession();
  const completion = await service.execute({ sessionId, kind: "argv", argv: ["node", "-p", "42"] });
  assert.equal(completion.command.kind, "exited");
  const trace = completion.trace as any;
  for (const phase of ["validateMs", "queueMs", "prepareMs", "classifyMs", "resolveMs", "planMs", "executeMs", "processTotalMs", "spawnMs", "firstByteMs", "exitMs", "stateCommitMs"]) assert.ok(trace.timings[phase] >= 0, phase);
  assert.equal(trace.commandName, undefined);
  assert.ok(runtime.info().initializationTimings.totalMs > 0);
  runtime.config.runtime.observability.collectCommandNames = true;
  await service.explain({ sessionId, kind: "argv", argv: ["node", "-p", "secret-in-args"] });
  assert.equal(service.traces(1)[0].commandName, "node");
  assert.equal(JSON.stringify(service.traces()).includes("secret-in-args"), false);
});

test("trace IO failure never changes a successfully executed command", async (context) => {
  const { runtime } = await runtimeFixture(context, { observability: { writeTraceFile: true } });
  await mkdir(traceFilePath(runtime.config.dataRoot));
  const service = new PosixLoomService(runtime);
  const completion = await service.execute({ sessionId: service.createSession(), kind: "argv", argv: ["node", "-p", "42"] });
  await service.flushTraces();
  assert.deepEqual(completion.command, { kind: "exited", exitCode: 0 });
  assert.ok((runtime.traces.diagnostics().persistence as any).lastErrorCode);
});

test("Runtime creation rolls back activated plugins when registry validation fails", async (context) => {
  let cleaned = false;
  const plugin: RuntimePlugin = {
    manifest: { id: "test.invalid-registry", version: "1.0.0", description: "Cleanup fixture", provides: [NATIVE_COMMANDS.id] },
    activate(ctx) {
      ctx.defer(() => { cleaned = true; });
      ctx.provide(NATIVE_COMMANDS, { name: "invalid-tool", executable: process.execPath, adapterId: "missing-adapter", shellEquivalent: true });
    },
  };
  await assert.rejects(runtimeFixture(context, {}, [plugin]), (error: any) => error.code === "REGISTRY_INVALID");
  assert.equal(cleaned, true);
});
