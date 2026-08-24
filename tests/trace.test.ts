import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTraceEvents, traceFilePath } from "../src/core/trace.js";

test("persisted trace reader returns only the requested JSONL tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "posixloom-trace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "logs"), { recursive: true });
  const events = Array.from({ length: 100 }, (_, index) => ({ timestamp: new Date(index * 1000).toISOString(), index }));
  await writeFile(traceFilePath(root), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const tail = await readTraceEvents(root, 3);
  assert.deepEqual(tail.map((event) => event.index), [97, 98, 99]);
});

test("persisted trace reader reports malformed tail entries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "posixloom-trace-invalid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(traceFilePath(root), "{not-json}\n", "utf8");
  await assert.rejects(readTraceEvents(root, 1), (error: any) => error?.code === "TRACE_FILE_INVALID");
});
