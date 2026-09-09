import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { JobManager, type JobManagerOptions, type JobStep } from "../src/core/jobs.js";
import { PosixLoomService } from "../src/core/service.js";
import { deferred, runtimeFixture } from "./helpers/runtime-fixture.js";

const nodeStep = (id: string, code: string): JobStep => ({ id, input: { kind: "argv", argv: ["node", "-e", code] }, statePolicy: "isolated" });
async function fixture(context: TestContext, options: JobManagerOptions = {}, overrides: Record<string, unknown> = {}) {
  const { runtime, root } = await runtimeFixture(context, overrides);
  const service = new PosixLoomService(runtime);
  const manager = await JobManager.create(service, options);
  context.after(() => manager.close());
  return { runtime, root, service, manager, sessionId: service.createSession() };
}
async function untilOutput(manager: JobManager, jobId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await manager.events(jobId)).events.some((event) => event.type === "output")) return;
    if (!["queued", "running"].includes(manager.get(jobId).status)) assert.fail("Process finished before producing output");
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail("Timed out waiting for process output");
}

test("jobs preserve complete process output independently of bounded command buffers and paginate without duplicates", async (context) => {
  const { manager, sessionId } = await fixture(context, {}, { process: { maxOutputBytes: 64 } });
  const request = await manager.submit({ sessionId, label: "Full output", steps: [nodeStep("print", 'process.stdout.write("x".repeat(200000));process.stderr.write("last-error")')] });
  assert.equal(request.status, "queued");
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "completed");
  assert.equal(result.truncated, false);
  assert.equal(result.steps[0].stdoutBytes, 200000);
  let cursor = -1;
  const output: Buffer[] = [], errors: Buffer[] = [], sequences: number[] = [];
  while (true) {
    const page = await manager.events(request.jobId, cursor, 2);
    assert.ok(page.events.length <= 2);
    for (const event of page.events) {
      sequences.push(event.sequence);
      if (event.type === "output") (event.stream === "stdout" ? output : errors).push(Buffer.from(event.dataBase64!, "base64"));
    }
    cursor = page.nextSequence;
    if (!page.hasMore) break;
  }
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index));
  assert.equal(Buffer.concat(output).toString(), "x".repeat(200000));
  assert.equal(Buffer.concat(errors).toString(), "last-error");
  assert.deepEqual(await manager.events(request.jobId, cursor), { events: [], nextSequence: cursor, hasMore: false });
  const artifact = await manager.readArtifact(request.jobId, "output");
  assert.equal(artifact.eof, true);
  assert.equal(createHash("sha256").update(artifact.data).digest("hex"), artifact.sha256);
  const isolated = manager.get(request.jobId);
  isolated.steps[0].input = { kind: "text", raw: "mutated" };
  assert.equal(manager.get(request.jobId).steps[0].input.kind, "argv");
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.ok(result.steps[0].commandId);
  assert.equal(result.steps[0].preview?.backend, "native");
  assert.equal(JSON.stringify(result.steps[0].preview).includes("last-error"), false);
});

test("jobs execute steps in order and stop on a nonzero exit code", async (context) => {
  const { manager, sessionId, root } = await fixture(context);
  const marker = join(root, "should-not-exist");
  const request = await manager.submit({ sessionId, steps: [nodeStep("first", 'console.log("first")'), nodeStep("failure", "process.exit(7)"), nodeStep("skipped", `require("fs").writeFileSync(${JSON.stringify(marker)},"bad")`)] });
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.steps.map((step) => step.status), ["completed", "failed", "skipped"]);
  assert.deepEqual(result.steps[1].outcome, { kind: "exited", exitCode: 7 });
  assert.equal(existsSync(marker), false);
  assert.ok(result.artifacts.some((artifact) => artifact.artifactId === "output"));
});

test("queued jobs hold their session lease and can be cancelled before process start", async (context) => {
  const { manager, sessionId, service, root } = await fixture(context);
  const marker = join(root, "never-started");
  const request = await manager.submit({ sessionId, steps: [nodeStep("step", `require("fs").writeFileSync(${JSON.stringify(marker)},"bad")`)] });
  assert.throws(() => service.sessions.close(sessionId), (error: any) => error.code === "SESSION_BUSY");
  const result = await manager.cancel(request.jobId);
  assert.equal(result.status, "cancelled");
  assert.equal(result.steps[0].status, "skipped");
  assert.equal(existsSync(marker), false);
  service.sessions.close(sessionId);
});

