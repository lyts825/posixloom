import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { NativeEventValidator, NativeFrameDecoder, OutputCollector, encodeNativeFrame, runProcess } from "../src/core/process.js";

test("output collector preserves every byte up to the configured limit", () => {
  for (const size of [1, 4, 5, 8]) {
    const collector = new OutputCollector(8);
    const expected = Buffer.from("abcdefgh").subarray(0, size);
    collector.push(expected.subarray(0, Math.min(3, size)));
    collector.push(expected.subarray(Math.min(3, size)));
    const result = collector.finish();
    assert.equal(result.truncated, false);
    assert.deepEqual(result.data, expected);
  }
});

test("output collector keeps a bounded head and tail after truncation", () => {
  const collector = new OutputCollector(8);
  collector.push(Buffer.from("abc"));
  collector.push(Buffer.from("defghijklmno"));
  const result = collector.finish();
  assert.equal(result.truncated, true);
  assert.equal(result.data.subarray(0, 4).toString(), "abcd");
  assert.equal(result.data.subarray(-4).toString(), "lmno");
  assert.equal(collector.totalBytes, 15);
});

test("native protocol decoder accepts split length-prefixed frames", () => {
  const encoded = encodeNativeFrame({ protocolVersion: 1, type: "hello" });
  const decoder = new NativeFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(encoded.subarray(2)), [{ protocolVersion: 1, type: "hello" }]);
  decoder.finish();
});

test("native host request size is validated before spawning the host", async () => {
  await assert.rejects(
    () => runProcess({
      program: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1000,
      hostPath: "definitely-missing-native-host.exe",
      input: Buffer.alloc(13 * 1024 * 1024),
      maxOutputBytes: 1024,
    }),
    (error: any) => error?.code === "NATIVE_FRAME_TOO_LARGE",
  );
});

test("native event state machine rejects ambiguous or malformed events", () => {
  const validator = new NativeEventValidator();
  assert.throws(() => validator.accept({ protocolVersion: 2, type: "hello", maxFrameBytes: 16 * 1024 * 1024 }), /protocol mismatch/i);
  assert.equal(validator.accept({ protocolVersion: 1, type: "hello", maxFrameBytes: 16 * 1024 * 1024 }).type, "hello");
  assert.throws(() => validator.accept({ protocolVersion: 1, type: "hello", maxFrameBytes: 16 * 1024 * 1024 }), /duplicated|order/);

  const streams = new NativeEventValidator();
  streams.accept({ protocolVersion: 1, type: "hello", maxFrameBytes: 16 * 1024 * 1024 });
  streams.accept({ protocolVersion: 1, type: "started", pid: 123 });
  assert.throws(() => streams.accept({ protocolVersion: 1, type: "stdout", data: "%%%=" }), /Base64/);
  assert.throws(() => streams.accept({ protocolVersion: 1, type: "exit", code: 0, outcome: "unknown" }), /exit event/);
  assert.throws(() => streams.accept({ protocolVersion: 1, type: "mystery" }), /Unknown Native Host event/);
});

const hostPath = join(process.cwd(), "native", "posixloom-host", "target", "debug", process.platform === "win32" ? "posixloom.exe" : "posixloom");

test("native host preserves exact argv including spaces", { skip: !existsSync(hostPath) }, async () => {
  const result = await runProcess({
    program: process.execPath,
    args: ["-p", "process.argv.at(1)", "a b"],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 5000,
    cancelGraceMs: 1000,
    hostPath,
    maxOutputBytes: 1024,
  });
  assert.deepEqual(result.outcome, { kind: "exited", exitCode: 0 });
  assert.equal(result.stdout.toString().trim(), "a b");
});

test("native host owns timeout and terminates the whole process tree", { skip: !existsSync(hostPath) }, async () => {
  const script = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)']);console.log(c.pid);setTimeout(()=>{},10000)";
  const result = await runProcess({
    program: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 500,
    cancelGraceMs: 1000,
    hostPath,
    maxOutputBytes: 1024,
  });
  assert.deepEqual(result.outcome, { kind: "timed-out" });
  const descendantPid = Number(result.stdout.toString().trim());
  assert.equal(Number.isInteger(descendantPid), true);
  assert.throws(() => process.kill(descendantPid, 0));
});

test("native host handles cooperative cancellation", { skip: !existsSync(hostPath) }, async () => {
  const controller = new AbortController();
  const pending = runProcess({
    program: process.execPath,
    args: ["-e", "setTimeout(()=>{},10000)"],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 5000,
    cancelGraceMs: 1000,
    hostPath,
    signal: controller.signal,
    maxOutputBytes: 1024,
  });
  setTimeout(() => controller.abort(), 100);
  assert.deepEqual((await pending).outcome, { kind: "cancelled" });
});
