import test from "node:test";
import assert from "node:assert/strict";
import { PosixLoomService, parseStateReport, quotePosix } from "../src/core/service.js";
import { RuntimeManager } from "../src/core/runtime.js";
import type { ProcessRunResult } from "../src/core/process.js";
import type { ShellExecutionPlan } from "../src/core/types.js";

function stateReport(cwd: string, entries: string[], exitCode = 0): Buffer {
  const env = Buffer.from(`${entries.join("\0")}\0`, "utf8");
  return Buffer.concat([
    Buffer.from(`__POSIXLOOM_REPORT_V1\nexit-code=${exitCode}\ncwd-b64=${Buffer.from(cwd).toString("base64")}\nenv-bytes=${env.length}\n`),
    env,
    Buffer.from("__POSIXLOOM_REPORT_END\n"),
  ]);
}

function shellPlan(runtime: RuntimeManager, sessionId: string): ShellExecutionPlan {
  return {
    mode: "shell",
    planId: "state-report-test",
    commandId: "state-report-test",
    sessionId,
    snapshotId: runtime.snapshot.snapshotId,
    timeoutMs: 1000,
    detached: false,
    policyProfile: "workspace-guard",
    bashExecutable: "bash",
    commandBody: "true",
    cwdVirtual: "/workspace",
    envPosix: {},
    baseStateVersion: 0n,
    statePolicy: "cwd-env",
    mountBootstrap: [],
    stateReportPath: "unused",
  };
}

test("state report parser separates exit code, cwd and exported env", () => {
  const env = Buffer.from("FOO=bar\0PATH=/posixloom/bin:/usr/bin\0", "utf8");
  const report = Buffer.concat([
    Buffer.from("__POSIXLOOM_REPORT_V1\nexit-code=7\ncwd-b64=L3dvcmtzcGFjZS9zcmM=\nenv-bytes=" + env.length + "\n"),
    env,
    Buffer.from("__POSIXLOOM_REPORT_END\n"),
  ]);
  assert.deepEqual(parseStateReport(report), { exitCode: 7, cwd: "/workspace/src", exportedEnv: { FOO: "bar", PATH: "/posixloom/bin:/usr/bin" } });
});

test("POSIX quoting protects single quotes", () => {
  assert.equal(quotePosix("a'b"), "'a'\\''b'");
});

test("state report parser rejects ambiguous metadata, trailing bytes and environment collisions", () => {
  const valid = stateReport("/workspace", ["PATH=/posixloom/bin:/usr/bin"]);
  assert.throws(() => parseStateReport(Buffer.from(valid.toString("binary").replace("exit-code=", "exit="), "binary")), /metadata labels/);
  assert.throws(() => parseStateReport(Buffer.concat([valid, Buffer.from("extra")])), /trailing data/);
  assert.throws(() => parseStateReport(stateReport("/workspace", ["Foo=one", "FOO=two", "PATH=/posixloom/bin:/usr/bin"])), /collide/);
  assert.throws(() => parseStateReport(stateReport("/workspace", ["FOO=one", "FOO=two", "PATH=/posixloom/bin:/usr/bin"])), /duplicated/);
  assert.throws(() => parseStateReport(Buffer.from("not-a-state-report")), /header/);
});

test("non-exit process outcomes never commit a complete StateReport", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession();
  const result: ProcessRunResult = {
    outcome: { kind: "timed-out" },
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    report: stateReport("/workspace", ["FOO=bar", "PATH=/posixloom/bin:/usr/bin"]),
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    processMode: "native-host",
  };
  const completion = (service as any).shellCompletion(shellPlan(runtime, sessionId), result, "test", Date.now());
  assert.deepEqual(completion.command, { kind: "timed-out" });
  assert.equal(completion.state.kind, "not-produced");
  assert.equal(service.sessionSnapshot(sessionId).version, 0n);
});

test("StateReport cannot commit an unmounted cwd", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession();
  const result: ProcessRunResult = {
    outcome: { kind: "exited", exitCode: 0 },
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    report: stateReport("/usr", ["PATH=/posixloom/bin:/usr/bin"]),
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    processMode: "native-host",
  };
  const completion = (service as any).shellCompletion(shellPlan(runtime, sessionId), result, "test", Date.now());
  assert.equal(completion.state.kind, "protocol-failed");
  assert.equal(service.sessionSnapshot(sessionId).cwd, "/workspace");
  assert.equal(service.sessionSnapshot(sessionId).version, 0n);
});
