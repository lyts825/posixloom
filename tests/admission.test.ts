import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionAdmission } from "../src/core/admission.js";
import { SessionStateStore } from "../src/core/session.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>((done) => setImmediate(done));
const options = { maxConcurrent: 2, maxConcurrentPerClient: 1, maxQueued: 3, maxQueuedPerClient: 2, queueTimeoutMs: 5000 };

test("admission bounds global/client capacity and bypasses a blocked client's lane", async () => {
  const admission = new ExecutionAdmission(options);
  const gates = Array.from({ length: 5 }, deferred);
  const started: number[] = [];
  const run = (index: number, client: string) => admission.run(client, undefined, undefined, async () => { started.push(index); await gates[index].promise; });
  const a = run(0, "a"), a2 = run(1, "a"), b = run(2, "b"), c = run(3, "c"), a3 = run(4, "a");
  assert.deepEqual(admission.snapshot(), { active: 2, queued: 3, clients: 2, completed: 0, rejected: 0 });
  await assert.rejects(run(0, "overflow"), (error: any) => error.code === "SERVER_BUSY");
  gates[2].resolve(); await b; await turn();
  assert.deepEqual(started, [0, 2, 3]);
  gates[0].resolve(); await a; await turn();
  assert.deepEqual(started, [0, 2, 3, 1]);
  gates[1].resolve(); await a2; gates[3].resolve(); gates[4].resolve(); await Promise.all([c, a3]);
  assert.deepEqual(admission.snapshot(), { active: 0, queued: 0, clients: 0, completed: 5, rejected: 1 });
});

test("same-session requests wait without occupying execution slots", async () => {
  const admission = new ExecutionAdmission({ ...options, maxConcurrentPerClient: 2 });
  const gate = deferred();
  const started: string[] = [];
  const run = (name: string, lane: string) => admission.run("client", lane, undefined, async () => { started.push(name); await gate.promise; });
  const tasks = [run("one", "session-a"), run("two", "session-a"), run("other", "session-b")];
  await turn();
  assert.deepEqual(started, ["one", "other"]);
  assert.equal(admission.snapshot().queued, 1);
  gate.resolve(); await Promise.all(tasks);
  assert.deepEqual(started, ["one", "other", "two"]);
});

test("same-session requests keep submission order across clients, including queued dispatch", async () => {
  for (const fillGlobalCapacity of [false, true]) {
    const admission = new ExecutionAdmission({ ...options, maxQueued: 8, maxQueuedPerClient: 8 });
    const busy = deferred(), filler = deferred();
    const order: string[] = [];
    let state = "old";
    const tasks = [admission.run("a", "other-session", undefined, () => busy.promise)];
    if (fillGlobalCapacity) tasks.push(admission.run("c", undefined, undefined, () => filler.promise));
    tasks.push(admission.run("a", "shared-session", undefined, async () => { state = "new"; order.push("first"); }));
    tasks.push(admission.run("b", "shared-session", undefined, async () => { order.push(`second:${state}`); }));
    try {
      filler.resolve();
      await turn();
      assert.deepEqual([...order], [], "a later client must not overtake the queued session head");
      await admission.run("b", "unrelated-session", undefined, async () => { order.push("unrelated"); });
      busy.resolve();
      await Promise.all(tasks);
      assert.deepEqual(order, ["unrelated", "first", "second:new"]);
      assert.equal(admission.snapshot().active + admission.snapshot().queued, 0);
    } finally {
      busy.resolve(); filler.resolve();
      await Promise.allSettled(tasks);
    }
  }
});

test("cancelling a queued session head releases its cross-client successor", async () => {
  const admission = new ExecutionAdmission(options);
  const busy = deferred(), controller = new AbortController();
  const running = admission.run("a", "other-session", undefined, () => busy.promise);
  let successorStarted = false;
  const head = admission.run("a", "shared-session", controller.signal, async () => assert.fail("cancelled head ran"));
  const rejected = assert.rejects(head, (error: any) => error.code === "EXECUTION_CANCELLED");
  const successor = admission.run("b", "shared-session", undefined, async () => { successorStarted = true; });
  try {
    await turn();
    assert.equal(successorStarted, false);
    controller.abort();
    await rejected;
    await successor;
    assert.equal(successorStarted, true);
    assert.equal(admission.snapshot().active, 1);
  } finally {
    controller.abort(); busy.resolve();
    await Promise.allSettled([running, rejected, successor]);
  }
});

