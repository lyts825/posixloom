/**
 * Remote HTTP/JSON adapter for the PosixLoom core.
 *
 * This module knows nothing about the GUI implementation or the concrete plugin
 * marketplace. Optional capabilities are supplied through a generic extension port.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { PosixLoomError, asPosixLoomError } from "../core/errors.js";
import { parseExecutionRequest, executionRequestSchema, type ExecutionRequest } from "../core/execution-request.js";
import { IdempotencyStore, requestFingerprint, type Receipt } from "./idempotency.js";
import { openApiDocument } from "./openapi.js";
import { WorkbenchHttp, isWorkbenchRoute, WORKBENCH_CAPABILITIES } from "./workbench.js";
import { summarizeTraces } from "../core/trace-summary.js";
import type { ProcessOutputEvent } from "../core/process.js";
import { RuntimeManager } from "../core/runtime.js";
import { PosixLoomService, type ExecuteOptions } from "../core/service.js";
import type { CommandCompletion, SessionState, StateOutcome } from "../core/types.js";

export const HTTP_API_VERSION = 1;

export interface RemoteHttpExtensionRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
}

export interface RemoteHttpExtensionResult {
  status?: number;
  body: Record<string, unknown>;
}

/** Generic authenticated route contribution; the HTTP package does not know its domain. */
export interface RemoteHttpExtension {
  capabilities: string[];
  handle(request: RemoteHttpExtensionRequest): Promise<RemoteHttpExtensionResult | undefined>;
}

export interface RemoteHttpOptions {
  host?: string;
  port?: number;
  token?: string;
  corsOrigins?: string[];
  maxBodyBytes?: number;
  extensions?: RemoteHttpExtension[];
}

export interface RemoteHttpServer {
  host: string;
  port: number;
  origin: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

type ExecuteBody = ExecutionRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function jsonState(state: SessionState): Record<string, unknown> {
  return { version: state.version.toString(), cwd: state.cwd, exportedEnv: state.exportedEnv };
}

function jsonStateOutcome(outcome: StateOutcome): Record<string, unknown> {
  return outcome.kind === "committed" ? { ...outcome, newVersion: outcome.newVersion.toString() } : outcome;
}

function jsonCompletion(completion: CommandCompletion): Record<string, unknown> {
  return {
    command: completion.command,
    state: jsonStateOutcome(completion.state),
    stdoutBase64: completion.stdout.toString("base64"),
    stderrBase64: completion.stderr.toString("base64"),
    stdoutBytes: completion.stdoutBytes,
    stderrBytes: completion.stderrBytes,
    truncated: completion.truncated,
    backend: completion.backend,
    planId: completion.planId,
    trace: completion.trace,
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => typeof candidate === "bigint" ? candidate.toString() : candidate);
}

function statusFor(error: PosixLoomError): number {
  if (error.code === "HTTP_UNAUTHORIZED") return 401;
  if (error.code === "HTTP_FORBIDDEN") return 403;
  if (error.code === "HTTP_NOT_FOUND" || error.code === "SESSION_NOT_FOUND" || error.code.endsWith("_NOT_FOUND") || error.code.endsWith("_NOT_INSTALLED")) return 404;
  if (error.code === "HTTP_METHOD_NOT_ALLOWED") return 405;
  if (error.code === "HTTP_BODY_TOO_LARGE" || error.code === "STATE_FILE_TOO_LARGE" || error.code === "TERMINAL_INPUT_TOO_LARGE") return 413;
  if (error.code === "STATE_CONFLICT" || error.code === "SESSION_BUSY" || error.code === "JOB_STORE_LOCKED" || error.code === "JOB_BUSY" || error.code.startsWith("IDEMPOTENCY_") || error.code === "TERMINAL_CLOSED") return 409;
  if (["JOB_NOT_RUNNING", "TERMINAL_MODE_REQUIRED", "TERMINAL_INPUT_CLOSED", "JOB_ARTIFACT_CHANGED", "STATE_STORAGE_UNSAFE"].includes(error.code)) return 409;
  if (error.code.startsWith("POLICY_") || error.code === "ARTIFACT_PATH_DENIED") return 403;
  if (error.code === "SERVER_BUSY" || error.code === "QUEUE_TIMEOUT") return 429;
  if (["SESSION_LIMIT_REACHED", "JOB_LIMIT_REACHED", "CHECKPOINT_LIMIT_REACHED", "JOB_STORAGE_FULL", "TERMINAL_INPUT_BUFFER_FULL"].includes(error.code)) return 429;
  if (error.code === "JOB_PATH_DENIED") return 403;
  if (error.code === "STATE_PATCH_REJECTED") return 400;
  if (error.code.startsWith("HTTP_") || error.code.endsWith("_INVALID") || error.code === "TIMEOUT_INVALID") return 400;
  return 500;
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  response.setHeader("cross-origin-resource-policy", "same-origin");
}

async function writeJson(response: ServerResponse, status: number, value: unknown, timeoutMs: number, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  setCommonHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  await writeResponse(response, `${jsonText(value)}\n`, timeoutMs, signal, true);
}

async function writeError(response: ServerResponse, error: unknown, requestId: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (response.headersSent) { response.destroy(); return; }
  const normalized = asPosixLoomError(error, "HTTP_INTERNAL_ERROR");
  await writeJson(response, statusFor(normalized), {
    error: { code: normalized.code, message: normalized.message, details: normalized.details },
    requestId,
  }, timeoutMs, signal, normalized.code === "HTTP_UNAUTHORIZED" ? { "www-authenticate": "Bearer realm=\"PosixLoom\"" } : statusFor(normalized) === 429 || normalized.code === "IDEMPOTENCY_IN_PROGRESS" ? { "retry-after": "1" } : {});
}

function tokenMatches(expected: string, request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const alternate = request.headers["x-posixloom-token"];
  const presented = bearer ?? (Array.isArray(alternate) ? alternate[0] : alternate);
  if (typeof presented !== "string") return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const presentedHash = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expectedHash, presentedHash);
}

