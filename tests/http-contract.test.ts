import assert from "node:assert/strict";
import test from "node:test";
import { PosixLoomError } from "../src/core/errors.js";
import type { ProcessRunResult } from "../src/core/process.js";
import { startRemoteHttpServer } from "../src/http/server.js";
import { EXECUTION_BACKENDS } from "../src/plugins/contracts.js";
import type { RuntimePlugin } from "../src/plugins/kernel.js";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

type Schema = Record<string, any>;
/** Deliberately limited to response-schema keywords; unknown validation keywords fail closed. */
function assertContract(value: unknown, schema: Schema, schemas: Record<string, Schema>, path = "$response"): void {
  const supported = new Set(["$ref", "oneOf", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "pattern", "minimum", "description", "contentEncoding"]);
  for (const keyword of Object.keys(schema)) assert.ok(supported.has(keyword), `Unsupported schema keyword ${keyword} at ${path}`);
  if (schema.$ref) {
    assert.ok(schema.$ref.startsWith("#/components/schemas/"));
    const target = schemas[schema.$ref.slice("#/components/schemas/".length)];
    assert.ok(target, `Unresolved schema reference ${schema.$ref}`);
    assertContract(value, target, schemas, path);
  }
  if (schema.oneOf) {
    let matches = 0;
    for (const candidate of schema.oneOf) {
      try { assertContract(value, candidate, schemas, path); matches += 1; } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        if (error.message.includes("Unsupported schema keyword") || error.message.includes("Unresolved schema reference")) throw error;
      }
    }
    assert.equal(matches, 1, `${path} must match exactly one variant`);
  }
  if ("const" in schema) assert.deepEqual(value, schema.const, `${path} const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} enum`);
  if (schema.type === "integer") assert.ok(Number.isSafeInteger(value), `${path} integer`);
  else if (schema.type === "array") assert.ok(Array.isArray(value), `${path} array`);
  else if (schema.type === "object") assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${path} object`);
  else if (schema.type) assert.equal(typeof value, schema.type, `${path} type`);
  if (schema.minimum !== undefined) assert.ok(typeof value === "number" && value >= schema.minimum, `${path} minimum`);
  if (schema.pattern) assert.ok(typeof value === "string" && new RegExp(schema.pattern, "u").test(value), `${path} pattern`);
  if (schema.type === "array") for (const [index, item] of (value as unknown[]).entries()) assertContract(item, schema.items, schemas, `${path}[${index}]`);
  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(record, key), `${path}.${key} required`);
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property) assertContract(item, property, schemas, `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${path}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") assertContract(item, schema.additionalProperties, schemas, `${path}.${key}`);
    }
  }
}

test("published OpenAPI schemas validate real session, completion, error and NDJSON responses", async (context) => {
  let mode: "success" | "cancelled" | "truncated" | "error" = "success";
  const stdout = Buffer.from("中文\n");
  const plugin: RuntimePlugin = {
    manifest: { id: "test.http-contract", version: "1.0.0", description: "Controlled transport outcomes", provides: [EXECUTION_BACKENDS.id] },
    activate(ctx) { ctx.provide(EXECUTION_BACKENDS, { id: "test.contract", mode: "native" as const, async execute({ onOutput }): Promise<ProcessRunResult> {
      if (mode === "error") throw new PosixLoomError("CONTRACT_BACKEND_FAILED", "Controlled backend failure", { phase: "execute" });
      await onOutput?.({ stream: "stdout", data: stdout, sequence: 0 });
      return { outcome: mode === "cancelled" ? { kind: "cancelled" } : { kind: "exited", exitCode: 0 }, stdout, stderr: Buffer.alloc(0), report: Buffer.alloc(0), stdoutBytes: mode === "truncated" ? 1000 : stdout.length, stderrBytes: 0, truncated: mode === "truncated", processMode: "node-fallback" };
    } }, { priority: 10000 }); },
  };
  const { runtime } = await runtimeFixture(context, {}, [plugin]);
  const server = await startRemoteHttpServer(runtime, { port: 0 });
  const headers = { "content-type": "application/json" };
  try {
    const api = await (await fetch(server.origin + "/api/v1/openapi.json")).json();
    const schemas = api.components.schemas;
    const validate = (name: string, value: unknown) => assertContract(value, schemas[name], schemas);
    const responseSchema = (path: string, method: string, status: number, media = "application/json") => api.paths[path][method].responses[status].content[media].schema;
    const created = await (await fetch(server.origin + "/api/v1/sessions", { method: "POST", headers, body: "{}" })).json();
    assertContract(created, responseSchema("/api/v1/sessions", "post", 201), schemas);
    const endpoint = `${server.origin}/api/v1/sessions/${created.sessionId}`;
    validate("SessionResponse", await (await fetch(endpoint)).json());
    validate("SessionListResponse", await (await fetch(server.origin + "/api/v1/sessions")).json());
    assert.throws(() => validate("SessionResponse", { ...created, state: { ...created.state, version: 0 } }));

    const input = { kind: "argv", argv: ["node"] };
    const preview = await (await fetch(endpoint + "/explain", { method: "POST", headers, body: JSON.stringify({ input }) })).json();
    assertContract(preview, responseSchema("/api/v1/sessions/{id}/explain", "post", 200), schemas);
    const execute = (extra: Record<string, unknown> = {}, key?: string) => fetch(endpoint + "/execute", { method: "POST", headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify({ input, ...extra }) });
    const completion = await (await execute({}, "contract-replay")).json();
    assertContract(completion, responseSchema("/api/v1/sessions/{id}/execute", "post", 200), schemas);
    const missingResultField = structuredClone(completion); delete missingResultField.result.stdoutBytes;
    assert.throws(() => validate("CompletionResponse", missingResultField));
    assert.throws(() => validate("CompletionResponse", { ...completion, result: { ...completion.result, command: { kind: "future-outcome" } } }));

    const ndjson = responseSchema("/api/v1/sessions/{id}/execute", "post", 200, "application/x-ndjson");
    const events = (await (await execute({ stream: true })).text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["started", "output", "completed"]);
    for (const event of events) assertContract(event, ndjson, schemas);
    assert.throws(() => assertContract({ ...events[1], sequence: -1 }, ndjson, schemas));
    const replay = await execute({ stream: true }, "contract-replay");
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    const replayEvent = JSON.parse((await replay.text()).trim());
    assert.equal(replayEvent.replayed, true); assertContract(replayEvent, ndjson, schemas);

    for (const outcome of ["cancelled", "truncated"] as const) {
      mode = outcome;
      const result = await (await execute()).json();
      validate("CompletionResponse", result);
      assert.equal(outcome === "cancelled" ? result.result.command.kind : result.result.truncated, outcome === "cancelled" ? "cancelled" : true);
    }
    mode = "error";
    const failure = await execute(); assert.equal(failure.status, 500);
    assertContract(await failure.json(), responseSchema("/api/v1/sessions/{id}/execute", "post", 500), schemas);
    const streamedError = (await (await execute({ stream: true })).text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(streamedError.map((event) => event.type), ["started", "error"]);
    for (const event of streamedError) assertContract(event, ndjson, schemas);
    const invalid = await execute({ timeoutMs: -1 }); assert.equal(invalid.status, 400);
    validate("ErrorResponse", await invalid.json());
    validate("SessionClosedResponse", await (await fetch(endpoint, { method: "DELETE" })).json());
  } finally { await server.close(); }
});