test("background work survives caller detachment, supports running cancellation, and close drains execution", async (context) => {
  const { manager, sessionId, runtime } = await fixture(context);
  const request = await manager.submit({ sessionId, steps: [nodeStep("long", 'console.log("ready");setInterval(()=>{},1000)')] });
  await untilOutput(manager, request.jobId);
  assert.equal(manager.get(request.jobId).status, "running");
  assert.equal((await manager.cancel(request.jobId)).status, "cancelled");
  assert.equal(runtime.admission.snapshot().active, 0);
  const next = await manager.submit({ sessionId, steps: [nodeStep("long", 'console.log("ready");setInterval(()=>{},1000)')] });
  await untilOutput(manager, next.jobId);
  await manager.close();
  assert.equal(runtime.admission.snapshot().active, 0);
  const restored = await JobManager.create(new PosixLoomService(runtime));
  try { assert.equal(restored.get(next.jobId).status, "cancelled"); }
  finally { await restored.close(); }
});

test("a log quota cancels producers and preserves an explicit truncated final result", async (context) => {
  const { manager, sessionId } = await fixture(context, { maxLogBytes: 4096 });
  const request = await manager.submit({ sessionId, steps: [nodeStep("flood", 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)')] });
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "JOB_LOG_QUOTA");
  assert.equal(result.truncated, true);
  assert.ok(result.logBytes <= 4096);
  const events = await manager.events(request.jobId);
  assert.equal(events.events.at(-1)?.type, "completed");
  assert.equal(events.events.at(-1)?.status, "failed");
});

test("total storage quota is shared across logs and explicit artifacts", async (context) => {
  const { manager, sessionId } = await fixture(context, { maxTotalBytes: 18_000 });
  const request = await manager.submit({ sessionId, steps: [nodeStep("flood", 'process.stdout.write("x".repeat(30000))')] });
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "JOB_STORAGE_FULL");
  const files = await readdir(join(manager.directory, request.jobId));
  let bytes = 0;
  for (const file of files) { const metadata = await stat(join(manager.directory, request.jobId, file)); if (metadata.isFile()) bytes += metadata.size; }
  assert.ok(bytes <= 18_000);
  await assert.rejects(manager.submit({ sessionId, steps: [nodeStep("large", `console.log(${JSON.stringify("a".repeat(20_000))})`)] }), (error: any) => error.code === "JOB_STORAGE_FULL");
});

test("declared artifacts become immutable snapshots with hashes and bounded range reads", async (context) => {
  const { manager, sessionId, root } = await fixture(context);
  const request = await manager.submit({ sessionId, artifacts: ["/workspace/report.txt"], steps: [nodeStep("write", 'require("fs").writeFileSync("report.txt","abcdef")')] });
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "completed");
  const artifact = result.artifacts.find((item) => item.virtualPath === "/workspace/report.txt")!;
  assert.ok(artifact);
  assert.equal(artifact.sha256, createHash("sha256").update("abcdef").digest("hex"));
  await writeFile(join(root, "report.txt"), "replaced-original");
  const first = await manager.readArtifact(request.jobId, artifact.artifactId, 0, 2);
  assert.equal(first.data.toString(), "ab");
  assert.equal(first.eof, false);
  const second = await manager.readArtifact(request.jobId, artifact.artifactId, first.nextOffset, 10);
  assert.equal(second.data.toString(), "cdef");
  assert.equal(second.eof, true);
  await assert.rejects(manager.readArtifact(request.jobId, "../../record.json"), (error: any) => error.code === "JOB_ARTIFACT_NOT_FOUND");
  await assert.rejects(manager.readArtifact(request.jobId, artifact.artifactId, -1), (error: any) => error.code === "JOB_REQUEST_INVALID");
});