function canonicalAuthority(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.host.toLocaleLowerCase();
  } catch {
    return undefined;
  }
}

function httpOrigin(host: string, port: number): string {
  const normalized = host.replace(/^\[|\]$/g, "");
  const displayHost = normalized.includes(":") ? `[${normalized}]` : normalized;
  return new URL(`http://${displayHost}:${port}`).origin;
}

function normalizedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function originAllowed(origin: string, serverOrigins: ReadonlySet<string>, corsOrigins: ReadonlySet<string>): boolean {
  const normalized = normalizedOrigin(origin);
  return normalized !== undefined && (serverOrigins.has(normalized) || corsOrigins.has(normalized));
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  serverOrigins: ReadonlySet<string>,
  corsOrigins: ReadonlySet<string>,
): void {
  const origin = request.headers.origin;
  if (!origin) return;
  response.setHeader("vary", "Origin");
  if (originAllowed(origin, serverOrigins, corsOrigins)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type, x-posixloom-token, idempotency-key");
    response.setHeader("access-control-max-age", "600");
    response.setHeader("access-control-expose-headers", "x-request-id, idempotency-replayed, retry-after");
  }
}

async function readJson(request: IncomingMessage, maximum: number, allowEmpty = false): Promise<Record<string, unknown>> {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLocaleLowerCase();
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maximum) throw new PosixLoomError("HTTP_BODY_TOO_LARGE", "Request body exceeds the configured byte limit", { declared, maximum });
  if (declared > 0 && contentType !== "application/json") throw new PosixLoomError("HTTP_CONTENT_TYPE_INVALID", "Request body must use application/json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) throw new PosixLoomError("HTTP_BODY_TOO_LARGE", "Request body exceeds the configured byte limit", { bytes, maximum });
    chunks.push(buffer);
  }
  if (bytes === 0 && allowEmpty) return {};
  if (contentType !== "application/json") throw new PosixLoomError("HTTP_CONTENT_TYPE_INVALID", "Request body must use application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PosixLoomError("HTTP_JSON_INVALID", "Request body is not valid JSON");
  }
  if (!isRecord(parsed)) throw new PosixLoomError("HTTP_JSON_INVALID", "Request JSON must be an object");
  return parsed;
}

