import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PosixLoomService } from "../src/core/service.js";
import { ProjectTaskStore, TASK_LIMITS, parseTaskDefinition } from "../src/core/tasks.js";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

const task = { id: "inspect", title: "Inspect project", parameters: { target: { type: "string", required: true }, mode: { type: "enum", values: ["quick", "full"], default: "quick" } }, steps: [{ id: "files", input: { kind: "argv", argv: ["rg", "--files", "${target}"] }, cwd: "/workspace", envDelta: { MODE: "selected:${mode}" } }], artifacts: ["/workspace/result-${mode}.json"] };

test("project tasks persist atomically and resolve data without splitting or recursive expansion", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime);
  const store = new ProjectTaskStore(service);
  assert.deepEqual(await store.list(), []);
  await store.save(task);
  const payload = "a b 'quoted' \"double\"; $(touch bad) ${mode}";
  const resolved = await new ProjectTaskStore(service).resolve("inspect", { target: payload });
  assert.deepEqual(resolved.steps[0].input, { kind: "argv", argv: ["rg", "--files", payload] });
  assert.equal(resolved.steps[0].envDelta?.MODE, "selected:quick");
  assert.deepEqual(resolved.artifacts, ["/workspace/result-quick.json"]);
  assert.equal(resolved.label, "Inspect project");
  assert.equal(JSON.parse(await readFile(store.manifestPath, "utf8")).schemaVersion, 1);
});

test("task parameters reject unknown, missing, nonstring, oversized and invalid enum values", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const store = new ProjectTaskStore(new PosixLoomService(runtime));
  await store.save(task);
  for (const parameters of [{}, { target: "src", extra: "x" }, { target: 1 }, { target: "a\0b" }, { target: "x".repeat(TASK_LIMITS.maxValueBytes + 1) }, { target: "src", mode: "unsafe" }]) {
    await assert.rejects(store.resolve("inspect", parameters), { code: "TASK_INVALID" });
  }
  await assert.rejects(store.resolve("absent", {}), { code: "TASK_NOT_FOUND" });
});

test("task declarations forbid parameter interpolation into shell text and interpreter code", () => {
  for (const input of [{ kind: "text", raw: "echo ${target}" }, { kind: "argv", argv: ["echo", "prefix=${target}"] }, { kind: "argv", argv: ["${target}", "hello"] }, { kind: "argv", argv: ["bash", "-lc", "${target}"] }, { kind: "argv", argv: ["node", "-e", "${target}"] }]) {
    assert.throws(() => parseTaskDefinition({ ...task, steps: [{ id: "one", input }] }), { code: "TASK_INVALID" });
  }
  const fixed = parseTaskDefinition({ ...task, steps: [{ id: "one", input: { kind: "text", raw: "printf '%s' \"$VALUE\"" }, envDelta: { VALUE: "${target}" } }] });
  assert.equal(fixed.steps[0].input.kind, "text");
});

test("task manifests enforce strict shapes, bounds, step identity and declared templates", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const store = new ProjectTaskStore(new PosixLoomService(runtime));
  for (const malformed of [{ schemaVersion: 2, tasks: [] }, { schemaVersion: 1, tasks: [task, task] }, { schemaVersion: 1, tasks: [], extra: true }]) await assert.rejects(store.saveManifest(malformed), { code: "TASK_INVALID" });
  for (const malformed of [{ ...task, unknown: true }, { ...task, steps: [] }, { ...task, steps: [task.steps[0], task.steps[0]] }, { ...task, steps: [{ id: "x", input: { kind: "argv", argv: ["echo", "${missing}"] } }] }, { ...task, parameters: { name: { type: "enum", values: ["a"], default: "b" } } }]) await assert.rejects(store.save(malformed), { code: "TASK_INVALID" });
  assert.deepEqual(await store.list(), []);
});

test("resolved paths and environments revalidate parameter substitutions", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const store = new ProjectTaskStore(new PosixLoomService(runtime));
  await store.save({ id: "path", parameters: { dir: { type: "string", required: true } }, steps: [{ id: "one", input: { kind: "argv", argv: ["echo", "ok"] }, cwd: "/workspace/${dir}" }], artifacts: ["/workspace/${dir}/result.txt"] });
  await assert.rejects(store.resolve("path", { dir: "../outside" }), { code: "TASK_INVALID" });
  await store.save({ id: "env", parameters: { path: { type: "string" } }, steps: [{ id: "one", input: { kind: "argv", argv: ["echo"] }, envDelta: { PATH: "${path}" } }] });
  await assert.rejects(store.resolve("env", { path: "/unsafe" }), { code: "STATE_PATCH_REJECTED" });
  await assert.rejects(store.save({ id: "owned", steps: [{ id: "one", input: { kind: "argv", argv: ["echo"] }, envDelta: { HOME: "/tmp" } }] }), { code: "STATE_PATCH_REJECTED" });
});

test("concurrent task saves preserve both declarations and manifest replacements are validated", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const service = new PosixLoomService(runtime);
  const first = new ProjectTaskStore(service);
  const second = new ProjectTaskStore(service);
  await Promise.all([first.save({ ...task, id: "first" }), second.save({ ...task, id: "second" })]);
  assert.deepEqual((await first.list()).map((entry) => entry.id).sort(), ["first", "second"]);
  await first.delete("first");
  assert.equal((await first.list()).length, 1);
  await first.saveManifest({ schemaVersion: 1, tasks: [] });
  assert.deepEqual(await first.list(), []);
});

test("task reads reject oversized files and symlinked manifest directories", async (context) => {
  const { runtime, root } = await runtimeFixture(context);
  const store = new ProjectTaskStore(new PosixLoomService(runtime));
  await mkdir(join(root, ".posixloom"));
  await writeFile(store.manifestPath, " ".repeat(TASK_LIMITS.maxFileBytes + 1));
  await assert.rejects(store.list(), { code: "STATE_FILE_TOO_LARGE" });
  const outside = join(root, "outside");
  await mkdir(outside);
  runtime.config.runtime.runtime.workspace = join(root, "linked");
  await mkdir(runtime.config.runtime.runtime.workspace);
  await symlink(outside, join(runtime.config.runtime.runtime.workspace, ".posixloom"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(new ProjectTaskStore(new PosixLoomService(runtime)).list(), { code: "STATE_STORAGE_UNSAFE" });
});
