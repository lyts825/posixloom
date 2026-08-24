import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { PolicyGate } from "../src/core/policy.js";
import { RuntimeManager } from "../src/core/runtime.js";

test("git init translates its explicit virtual destination as a create path", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const gate = new PolicyGate("trusted", runtime.config.runtime.policy.profiles.trusted, runtime.mountTable, runtime.snapshot);
  const resolved = runtime.registry.resolve("git", ["git", "init", "/workspace/仓 库"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(resolved);
  assert.equal(resolved.adapter.argv[2], join(runtime.config.workspace, "仓 库"));
  assert.equal(resolved.adapter.decisions[0]?.intent, "create");
});

test("git init distinguishes template reads and separate directory creates", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const gate = new PolicyGate("trusted", runtime.config.runtime.policy.profiles.trusted, runtime.mountTable, runtime.snapshot);
  const resolved = runtime.registry.resolve("git", ["git", "init", "--template", "/workspace/template", "--separate-git-dir", "/workspace/metadata", "/workspace/repository"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(resolved);
  assert.equal(resolved.adapter.argv[3], join(runtime.config.workspace, "template"));
  assert.equal(resolved.adapter.argv[5], join(runtime.config.workspace, "metadata"));
  assert.equal(resolved.adapter.argv[6], join(runtime.config.workspace, "repository"));
  assert.deepEqual(resolved.adapter.decisions.map((decision) => decision.intent), ["read", "create", "create"]);
});

test("git resolves a subcommand after global options", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const gate = new PolicyGate("trusted", runtime.config.runtime.policy.profiles.trusted, runtime.mountTable, runtime.snapshot);
  const resolved = runtime.registry.resolve("git", ["git", "-C", "/workspace", "init", "/tmp/repository"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(resolved);
  assert.equal(resolved.adapter.argv[2], runtime.config.workspace);
  assert.equal(resolved.adapter.argv[4], join(runtime.config.dataRoot, "tmp", "repository"));
  assert.deepEqual(resolved.adapter.decisions.map((decision) => decision.intent), ["read", "create"]);
});

test("git translates a combined global -C option", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const gate = new PolicyGate("trusted", runtime.config.runtime.policy.profiles.trusted, runtime.mountTable, runtime.snapshot);
  const resolved = runtime.registry.resolve("git", ["git", "-C/workspace", "status"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(resolved);
  assert.equal(resolved.adapter.argv[1], `-C${runtime.config.workspace}`);
});

test("git leaves magic pathspecs untouched after the separator", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const gate = new PolicyGate("trusted", runtime.config.runtime.policy.profiles.trusted, runtime.mountTable, runtime.snapshot);
  const resolved = runtime.registry.resolve("git", ["git", "status", "--", ":(exclude)/workspace/generated", "/workspace/source"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(resolved);
  assert.equal(resolved.adapter.argv[3], ":(exclude)/workspace/generated");
  assert.equal(resolved.adapter.argv[4], join(runtime.config.workspace, "source"));
  assert.deepEqual(resolved.adapter.decisions.map((decision) => decision.argumentIndex), [4]);
});

test("ripgrep distinguishes patterns and option values from path positions", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const gate = new PolicyGate("trusted", runtime.config.runtime.policy.profiles.trusted, runtime.mountTable, runtime.snapshot);
  const resolved = runtime.registry.resolve("rg", ["rg", "/a/", "--glob", "/generated/", "/workspace"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(resolved);
  assert.equal(resolved.adapter.argv[1], "/a/");
  assert.equal(resolved.adapter.argv[3], "/generated/");
  assert.equal(resolved.adapter.argv[4], runtime.config.workspace);
  assert.deepEqual(resolved.adapter.decisions.map((decision) => decision.argumentIndex), [4]);

  const files = runtime.registry.resolve("rg", ["rg", "--files", "/workspace"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(files);
  assert.equal(files.adapter.argv[2], runtime.config.workspace);
});

test("node translates an entrypoint after options without rewriting script arguments", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const gate = new PolicyGate("trusted", runtime.config.runtime.policy.profiles.trusted, runtime.mountTable, runtime.snapshot);
  const resolved = runtime.registry.resolve(
    "node",
    ["node", "--preserve-symlinks", "--require", "/workspace/preload.cjs", "/workspace/app.js", "/workspace/script-argument"],
    runtime.snapshot,
    runtime.mountTable,
    gate,
  );
  assert.ok(resolved);
  assert.equal(resolved.adapter.argv[3], join(runtime.config.workspace, "preload.cjs"));
  assert.equal(resolved.adapter.argv[4], join(runtime.config.workspace, "app.js"));
  assert.equal(resolved.adapter.argv[5], "/workspace/script-argument");
  assert.deepEqual(resolved.adapter.decisions.map((decision) => decision.argumentIndex), [3, 4]);

  const stdin = runtime.registry.resolve("node", ["node", "-", "/workspace/stdin-argument"], runtime.snapshot, runtime.mountTable, gate);
  assert.ok(stdin);
  assert.equal(stdin.adapter.argv[2], "/workspace/stdin-argument");
  assert.deepEqual(stdin.adapter.decisions, []);
});
