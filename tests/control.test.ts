import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { serveControlPlane } from "../src/core/control.js";
import { NativeFrameDecoder, encodeNativeFrame } from "../src/core/process.js";
import { RuntimeManager } from "../src/core/runtime.js";

class FrameReader {
  private readonly decoder = new NativeFrameDecoder();
  private readonly pending: any[] = [];

  constructor(private readonly output: PassThrough) {}

  async next(): Promise<any> {
    for (;;) {
      const queued = this.pending.shift();
      if (queued) return queued;
      const chunk = this.output.read();
      if (chunk) {
        this.pending.push(...this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        continue;
      }
      await new Promise<void>((resolve) => this.output.once("readable", resolve));
    }
  }
}

test("control protocol exposes a versioned Harness-facing session and argv API", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new FrameReader(output);
  const server = serveControlPlane(runtime, input, output);
  const hello = await reader.next();
  assert.equal(hello.type, "hello");
  assert.equal(hello.protocolVersion, 1);
  assert.equal(hello.capabilities.includes("stream-output-v1"), true);
  assert.equal(hello.capabilities.includes("execute-plan"), true);

  input.write(encodeNativeFrame({ protocolVersion: 1, type: "session.create", id: "s", cwd: "/workspace" }));
  const created = await reader.next();
  assert.equal(created.type, "result");
  const sessionId = created.result.sessionId;
  assert.equal(typeof created.result.state.version, "string");

  input.write(encodeNativeFrame({
    protocolVersion: 1,
    type: "execute",
    id: "e",
    sessionId,
    input: { kind: "argv", argv: ["node", "-p", "process.argv.at(1)", "a b"] },
  }));
  const executed = await reader.next();
  assert.equal(executed.type, "result");
  assert.equal(Buffer.from(executed.result.stdoutBase64, "base64").toString().trim(), "a b");

  input.write(encodeNativeFrame({ protocolVersion: 1, type: "shutdown", id: "shutdown" }));
  assert.equal((await reader.next()).result.shuttingDown, true);
  await server;
});

test("control protocol previews plans and streams ordered binary output", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new FrameReader(output);
  const server = serveControlPlane(runtime, input, output);
  await reader.next();

  input.write(encodeNativeFrame({ protocolVersion: 1, type: "session.create", id: "create-stream" }));
  const sessionId = (await reader.next()).result.sessionId;
  input.write(encodeNativeFrame({
    protocolVersion: 1,
    type: "execute.plan",
    id: "plan",
    sessionId,
    envDelta: { POSIXLOOM_TEST_SECRET: "control-secret-value" },
    input: { kind: "argv", argv: ["node", "-p", "1"] },
  }));
  const planned = await reader.next();
  assert.equal(planned.type, "result");
  assert.equal(planned.result.backend, "native");
  assert.equal(JSON.stringify(planned).includes("control-secret-value"), false);

  input.write(encodeNativeFrame({
    protocolVersion: 1,
    type: "execute",
    id: "stream",
    sessionId,
    stream: true,
    input: {
      kind: "argv",
      argv: ["node", "-e", "process.stdout.write(Buffer.from([0,1,2]));process.stderr.write(Buffer.from([255,254]))"],
    },
  }));
  const frames: any[] = [];
  for (;;) {
    const frame = await reader.next();
    frames.push(frame);
    if (frame.id === "stream" && frame.type === "result") break;
  }
  assert.equal(frames[0].event, "started");
  const outputEvents = frames.filter((frame) => frame.event === "output");
  assert.deepEqual(outputEvents.map((frame) => frame.sequence), outputEvents.map((_, index) => index));
  assert.deepEqual(
    Buffer.concat(outputEvents.filter((frame) => frame.stream === "stdout").map((frame) => Buffer.from(frame.dataBase64, "base64"))),
    Buffer.from([0, 1, 2]),
  );
  assert.deepEqual(
    Buffer.concat(outputEvents.filter((frame) => frame.stream === "stderr").map((frame) => Buffer.from(frame.dataBase64, "base64"))),
    Buffer.from([255, 254]),
  );
  assert.equal(frames.at(-1).result.command.kind, "exited");

  input.write(encodeNativeFrame({ protocolVersion: 1, type: "runtime.info", id: "info" }));
  assert.equal((await reader.next()).result.runtimeId, runtime.snapshot.runtimeId);
  input.write(encodeNativeFrame({ protocolVersion: 1, type: "trace.list", id: "traces", limit: 1 }));
  assert.equal((await reader.next()).result.events.length, 1);
  input.write(encodeNativeFrame({ protocolVersion: 1, type: "shutdown", id: "done" }));
  await reader.next();
  await server;
});

