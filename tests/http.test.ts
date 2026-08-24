import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
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

function rawLoopbackRequest(port: number, options: { method?: string; path?: string; host: string; origin?: string; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: options.path ?? "/api/v1/sessions",
      method: options.method ?? "GET",
      headers: {
        host: options.host,
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.body ? { "content-type": "application/json", "content-length": Buffer.byteLength(options.body) } : {}),
        connection: "close",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
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

test("tokenless loopback HTTP rejects DNS-rebinding Host headers and invalid session cwd", async (context) => {
  const runtime = await RuntimeManager.create(process.cwd());
  const server = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  context.after(() => server.close());
  const hostileOrigin = `http://attacker.example:${server.port}`;
  const rebound = await rawLoopbackRequest(server.port, {
    method: "POST",
    host: `attacker.example:${server.port}`,
    origin: hostileOrigin,
    body: JSON.stringify({ cwd: "/workspace" }),
  });
  assert.equal(rebound.status, 403);

  const preflight = await rawLoopbackRequest(server.port, {
    method: "OPTIONS",
    host: `attacker.example:${server.port}`,
    origin: hostileOrigin,
  });
  assert.equal(preflight.status, 403);

  const created = await fetch(`${server.origin}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace" }),
  });
  assert.equal(created.status, 201);

  const invalidCwd = await fetch(`${server.origin}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/../workspace" }),
  });
  assert.equal(invalidCwd.status, 400);
});
