import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { serveControlPlane } from "../src/core/control.js";
import { encodeNativeFrame, NATIVE_MAX_FRAME_BYTES, NativeFrameDecoder } from "../src/core/process.js";
import { EXECUTION_BACKENDS } from "../src/plugins/contracts.js";
import type { RuntimePlugin } from "../src/plugins/kernel.js";
import { deferred, runtimeFixture } from "./helpers/runtime-fixture.js";

function client() {
  const input = new PassThrough(), output = new PassThrough(), decoder = new NativeFrameDecoder();
  const pending: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  output.on("data", (chunk) => { for (const value of decoder.push(chunk)) { const waiter = waiters.shift(); if (waiter) waiter(value); else pending.push(value); } });
  return {
    input, output,
    send: (frame: Record<string, unknown>) => input.write(encodeNativeFrame({ protocolVersion: 1, ...frame })),
    next: (): Promise<any> => pending.length ? Promise.resolve(pending.shift()) : new Promise((resolve) => waiters.push(resolve)),
  };
}

test("long-lived control connection advertises and enforces bounded replay history", async (context) => {
  const { runtime } = await runtimeFixture(context, { protocol: { replayWindowSize: 3, replayWindowTtlMs: 60000 } });
  const peer = client(), server = serveControlPlane(runtime, peer.input, peer.output);
  assert.equal((await peer.next()).replayWindow.maximum, 3);
  for (let index = 0; index < 1000; index += 1) {
    peer.send({ type: "metrics", id: String(index) });
    const result = await peer.next();
    assert.ok(result.result.replayIds <= 5);
  }
  peer.send({ type: "metrics", id: "999" });
  assert.equal((await peer.next()).code, "CONTROL_REQUEST_DUPLICATE_ID");
  peer.send({ type: "metrics", id: "0" });
  assert.equal((await peer.next()).type, "result");
  peer.send({ type: "trace.summary", id: "summary" });
  assert.equal((await peer.next()).result.summary.sample.events, 0);
  peer.send({ type: "shutdown", id: "done" }); await peer.next(); await server;
});

test("control reserves cancel/shutdown capacity and cancels queued plan previews", async (context) => {
  const entered = deferred();
  const plugin: RuntimePlugin = {
    manifest: { id: "test.control-block", version: "1.0.0", description: "Cancellation fixture", provides: [EXECUTION_BACKENDS.id] },
    activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "blocking", mode: "native", async execute({ signal }) {
      entered.resolve();
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { outcome: { kind: "cancelled" }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), report: Buffer.alloc(0), stdoutBytes: 0, stderrBytes: 0, truncated: false, processMode: "node-fallback" };
    } }, { priority: 10000 }); },
  };
  const { runtime } = await runtimeFixture(context, { protocol: { maxPendingRequests: 2 }, process: { maxConcurrent: 1, maxQueued: 1 } }, [plugin]);
  const peer = client(), server = serveControlPlane(runtime, peer.input, peer.output);
  await peer.next();
  peer.send({ type: "session.create", id: "session" });
  const sessionId = (await peer.next()).result.sessionId;
  peer.send({ type: "execute", id: "running", sessionId, input: { kind: "argv", argv: ["node"] } });
  await entered.promise;
  peer.send({ type: "execute.plan", id: "plan", sessionId, input: { kind: "argv", argv: ["node"] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.admission.snapshot().queued, 1);
  peer.send({ type: "runtime.info", id: "overload" });
  assert.equal((await peer.next()).code, "SERVER_BUSY");
  peer.send({ type: "cancel", id: "cancel-plan", targetId: "plan" });
  const responses = [await peer.next(), await peer.next()];
  assert.equal(responses.find((frame) => frame.id === "cancel-plan").result.cancelling, true);
  assert.equal(responses.find((frame) => frame.id === "plan").code, "EXECUTION_CANCELLED");
  peer.send({ type: "shutdown", id: "done" });
  await server;
  assert.equal(runtime.admission.snapshot().active + runtime.admission.snapshot().queued, 0);
});

