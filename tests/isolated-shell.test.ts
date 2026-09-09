import assert from "node:assert/strict";
import test from "node:test";
import { parseIsolatedReport, parseStateReport } from "../src/core/state-report.js";
import { PosixLoomService } from "../src/core/service.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellNamespaceIdentity } from "../src/core/shell-namespace.js";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

const receipt = (code: string | number) => Buffer.from(`__POSIXLOOM_COMPLETION_V1\nexit-code=${code}\n__POSIXLOOM_REPORT_END\n`);

test("Git wrapper and direct Bash share the actual DLL namespace identity", async (context) => {
  const { root } = await runtimeFixture(context);
  const wrapper = join(root, "git", "bin", "bash.exe"), direct = join(root, "git", "usr", "bin", "bash.exe");
  await mkdir(join(root, "git", "bin"), { recursive: true });
  await mkdir(join(root, "git", "usr", "bin"), { recursive: true });
  for (const path of [wrapper, direct, join(root, "git", "usr", "bin", "msys-2.0.dll")]) await writeFile(path, "fixture");
  assert.equal(shellNamespaceIdentity(wrapper), shellNamespaceIdentity(direct));
});

test("isolated receipts reject truncation, trailing bytes and invalid codes without weakening StateReport", () => {
  assert.equal(parseIsolatedReport(Buffer.alloc(0)), undefined);
  for (const code of [0, 7, 255]) assert.deepEqual(parseIsolatedReport(receipt(code)), { exitCode: code });
  const valid = receipt(7);
  for (let size = 1; size < valid.length; size++) assert.throws(() => parseIsolatedReport(valid.subarray(0, size)));
  for (const code of ["-1", "256", "01", "1.0", "+1", "", "NaN"]) assert.throws(() => parseIsolatedReport(receipt(code)));
  for (const suffix of ["\n", "extra", "\0"]) assert.throws(() => parseIsolatedReport(Buffer.concat([valid, Buffer.from(suffix)])));
  assert.throws(() => parseStateReport(valid), /header/);
  const legacy = Buffer.from("__POSIXLOOM_REPORT_V1\nexit-code=7\ncwd-b64=L3dvcmtzcGFjZQ==\nenv-bytes=0\n__POSIXLOOM_REPORT_END\n");
  assert.equal(parseIsolatedReport(legacy)?.exitCode, 7);
});

test("isolated shell preserves output and exit code without collecting cwd or environment", async (context) => {
  const { runtime } = await runtimeFixture(context);
  if (!runtime.findBash()) { context.skip("Bash unavailable"); return; }
  const service = new PosixLoomService(runtime), sessionId = service.createSession();
  const before = service.sessionSnapshot(sessionId);
  const result = await service.execute({ sessionId, statePolicy: "isolated", raw: [
    "env() { return 99; }; base64() { return 99; }; wc() { return 99; }; tr() { return 99; }; function [ { return 1; }",
    "export ISOLATED_VALUE='不应提交'; cd /tmp",
    "builtin printf '你好 stdout'; builtin printf 'stderr' >&2; printf() { return 99; }; return 7",
  ].join("\n") });
  assert.deepEqual(result.command, { kind: "exited", exitCode: 7 });
  assert.deepEqual(result.state, { kind: "not-applicable" });
  assert.equal(result.stdout.toString(), "你好 stdout");
  assert.equal(result.stderr.toString(), "stderr");
  assert.deepEqual(service.sessionSnapshot(sessionId), before);
  const stateful = await service.execute({ sessionId, statePolicy: "cwd-env", raw: "function [ { return 0; }; true" });
  assert.equal(stateful.state.kind, "committed");
});

test("isolated early exit, exec, errexit and receipt write failure retain failure semantics", async (context) => {
  const { runtime } = await runtimeFixture(context);
  if (!runtime.findBash()) { context.skip("Bash unavailable"); return; }
  const service = new PosixLoomService(runtime), sessionId = service.createSession();
  for (const [raw, exitCode] of [["exit 9", 9], ["exec /usr/bin/true", 0], ["set -e; false", 1], ["POSIXLOOM_STATE_REPORT_PATH=/workspace; true", 240]] as const) {
    const result = await service.execute({ sessionId, statePolicy: "isolated", raw });
    assert.deepEqual(result.command, { kind: "exited", exitCode }, result.stderr.toString());
    assert.equal(result.state.kind, "not-produced");
    assert.equal(service.sessionSnapshot(sessionId).version, 0n);
  }
  const controller = new AbortController();
  const result = await service.execute({ sessionId, statePolicy: "isolated", raw: "sleep 10", signal: controller.signal }, {
    onOutput: () => undefined,
    onStarted: () => { setTimeout(() => controller.abort(), 100); },
  });
  assert.equal(result.command.kind, "cancelled");
  assert.equal(result.state.kind, "not-produced");
});
