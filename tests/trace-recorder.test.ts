import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TraceRecorder, readTraceEvents, traceFilePath } from "../src/core/trace.js";
import { summarizeTraces } from "../src/core/trace-summary.js";

test("trace ring retains newest events in order and does not expose mutable references", async () => {
  const recorder = new TraceRecorder(3, false, ".");
  const value = { nested: { value: 0 }, timestamp: "caller-time" };
  const returned = await recorder.record(value);
  value.nested.value = 9; (returned.nested as any).value = 8;
  assert.equal((recorder.snapshot()[0].nested as any).value, 0);
  assert.notEqual(recorder.snapshot()[0].timestamp, "caller-time");
  for (let index = 0; index < 100; index += 1) await recorder.record({ index });
  assert.deepEqual(recorder.snapshot().map((event) => event.index), [97, 98, 99]);
  assert.deepEqual(recorder.snapshot(2).map((event) => event.index), [98, 99]);
  assert.deepEqual(recorder.snapshot(0), []);
  const off = new TraceRecorder(0, false, "."); await off.record({ index: 1 }); assert.deepEqual(off.snapshot(), []);
  await recorder.record({ circular: value, bigint: 1n });
  assert.equal(recorder.diagnostics().serializationErrors, 1);
  assert.equal(recorder.snapshot(1)[0].errorCode, "TRACE_SERIALIZATION_FAILED");
  await recorder.close();
});

test("trace writer batches, rotates within file limits and reads across retained files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "posixloom-trace-rotate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "logs"));
  const recorder = new TraceRecorder(2, true, root, { traceMaxFileBytes: 115, traceRetainedFiles: 2, traceMaxPendingBytes: 10000, traceFlushIntervalMs: 60000 });
  for (let index = 0; index < 10; index += 1) await recorder.record({ index });
  assert.equal((recorder.diagnostics().persistence as any).written, 0);
  await recorder.close();
  const files = await readdir(join(root, "logs"));
  assert.equal(files.length, 3);
  for (const file of files) assert.ok((await stat(join(root, "logs", file))).size <= 115);
  const events = await readTraceEvents(root, 20);
  assert.deepEqual(events.map((event) => event.index), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual((await readTraceEvents(root, 3)).map((event) => event.index), [7, 8, 9]);
  assert.equal((recorder.diagnostics().persistence as any).written, 10);
});

test("trace queues drop bounded excess and recover from IO failure without rejecting records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "posixloom-trace-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "logs"));
  const limited = new TraceRecorder(2, true, root, { traceMaxPendingBytes: 1 });
  await limited.record({ index: 1 }); await limited.flush();
  assert.equal((limited.diagnostics().persistence as any).dropped, 1);
  assert.equal(limited.snapshot().length, 1);
  await mkdir(traceFilePath(root));
  const recorder = new TraceRecorder(3, true, root);
  await assert.doesNotReject(recorder.record({ index: 1 }));
  await assert.doesNotReject(recorder.flush());
  assert.ok((recorder.diagnostics().persistence as any).lastErrorCode);
  assert.equal((recorder.diagnostics().persistence as any).pendingBytes, 0);
  await rmdir(traceFilePath(root));
  await recorder.record({ index: 2 }); await recorder.close();
  assert.equal((await readTraceEvents(root))[0].index, 2);
  assert.equal((recorder.diagnostics().persistence as any).lastErrorCode, undefined);
  await limited.close();
});

test("multiple Runtime trace writers serialize writes and rotation at a shared path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "posixloom-trace-shared-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "logs"));
  const recorders = Array.from({ length: 4 }, () => new TraceRecorder(1, true, root, { traceMaxFileBytes: 180, traceRetainedFiles: 100 }));
  await Promise.all(recorders.map(async (recorder, writer) => {
    for (let index = 0; index < 20; index += 1) { await recorder.record({ writer, index }); if (index % 3 === 0) await recorder.flush(); }
    await recorder.close();
  }));
  const events = await readTraceEvents(root, 100);
  assert.equal(events.length, 80);
  assert.equal(new Set(events.map((event) => String(event.writer) + ":" + String(event.index))).size, 80);
  for (const recorder of recorders) assert.equal((recorder.diagnostics().persistence as any).dropped, 0);
});

test("trace summary reports measured fallback candidates without interpreting command arguments", () => {
  const events = Array.from({ length: 4 }, (_, index) => ({ timestamp: "2026-01-01", operation: "execute", backend: index ? "msys2" : "native", commandName: index ? "find" : "node", fallbackReason: index ? "native-miss" : "native-registry", durationMs: 10 * (index + 1), timings: { queueMs: index } }));
  const summary = summarizeTraces(events) as any;
  assert.equal(summary.nativeHitRate, 0.25);
  assert.deepEqual(summary.durationMs, { count: 4, p50: 20, p95: 40, max: 40 });
  assert.equal(summary.fallbackCandidates[0].command, "find");
  assert.equal(summary.fallbackCandidates[0].samples, 3);
  assert.equal(summary.fallbackCandidates[0].observedTotalMs, 90);
  assert.equal((summarizeTraces([]) as any).nativeHitRate, null);
});
