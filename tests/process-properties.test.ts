import assert from "node:assert/strict";
import test from "node:test";
import { NativeEventValidator, NativeFrameDecoder, OutputCollector, encodeNativeFrame, NATIVE_MAX_FRAME_BYTES } from "../src/core/process.js";

test("namespace waits allow only explicit pre-start cancellation or timeout terminal frames", () => {
  const hello = { protocolVersion: 1, type: "hello", maxFrameBytes: NATIVE_MAX_FRAME_BYTES };
  for (const [outcome, code] of [["cancelled", 130], ["timed-out", 124]] as const) {
    const value = { protocolVersion: 1, type: "exit", outcome, code };
    const ordinary = new NativeEventValidator(); ordinary.accept(hello);
    assert.throws(() => ordinary.accept(value), /exit event/);
    const waiting = new NativeEventValidator(true); waiting.accept(hello);
    assert.deepEqual(waiting.accept(value), value);
    assert.throws(() => waiting.accept({ protocolVersion: 1, type: "started", pid: 1 }), /terminal/);
  }
  for (const [outcome, code] of [["exited", 0], ["crashed", 1], ["cancelled", 0], ["timed-out", 130]] as const) {
    const waiting = new NativeEventValidator(true); waiting.accept(hello);
    assert.throws(() => waiting.accept({ protocolVersion: 1, type: "exit", outcome, code }), /exit event/);
    assert.throws(() => waiting.accept({ protocolVersion: 1, type: "stdout", data: "YQ==" }), /before started/);
  }
});

function random(seed = 0x5eed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }; }

test("frame decoder round-trips randomized Unicode frames at arbitrary chunk boundaries", () => {
  const next = random();
  for (let run = 0; run < 300; run += 1) {
    const expected = Array.from({ length: next() % 12 + 1 }, (_, index) => ({ index, text: "a中😀\\\n".repeat(next() % 30), value: next(), nested: [null, true, ""] }));
    const bytes = Buffer.concat(expected.map(encodeNativeFrame));
    const decoder = new NativeFrameDecoder(), actual: unknown[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const size = next() % 97 + 1;
      actual.push(...decoder.push(bytes.subarray(offset, offset + size))); offset += size;
    }
    decoder.finish(); assert.deepEqual(actual, expected);
  }
});

test("decoder rejects invalid UTF-8, zero, oversize and every incomplete frame prefix", () => {
  for (const payload of [Buffer.from([0x22, 0xc0, 0xaf, 0x22]), Buffer.from("{bad"), Buffer.alloc(0)]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    assert.throws(() => new NativeFrameDecoder().push(Buffer.concat([header, payload])), (error: any) => error.code === "NATIVE_FRAME_INVALID");
  }
  const oversize = Buffer.alloc(4); oversize.writeUInt32LE(NATIVE_MAX_FRAME_BYTES + 1);
  assert.throws(() => new NativeFrameDecoder().push(oversize), (error: any) => error.code === "NATIVE_FRAME_TOO_LARGE");
  const frame = encodeNativeFrame({ text: "partial中😀" });
  for (let end = 1; end < frame.length; end += 1) {
    const decoder = new NativeFrameDecoder(); decoder.push(frame.subarray(0, end));
    assert.throws(() => decoder.finish(), (error: any) => error.code === "NATIVE_FRAME_TRUNCATED");
  }
});

test("output ring equals a reference head/tail model for randomized sizes and chunkings", () => {
  const next = random(42);
  for (let run = 0; run < 1200; run += 1) {
    const limit = next() % 100 + 1, length = next() % 1200;
    const input = Buffer.from(Array.from({ length }, () => next() & 255));
    const collector = new OutputCollector(limit);
    for (let offset = 0; offset < input.length;) {
      const size = next() % 99 + 1, chunk = Buffer.from(input.subarray(offset, offset + size));
      collector.push(chunk); chunk.fill(0); offset += size; // Must own retained bytes.
    }
    const head = Math.ceil(limit / 2), tail = Math.floor(limit / 2);
    const expected = length <= limit ? input : Buffer.concat([input.subarray(0, head), Buffer.from("\n[PosixLoom OUTPUT TRUNCATED]\n"), tail ? input.subarray(-tail) : Buffer.alloc(0)]);
    const result = collector.finish();
    assert.equal(result.truncated, length > limit); assert.equal(collector.totalBytes, length); assert.deepEqual(result.data, expected);
    assert.deepEqual(collector.finish(), result);
  }
});
