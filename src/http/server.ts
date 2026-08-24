/**
 * Remote HTTP/JSON adapter for the PosixLoom core.
 *
 * This module knows nothing about the GUI implementation or the concrete plugin
 * marketplace. Optional capabilities are supplied through a generic extension port.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PosixLoomError, asPosixLoomError } from "../core/errors.js";
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

interface ExecuteBody {
  input: { kind: "text"; raw: string } | { kind: "argv"; argv: string[] };
  cwd?: string;
  envDelta?: Record<string, string | null>;
  statePolicy?: "isolated" | "cwd-env";
  timeoutMs?: number;
  stream: boolean;
}

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
  if (error.code === "HTTP_BODY_TOO_LARGE") return 413;
  if (error.code === "STATE_CONFLICT") return 409;
  if (error.code === "SESSION_LIMIT_REACHED") return 429;
  if (error.code.startsWith("HTTP_") || error.code.endsWith("_INVALID") || error.code === "TIMEOUT_INVALID") return 400;
  return 500;
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  response.setHeader("cross-origin-resource-policy", "same-origin");
}

function sendJson(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  setCommonHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  response.end(`${jsonText(value)}\n`);
}

function sendError(response: ServerResponse, error: unknown, requestId: string): void {
  const normalized = asPosixLoomError(error, "HTTP_INTERNAL_ERROR");
  sendJson(response, statusFor(normalized), {
    error: { code: normalized.code, message: normalized.message, details: normalized.details },
    requestId,
  }, normalized.code === "HTTP_UNAUTHORIZED" ? { "www-authenticate": "Bearer realm=\"PosixLoom\"" } : {});
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
    response.setHeader("access-control-allow-headers", "authorization, content-type, x-posixloom-token");
    response.setHeader("access-control-max-age", "600");
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
  if (!isRecord(body.input)) throw new PosixLoomError("HTTP_EXECUTE_INVALID", "execute requires an input object");
  let input: ExecuteBody["input"];
  if (body.input.kind === "text") {
    if (typeof body.input.raw !== "string" || body.input.raw.length > 1024 * 1024) throw new PosixLoomError("HTTP_EXECUTE_INVALID", "text input requires a raw string of at most 1 MiB");
    input = { kind: "text", raw: body.input.raw };
  } else if (body.input.kind === "argv") {
    if (!Array.isArray(body.input.argv) || body.input.argv.length === 0 || body.input.argv.length > 4096 || body.input.argv.some((argument) => typeof argument !== "string" || argument.length > 32_768)) {
      throw new PosixLoomError("HTTP_EXECUTE_INVALID", "argv input requires 1 to 4096 string arguments");
    }
    input = { kind: "argv", argv: [...body.input.argv] as string[] };
  } else throw new PosixLoomError("HTTP_EXECUTE_INVALID", "input.kind must be text or argv");
  const cwd = body.cwd;
  if (cwd !== undefined && typeof cwd !== "string") throw new PosixLoomError("HTTP_EXECUTE_INVALID", "cwd must be a string");
  const timeoutMs = body.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0)) throw new PosixLoomError("HTTP_EXECUTE_INVALID", "timeoutMs must be a positive integer");
  const statePolicy = body.statePolicy;
  if (statePolicy !== undefined && statePolicy !== "isolated" && statePolicy !== "cwd-env") throw new PosixLoomError("HTTP_EXECUTE_INVALID", "statePolicy must be isolated or cwd-env");
  let envDelta: Record<string, string | null> | undefined;
  if (body.envDelta !== undefined) {
    if (!isRecord(body.envDelta)) throw new PosixLoomError("HTTP_EXECUTE_INVALID", "envDelta must be an object");
    envDelta = {};
    for (const [key, value] of Object.entries(body.envDelta)) {
      if (typeof value !== "string" && value !== null) throw new PosixLoomError("HTTP_EXECUTE_INVALID", "envDelta values must be strings or null", { key });
      envDelta[key] = value;
    }
  }
  const streamRequested = body.stream === true || accept?.split(",").some((value) => value.trim().startsWith("application/x-ndjson")) === true;
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new PosixLoomError("HTTP_EXECUTE_INVALID", "stream must be a boolean");
  return { input, cwd: cwd as string | undefined, envDelta, statePolicy: statePolicy as ExecuteBody["statePolicy"], timeoutMs: timeoutMs as number | undefined, stream: streamRequested };
}

function executeOptions(sessionId: string, body: ExecuteBody, signal?: AbortSignal): ExecuteOptions {
  const common = { sessionId, cwd: body.cwd, envDelta: body.envDelta, statePolicy: body.statePolicy, timeoutMs: body.timeoutMs, signal };
  return body.input.kind === "argv" ? { ...common, kind: "argv", argv: body.input.argv } : { ...common, kind: "text", raw: body.input.raw };
}

async function writeResponse(response: ServerResponse, text: string): Promise<void> {
  if (response.destroyed || response.writableEnded) throw new PosixLoomError("HTTP_CLIENT_CLOSED", "HTTP client closed the response stream");
  if (response.write(text)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("error", onError);
      response.off("close", onClose);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new PosixLoomError("HTTP_CLIENT_CLOSED", "HTTP client closed the response stream")); };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
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
  const inflight = new Set<AbortController>();
  const startedAt = Date.now();
  const serverOrigins = new Set<string>();
  const allowedAuthorities = new Set<string>();
  let serverOrigin = "";

  const server: Server = createServer((request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
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
        response.end();
        return;
      }
      if (url.pathname === "/api/v1/health" && method === "GET") {
        sendJson(response, 200, { status: "ok", apiVersion: HTTP_API_VERSION, runtimeId: runtime.snapshot.runtimeId, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), requestId });
        return;
      }
      if (!url.pathname.startsWith("/api/v1")) throw new PosixLoomError("HTTP_NOT_FOUND", "HTTP endpoint not found", { path: url.pathname });
      if (token && !tokenMatches(token, request)) throw new PosixLoomError("HTTP_UNAUTHORIZED", "A valid bearer token is required");

      if ((url.pathname === "/api/v1" || url.pathname === "/api/v1/capabilities") && method === "GET") {
        const extensionCapabilities = (options.extensions ?? []).flatMap((extension) => extension.capabilities);
        sendJson(response, 200, { apiVersion: HTTP_API_VERSION, transport: "http-json", streaming: "application/x-ndjson", capabilities: ["sessions", "execute", "execute-plan", "stream-output", "runtime", "traces", ...new Set(extensionCapabilities)], requestId });
        return;
      }
      if (url.pathname === "/api/v1/runtime" && method === "GET") {
        sendJson(response, 200, { runtime: runtime.info(), requestId });
        return;
      }
      if (url.pathname === "/api/v1/runtime/doctor" && method === "GET") {
        sendJson(response, 200, { report: runtime.doctor(), requestId });
        return;
      }
      if (url.pathname === "/api/v1/traces" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000) throw new PosixLoomError("HTTP_QUERY_INVALID", "trace limit must be an integer between 1 and 5000");
        sendJson(response, 200, { events: service.traces().slice(-limit), requestId });
        return;
      }
      if (url.pathname === "/api/v1/sessions" && method === "GET") {
        const result = service.listSessions().map(({ sessionId, state }) => ({ sessionId, state: jsonState(state) }));
        sendJson(response, 200, { sessions: result, requestId });
        return;
      }
      if (url.pathname === "/api/v1/sessions" && method === "POST") {
        const body = await readJson(request, maximumBody, true);
        if (body.cwd !== undefined && typeof body.cwd !== "string") throw new PosixLoomError("HTTP_SESSION_INVALID", "cwd must be a string");
        const sessionId = service.createSession((body.cwd as string | undefined) ?? "/workspace");
        sendJson(response, 201, { sessionId, state: jsonState(service.sessionSnapshot(sessionId)), requestId });
        return;
      }

      const session = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (session) {
        const sessionId = validSegment(session[1], "sessionId");
        if (method === "GET") {
          sendJson(response, 200, { sessionId, state: jsonState(service.sessionSnapshot(sessionId)), requestId });
          return;
        }
        if (method === "DELETE") {
          service.sessions.close(sessionId);
          sendJson(response, 200, { closed: true, sessionId, requestId });
          return;
        }
        throw new PosixLoomError("HTTP_METHOD_NOT_ALLOWED", "Method is not allowed for this session endpoint");
      }

      const explain = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/explain$/);
      if (explain && method === "POST") {
        const sessionId = validSegment(explain[1], "sessionId");
        const body = parseExecuteBody(await readJson(request, maximumBody), request.headers.accept);
        const preview = await service.explain(executeOptions(sessionId, { ...body, stream: false }));
        sendJson(response, 200, { preview, requestId });
        return;
      }

      const execute = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/execute$/);
      if (execute && method === "POST") {
        const sessionId = validSegment(execute[1], "sessionId");
        const body = parseExecuteBody(await readJson(request, maximumBody), request.headers.accept);
        if (!body.stream) {
          const completion = await service.execute(executeOptions(sessionId, body));
          sendJson(response, 200, { result: jsonCompletion(completion), requestId });
          return;
        }
        const controller = new AbortController();
        inflight.add(controller);
        const onClose = (): void => { if (!response.writableEnded) controller.abort(); };
        response.once("close", onClose);
        setCommonHeaders(response);
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "x-accel-buffering": "no" });
        let sequence = 0;
        const sendEvent = (event: unknown): Promise<void> => writeResponse(response, `${jsonText(event)}\n`);
        try {
          const completion = await service.execute(executeOptions(sessionId, body, controller.signal), {
            onStarted: (preview) => sendEvent({ type: "started", preview, requestId }),
            onOutput: (event: ProcessOutputEvent) => sendEvent({ type: "output", stream: event.stream, sequence: sequence++, dataBase64: event.data.toString("base64"), requestId }),
          });
          if (completion.command.kind === "crashed" && completion.command.errorCode === "OUTPUT_SINK_FAILED") {
            response.destroy();
            return;
          }
          await sendEvent({ type: "completed", result: jsonCompletion(completion), requestId });
          response.end();
        } catch (error) {
          if (!response.destroyed && !response.writableEnded) {
            const normalized = asPosixLoomError(error, "HTTP_EXECUTION_FAILED");
            await sendEvent({ type: "error", error: { code: normalized.code, message: normalized.message, details: normalized.details }, requestId }).catch(() => undefined);
            response.end();
          }
        } finally {
          inflight.delete(controller);
          response.off("close", onClose);
        }
        return;
      }

      for (const extension of options.extensions ?? []) {
        const result = await extension.handle({ method, pathname: url.pathname, searchParams: url.searchParams });
        if (result) {
          sendJson(response, result.status ?? 200, { ...result.body, requestId });
          return;
        }
      }
      throw new PosixLoomError("HTTP_NOT_FOUND", "HTTP endpoint not found", { path: url.pathname });
    };
    void run().catch((error) => sendError(response, error, requestId));
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
      for (const controller of inflight) controller.abort();
      closePromise = new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
