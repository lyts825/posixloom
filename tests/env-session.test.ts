import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEnv, validateStatePatch } from "../src/core/env.js";
import { SessionStateStore } from "../src/core/session.js";

test("environment keys are case-folded and collisions are rejected", () => {
  assert.deepEqual(normalizeEnv({ Foo: "a" }), { FOO: "a" });
  assert.throws(() => normalizeEnv({ PATH: "a", Path: "b" }), /collide/);
});

test("session state commits with a monotonic version", () => {
  const store = new SessionStateStore();
  const id = store.create("/workspace", { FOO: "one" });
  const first = store.snapshot(id);
  const next = store.commit(id, { baseStateVersion: first.version, cwd: "/workspace/src", setEnv: { BAR: "two" }, removeEnv: [] }, "cwd-env");
  assert.equal(next.version, 1n);
  assert.equal(next.cwd, "/workspace/src");
  assert.equal(next.exportedEnv.BAR, "two");
  assert.throws(() => store.commit(id, { baseStateVersion: 0n, setEnv: {}, removeEnv: [] }, "cwd-env"), /stale/);
});

test("runtime-owned environment cannot be committed", () => {
  const state = { version: 0n, cwd: "/workspace", exportedEnv: {} };
  assert.throws(() => validateStatePatch({ baseStateVersion: 0n, setEnv: { HOME: "/tmp" }, removeEnv: [] }, state, "cwd-env"), /cannot be committed/);
});

test("PATH preserves complete runtime entries and cannot be removed", () => {
  const store = new SessionStateStore();
  const id = store.create("/workspace", { PATH: "/posixloom/bin:/usr/bin" });
  assert.throws(() => store.commit(id, { baseStateVersion: 0n, setEnv: { PATH: "/posixloom/bin:/usr/bin-evil" }, removeEnv: [] }, "cwd-env"), /complete/);
  assert.throws(() => store.commit(id, { baseStateVersion: 0n, setEnv: {}, removeEnv: ["PATH"] }, "cwd-env"), /cannot be removed/);
});

test("session store expires idle records and evicts the least recently used inactive session", () => {
  let now = 0;
  const store = new SessionStateStore({ maxSessions: 2, idleTimeoutMs: 10, now: () => now });
  const first = store.create("/workspace", {});
  now = 1;
  const second = store.create("/workspace", {});
  now = 2;
  store.snapshot(first);
  const third = store.create("/workspace", {});
  assert.throws(() => store.snapshot(second), (error: any) => error?.code === "SESSION_NOT_FOUND");
  assert.equal(store.snapshot(first).cwd, "/workspace");
  assert.equal(store.snapshot(third).cwd, "/workspace");

  now = 12;
  assert.deepEqual(store.list(), []);
});

test("active session lanes cannot be evicted to satisfy the capacity limit", async () => {
  let now = 0;
  const store = new SessionStateStore({ maxSessions: 1, idleTimeoutMs: 10, now: () => now });
  const id = store.create("/workspace", {});
  let release!: () => void;
  let started!: () => void;
  const hasStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const running = store.inStateLane(id, async () => { started(); await blocked; });
  await hasStarted;
  now = 20;
  assert.throws(() => store.create("/workspace", {}), (error: any) => error?.code === "SESSION_LIMIT_REACHED");
  release();
  await running;
  now = 31;
  assert.equal(store.list().length, 0);
});