function parseExecuteBody(body: Record<string, unknown>, accept: string | undefined): ExecuteBody {
  const parsed = parseExecutionRequest(body, { code: "HTTP_EXECUTE_INVALID", allowTerminal: false });
  return { ...parsed, stream: parsed.stream || accept?.split(",").some((value) => value.trim().startsWith("application/x-ndjson")) === true };
}

function executeOptions(sessionId: string, body: ExecuteBody, signal?: AbortSignal, clientId?: string): ExecuteOptions {
  const common = { sessionId, cwd: body.cwd, envDelta: body.envDelta, statePolicy: body.statePolicy, timeoutMs: body.timeoutMs, signal, clientId };
  return body.input.kind === "argv" ? { ...common, kind: "argv", argv: body.input.argv } : { ...common, kind: "text", raw: body.input.raw };
}

async function writeResponse(response: ServerResponse, text: string, timeoutMs: number, signal: AbortSignal, end = false): Promise<void> {
  if (response.destroyed || response.writableEnded || signal.aborted) throw new PosixLoomError("HTTP_CLIENT_CLOSED", "HTTP client closed the response stream");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      response.off("error", onError);
      response.off("close", onClose);
      signal.removeEventListener("abort", onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new PosixLoomError("HTTP_CLIENT_CLOSED", "HTTP client closed the response stream"));
    response.once("error", onError);
    response.once("close", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    try {
      timer = setTimeout(() => finish(new PosixLoomError("HTTP_OUTPUT_TIMEOUT", "HTTP response did not drain before the configured deadline", { timeoutMs })), timeoutMs);
      // Await the write callback even below the high-water mark: HTTP/1 pipelining
      // can buffer a response behind another response on the same socket.
      if (end) response.end(text, () => finish());
      else response.write(text, (error) => finish(error ?? undefined));
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

function validSegment(value: string, name: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new PosixLoomError("HTTP_PATH_INVALID", `${name} is not valid URL encoding`);
  }
  if (!decoded || decoded.length > 128 || decoded.includes("/") || decoded.includes("\\")) throw new PosixLoomError("HTTP_PATH_INVALID", `${name} is invalid`, { name });
  return decoded;
}

/** Start a JSON API server. It does not serve GUI assets. */
export async function startRemoteHttpServer(runtime: RuntimeManager, options: RemoteHttpOptions = {}): Promise<RemoteHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 7331;
  const maximumBody = options.maxBodyBytes ?? 1024 * 1024;
  const token = options.token;
  if (!host.trim()) throw new PosixLoomError("HTTP_OPTIONS_INVALID", "HTTP host must be non-empty");
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new PosixLoomError("HTTP_OPTIONS_INVALID", "HTTP port must be an integer between 0 and 65535");
  if (!Number.isSafeInteger(maximumBody) || maximumBody <= 0) throw new PosixLoomError("HTTP_OPTIONS_INVALID", "maxBodyBytes must be a positive integer");
  if (token !== undefined && Buffer.byteLength(token) < 16) throw new PosixLoomError("HTTP_OPTIONS_INVALID", "HTTP bearer token must be at least 16 bytes");
  if (!loopbackHost(host) && !token) throw new PosixLoomError("HTTP_AUTH_REQUIRED", "A bearer token is required when binding the HTTP service beyond loopback", { host });
  const corsOrigins = new Set<string>();
  for (const origin of options.corsOrigins ?? []) {
    const normalized = normalizedOrigin(origin);
    if (!normalized) throw new PosixLoomError("HTTP_OPTIONS_INVALID", "CORS origins must be absolute HTTP(S) origins", { origin });
    corsOrigins.add(normalized);
  }
  const service = new PosixLoomService(runtime);
  const workbench = new WorkbenchHttp(service);
  const inflight = new Set<AbortController>();
  const limits = runtime.config.runtime.protocol;
  const receipts = new IdempotencyStore(limits.idempotencyMaxEntries, limits.idempotencyTtlMs, limits.idempotencyMaxBytes);
  const requestTasks = new Set<Promise<void>>();
  const responses = new Map<ServerResponse, { socket: Socket; close(): void }>();
  let pendingRequests = 0;
  let rejectedRequests = 0;
  let closing = false;
  const startedAt = Date.now();
  const serverOrigins = new Set<string>();
  const allowedAuthorities = new Set<string>();
  let serverOrigin = "";

  const server: Server = createServer((request, response) => {
    const requestId = randomUUID();
    const responseClosed = new AbortController();
    const outputTimeout = runtime.config.runtime.process.outputDrainTimeoutMs;
    const sendJson = (target: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): Promise<void> =>
      writeJson(target, status, value, outputTimeout, responseClosed.signal, headers);
    const sendError = (target: ServerResponse, error: unknown, id: string): Promise<void> =>
      writeError(target, error, id, outputTimeout, responseClosed.signal);
    const endResponse = (): Promise<void> => writeResponse(response, "", outputTimeout, responseClosed.signal, true);
    if (closing || pendingRequests >= limits.maxPendingRequests) {
      rejectedRequests += 1;
      response.setHeader("connection", "close");
      void sendError(response, new PosixLoomError("SERVER_BUSY", "HTTP request capacity exhausted"), requestId).catch(() => response.destroy());
      return;
    }
    pendingRequests += 1;
    const closeResponse = (): void => {
      responseClosed.abort();
      responses.delete(response);
      response.off("close", closeResponse);
    };
    responses.set(response, { socket: request.socket, close: closeResponse });
    response.once("close", closeResponse);
    const clientId = `http:${request.socket.remoteAddress ?? "unknown"}`;
    response.setHeader("x-request-id", requestId);
    const writeStreamEvent = async (event: unknown): Promise<void> => {
      try {
        await writeResponse(response, `${jsonText(event)}\n`, runtime.config.runtime.process.outputDrainTimeoutMs, responseClosed.signal);
      } catch (error) {
        closeResponse();
        response.destroy();
        request.socket.destroy();
        throw error;
      }
    };
    const run = async (): Promise<void> => {
      if (!token) {
        const authority = canonicalAuthority(request.headers.host);
        if (!authority || !allowedAuthorities.has(authority)) {
          throw new PosixLoomError("HTTP_FORBIDDEN", "Request Host is not one of the HTTP service's loopback origins", { host: request.headers.host });
        }
      }
      applyCors(request, response, serverOrigins, corsOrigins);
      const origin = request.headers.origin;
      if (origin && !originAllowed(origin, serverOrigins, corsOrigins)) throw new PosixLoomError("HTTP_FORBIDDEN", "Cross-origin request is not allowed", { origin });
      let url: URL;
      try {
        url = new URL(request.url ?? "/", serverOrigin);
      } catch {
        throw new PosixLoomError("HTTP_PATH_INVALID", "Request URL is invalid");
      }
      const method = request.method ?? "GET";
      if (method === "OPTIONS") {
        response.writeHead(204);
        await endResponse();
        return;
      }
      if (url.pathname === "/api/v1/health" && method === "GET") {
        await sendJson(response, 200, { status: "ok", apiVersion: HTTP_API_VERSION, runtimeId: runtime.snapshot.runtimeId, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), requestId });
        return;
      }
      if (!url.pathname.startsWith("/api/v1")) throw new PosixLoomError("HTTP_NOT_FOUND", "HTTP endpoint not found", { path: url.pathname });
      if (token && !tokenMatches(token, request)) throw new PosixLoomError("HTTP_UNAUTHORIZED", "A valid bearer token is required");

      if ((url.pathname === "/api/v1" || url.pathname === "/api/v1/capabilities") && method === "GET") {
        const extensionCapabilities = (options.extensions ?? []).flatMap((extension) => extension.capabilities);
        await sendJson(response, 200, { apiVersion: HTTP_API_VERSION, transport: "http-json", streaming: "application/x-ndjson", capabilities: ["sessions", "execute", "execute-plan", "stream-output", "runtime", "traces", "trace-summary", "metrics", "idempotency-v1", "schema", ...WORKBENCH_CAPABILITIES, ...new Set(extensionCapabilities)], limits: { ...limits, ...runtime.config.runtime.process, jobs: runtime.config.runtime.jobs }, requestId });
        return;
      }
      if (isWorkbenchRoute(url.pathname)) {
        const body = method === "POST" ? await readJson(request, maximumBody, true) : {};
        const headerKey = method === "POST" && url.pathname === "/api/v1/jobs" ? request.headers["idempotency-key"] : undefined;
        if (headerKey !== undefined && typeof headerKey !== "string") throw new PosixLoomError("HTTP_IDEMPOTENCY_INVALID", "Idempotency-Key must be a single header");
        const key = headerKey;
        if (key !== undefined) {
          const prior = receipts.begin(key, requestFingerprint({ ...body, resource: "jobs" }));
          if (prior.replayed) {
            response.setHeader("idempotency-replayed", "true");
            await sendJson(response, prior.receipt!.status, { ...prior.receipt!.body, requestId });
            return;
          }
        }
        let result;
        try { result = await workbench.handle(method, url, body, clientId); }
        catch (error) {
          if (key !== undefined) {
            const normalized = asPosixLoomError(error, "HTTP_WORKBENCH_FAILED");
            receipts.complete(key, { status: statusFor(normalized), body: { error: { code: normalized.code, message: normalized.message, details: normalized.details } } });
          }
          throw error;
        }
        if (key !== undefined) receipts.complete(key, result);
        await sendJson(response, result.status, { ...result.body, requestId });
        return;
      }
      if (url.pathname === "/api/v1/metrics" && method === "GET") {
        await sendJson(response, 200, { ...service.metrics(), http: { pendingRequests, rejectedRequests, executions: inflight.size }, idempotency: receipts.snapshot(), requestId }); return;
      }
      if (url.pathname === "/api/v1/schema" && method === "GET") { await sendJson(response, 200, { ...executionRequestSchema, properties: { ...executionRequestSchema.properties, terminal: false } }); return; }
      if (url.pathname === "/api/v1/openapi.json" && method === "GET") { await sendJson(response, 200, openApiDocument); return; }
      if (url.pathname === "/api/v1/runtime" && method === "GET") {
        await sendJson(response, 200, { runtime: runtime.info(), requestId });
        return;
      }
      if (url.pathname === "/api/v1/runtime/doctor" && method === "GET") {
        await sendJson(response, 200, { report: runtime.doctor(), requestId });
        return;
      }
      if ((url.pathname === "/api/v1/traces" || url.pathname === "/api/v1/traces/summary") && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000) throw new PosixLoomError("HTTP_QUERY_INVALID", "trace limit must be an integer between 1 and 5000");
        const events = service.traces(limit);
        await sendJson(response, 200, url.pathname.endsWith("/summary") ? { summary: summarizeTraces(events), requestId } : { events, requestId });
        return;
      }
      if (url.pathname === "/api/v1/sessions" && method === "GET") {
        const result = service.listSessions().map(({ sessionId, state }) => ({ sessionId, state: jsonState(state) }));
        await sendJson(response, 200, { sessions: result, requestId });
        return;
      }
      if (url.pathname === "/api/v1/sessions" && method === "POST") {
        const body = await readJson(request, maximumBody, true);
        if (body.cwd !== undefined && typeof body.cwd !== "string") throw new PosixLoomError("HTTP_SESSION_INVALID", "cwd must be a string");
        const sessionId = service.createSession((body.cwd as string | undefined) ?? "/workspace");
        await sendJson(response, 201, { sessionId, state: jsonState(service.sessionSnapshot(sessionId)), requestId });
        return;
      }

      const session = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (session) {
        const sessionId = validSegment(session[1], "sessionId");
        if (method === "GET") {
          await sendJson(response, 200, { sessionId, state: jsonState(service.sessionSnapshot(sessionId)), requestId });
          return;
        }
        if (method === "DELETE") {
          service.sessions.close(sessionId);
          await sendJson(response, 200, { closed: true, sessionId, requestId });
          return;
        }
        throw new PosixLoomError("HTTP_METHOD_NOT_ALLOWED", "Method is not allowed for this session endpoint");
      }

      const explain = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/explain$/);
      if (explain && method === "POST") {
        const sessionId = validSegment(explain[1], "sessionId");
        const body = parseExecuteBody(await readJson(request, maximumBody), request.headers.accept);
        const controller = new AbortController();
        inflight.add(controller);
        const onClose = (): void => { if (!response.writableEnded) controller.abort(); };
        responseClosed.signal.addEventListener("abort", onClose, { once: true });
        if (responseClosed.signal.aborted || response.destroyed || request.aborted || closing) controller.abort();
        let preview;
        try { preview = await service.explain(executeOptions(sessionId, { ...body, stream: false }, controller.signal, clientId)); }
        finally { inflight.delete(controller); responseClosed.signal.removeEventListener("abort", onClose); }
        await sendJson(response, 200, { preview, requestId });
        return;
      }

      const execute = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/execute$/);
      if (execute && method === "POST") {
        const sessionId = validSegment(execute[1], "sessionId");
        const body = parseExecuteBody(await readJson(request, maximumBody), request.headers.accept);
        const headerKey = request.headers["idempotency-key"];
        if (headerKey !== undefined && typeof headerKey !== "string") throw new PosixLoomError("HTTP_IDEMPOTENCY_INVALID", "Idempotency-Key must be a single header");
        const key = headerKey;
        if (key !== undefined) {
          const { stream: _stream, ...identity } = body;
          const existing = receipts.begin(key, requestFingerprint({ sessionId, ...identity }));
          if (existing.replayed) {
            response.setHeader("idempotency-replayed", "true");
            const receipt = existing.receipt!;
            if (body.stream && receipt.status === 200) {
              setCommonHeaders(response);
              response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
              await writeStreamEvent({ type: "completed", ...receipt.body, replayed: true, requestId });
              await endResponse();
            } else await sendJson(response, receipt.status, { ...receipt.body, requestId });
            return;
          }
        }
        const controller = new AbortController();
        inflight.add(controller);
        const onClose = (): void => { if (!response.writableEnded) controller.abort(); };
        responseClosed.signal.addEventListener("abort", onClose, { once: true });
        if (responseClosed.signal.aborted || response.destroyed || request.aborted || closing) controller.abort();
        const save = (receipt: Receipt): void => { if (key !== undefined) receipts.complete(key, receipt); };
        let admitted = false;
        let sequence = 0;
        const sendEvent = (event: unknown): Promise<void> => {
          if (!response.headersSent) {
            setCommonHeaders(response);
            response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "x-accel-buffering": "no" });
          }
          return writeStreamEvent(event);
        };
        try {
          const completion = await service.execute(executeOptions(sessionId, body, controller.signal, clientId), {
            onAdmitted: () => { admitted = true; },
            ...(body.stream ? {
              onStarted: (preview) => sendEvent({ type: "started", preview, requestId }),
              onOutput: (event: ProcessOutputEvent) => sendEvent({ type: "output", stream: event.stream, sequence: sequence++, dataBase64: event.data.toString("base64"), requestId }),
            } : {}),
          });
          const result = jsonCompletion(completion);
          save({ status: 200, body: { result } });
          if (!body.stream) { await sendJson(response, 200, { result, requestId }); return; }
          if (completion.command.kind === "crashed" && completion.command.errorCode === "OUTPUT_SINK_FAILED") { response.destroy(); return; }
          await sendEvent({ type: "completed", result, requestId });
          await endResponse();
        } catch (error) {
          const normalized = asPosixLoomError(error, "HTTP_EXECUTION_FAILED");
          const payload = { error: { code: normalized.code, message: normalized.message, details: normalized.details } };
          if (key !== undefined && !admitted && (normalized.code === "SERVER_BUSY" || normalized.code === "QUEUE_TIMEOUT")) receipts.retryAfterRejection(key);
          else save({ status: statusFor(normalized), body: payload });
          if (!body.stream || !response.headersSent) throw error;
          if (!response.destroyed && !response.writableEnded) {
            await sendEvent({ type: "error", ...payload, requestId }).catch(() => undefined);
            await endResponse();
          }
        } finally {
          inflight.delete(controller);
          responseClosed.signal.removeEventListener("abort", onClose);
        }
        return;
      }

      for (const extension of options.extensions ?? []) {
        const result = await extension.handle({ method, pathname: url.pathname, searchParams: url.searchParams });
        if (result) {
          await sendJson(response, result.status ?? 200, { ...result.body, requestId });
          return;
        }
      }
      throw new PosixLoomError("HTTP_NOT_FOUND", "HTTP endpoint not found", { path: url.pathname });
    };
    const task = run().catch((error) => sendError(response, error, requestId).catch(() => { response.destroy(); request.socket.destroy(); })).finally(() => { pendingRequests -= 1; requestTasks.delete(task); });
    requestTasks.add(task);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxConnections = limits.maxPendingRequests + 16;
  server.on("connection", (socket) => {
    // Queued HTTP/1.1 responses may never receive their own close event. One socket
    // listener cancels every affected response without adding a listener per request.
    socket.once("close", () => {
      for (const [response, pending] of responses) {
        if (pending.socket !== socket) continue;
        pending.close();
        response.destroy();
      }
    });
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });
  const address = server.address() as AddressInfo;
  serverOrigin = httpOrigin(address.address, address.port);
  serverOrigins.add(serverOrigin);
  if (loopbackHost(host)) {
    for (const alias of new Set([host, address.address, "localhost", "127.0.0.1", "::1"])) {
      const origin = httpOrigin(alias, address.port);
      serverOrigins.add(origin);
      allowedAuthorities.add(new URL(origin).host.toLocaleLowerCase());
    }
  } else {
    allowedAuthorities.add(new URL(serverOrigin).host.toLocaleLowerCase());
  }
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  server.once("close", resolveClosed);
  let closePromise: Promise<void> | undefined;
  return {
    host: address.address,
    port: address.port,
    origin: serverOrigin,
    closed,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      for (const [response] of responses) {
        response.shouldKeepAlive = false;
        if (!response.headersSent) response.setHeader("connection", "close");
      }
      for (const controller of inflight) controller.abort();
      const workbenchClosed = workbench.close();
      void workbenchClosed.catch(() => undefined);
      closePromise = new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        const deadline = setTimeout(() => {
          for (const [response, pending] of responses) { pending.close(); response.destroy(); }
          server.closeAllConnections();
        }, runtime.config.runtime.process.cancelGraceMs + runtime.config.runtime.process.outputDrainTimeoutMs);
        server.close((error) => { clearTimeout(deadline); error ? reject(error) : resolve(); });
        server.closeIdleConnections();
      }).then(async () => { await workbenchClosed; await Promise.allSettled(requestTasks); await service.flushTraces(); });
      return closePromise;
    },
  };
}
