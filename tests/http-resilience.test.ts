import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PosixLoomError } from "../src/core/errors.js";
import { startRemoteHttpServer } from "../src/http/server.js";
import { EXECUTION_BACKENDS } from "../src/plugins/contracts.js";
import type { RuntimePlugin } from "../src/plugins/kernel.js";
import { deferred, runtimeFixture } from "./helpers/runtime-fixture.js";

const headers = { "content-type": "application/json" };
const baseResult = { outcome: { kind: "exited" as const, exitCode: 0 }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), report: Buffer.alloc(0), stdoutBytes: 0, stderrBytes: 0, truncated: false, processMode: "node-fallback" as const };
async function createSession(origin: string): Promise<string> { return (await (await fetch(origin + "/api/v1/sessions", { method: "POST", headers, body: "{}" })).json()).sessionId; }

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Operation did not settle within ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test("HTTP retries return the original result once, including a completed-only stream replay", async (context) => {
  const { runtime, root } = await runtimeFixture(context);
  const server = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  try {
    const session = await createSession(server.origin);
    const endpoint = server.origin + "/api/v1/sessions/" + session + "/execute";
    const body = { input: { kind: "argv", argv: ["node", "-e", "require('node:fs').appendFileSync('counter.txt','x');console.log('once')"] } };
    const send = (value: unknown, extra: Record<string, string> = {}) => fetch(endpoint, { method: "POST", headers: { ...headers, "idempotency-key": "side-effect", ...extra }, body: JSON.stringify(value) });
    const first = await (await send(body)).json();
    const retry = await send(body);
    assert.equal(retry.status, 200); assert.equal(retry.headers.get("idempotency-replayed"), "true");
    assert.deepEqual((await retry.json()).result, first.result);
    const streamed = await send({ ...body, stream: true });
    const events = (await streamed.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 1); assert.equal(events[0].type, "completed"); assert.equal(events[0].replayed, true);
    assert.equal(await readFile(join(root, "counter.txt"), "utf8"), "x");
    const conflict = await send({ input: { kind: "argv", argv: ["node", "-p", "123"] } });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
    const schema = await (await fetch(server.origin + "/api/v1/schema")).json();
    assert.equal(schema.properties.terminal, false);
    const api = await (await fetch(server.origin + "/api/v1/openapi.json")).json();
    assert.equal(api.openapi, "3.1.0");
    const summary = await (await fetch(server.origin + "/api/v1/traces/summary")).json();
    assert.equal(summary.summary.sample.executions, 1);
  } finally { await server.close(); }
});

test("HTTP pending idempotency, busy sessions, overload and metrics retain execution safety", async (context) => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const plugin: RuntimePlugin = {
    manifest: { id: "test.http-block", version: "1.0.0", description: "Deterministic test fixture", provides: [EXECUTION_BACKENDS.id] },
    activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "test.backend", mode: "native", async execute() { calls += 1; entered.resolve(); await release.promise; return baseResult; } }, { priority: 10000 }); },
  };
  const { runtime } = await runtimeFixture(context, { process: { maxConcurrent: 1, maxQueued: 0, maxQueuedPerClient: 0 } }, [plugin]);
  const server = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  const session = await createSession(server.origin);
  const url = server.origin + "/api/v1/sessions/" + session;
  const send = (key: string) => fetch(url + "/execute", { method: "POST", headers: { ...headers, "idempotency-key": key }, body: JSON.stringify({ input: { kind: "argv", argv: ["node"] }, statePolicy: "isolated" }) });
  const first = send("active");
  try {
    await entered.promise;
    const pending = await send("active");
    assert.equal(pending.status, 409); assert.equal(pending.headers.get("retry-after"), "1");
    assert.equal((await pending.json()).error.code, "IDEMPOTENCY_IN_PROGRESS");
    const close = await fetch(url, { method: "DELETE" });
    assert.equal(close.status, 409); assert.equal((await close.json()).error.code, "SESSION_BUSY");
    const busy = await send("other");
    assert.equal(busy.status, 429); assert.equal(busy.headers.get("retry-after"), "1");
    assert.equal((await busy.json()).error.code, "SERVER_BUSY");
    const busyStream = await fetch(url + "/execute", { method: "POST", headers, body: JSON.stringify({ input: { kind: "argv", argv: ["node"] }, stream: true }) });
    assert.equal(busyStream.status, 429);
    assert.equal((await busyStream.json()).error.code, "SERVER_BUSY");
    const metrics = await (await fetch(server.origin + "/api/v1/metrics")).json();
    assert.equal(metrics.admission.active, 1); assert.equal(metrics.admission.queued, 0); assert.equal(metrics.idempotency.pending, 1);
    assert.equal(calls, 1);
  } finally { release.resolve(); await (await first).text(); await server.close(); }
});

