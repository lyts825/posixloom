import { executionRequestSchema } from "../core/execution-request.js";
import { workbenchSchemas, workbenchPaths } from "./workbench-openapi.js";

const string = { type: "string" };
const boolean = { type: "boolean" };
const integer = { type: "integer", minimum: 0 };
const version = { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "Decimal version; never coerce to a JavaScript number" };
const base64 = { type: "string", contentEncoding: "base64", pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required });
const variant = (kind: string, fields: Record<string, unknown> = {}) => object({ kind: { const: kind }, ...fields });
const envelope = (properties: Record<string, unknown>) => object({ ...properties, requestId: string });
const jsonResponse = (name: string, description: string) => ({ description, content: { "application/json": { schema: ref(name) } } });
const errorResponse = jsonResponse("ErrorResponse", "Structured error; use error.code for programmatic decisions");
const errors = Object.fromEntries([400, 401, 403, 404, 405, 409, 413, 429, 500].map((status) => [status, errorResponse]));
const genericResponse = { description: "JSON response", content: { "application/json": { schema: { type: "object" } } } };
const sessionParameter = { name: "id", in: "path", required: true, schema: string };

export const responseSchemas = {
  SessionState: object({ version, cwd: string, exportedEnv: { type: "object", additionalProperties: string } }),
  Session: object({ sessionId: string, state: ref("SessionState") }),
  SessionResponse: envelope({ sessionId: string, state: ref("SessionState") }),
  SessionListResponse: envelope({ sessions: { type: "array", items: ref("Session") } }),
  SessionClosedResponse: envelope({ closed: { const: true }, sessionId: string }),
  Error: object({ code: string, message: string, details: { type: "object" } }),
  ErrorResponse: envelope({ error: ref("Error") }),
  CommandOutcome: { oneOf: [variant("exited", { exitCode: { type: "integer" } }), variant("cancelled"), variant("timed-out"), variant("spawn-failed", { errorCode: string }), variant("crashed", { errorCode: string })] },
  StateOutcome: { oneOf: [variant("committed", { newVersion: version }), variant("rejected", { reason: string }), variant("not-produced", { reason: string }), variant("protocol-failed", { reason: string }), variant("not-applicable")] },
  Completion: object({
    command: ref("CommandOutcome"), state: ref("StateOutcome"), stdoutBase64: base64, stderrBase64: base64,
    stdoutBytes: integer, stderrBytes: integer, truncated: boolean, backend: { enum: ["native", "msys2"] }, planId: string,
    trace: { type: "object", description: "Extensible execution diagnostics; clients must tolerate additional fields" },
  }),
  CompletionResponse: envelope({ result: ref("Completion") }),
  ExecutionPreview: object({
    planId: string, commandId: string, sessionId: string, snapshotId: string, sessionVersion: version,
    mode: { enum: ["native", "shell"] }, backend: { enum: ["native", "msys2"] },
    commandKind: { enum: ["simple", "builtin", "shell-required", "explicit-shell"] }, reason: string, executable: string,
    argv: { type: "array", items: string }, cwdVirtual: string, cwdHost: string, timeoutMs: { type: "integer", minimum: 1 },
    statePolicy: { enum: ["isolated", "cwd-env"] }, policyProfile: { enum: ["trusted", "workspace-guard"] },
    pathDecisions: { type: "array", items: { type: "object" } }, environmentKeys: { type: "array", items: string },
    checks: object({ runtimeIntegrity: { const: "passed" }, cwdPolicy: { const: "passed" }, executablePolicy: { const: "passed" } }),
    limitations: { type: "array", items: string }, replayable: { const: false },
  }),
  PreviewResponse: envelope({ preview: ref("ExecutionPreview") }),
  StartedEvent: envelope({ type: { const: "started" }, preview: ref("ExecutionPreview") }),
  OutputEvent: envelope({ type: { const: "output" }, stream: { enum: ["stdout", "stderr"] }, sequence: integer, dataBase64: base64 }),
  CompletedEvent: object({ type: { const: "completed" }, result: ref("Completion"), requestId: string, replayed: { const: true } }, ["type", "result", "requestId"]),
  ErrorEvent: envelope({ type: { const: "error" }, error: ref("Error") }),
  NdjsonEvent: { oneOf: [ref("StartedEvent"), ref("OutputEvent"), ref("CompletedEvent"), ref("ErrorEvent")] },
};

const execution = (execute: boolean) => ({
  parameters: [sessionParameter, ...(execute ? [{ name: "Idempotency-Key", in: "header", schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, description: "Process-local deduplication. A confirmed pre-admission SERVER_BUSY/QUEUE_TIMEOUT can retry the same key. Admitted failures and cancellations are retained; no restart guarantee." }] : [])],
  requestBody: { required: true, content: { "application/json": { schema: ref("ExecutionRequest") } } },
  responses: {
    ...errors,
    "200": execute ? {
      description: "Completion JSON or newline-delimited events. The NDJSON schema describes each line, not the entire stream. Replays emit only completed.",
      headers: { "Idempotency-Replayed": { schema: { const: "true" } } },
      content: { "application/json": { schema: ref("CompletionResponse") }, "application/x-ndjson": { schema: ref("NdjsonEvent") } },
    } : jsonResponse("PreviewResponse", "Non-binding execution preview"),
  },
});
export const openApiDocument = {
  openapi: "3.1.0", info: { title: "PosixLoom HTTP API", version: "1.0.0" },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: { ExecutionRequest: { ...executionRequestSchema, properties: { ...executionRequestSchema.properties, terminal: false } }, ...responseSchemas, ...workbenchSchemas },
  },
  paths: {
    ...workbenchPaths,
    "/api/v1/health": { get: { security: [], responses: { "200": genericResponse } } },
    ...Object.fromEntries(["capabilities", "runtime", "runtime/doctor", "traces", "traces/summary", "metrics", "schema", "openapi.json"].map((name) => [`/api/v1/${name}`, { get: { responses: { ...errors, "200": genericResponse } } }])),
    "/api/v1/sessions": {
      get: { responses: { ...errors, "200": jsonResponse("SessionListResponse", "Live session snapshots") } },
      post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { cwd: string } } } } }, responses: { ...errors, "201": jsonResponse("SessionResponse", "Created session") } },
    },
    "/api/v1/sessions/{id}": {
      get: { parameters: [sessionParameter], responses: { ...errors, "200": jsonResponse("SessionResponse", "Session snapshot") } },
      delete: { parameters: [sessionParameter], responses: { ...errors, "200": jsonResponse("SessionClosedResponse", "Closed session; running or queued work instead returns SESSION_BUSY") } },
    },
    "/api/v1/sessions/{id}/explain": { post: execution(false) },
    "/api/v1/sessions/{id}/execute": { post: execution(true) },
  },
};
