import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("CLI PTY forwards interactive stdin and preserves terminal output", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync(process.execPath, [
    cli,
    "exec",
    "--pty",
    "--",
    "node",
    "-e",
    "process.stdout.write('CLI_PTY_PROMPT>');process.stdin.once('data',d=>{process.stdout.write('CLI_PTY_GOT:'+d.toString().trim());process.exit(0)})",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: "cli-input\r\n",
    timeout: 10_000,
    env: { ...process.env, POSIXLOOM_UPDATE_FEED_URL: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("CLI_PTY_PROMPT>"), true);
  assert.equal(result.stdout.includes("CLI_PTY_GOT:cli-input"), true);
});

test("config validation rejects the removed persistence promise and string booleans", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "posixloom-config-invalid-"));
  try {
    mkdirSync(join(dataRoot, "config"), { recursive: true });
    writeFileSync(join(dataRoot, "config", "config.json"), JSON.stringify({ session: { persistAcrossRestart: true } }));
    const persistence = spawnSync(process.execPath, [cli, "config", "validate", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, POSIXLOOM_DATA_ROOT: dataRoot, POSIXLOOM_UPDATE_FEED_URL: "" },
    });
    assert.equal(persistence.status, 2);
    assert.equal(JSON.parse(persistence.stdout).error.code, "CONFIG_UNSUPPORTED");

    writeFileSync(join(dataRoot, "config", "config.json"), JSON.stringify({ observability: { writeTraceFile: "false" } }));
    const boolean = spawnSync(process.execPath, [cli, "config", "validate", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, POSIXLOOM_DATA_ROOT: dataRoot, POSIXLOOM_UPDATE_FEED_URL: "" },
    });
    assert.equal(boolean.status, 2);
    assert.equal(JSON.parse(boolean.stdout).error.code, "CONFIG_INVALID");
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
