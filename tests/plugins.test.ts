import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginMarketplace, validatePluginManifest } from "../src/plugins/marketplace.js";

function remoteManifest(id: string, version = "1.0.0"): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id,
    name: "Remote Test",
    version,
    description: "Remote test plugin",
    author: "Tests",
    category: "Testing",
    tags: ["remote"],
    commands: [{ id: "run", title: "Run", description: "Run", input: { kind: "argv", argv: ["node", "--version"] } }],
  };
}

test("plugin marketplace installs declarative built-ins without executing them", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "posixloom-plugins-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const marketplace = new PluginMarketplace(dataRoot);

  const catalog = await marketplace.catalog("workspace");
  const candidate = catalog.find((item) => item.manifest.id === "workspace-inspector");
  assert.ok(candidate);
  assert.equal(candidate.installedVersion, undefined);

  const installed = await marketplace.install("workspace-inspector");
  assert.equal(installed.manifest.id, "workspace-inspector");
  assert.equal((await marketplace.installed()).length, 1);
  const command = await marketplace.command("workspace-inspector", "git-status");
  assert.deepEqual(command.input, { kind: "argv", argv: ["git", "status", "--short", "--branch"] });

  const record = JSON.parse(await readFile(join(dataRoot, "plugins", "installed", "workspace-inspector.json"), "utf8"));
  assert.equal(record.recordVersion, 1);
  assert.equal(record.source, "builtin");
  assert.equal(record.manifest.commands[0].input.kind, "argv");

  await marketplace.uninstall("workspace-inspector");
  assert.deepEqual(await marketplace.installed(), []);
  await assert.rejects(marketplace.command("workspace-inspector", "git-status"), (error: any) => error?.code === "PLUGIN_NOT_INSTALLED");
});

test("plugin manifests reject traversal ids, duplicate commands, and executable code fields", () => {
  assert.throws(() => validatePluginManifest({
    manifestVersion: 1,
    id: "../escape",
    name: "Escape",
    version: "1.0.0",
    description: "invalid",
    author: "test",
    category: "test",
    tags: [],
    commands: [{ id: "run", title: "Run", description: "Run", input: { kind: "text", raw: "echo no" } }],
  }), (error: any) => error?.code === "PLUGIN_MANIFEST_INVALID");

  assert.throws(() => validatePluginManifest({
    manifestVersion: 1,
    id: "duplicate",
    name: "Duplicate",
    version: "1.0.0",
    description: "invalid",
    author: "test",
    category: "test",
    tags: [],
    commands: [
      { id: "same", title: "One", description: "One", input: { kind: "text", raw: "echo one" } },
      { id: "same", title: "Two", description: "Two", input: { kind: "text", raw: "echo two" } },
    ],
  }), (error: any) => error?.code === "PLUGIN_MANIFEST_INVALID");
});

test("plugin marketplace discovers an explicitly configured loopback catalog", async (context) => {
  const catalog = {
    schemaVersion: 1,
    plugins: [{
      manifestVersion: 1,
      id: "remote-readonly",
      name: "Remote Readonly",
      version: "2.1.0",
      description: "A test command pack served by a remote catalog.",
      author: "Tests",
      category: "Testing",
      tags: ["remote"],
      commands: [{ id: "node-version", title: "Node version", description: "Print Node version", input: { kind: "argv", argv: ["node", "--version"] } }],
    }],
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(catalog));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const dataRoot = await mkdtemp(join(tmpdir(), "posixloom-remote-plugins-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));

  const marketplace = new PluginMarketplace(dataRoot, { marketplaceUrl: `http://127.0.0.1:${port}/catalog.json` });
  const remote = (await marketplace.catalog()).find((item) => item.manifest.id === "remote-readonly");
  assert.equal(remote?.manifest.version, "2.1.0");
  assert.match(remote?.source ?? "", /^http:\/\/127\.0\.0\.1:/);
  assert.equal((await marketplace.install("remote-readonly")).source, `http://127.0.0.1:${port}/catalog.json`);

  assert.throws(() => new PluginMarketplace(dataRoot, { marketplaceUrl: "http://example.com/catalog.json" }), (error: any) => error?.code === "PLUGIN_MARKETPLACE_URL_INVALID");
});

test("remote catalogs are streamed under a byte limit and cannot redefine built-in ids", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "posixloom-bounded-catalog-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  let emittedBytes = 0;
  const oversizedFetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      emittedBytes += 512;
      controller.enqueue(new Uint8Array(512));
    },
  }, { highWaterMark: 0 }), { status: 200 })) as typeof fetch;
  const bounded = new PluginMarketplace(dataRoot, {
    marketplaceUrl: "https://marketplace.example/catalog.json",
    maxCatalogBytes: 1024,
    fetch: oversizedFetch,
  });
  await assert.rejects(bounded.catalog(), (error: any) => error?.code === "PLUGIN_MARKETPLACE_TOO_LARGE");
  assert.equal(emittedBytes, 1536);

  const shadowCatalog = JSON.stringify({ schemaVersion: 1, plugins: [remoteManifest("workspace-inspector", "999.0.0")] });
  const shadowing = new PluginMarketplace(dataRoot, {
    marketplaceUrl: "https://marketplace.example/catalog.json",
    fetch: (async () => new Response(shadowCatalog, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  await assert.rejects(shadowing.catalog(), (error: any) => error?.code === "PLUGIN_MARKETPLACE_INVALID");
});

test("installed records cannot assign a built-in id to a remote source", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "posixloom-plugin-record-shadow-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const installedRoot = join(dataRoot, "plugins", "installed");
  await mkdir(installedRoot, { recursive: true });
  await writeFile(join(installedRoot, "workspace-inspector.json"), JSON.stringify({
    recordVersion: 1,
    installedAt: new Date(0).toISOString(),
    source: "https://attacker.example/catalog.json",
    manifest: remoteManifest("workspace-inspector", "999.0.0"),
  }), "utf8");
  const marketplace = new PluginMarketplace(dataRoot);
  await assert.rejects(marketplace.installed(), (error: any) => error?.code === "PLUGIN_RECORD_INVALID");
});
