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