test("artifact capture rejects host paths, escaping paths, directories, junctions, and oversized files", async (context) => {
  const { manager, sessionId, root } = await fixture(context, { maxArtifactBytes: 4 });
  for (const path of [join(root, "file"), "/workspace/../file", "/c/Windows/file", "/workspace", "/workspace/a:stream", "//server/share"]) {
    await assert.rejects(manager.submit({ sessionId, artifacts: [path], steps: [nodeStep("step", "0")] }), (error: any) => error.code === "JOB_ARTIFACT_PATH_INVALID");
  }
  await mkdir(join(root, "folder"));
  const directory = await manager.submit({ sessionId, artifacts: ["/workspace/folder"], steps: [nodeStep("step", "0")] });
  const directoryResult = await manager.wait(directory.jobId);
  assert.equal(directoryResult.status, "failed");
  assert.equal(directoryResult.error?.code, "JOB_ARTIFACT_PATH_INVALID");
  await symlink(join(root, "folder"), join(root, "junction"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(manager.submit({ sessionId, artifacts: ["/workspace/junction/file"], steps: [nodeStep("step", "0")] }), (error: any) => error.code === "JOB_PATH_DENIED");
  const large = await manager.submit({ sessionId, artifacts: ["/workspace/large.txt"], steps: [nodeStep("write", 'require("fs").writeFileSync("large.txt","12345")')] });
  const result = await manager.wait(large.jobId);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "JOB_ARTIFACT_QUOTA");
  assert.equal(result.artifacts.length, 1);
});

test("artifact virtual roots obey workspace-guard even when a file is mounted", async (context) => {
  const { manager, sessionId } = await fixture(context, {}, { policy: { defaultProfile: "workspace-guard", profiles: { "workspace-guard": { mode: "guardrail", knownReadRoots: ["/workspace"], knownWriteRoots: ["/workspace"], runtimeReadOnly: true } } } });
  await assert.rejects(manager.submit({ sessionId, artifacts: ["/home/private.txt"], steps: [nodeStep("step", "0")] }), (error: any) => error.code === "POLICY_CWD_DENIED");
});

test("job restart recovers output cursor and marks unfinished work interrupted without replay", async (context) => {
  const { manager, sessionId, service, root } = await fixture(context);
  const request = await manager.submit({ sessionId, steps: [nodeStep("print", 'console.log("retained")')] });
  await manager.wait(request.jobId);
  await manager.close();
  const file = join(manager.directory, request.jobId, "record.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  record.status = "running";
  record.steps[0].status = "running";
  record.steps[0].input.argv = ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(join(root, "replayed"))},"bad")`];
  record.nextSequence = 0;
  await writeFile(file, JSON.stringify(record));
  await appendFile(join(manager.directory, request.jobId, "output.ndjson"), '{"sequence":');
  const restored = await JobManager.create(service);
  try {
    const recovered = restored.get(request.jobId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.steps[0].status, "interrupted");
    assert.equal(recovered.error?.code, "JOB_INTERRUPTED");
    assert.ok(recovered.nextSequence > 0);
    assert.equal(existsSync(join(root, "replayed")), false);
    const artifact = await restored.readArtifact(request.jobId, "output");
    assert.equal(createHash("sha256").update(artifact.data).digest("hex"), artifact.sha256);
    assert.equal((await restored.events(request.jobId)).events.some((event) => event.type === "output"), true);
  } finally { await restored.close(); }
});

test("storage locks reject concurrent managers and failed initialization releases its lock", async (context) => {
  const { manager, service, sessionId } = await fixture(context);
  await assert.rejects(JobManager.create(service), (error: any) => error.code === "JOB_STORE_LOCKED");
  const request = await manager.submit({ sessionId, steps: [nodeStep("step", "0")] });
  await manager.wait(request.jobId);
  await manager.close();
  const file = join(manager.directory, request.jobId, "record.json");
  const saved = await readFile(file);
  await writeFile(file, "{bad-json");
  await assert.rejects(JobManager.create(service));
  await writeFile(file, saved);
  const restored = await JobManager.create(service);
  try { assert.equal(restored.get(request.jobId).status, "completed"); }
  finally { await restored.close(); }
});

test("retention and job count bounds delete completed history but protect active work", async (context) => {
  const { manager, sessionId } = await fixture(context, { maxJobs: 2, maxActiveJobs: 1 });
  const first = await manager.submit({ sessionId, steps: [nodeStep("one", "0")] });
  await manager.wait(first.jobId);
  const second = await manager.submit({ sessionId, steps: [nodeStep("two", "0")] });
  await manager.wait(second.jobId);
  const third = await manager.submit({ sessionId, steps: [nodeStep("three", 'console.log("ready");setInterval(()=>{},1000)')] });
  assert.throws(() => manager.get(first.jobId), (error: any) => error.code === "JOB_NOT_FOUND");
  await assert.rejects(manager.submit({ sessionId, steps: [nodeStep("four", "0")] }), (error: any) => error.code === "JOB_LIMIT_REACHED");
  await assert.rejects(manager.delete(third.jobId), (error: any) => error.code === "JOB_BUSY");
  await manager.cancel(third.jobId);
  await manager.delete(third.jobId);
  assert.equal(manager.list().length, 1);
  await manager.delete(second.jobId);
  assert.equal(manager.list(sessionId).length, 0);
});

test("validation and nonterminal controls fail before starting work", async (context) => {
  const { manager, sessionId } = await fixture(context);
  await assert.rejects(manager.submit({ sessionId, steps: [] }), (error: any) => error.code === "JOB_REQUEST_INVALID");
  await assert.rejects(manager.submit({ sessionId, steps: [nodeStep("same", "0"), nodeStep("same", "0")] }), (error: any) => error.code === "JOB_REQUEST_INVALID");
  await assert.rejects(manager.submit({ sessionId, terminal: { columns: 80, rows: 24 }, steps: [nodeStep("a", "0"), nodeStep("b", "0")] }), (error: any) => error.code === "JOB_REQUEST_INVALID");
  const request = await manager.submit({ sessionId, steps: [nodeStep("step", "0")] });
  await assert.rejects(manager.input(request.jobId, Buffer.from("hello")), (error: any) => error.code === "TERMINAL_MODE_REQUIRED");
  await manager.wait(request.jobId);
  await assert.rejects(manager.resize(request.jobId, 80, 24), (error: any) => error.code === "JOB_NOT_RUNNING");
});

test("artifact capture retains running state, admission capacity, and session lease until snapshots are ready", async (context) => {
  const { manager, sessionId, service } = await fixture(context, { maxActiveJobs: 1, maxJobs: 1 });
  const entered = deferred(), release = deferred();
  const capture = (manager as any).captureArtifact.bind(manager);
  (manager as any).captureArtifact = async (...args: unknown[]) => { entered.resolve(); await release.promise; return capture(...args); };
  const request = await manager.submit({ sessionId, artifacts: ["/workspace/report.txt"], steps: [nodeStep("write", 'require("fs").writeFileSync("report.txt","report")')] });
  try {
    await entered.promise;
    assert.equal(manager.get(request.jobId).status, "running");
    assert.throws(() => service.sessions.close(sessionId), (error: any) => error.code === "SESSION_BUSY");
    await assert.rejects(manager.delete(request.jobId), (error: any) => error.code === "JOB_BUSY");
    await assert.rejects(manager.submit({ sessionId, steps: [nodeStep("next", "0")] }), (error: any) => error.code === "JOB_LIMIT_REACHED");
  } finally { release.resolve(); }
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "completed");
  assert.ok(result.artifacts.some((artifact) => artifact.name === "report.txt"));
});

test("cancelling during artifact capture produces a cancelled job and no partial artifact", async (context) => {
  const { manager, sessionId } = await fixture(context);
  const entered = deferred(), release = deferred();
  const capture = (manager as any).captureArtifact.bind(manager);
  (manager as any).captureArtifact = async (...args: unknown[]) => { entered.resolve(); await release.promise; return capture(...args); };
  const request = await manager.submit({ sessionId, artifacts: ["/workspace/report.txt"], steps: [nodeStep("write", 'require("fs").writeFileSync("report.txt","report")')] });
  await entered.promise;
  const cancellation = manager.cancel(request.jobId);
  release.resolve();
  const result = await cancellation;
  assert.equal(result.status, "cancelled");
  assert.equal(result.artifacts.filter((artifact) => artifact.artifactId !== "output").length, 0);
  assert.deepEqual(await readdir(join(manager.directory, request.jobId, "artifacts")), []);
});

test("large logs reconnect from sparse offsets and empty polling does not reread files", async (context) => {
  const { manager, sessionId, service } = await fixture(context);
  // Repeated 64 KiB writes create enough records to cross the sparse index boundary.
  const request = await manager.submit({ sessionId, steps: [nodeStep("many", 'for(let i=0;i<150;i++)process.stdout.write("x".repeat(65536))')] });
  const result = await manager.wait(request.jobId);
  assert.ok(result.nextSequence > 128);
  const tail = await manager.events(request.jobId, result.nextSequence - 3, 1);
  assert.equal(tail.events[0].sequence, result.nextSequence - 2);
  assert.equal(tail.hasMore, true);
  const empty = await manager.events(request.jobId, result.nextSequence - 1);
  assert.deepEqual(empty, { events: [], nextSequence: result.nextSequence - 1, hasMore: false });
  await manager.close();
  const restored = await JobManager.create(service);
  try { assert.deepEqual(await restored.events(request.jobId, result.nextSequence - 3, 1), tail); }
  finally { await restored.close(); }
});

test("expired completed jobs are pruned when reopening the store", async (context) => {
  const { manager, sessionId, service } = await fixture(context);
  const request = await manager.submit({ sessionId, steps: [nodeStep("step", "0")] });
  await manager.wait(request.jobId);
  await manager.close();
  const file = join(manager.directory, request.jobId, "record.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  record.updatedAt = "2000-01-01T00:00:00.000Z";
  await writeFile(file, JSON.stringify(record));
  const restored = await JobManager.create(service);
  try { assert.deepEqual(restored.list(), []); assert.equal(existsSync(join(manager.directory, request.jobId)), false); }
  finally { await restored.close(); }
});

test("workspaces sharing a DataRoot have separate job histories and independent storage locks", async (context) => {
  const first = await fixture(context);
  const request = await first.manager.submit({ sessionId: first.sessionId, steps: [nodeStep("step", "0")] });
  await first.manager.wait(request.jobId);
  const other = await runtimeFixture(context);
  other.runtime.config.dataRoot = first.runtime.config.dataRoot;
  const second = await JobManager.create(new PosixLoomService(other.runtime));
  try {
    assert.notEqual(second.directory, first.manager.directory);
    assert.deepEqual(second.list(), []);
    assert.throws(() => second.get(request.jobId), (error: any) => error.code === "JOB_NOT_FOUND");
    assert.equal(first.manager.get(request.jobId).status, "completed");
  } finally { await second.close(); }
});

test("a failing test command still archives its generated report and stops later steps", async (context) => {
  const { manager, sessionId } = await fixture(context);
  const request = await manager.submit({ sessionId, artifacts: ["/workspace/test-report.json"], steps: [nodeStep("test", 'require("fs").writeFileSync("test-report.json",JSON.stringify({failed:1}));process.exit(3)'), nodeStep("skipped", 'console.log("must not run")')] });
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.steps[0].outcome, { kind: "exited", exitCode: 3 });
  assert.equal(result.steps[1].status, "skipped");
  const report = result.artifacts.find((artifact) => artifact.name === "test-report.json");
  assert.ok(report);
  assert.equal((await manager.readArtifact(request.jobId, report.artifactId)).data.toString(), '{"failed":1}');
});

test("missing declared reports are recorded separately and preserve the original command failure", async (context) => {
  const { manager, sessionId } = await fixture(context);
  const request = await manager.submit({ sessionId, artifacts: ["/workspace/missing-report.xml"], steps: [nodeStep("test", "process.exit(9)")] });
  const result = await manager.wait(request.jobId);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.steps[0].outcome, { kind: "exited", exitCode: 9 });
  assert.equal(result.error, undefined);
  assert.equal(result.artifactErrors?.length, 1);
  assert.equal(result.artifactErrors![0].virtualPath, "/workspace/missing-report.xml");
  assert.ok(result.artifactErrors![0].error.code);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.artifactId), ["output"]);
});
