import { PosixLoomError } from "./errors.js";
import type { StatePolicy, TerminalSize } from "./types.js";

export const EXECUTION_LIMITS = Object.freeze({ maxTextBytes: 1024 * 1024, maxArgs: 4096, maxArgumentBytes: 32768, maxEnvironmentBytes: 1024 * 1024 });
export interface ExecutionRequest {
  input: { kind: "text"; raw: string } | { kind: "argv"; argv: string[] };
  cwd?: string;
  timeoutMs?: number;
  envDelta?: Record<string, string | null>;
  statePolicy?: StatePolicy;
  terminal?: TerminalSize;
  stream: boolean;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Shared semantic boundary for CLI, stdio, HTTP and embedders. Byte limits are UTF-8. */
export function parseExecutionRequest(value: unknown, options: { code?: string; allowEmpty?: boolean; allowTerminal?: boolean } = {}): ExecutionRequest {
  const invalid = (message: string): never => { throw new PosixLoomError(options.code ?? "EXECUTE_REQUEST_INVALID", message); };
  if (!isRecord(value) || !isRecord(value.input)) return invalid("execute requires an input object");
  let input: ExecutionRequest["input"];
  if (value.input.kind === "text") {
    const raw = value.input.raw;
    if (typeof raw !== "string" || raw.includes("\0") || Buffer.byteLength(raw) > EXECUTION_LIMITS.maxTextBytes) return invalid("text input requires a NUL-free raw string of at most 1 MiB");
    input = { kind: "text", raw };
  } else if (value.input.kind === "argv") {
    const argv = value.input.argv;
    if (!Array.isArray(argv) || argv.length < (options.allowEmpty ? 0 : 1) || argv.length > EXECUTION_LIMITS.maxArgs
      || argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > EXECUTION_LIMITS.maxArgumentBytes)) return invalid("argv requires 1 to 4096 NUL-free strings, each at most 32768 UTF-8 bytes");
    if (Buffer.byteLength(JSON.stringify(argv)) > EXECUTION_LIMITS.maxTextBytes) return invalid("argv input exceeds 1 MiB");
    input = { kind: "argv", argv: [...argv] as string[] };
  } else return invalid("input.kind must be text or argv");
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.includes("\0") || Buffer.byteLength(value.cwd) > 32768)) return invalid("cwd must be a NUL-free string of at most 32768 bytes");
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0 || (value.timeoutMs as number) > 2147483647)) return invalid("timeoutMs must be an integer between 1 and 2147483647");
  if (value.statePolicy !== undefined && value.statePolicy !== "isolated" && value.statePolicy !== "cwd-env") return invalid("statePolicy must be isolated or cwd-env");
  if (value.stream !== undefined && typeof value.stream !== "boolean") return invalid("stream must be a boolean");
  let envDelta: ExecutionRequest["envDelta"];
  if (value.envDelta !== undefined) {
    if (!isRecord(value.envDelta)) return invalid("envDelta must be an object");
    envDelta = Object.create(null) as Record<string, string | null>;
    for (const [key, entry] of Object.entries(value.envDelta)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || (entry !== null && (typeof entry !== "string" || entry.includes("\0")))) return invalid("envDelta requires valid environment names and NUL-free string or null values");
      envDelta[key] = entry;
    }
    if (Buffer.byteLength(JSON.stringify(envDelta)) > EXECUTION_LIMITS.maxEnvironmentBytes) return invalid("envDelta exceeds 1 MiB");
  }
  let terminal: TerminalSize | undefined;
  if (value.terminal !== undefined) {
    if (options.allowTerminal === false) return invalid("Interactive terminals are not supported by this transport");
    const size = value.terminal;
    if (!isRecord(size) || !Number.isSafeInteger(size.columns) || !Number.isSafeInteger(size.rows) || (size.columns as number) < 1 || (size.rows as number) < 1 || (size.columns as number) > 32767 || (size.rows as number) > 32767) return invalid("terminal columns and rows must be integers between 1 and 32767");
    terminal = { columns: size.columns as number, rows: size.rows as number };
  }
  return { input, cwd: value.cwd as string | undefined, timeoutMs: value.timeoutMs as number | undefined, envDelta, statePolicy: value.statePolicy as StatePolicy | undefined, terminal, stream: value.stream === true };
}

/** UTF-8 byte limits supplement JSON Schema's code-point lengths via x-maxUtf8Bytes. */
export const executionRequestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", title: "PosixLoom Execution Request v1", type: "object", required: ["input"],
  properties: {
    input: { oneOf: [
      { type: "object", required: ["kind", "raw"], properties: { kind: { const: "text" }, raw: { type: "string", pattern: "^[^\\u0000]*$", "x-maxUtf8Bytes": EXECUTION_LIMITS.maxTextBytes } } },
      { type: "object", required: ["kind", "argv"], properties: { kind: { const: "argv" }, argv: { type: "array", minItems: 1, maxItems: EXECUTION_LIMITS.maxArgs, "x-maxUtf8Bytes": EXECUTION_LIMITS.maxTextBytes, items: { type: "string", pattern: "^[^\\u0000]*$", "x-maxUtf8Bytes": EXECUTION_LIMITS.maxArgumentBytes } } } },
    ] },
    cwd: { type: "string", pattern: "^[^\\u0000]*$", "x-maxUtf8Bytes": 32768 },
    timeoutMs: { type: "integer", minimum: 1, maximum: 2147483647 },
    statePolicy: { enum: ["isolated", "cwd-env"] }, stream: { type: "boolean", default: false },
    envDelta: { type: "object", propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }, additionalProperties: { type: ["string", "null"], pattern: "^[^\\u0000]*$" }, "x-maxUtf8Bytes": EXECUTION_LIMITS.maxEnvironmentBytes },
    terminal: { type: "object", required: ["columns", "rows"], properties: { columns: { type: "integer", minimum: 1, maximum: 32767 }, rows: { type: "integer", minimum: 1, maximum: 32767 } } },
  },
} as const;