test("queued aborts and timeouts never execute and reclaim their queue entries", async () => {
  const admission = new ExecutionAdmission({ ...options, maxConcurrent: 1, queueTimeoutMs: 20 });
  const gate = deferred();
  const running = admission.run("one", undefined, undefined, () => gate.promise);
  const controller = new AbortController();
  let invoked = 0;
  const cancelled = admission.run("two", undefined, controller.signal, async () => { invoked += 1; });
  const rejected = assert.rejects(cancelled, (error: any) => error.code === "EXECUTION_CANCELLED");
  controller.abort(); await rejected;
  await assert.rejects(admission.run("three", undefined, undefined, async () => { invoked += 1; }), (error: any) => error.code === "QUEUE_TIMEOUT");
  await assert.rejects(admission.run("four", undefined, controller.signal, async () => { invoked += 1; }), (error: any) => error.code === "EXECUTION_CANCELLED");
  assert.equal(admission.snapshot().queued, 0);
  assert.equal(invoked, 0);
  gate.resolve(); await running;
  await assert.rejects(admission.run("one", undefined, undefined, async () => { throw new Error("backend failed"); }), /backend failed/);
  assert.equal(admission.snapshot().active, 0);
});

test("large mixed-client load obeys both limits with no leaked slots", async () => {
  const admission = new ExecutionAdmission({ ...options, maxConcurrent: 7, maxConcurrentPerClient: 2, maxQueued: 1000, maxQueuedPerClient: 1000 });
  let active = 0, peak = 0;
  const clients = new Map<string, number>();
  await Promise.all(Array.from({ length: 500 }, (_, index) => {
    const client = String(index % 5);
    return admission.run(client, undefined, undefined, async () => {
      active += 1; peak = Math.max(peak, active);
      clients.set(client, (clients.get(client) ?? 0) + 1);
      assert.ok(clients.get(client)! <= 2);
      assert.ok(active <= 7);
      await turn();
      active -= 1; clients.set(client, clients.get(client)! - 1);
    });
  }));
  assert.equal(peak, 7);
  assert.equal(admission.snapshot().completed, 500);
  assert.equal(admission.snapshot().active + admission.snapshot().queued, 0);
});

test("zero queue capacity rejects excess work, and invalid limits fail early", async () => {
  for (const value of [-1, 1.5, NaN]) assert.throws(() => new ExecutionAdmission({ ...options, maxQueued: value }));
  const admission = new ExecutionAdmission({ ...options, maxConcurrent: 1, maxQueued: 0, maxQueuedPerClient: 0 });
  const gate = deferred(), active = admission.run("a", undefined, undefined, () => gate.promise);
  await assert.rejects(admission.run("b", undefined, undefined, async () => {}), (error: any) => error.code === "SERVER_BUSY");
  gate.resolve(); await active;
});

test("leases protect isolated or queued sessions from close, TTL and eviction", async () => {
  let now = 0;
  const sessions = new SessionStateStore({ maxSessions: 1, idleTimeoutMs: 10, now: () => now });
  const session = sessions.create();
  const gate = deferred();
  const task = sessions.withLease(session, () => gate.promise);
  now = 100;
  assert.equal(sessions.list().length, 1);
  assert.throws(() => sessions.close(session), (error: any) => error.code === "SESSION_BUSY");
  assert.throws(() => sessions.create(), (error: any) => error.code === "SESSION_LIMIT_REACHED");
  gate.resolve(); await task;
  await assert.rejects(sessions.withLease(session, async () => { throw new Error("rejected"); }), /rejected/);
  sessions.close(session);
  assert.deepEqual(sessions.list(), []);
});