for (const rejection of ["SERVER_BUSY", "QUEUE_TIMEOUT"] as const) {
  test(`HTTP same-key retries recover after pre-admission ${rejection} without repeating admitted work`, async (context) => {
    const entered = deferred(), release = deferred(); let calls = 0;
    const plugin: RuntimePlugin = {
      manifest: { id: "test.http-retry", version: "1.0.0", description: "Controlled admission fixture", provides: [EXECUTION_BACKENDS.id] },
      activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "test.retry", mode: "native", async execute() {
        if (++calls === 1) { entered.resolve(); await release.promise; }
        return baseResult;
      } }, { priority: 10000 }); },
    };
    const { runtime } = await runtimeFixture(context, { process: { maxConcurrent: 1, maxQueued: rejection === "SERVER_BUSY" ? 0 : 1, maxQueuedPerClient: 1, queueTimeoutMs: 40 } }, [plugin]);
    const server = await startRemoteHttpServer(runtime, { port: 0 });
    const session = await createSession(server.origin);
    const endpoint = `${server.origin}/api/v1/sessions/${session}/execute`;
    const body = JSON.stringify({ input: { kind: "argv", argv: ["node"] }, statePolicy: "isolated" });
    const send = (key: string) => fetch(endpoint, { method: "POST", headers: { ...headers, "idempotency-key": key }, body });
    const active = send("active");
    try {
      await entered.promise;
      const rejected = await send("retry");
      assert.equal(rejected.status, 429); assert.equal((await rejected.json()).error.code, rejection);
      release.resolve(); await (await active).text();
      const retried = await send("retry");
      assert.equal(retried.status, 200); assert.equal(retried.headers.get("idempotency-replayed"), null);
      const result = await retried.json();
      const replay = await send("retry");
      assert.equal(replay.headers.get("idempotency-replayed"), "true");
      assert.deepEqual((await replay.json()).result, result.result);
      assert.equal(calls, 2);
    } finally { release.resolve(); await (await active).text().catch(() => undefined); await server.close(); }
  });
}

test("HTTP preserves post-admission overload failures even when their error code resembles admission", async (context) => {
  let calls = 0;
  const plugin: RuntimePlugin = {
    manifest: { id: "test.http-admitted-error", version: "1.0.0", description: "Side effect then error fixture", provides: [EXECUTION_BACKENDS.id] },
    activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "test.error", mode: "native", async execute() {
      calls += 1; throw new PosixLoomError("SERVER_BUSY", "Backend failed after a side effect");
    } }, { priority: 10000 }); },
  };
  const { runtime } = await runtimeFixture(context, {}, [plugin]);
  const server = await startRemoteHttpServer(runtime, { port: 0 });
  try {
    const session = await createSession(server.origin);
    const send = () => fetch(`${server.origin}/api/v1/sessions/${session}/execute`, { method: "POST", headers: { ...headers, "idempotency-key": "started" }, body: JSON.stringify({ input: { kind: "argv", argv: ["node"] } }) });
    const first = await send(); assert.equal(first.status, 429); await first.text();
    const second = await send(); assert.equal(second.status, 429); assert.equal(second.headers.get("idempotency-replayed"), "true"); await second.text();
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test("HTTP shutdown cancels non-streaming executions and drains their traces", async (context) => {
  const entered = deferred();
  const plugin: RuntimePlugin = {
    manifest: { id: "test.http-cancel", version: "1.0.0", description: "Deterministic test fixture", provides: [EXECUTION_BACKENDS.id] },
    activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "test.cancel", mode: "native", async execute({ signal }) {
      entered.resolve();
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { ...baseResult, outcome: { kind: "cancelled" } };
    } }, { priority: 10000 }); },
  };
  const { runtime } = await runtimeFixture(context, { observability: { writeTraceFile: true } }, [plugin]);
  const server = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  const session = await createSession(server.origin);
  const request = fetch(server.origin + "/api/v1/sessions/" + session + "/execute", { method: "POST", headers, body: JSON.stringify({ input: { kind: "argv", argv: ["node"] } }) }).then((response) => response.json());
  await entered.promise;
  await server.close();
  assert.equal((await request).result.command.kind, "cancelled");
  assert.equal(runtime.admission.snapshot().active, 0);
  assert.equal((runtime.traces.diagnostics().persistence as any).pendingBytes, 0);
});