test("unresponsive control output fails on a deadline instead of hanging shutdown", async (context) => {
  const { runtime } = await runtimeFixture(context, { process: { outputDrainTimeoutMs: 25 } });
  const output = new Writable({ write(_chunk, _encoding, _callback) {} }), input = new PassThrough();
  await assert.rejects(serveControlPlane(runtime, input, output), (error: any) => error.code === "CONTROL_OUTPUT_TIMEOUT");
  assert.equal(input.destroyed, true); assert.equal(output.destroyed, true);
});

test("large binary completions fit the frame limit while retaining outcomes and streamed bytes", async (context) => {
  const stdout = Buffer.alloc(7 * 1024 * 1024, 0xff), stderr = Buffer.alloc(7 * 1024 * 1024, 0x80);
  stdout.fill(0x41, stdout.length - 16); stderr.fill(0x42, stderr.length - 16);
  let includeStderr = true;
  const plugin: RuntimePlugin = {
    manifest: { id: "test.control-output", version: "1.0.0", description: "Large binary output fixture", provides: [EXECUTION_BACKENDS.id] },
    activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "large-output", mode: "native", async execute({ onOutput }) {
      const currentStderr = includeStderr ? stderr : Buffer.alloc(0);
      if (onOutput) {
        let sequence = 0;
        for (const [stream, data] of [["stdout", stdout], ["stderr", currentStderr]] as const) {
          for (let offset = 0; offset < data.length; offset += 64 * 1024) await onOutput({ stream, sequence: sequence++, data: data.subarray(offset, offset + 64 * 1024) });
        }
      }
      return { outcome: { kind: "exited", exitCode: 23 }, stdout, stderr: currentStderr, report: Buffer.alloc(0), stdoutBytes: stdout.length, stderrBytes: currentStderr.length, truncated: false, processMode: "node-fallback" };
    } }, { priority: 10000 }); },
  };
  const { runtime } = await runtimeFixture(context, {}, [plugin]);
  const peer = client(), server = serveControlPlane(runtime, peer.input, peer.output);
  try {
    await peer.next();
    peer.send({ type: "session.create", id: "session" });
    const sessionId = (await peer.next()).result.sessionId;
    for (const stream of [false, true]) {
      const hashes = { stdout: createHash("sha256"), stderr: createHash("sha256") };
      let sequence = 0;
      peer.send({ type: "execute", id: `输出"\\\n${stream}`, sessionId, stream, input: { kind: "argv", argv: ["node"] } });
      let frame: any;
      do {
        frame = await peer.next();
        if (frame.event === "output") {
          assert.equal(frame.sequence, sequence++);
          hashes[frame.stream as "stdout" | "stderr"].update(Buffer.from(frame.dataBase64, "base64"));
        }
      } while (frame.type === "event");
      assert.equal(frame.type, "result", JSON.stringify({ code: frame.code, details: frame.details }));
      assert.ok(encodeNativeFrame(frame).length - 4 <= NATIVE_MAX_FRAME_BYTES);
      assert.deepEqual(frame.result.command, { kind: "exited", exitCode: 23 });
      assert.deepEqual(frame.result.state, { kind: "not-applicable" });
      assert.equal(frame.result.truncated, true);
      assert.equal(frame.result.stdoutBytes, stdout.length); assert.equal(frame.result.stderrBytes, stderr.length);
      for (const [name, original] of [["stdout", stdout], ["stderr", stderr]] as const) {
        const retained: Buffer = Buffer.from(frame.result[name + "Base64"], "base64");
        assert.ok(retained.length < original.length && retained.length > 5 * 1024 * 1024);
        assert.deepEqual(retained.subarray(0, 16), original.subarray(0, 16));
        assert.deepEqual(retained.subarray(-16), original.subarray(-16));
        assert.ok(retained.includes(Buffer.from("[PosixLoom OUTPUT TRUNCATED]")));
        if (stream) assert.equal(hashes[name].digest("hex"), createHash("sha256").update(original).digest("hex"));
      }
    }
    includeStderr = false;
    peer.send({ type: "execute", id: "one-large-stream", sessionId, input: { kind: "argv", argv: ["node"] } });
    const frame = await peer.next();
    assert.equal(frame.type, "result");
    assert.equal(frame.result.truncated, false, "unused stderr capacity should preserve the complete stdout");
    assert.deepEqual(Buffer.from(frame.result.stdoutBase64, "base64"), stdout);
    assert.equal(frame.result.stderrBase64, "");
  } finally {
    peer.input.end(); await server;
  }
});
