import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertControlChild } from "./helpers/control-child.js";

const root = process.cwd();
const cli = join(root, "dist", "src", "cli", "main.js");
const host = join(root, "native", "posixloom-host", "target", "debug", process.platform === "win32" ? "posixloom.exe" : "posixloom");
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

test("documented stdio entrypoints start with a frame and execute exact argv", async (context) => {
  const dataRoot = mkdtempSync(join(tmpdir(), "posixloom-entrypoint-"));
  context.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const options = { cwd: root, env: { ...process.env, POSIXLOOM_RUN_ROOT: root, POSIXLOOM_DATA_ROOT: dataRoot, POSIXLOOM_UPDATE_FEED_URL: "" } };
  await assertControlChild(process.execPath, [cli, "serve", "--stdio"], options);
  assert.equal(existsSync(npmCli), true, `npm CLI missing at ${npmCli}`);
  await assertControlChild(process.execPath, [npmCli, "run", "--silent", "serve:stdio"], options);
  assert.equal(existsSync(host), true, "Run npm run build:host before entrypoint integration tests");
  await assertControlChild(host, ["serve", "--stdio"], options);
});

test("native launcher accepts public and legacy commands and rejects malformed internal mode", () => {
  assert.equal(existsSync(host), true, "Run npm run build:host before entrypoint integration tests");
  for (const args of [["version"], ["launch", "version"], ["--help"], []]) {
    const result = spawnSync(host, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15_000, env: { ...process.env, POSIXLOOM_RUN_ROOT: root } });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /PosixLoom Runtime/);
  }
  for (const args of [["__exec-host"], ["__exec-host", "--protocol-v2"], ["__exec-host", "--protocol-v1", "version"]]) {
    const result = spawnSync(host, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /internal process protocol/);
  }
});