test("control cancellation uses an independent correlation id and reports the target", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new FrameReader(output);
  const server = serveControlPlane(runtime, input, output);
  await reader.next();

  input.write(encodeNativeFrame({ protocolVersion: 1, type: "session.create", id: "create" }));
  const sessionId = (await reader.next()).result.sessionId;
  input.write(encodeNativeFrame({
    protocolVersion: 1,
    type: "execute",
    id: "execute-1",
    sessionId,
    timeoutMs: 10_000,
    input: { kind: "argv", argv: ["node", "-e", "setTimeout(() => {}, 5000)"] },
  }));
  input.write(encodeNativeFrame({ protocolVersion: 1, type: "cancel", id: "cancel-1", targetId: "execute-1" }));

  const first = await reader.next();
  const second = await reader.next();
  const responses = new Map([[first.id, first], [second.id, second]]);
  assert.deepEqual(responses.get("cancel-1")?.result, { targetId: "execute-1", cancelling: true });
  assert.equal(responses.get("execute-1")?.result.command.kind, "cancelled");

  input.end();
  await server;
});

test("control protocol rejects reused request ids and malformed execute options", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new FrameReader(output);
  const server = serveControlPlane(runtime, input, output);
  await reader.next();

  input.write(encodeNativeFrame({ protocolVersion: 1, type: "runtime.doctor", id: "same" }));
  assert.equal((await reader.next()).type, "result");
  input.write(encodeNativeFrame({ protocolVersion: 1, type: "runtime.doctor", id: "same" }));
  assert.equal((await reader.next()).code, "CONTROL_REQUEST_DUPLICATE_ID");
  input.write(encodeNativeFrame({ protocolVersion: 99, type: "runtime.doctor", id: "wrong-version" }));
  assert.equal((await reader.next()).code, "CONTROL_PROTOCOL_MISMATCH");
  input.write(encodeNativeFrame({ protocolVersion: 1, type: "runtime.doctor", id: "wrong-version" }));
  assert.equal((await reader.next()).code, "CONTROL_REQUEST_DUPLICATE_ID");
  input.write(encodeNativeFrame({ protocolVersion: 1, type: "execute", id: "bad", sessionId: "missing", timeoutMs: 0, input: { kind: "argv", argv: ["node"] } }));
  assert.equal((await reader.next()).code, "CONTROL_REQUEST_INVALID");

  input.end();
  await server;
});

test("control protocol cancels in-flight work when input ends with a partial frame", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new FrameReader(output);
  const server = serveControlPlane(runtime, input, output);
  await reader.next();

  input.write(encodeNativeFrame({ protocolVersion: 1, type: "session.create", id: "create" }));
  const sessionId = (await reader.next()).result.sessionId;
  input.write(encodeNativeFrame({
    protocolVersion: 1,
    type: "execute",
    id: "execute",
    sessionId,
    timeoutMs: 10_000,
    input: { kind: "argv", argv: ["node", "-e", "setTimeout(() => {}, 5000)"] },
  }));
  input.end(Buffer.from([10, 0, 0, 0, 123]));

  await assert.rejects(server, (error: any) => error?.code === "NATIVE_FRAME_TRUNCATED");
});
