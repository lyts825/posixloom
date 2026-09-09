import assert from "node:assert/strict";
import test from "node:test";
import { startRemoteHttpServer } from "../src/http/server.js";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

const headers = { "content-type": "application/json" };
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for job");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const done = (job: any) => !["queued", "running"].includes(job.status);

test("HTTP jobs survive client disconnect, deduplicate submission, archive binary artifacts and resume output after restart", async (context) => {
  const { runtime } = await runtimeFixture(context);
  let server = await startRemoteHttpServer(runtime, { port: 0 });
  context.after(() => server.close());
  const api = async (path: string, method = "GET", body?: unknown, key?: string) => {
    const response = await fetch(server.origin + "/api/v1" + path, { method, headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  const { sessionId } = await api("/sessions", "POST", {});
  const secret = "never-export-command-secret-72931";
  const request = { sessionId, label: secret, input: { kind: "argv", argv: ["node", "-e", `process.stdout.write('first\\n'); setTimeout(()=>{require('fs').writeFileSync('report.bin',Buffer.from([0,255,1,2,3]));process.stdout.write('last 中文\\n')},400)`] }, artifacts: ["/workspace/report.bin"] };
  const submitted = await fetch(server.origin + "/api/v1/jobs", { method: "POST", headers: { ...headers, "idempotency-key": "archived-job" }, body: JSON.stringify(request) });
  assert.equal(submitted.status, 202);
  const { job } = await submitted.json();
  // This response's socket has no ownership of the persistent job.
  const controller = new AbortController();
  const observation = fetch(`${server.origin}/api/v1/jobs/${job.jobId}/events`, { signal: controller.signal }).catch(() => undefined);
  controller.abort(); await observation;
  const replay = await api("/jobs", "POST", request, "archived-job");
  assert.equal(replay.job.jobId, job.jobId);
  const completed = await until(async () => (await api(`/jobs/${job.jobId}`)).job, done);
  assert.equal(completed.status, "completed");
  assert.equal((await api("/jobs")).jobs.length, 1);
  const all: any[] = [];
  let after = -1;
  do {
    const page = await api(`/jobs/${job.jobId}/events?after=${after}&limit=1`);
    for (const event of page.events) { assert.ok(event.sequence > after); all.push(event); }
    after = page.nextSequence;
    if (!page.hasMore) break;
  } while (true);
  const stdout = Buffer.concat(all.filter((event) => event.type === "output" && event.stream === "stdout").map((event) => Buffer.from(event.dataBase64, "base64"))).toString("utf8");
  assert.match(stdout, /first\n/); assert.match(stdout, /last 中文\n/);
  const artifact = completed.artifacts.find((item: any) => item.name === "report.bin");
  assert.ok(artifact); assert.equal(artifact.size, 5); assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  const chunk = await api(`/jobs/${job.jobId}/artifacts/${artifact.artifactId}?offset=1&limit=2`);
  assert.deepEqual(Buffer.from(chunk.dataBase64, "base64"), Buffer.from([255, 1])); assert.equal(chunk.eof, false);
  const diagnostic = await api(`/diagnostics?jobId=${job.jobId}`);
  const serialized = JSON.stringify(diagnostic);
  assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes("report.bin")); assert.ok(!serialized.includes(runtime.config.workspace));
  assert.equal(diagnostic.report.schemaVersion, 1);
  await server.close();
  server = await startRemoteHttpServer(runtime, { port: 0 });
  assert.equal((await api(`/jobs/${job.jobId}`)).job.status, "completed");
  assert.equal((await api(`/jobs/${job.jobId}/events?after=${after}`)).events.length, 0);
  assert.equal((await api("/sessions")).sessions.length, 0);
});

test("HTTP project tasks preserve argv parameters, stop after failure, and checkpoints restore a new session", async (context) => {
  const { runtime } = await runtimeFixture(context);
  const server = await startRemoteHttpServer(runtime, { port: 0 });
  context.after(() => server.close());
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(server.origin + "/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const { sessionId } = await api("/sessions", "POST", {});
  const manifest = { schemaVersion: 1, tasks: [{ id: "check", title: "Check task", parameters: { value: { type: "string", required: true } }, artifacts: ["/workspace/failed-report.txt", "/workspace/missing-report.json"], steps: [
    { id: "echo", input: { kind: "argv", argv: ["node", "-e", "require('fs').writeFileSync('failed-report.txt','failure report');process.stdout.write(process.argv[1]);process.exit(7)", "${value}"] } },
    { id: "never", input: { kind: "argv", argv: ["node", "-e", "process.stdout.write('SHOULD_NOT_RUN')"] } },
  ] }] };
  await api("/tasks", "POST", manifest);
  assert.equal((await api("/tasks")).tasks[0].id, "check");
  const literal = "a b; echo injected & $(echo bad) 中文";
  const { job } = await api("/jobs", "POST", { sessionId, taskId: "check", parameters: { value: literal } });
  const result = await until(async () => (await api(`/jobs/${job.jobId}`)).job, done);
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0].outcome.exitCode, 7);
  assert.ok(result.artifacts.some((artifact: any) => artifact.name === "failed-report.txt"));
  assert.equal(result.artifactErrors[0].virtualPath, "/workspace/missing-report.json");
  const report = (await api(`/diagnostics?jobId=${job.jobId}`)).report;
  assert.equal(report.job.steps[0].plan.backend, "native");
  assert.equal(report.traces[0].commandId, result.steps[0].commandId);
  const page = await api(`/jobs/${job.jobId}/events`);
  const output = Buffer.concat(page.events.filter((event: any) => event.type === "output").map((event: any) => Buffer.from(event.dataBase64, "base64"))).toString("utf8");
  assert.equal(output, literal);
  const { checkpoint } = await api(`/sessions/${sessionId}/checkpoint`, "POST", { name: "saved" });
  assert.deepEqual(checkpoint.envKeys, []); assert.ok(!("exportedEnv" in checkpoint));
  const fork = await api(`/sessions/${sessionId}/fork`, "POST", {});
  assert.notEqual(fork.sessionId, sessionId); assert.equal(fork.state.version, "0");
  await api(`/sessions/${sessionId}`, "DELETE");
  const restored = await api(`/checkpoints/${checkpoint.checkpointId}/restore`, "POST", {});
  assert.equal(restored.state.cwd, "/workspace"); assert.equal(restored.state.version, "0");
  await api(`/checkpoints/${checkpoint.checkpointId}`, "DELETE");
  assert.equal((await api("/checkpoints")).checkpoints.length, 0);
  const openapi = await api("/openapi.json");
  assert.ok(openapi.paths["/api/v1/jobs/{id}/artifacts/{artifactId}"]); assert.ok(openapi.components.schemas.JobSubmission);
});

test("HTTP terminal jobs support real ConPTY input, resize and cancellation", { skip: process.platform !== "win32" }, async (context) => {
  const { runtime } = await runtimeFixture(context);
  const server = await startRemoteHttpServer(runtime, { port: 0 });
  context.after(() => server.close());
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(server.origin + "/api/v1" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const { sessionId } = await api("/sessions", "POST", {});
  const { job } = await api("/jobs", "POST", { sessionId, terminal: { columns: 80, rows: 24 }, timeoutMs: 10000, input: { kind: "argv", argv: ["node", "-e", "process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{console.log('heard:'+s.trim());process.exit(0)})"] } });
  await api(`/jobs/${job.jobId}/resize`, "POST", { columns: 100, rows: 30 });
  await api(`/jobs/${job.jobId}/input`, "POST", { dataBase64: Buffer.from("terminal-test\r").toString("base64") });
  const completed = await until(async () => (await api(`/jobs/${job.jobId}`)).job, done);
  assert.equal(completed.status, "completed");
  const events = await api(`/jobs/${job.jobId}/events`);
  const text = Buffer.concat(events.events.filter((item: any) => item.type === "output").map((item: any) => Buffer.from(item.dataBase64, "base64"))).toString("utf8");
  assert.match(text, /heard:terminal-test/);
  const waiting = (await api("/jobs", "POST", { sessionId, input: { kind: "argv", argv: ["node", "-e", "setInterval(()=>{},1000)"] } })).job;
  await api(`/jobs/${waiting.jobId}/cancel`, "POST", {});
  assert.equal((await until(async () => (await api(`/jobs/${waiting.jobId}`)).job, done)).status, "cancelled");
});
