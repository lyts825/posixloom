import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRemoteHttpServer } from "../src/http/server.js";
import { RuntimeManager } from "../src/core/runtime.js";
import { PluginMarketplace } from "../src/plugins/marketplace.js";
import { createPluginMarketplaceHttpExtension } from "../src/composition/plugin-http.js";

const TOKEN = "0123456789abcdef-test-token";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

test("remote HTTP service authenticates, manages sessions, executes, and streams NDJSON", async (context) => {
  const runtime = await RuntimeManager.create(process.cwd());
  const pluginRoot = await mkdtemp(join(tmpdir(), "posixloom-http-plugins-"));
  context.after(() => rm(pluginRoot, { recursive: true, force: true }));
  const plugins = new PluginMarketplace(pluginRoot);
  const server = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0, token: TOKEN, extensions: [createPluginMarketplaceHttpExtension(plugins)] });
  context.after(() => server.close());

  const health = await fetch(`${server.origin}/api/v1/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.apiVersion, 1);
  assert.equal((await fetch(`${server.origin}/api/v1/runtime`)).status, 401);
  assert.equal((await fetch(`${server.origin}/`)).status, 404);

  const capabilitiesResponse = await fetch(`${server.origin}/api/v1/capabilities`, { headers: authHeaders() });
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.capabilities.includes("plugins"), true);
  assert.equal(capabilities.capabilities.includes("stream-output"), true);

  const createdResponse = await fetch(`${server.origin}/api/v1/sessions`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ cwd: "/workspace" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.state.version, "0");
  const sessionId = created.sessionId;

  const explained = await fetch(`${server.origin}/api/v1/sessions/${sessionId}/explain`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ input: { kind: "argv", argv: ["node", "-p", "40 + 2"] } }),
  }).then((response) => response.json());
  assert.equal(explained.preview.backend, "native");
  assert.equal(explained.preview.replayable, false);

  const executed = await fetch(`${server.origin}/api/v1/sessions/${sessionId}/execute`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ input: { kind: "argv", argv: ["node", "-p", "process.argv.at(1)", "a b"] } }),
  }).then((response) => response.json());
  assert.equal(Buffer.from(executed.result.stdoutBase64, "base64").toString().trim(), "a b");
  assert.deepEqual(executed.result.command, { kind: "exited", exitCode: 0 });

  const streamResponse = await fetch(`${server.origin}/api/v1/sessions/${sessionId}/execute`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json", accept: "application/x-ndjson" }),
    body: JSON.stringify({ stream: true, input: { kind: "argv", argv: ["node", "-e", "process.stdout.write('one');process.stderr.write('two')"] } }),
  });
  assert.equal(streamResponse.headers.get("content-type")?.startsWith("application/x-ndjson"), true);
  const events = (await streamResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "started");
  assert.equal(events.at(-1).type, "completed");
  assert.equal(Buffer.concat(events.filter((event) => event.type === "output" && event.stream === "stdout").map((event) => Buffer.from(event.dataBase64, "base64"))).toString(), "one");
  assert.equal(Buffer.concat(events.filter((event) => event.type === "output" && event.stream === "stderr").map((event) => Buffer.from(event.dataBase64, "base64"))).toString(), "two");

  const catalog = await fetch(`${server.origin}/api/v1/plugins/catalog`, { headers: authHeaders() }).then((response) => response.json());
  assert.equal(catalog.plugins.some((item: any) => item.manifest.id === "workspace-inspector"), true);
  const installed = await fetch(`${server.origin}/api/v1/plugins/workspace-inspector`, { method: "POST", headers: authHeaders() });
  assert.equal(installed.status, 200);

  const closed = await fetch(`${server.origin}/api/v1/sessions/${sessionId}`, { method: "DELETE", headers: authHeaders() }).then((response) => response.json());
  assert.equal(closed.closed, true);
});

test("remote HTTP service enforces non-loopback auth and explicit CORS", async (context) => {
  const runtime = await RuntimeManager.create(process.cwd());
  await assert.rejects(startRemoteHttpServer(runtime, { host: "0.0.0.0", port: 0 }), (error: any) => error?.code === "HTTP_AUTH_REQUIRED");

  const allowedOrigin = "http://127.0.0.1:7330";
  const server = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0, token: TOKEN, corsOrigins: [allowedOrigin] });
  context.after(() => server.close());
  const preflight = await fetch(`${server.origin}/api/v1/sessions`, {
    method: "OPTIONS",
    headers: { origin: allowedOrigin, "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);

  const forbidden = await fetch(`${server.origin}/api/v1/capabilities`, { headers: authHeaders({ origin: "https://evil.example" }) });
  assert.equal(forbidden.status, 403);
});
