import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const cli = join(process.cwd(), "dist", "src", "cli", "main.js");

function runJson(args: string[]): any {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, POSIXLOOM_UPDATE_FEED_URL: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("diagnostic CLI exposes explain, config validation, runtime info and trace list", () => {
  const preview = runJson(["explain", "--json", "exec", "--", "node", "-p", "1"]);
  assert.equal(preview.backend, "native");
  assert.equal(Array.isArray(preview.environmentKeys), true);

  const sentinel = join(process.cwd(), "data", "tmp", `posixloom-dry-run-${process.pid}.txt`);
  const dryRun = runJson(["exec", "--dry-run", "--json", "--", "node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'unexpected')`]);
  assert.equal(dryRun.backend, "native");
  assert.equal(existsSync(sentinel), false);

  const config = runJson(["config", "validate", "--json"]);
  assert.deepEqual(config.valid, true);
  assert.equal(config.path.endsWith("config\\config.json") || config.path.endsWith("config/config.json"), true);

  const runtime = runJson(["runtime", "info", "--json"]);
  assert.equal(typeof runtime.snapshotId, "string");
  assert.equal(runtime.nativeCommands.includes("node"), true);

  const traces = runJson(["trace", "list", "--limit", "2", "--json"]);
  assert.equal(Array.isArray(traces.events), true);
});