test("HTTP shared validation rejects terminal, bad env and timeout without starting work", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const server = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  try {
    const session = await createSession(server.origin), body = { input: { kind: "argv", argv: ["node"] } };
    for (const extra of [{ terminal: { columns: 80, rows: 24 } }, { envDelta: { "bad-name": "x" } }, { timeoutMs: 2147483648 }, { stream: "true" }]) {
      const response = await fetch(server.origin + "/api/v1/sessions/" + session + "/execute", { method: "POST", headers, body: JSON.stringify({ ...body, ...extra }) });
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "HTTP_EXECUTE_INVALID");
    }
    assert.equal(runtime.admission.snapshot().completed, 0);
  } finally { await server.close(); }
});

for (const mode of ["timeout", "disconnect"] as const) for (const format of ["stream", "json", "replay"] as const) {
  test(`HTTP ${mode} releases pipelined ${format} writes and lets shutdown finish`, { timeout: 15000 }, async (context) => {
    const entered = deferred(), release = deferred();
    const stdout = Buffer.alloc(8 * 1024 * 1024, 65);
    let calls = 0;
    const plugin: RuntimePlugin = {
      manifest: { id: "test.http-drain", version: "1.0.0", description: "Backpressured completion fixture", provides: [EXECUTION_BACKENDS.id] },
      activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "large-result", mode: "native", async execute() {
        if (++calls === 1) entered.resolve();
        await release.promise;
        return { ...baseResult, stdout, stdoutBytes: stdout.length };
      } }, { priority: 10000 }); },
    };
    const { runtime } = await runtimeFixture(context, {
      process: { outputDrainTimeoutMs: mode === "timeout" ? 75 : 5000, cancelGraceMs: 50 },
      observability: { writeTraceFile: true },
    }, [plugin]);
    const server = await startRemoteHttpServer(runtime, { port: 0 });
    const socket = createConnection({ host: "127.0.0.1", port: server.port });
    socket.on("error", () => undefined);
    try {
      await once(socket, "connect");
      socket.pause();
      const sessionId = await createSession(server.origin);
      const body = JSON.stringify({ input: { kind: "argv", argv: ["node"] }, stream: format === "stream", statePolicy: "isolated" });
      if (format === "replay") {
        release.resolve();
        const seed = await fetch(`${server.origin}/api/v1/sessions/${sessionId}/execute`, { method: "POST", headers: { ...headers, "idempotency-key": "large-replay" }, body });
        assert.equal(seed.status, 200); await seed.text();
      }
      const replayHeader = format === "replay" ? "Idempotency-Key: large-replay\r\n" : "";
      const packet = `POST /api/v1/sessions/${sessionId}/execute HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\n${replayHeader}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`;
      socket.write(packet.repeat(4));
      await within(entered.promise, 3000);
      release.resolve();
      const metrics = () => fetch(server.origin + "/api/v1/metrics", { signal: AbortSignal.timeout(2000) }).then((response) => response.json());
      if (mode === "disconnect") {
        let current = await metrics();
        const expectedCompletions = format === "json" ? 4 : 1;
        for (let attempt = 0; (current.admission.completed < expectedCompletions || current.http.pendingRequests <= 1) && attempt < 100; attempt += 1) { await delay(10); current = await metrics(); }
        assert.ok(current.admission.completed >= expectedCompletions);
        assert.ok(current.http.pendingRequests > 1, "unread responses must retain capacity after execution has completed");
        socket.destroy();
      } else {
        let current = await metrics();
        const expectedCompletions = format === "replay" ? 1 : 4;
        for (let attempt = 0; (current.admission.completed < expectedCompletions || current.http.pendingRequests > 1) && attempt < 100; attempt += 1) { await delay(10); current = await metrics(); }
        assert.equal(current.admission.completed, expectedCompletions);
        assert.equal(current.http.executions, 0, "expired writes must release execution requests without an explicit shutdown");
        assert.equal(current.http.pendingRequests, 1, "only the metrics request should remain");
      }
      // Shorter than the disconnect case's drain timeout: socket closure must wake every response.
      await within(server.close(), 2000);
      assert.equal(runtime.admission.snapshot().active + runtime.admission.snapshot().queued, 0);
      if (format === "replay") assert.equal(calls, 1, "slow receipt delivery must never execute again");
      assert.equal((runtime.traces.diagnostics().persistence as any).pendingBytes, 0);
    } finally {
      release.resolve(); socket.destroy();
      await within(server.close(), 1500).catch(() => undefined);
    }
  });
}
