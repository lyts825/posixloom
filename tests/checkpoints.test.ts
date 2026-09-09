import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionCheckpointStore } from "../src/core/checkpoints.js";
import { PosixLoomService } from "../src/core/service.js";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

test("checkpoints survive service reconstruction with only explicitly selected environment values", async (context) => {
  const { runtime, root } = await runtimeFixture(context);
  await mkdir(join(root, "src"));
  const original = new PosixLoomService(runtime);
  const sessionId = original.createSession();
  original.sessions.commit(sessionId, { baseStateVersion: 0n, cwd: "/workspace/src", setEnv: { SAVED_VAR: "a b 'value'", UNSAVED_SECRET: "never-on-disk" }, removeEnv: [] }, "cwd-env");
  const store = new SessionCheckpointStore(original);
  const saved = await store.save(sessionId, { name: "Before experiment", envKeys: ["saved_var"] });
  assert.deepEqual(saved.envKeys, ["SAVED_VAR"]);
  assert.equal(JSON.stringify(saved).includes("a b 'value'"), false);
  const disk = await readFile(join(store.directory, `${saved.checkpointId}.json`), "utf8");
  assert.equal(disk.includes("never-on-disk"), false);
  assert.equal(disk.includes("a b 'value'"), true);
  original.sessions.close(sessionId);
  const restarted = new PosixLoomService(runtime);
  const newStore = new SessionCheckpointStore(restarted);
  assert.equal((await newStore.list())[0].name, "Before experiment");
  const restored = restarted.sessionSnapshot(await newStore.restore(saved.checkpointId));
  assert.equal(restored.version, 0n);
  assert.equal(restored.cwd, "/workspace/src");
  assert.equal(restored.exportedEnv.SAVED_VAR, "a b 'value'");
  assert.equal(restored.exportedEnv.UNSAVED_SECRET, undefined);
});

test("checkpoint saves default to no environment values and reject reserved or absent keys", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession();
  const store = new SessionCheckpointStore(service);
  const saved = await store.save(sessionId);
  assert.deepEqual(saved.envKeys, []);
  assert.deepEqual(JSON.parse(await readFile(join(store.directory, `${saved.checkpointId}.json`), "utf8")).exportedEnv, {});
  for (const envKeys of [["HOME"], ["MSYS2_ARG_CONV_EXCL"], ["POSIXLOOM_RUNTIME_ROOT"], ["KEY_THAT_DOES_NOT_EXIST"], ["PATH", "Path"]]) await assert.rejects(store.save(sessionId, { envKeys }));
});

test("checkpoint restore rechecks current policy and directory existence", async (context) => {
  const { runtime, root } = await runtimeFixture(context);
  await mkdir(join(root, "temporary"));
  const service = new PosixLoomService(runtime);
  const store = new SessionCheckpointStore(service);
  const saved = await store.save(service.createSession("/workspace/temporary"));
  await rm(join(root, "temporary"), { recursive: true });
  await assert.rejects(store.restore(saved.checkpointId), { code: "SESSION_CWD_INVALID" });
  const path = join(store.directory, `${saved.checkpointId}.json`);
  const tampered = JSON.parse(await readFile(path, "utf8"));
  tampered.cwd = "/c/Windows";
  await writeFile(path, JSON.stringify(tampered));
  await assert.rejects(store.restore(saved.checkpointId), { code: "SESSION_CWD_INVALID" });
});

test("fork creates independent version-zero state, preserving deletions and filtering runtime keys", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession();
  service.sessions.commit(sessionId, { baseStateVersion: 0n, setEnv: { FORK_VALUE: "old" }, removeEnv: ["USERNAME"] }, "cwd-env");
  const store = new SessionCheckpointStore(service);
  const forkId = await store.fork(sessionId);
  assert.notEqual(forkId, sessionId);
  const fork = service.sessionSnapshot(forkId);
  assert.equal(fork.version, 0n);
  assert.equal(fork.exportedEnv.FORK_VALUE, "old");
  assert.equal(fork.exportedEnv.USERNAME, undefined);
  assert.equal(fork.exportedEnv.HOME, undefined);
  service.sessions.commit(forkId, { baseStateVersion: 0n, setEnv: { FORK_VALUE: "new" }, removeEnv: [] }, "cwd-env");
  assert.equal(service.sessionSnapshot(sessionId).exportedEnv.FORK_VALUE, "old");
});

test("checkpoint tampering and identifier traversal cannot restore or delete arbitrary files", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime);
  const store = new SessionCheckpointStore(service);
  const saved = await store.save(service.createSession());
  for (const id of ["../tasks", "..\\tasks", "", `${saved.checkpointId}/../other`]) {
    await assert.rejects(store.restore(id), { code: "CHECKPOINT_INVALID" });
    await assert.rejects(store.delete(id), { code: "CHECKPOINT_INVALID" });
  }
  const path = join(store.directory, `${saved.checkpointId}.json`);
  const tampered = JSON.parse(await readFile(path, "utf8"));
  tampered.exportedEnv = { PATH: "/evil" }; tampered.envKeys = ["PATH"];
  await writeFile(path, JSON.stringify(tampered));
  await assert.rejects(store.restore(saved.checkpointId), { code: "STATE_PATCH_REJECTED" });
  tampered.exportedEnv = { HOME: "/evil" }; tampered.envKeys = ["HOME"];
  await writeFile(path, JSON.stringify(tampered));
  await assert.rejects(store.restore(saved.checkpointId), { code: "STATE_PATCH_REJECTED" });
  await store.delete(saved.checkpointId);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.restore(saved.checkpointId), { code: "CHECKPOINT_NOT_FOUND" });
});

test("checkpoint capture waits for the session lane to commit", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession();
  let release!: () => void;
  const waiting = new Promise<void>((done) => { release = done; });
  const operation = service.sessions.inStateLane(sessionId, async () => {
    await waiting;
    service.sessions.commit(sessionId, { baseStateVersion: 0n, setEnv: { LATEST_VALUE: "committed" }, removeEnv: [] }, "cwd-env");
  });
  const store = new SessionCheckpointStore(service);
  const pending = store.save(sessionId, { envKeys: ["LATEST_VALUE"] });
  release();
  await operation;
  const saved = await pending;
  const restored = service.sessionSnapshot(await store.restore(saved.checkpointId));
  assert.equal(restored.exportedEnv.LATEST_VALUE, "committed");
});

test("explicit session environments are validated before creating restored state", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime);
  assert.throws(() => service.createSession("/workspace", { HOME: "/tmp" }), { code: "STATE_PATCH_REJECTED" });
  assert.throws(() => service.createSession("/workspace", { BAD: "a\0b" }), { code: "STATE_PATCH_REJECTED" });
  assert.equal(service.sessionSnapshot(service.createSession("/workspace", { my_value: "safe" })).exportedEnv.MY_VALUE, "safe");
});
