import { executionRequestSchema } from "../core/execution-request.js";

const text = { type: "string" };
const number = { type: "integer", minimum: 0 };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required });
const list = (item: unknown) => ({ type: "array", items: item });
const envelope = (properties: Record<string, unknown>) => object({ ...properties, requestId: text });
const jobStatus = { enum: ["queued", "running", "completed", "failed", "cancelled", "interrupted"] };
export const workbenchSchemas = {
  JobStep: { ...object({ id: text, ...Object.fromEntries(Object.entries(executionRequestSchema.properties).filter(([key]) => key !== "terminal" && key !== "stream")) }, ["id", "input"]), additionalProperties: false },
  JobSubmission: {
    type: "object", required: ["sessionId"],
    properties: { ...executionRequestSchema.properties, sessionId: text, label: text, artifacts: list(text), taskId: text, parameters: { type: "object", additionalProperties: text } },
    oneOf: [{ required: ["input"], not: { required: ["taskId"] } }, { required: ["taskId"], not: { anyOf: [{ required: ["input"] }, { required: ["terminal"] }] } }],
    description: "Submit a standalone command (terminal allowed) or resolve a project task. The job survives HTTP disconnection while this service lives. Idempotency-Key protects submission retries within this service instance.",
  },
  JobArtifact: object({ artifactId: text, name: text, size: number, sha256: text }),
  JobRecord: object({ jobId: text, sessionId: text, label: text, status: jobStatus, createdAt: text, updatedAt: text, steps: list({ type: "object" }), artifacts: list(ref("JobArtifact")) }, ["jobId", "sessionId", "status", "createdAt", "updatedAt", "steps", "artifacts"]),
  JobResponse: envelope({ job: ref("JobRecord") }),
  JobListResponse: envelope({ jobs: list(ref("JobRecord")) }),
  JobEvent: object({ type: text, sequence: number, stream: { enum: ["stdout", "stderr"] }, dataBase64: { type: "string", contentEncoding: "base64" }, stepId: text }, ["type", "sequence"]),
  JobEventsResponse: envelope({ events: list(ref("JobEvent")), nextSequence: { type: "integer", minimum: -1 }, hasMore: { type: "boolean" } }),
  ArtifactChunkResponse: envelope({ dataBase64: { type: "string", contentEncoding: "base64" }, eof: { type: "boolean" } }),
  TaskParameter: object({ type: { enum: ["string", "enum"] }, default: text, required: { type: "boolean" }, values: list(text) }, ["type"]),
  TaskDefinition: object({ id: text, title: text, parameters: { type: "object", additionalProperties: ref("TaskParameter") }, steps: list(ref("JobStep")), artifacts: list(text) }, ["id", "steps"]),
  TaskManifest: object({ schemaVersion: { const: 1 }, tasks: list(ref("TaskDefinition")) }),
  TaskListResponse: envelope({ tasks: list(ref("TaskDefinition")) }),
  Checkpoint: object({ schemaVersion: { const: 1 }, checkpointId: text, name: text, createdAt: text, cwd: text, envKeys: list(text), runtimeId: text, snapshotId: text }),
  CheckpointResponse: envelope({ checkpoint: ref("Checkpoint") }),
  CheckpointListResponse: envelope({ checkpoints: list(ref("Checkpoint")) }),
  CheckpointRequest: object({ name: text, envKeys: list(text) }, []),
  DiagnosticResponse: envelope({ report: object({ schemaVersion: { const: 1 }, generatedAt: text, redaction: { type: "object" }, system: { type: "object" }, runtime: { type: "object" }, doctor: { type: "object" }, configuration: { type: "object" }, traces: list({ type: "object" }) }) }),
};
const parameter = (name: string) => ({ name, in: "path", required: true, schema: text });
const query = (name: string, minimum: number, fallback: number, maximum?: number) => ({ name, in: "query", schema: { type: "integer", minimum, default: fallback, ...(maximum ? { maximum } : {}) } });
const response = (name?: string) => ({ description: "JSON response", content: { "application/json": { schema: name ? ref(name) : { type: "object" } } } });
const errors = Object.fromEntries([400, 401, 403, 404, 405, 409, 413, 429, 500].map((status) => [status, response("ErrorResponse")]));
const operation = (schema?: string, status = 200, parameters: unknown[] = [], request?: unknown) => ({
  parameters,
  ...(request ? { requestBody: { required: true, content: { "application/json": { schema: request } } } } : {}),
  responses: { ...errors, [status]: response(schema) },
});
export const workbenchPaths = {
  "/api/v1/jobs": {
    get: operation("JobListResponse", 200, [{ name: "sessionId", in: "query", schema: text }]),
    post: operation("JobResponse", 202, [{ name: "Idempotency-Key", in: "header", schema: text }], ref("JobSubmission")),
  },
  "/api/v1/jobs/{id}": { get: operation("JobResponse", 200, [parameter("id")]), delete: operation(undefined, 200, [parameter("id")]) },
  "/api/v1/jobs/{id}/events": { get: operation("JobEventsResponse", 200, [parameter("id"), query("after", -1, -1), query("limit", 1, 256, 1024)]) },
  "/api/v1/jobs/{id}/cancel": { post: operation("JobResponse", 200, [parameter("id")]) },
  "/api/v1/jobs/{id}/input": { post: operation(undefined, 200, [parameter("id")], object({ dataBase64: { type: "string", contentEncoding: "base64" } })) },
  "/api/v1/jobs/{id}/resize": { post: operation(undefined, 200, [parameter("id")], object({ columns: { type: "integer", minimum: 1, maximum: 32767 }, rows: { type: "integer", minimum: 1, maximum: 32767 } })) },
  "/api/v1/jobs/{id}/eof": { post: operation(undefined, 200, [parameter("id")]) },
  "/api/v1/jobs/{id}/artifacts/{artifactId}": { get: operation("ArtifactChunkResponse", 200, [parameter("id"), parameter("artifactId"), query("offset", 0, 0), query("limit", 1, 262144, 1048576)]) },
  "/api/v1/tasks": { get: operation("TaskListResponse"), post: operation(undefined, 200, [], ref("TaskManifest")) },
  "/api/v1/tasks/{id}": { delete: operation(undefined, 200, [parameter("id")]) },
  "/api/v1/checkpoints": { get: operation("CheckpointListResponse") },
  "/api/v1/checkpoints/{id}": { delete: operation(undefined, 200, [parameter("id")]) },
  "/api/v1/checkpoints/{id}/restore": { post: operation("SessionResponse", 201, [parameter("id")]) },
  "/api/v1/sessions/{id}/checkpoint": { post: operation("CheckpointResponse", 201, [parameter("id")], ref("CheckpointRequest")) },
  "/api/v1/sessions/{id}/fork": { post: operation("SessionResponse", 201, [parameter("id")]) },
  "/api/v1/diagnostics": { get: operation("DiagnosticResponse", 200, [{ name: "jobId", in: "query", schema: text }]) },
};
