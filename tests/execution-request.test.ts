import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTION_LIMITS, executionRequestSchema, parseExecutionRequest } from "../src/core/execution-request.js";
import { parseExec, parseShell } from "../src/cli/command-options.js";
import { parseServeOptions, parseGuiOptions } from "../src/cli/network-options.js";

test("all execution fields are normalized and detached from caller-owned objects", () => {
  const request = { input: { kind: "argv", argv: ["node", "a b"] }, cwd: "/workspace", timeoutMs: 1, envDelta: { TOKEN: "safe", REMOVE: null }, statePolicy: "isolated", terminal: { columns: 1, rows: 32767 }, stream: true };
  const parsed = parseExecutionRequest(request);
  request.input.argv[1] = "mutated"; request.envDelta.TOKEN = "mutated"; request.terminal.rows = 1;
  assert.deepEqual(parsed.input, { kind: "argv", argv: ["node", "a b"] });
  assert.equal(parsed.envDelta!.TOKEN, "safe");
  assert.equal(parsed.terminal!.rows, 32767);
  assert.equal(parsed.stream, true);
  assert.equal(parseExecutionRequest({ input: { kind: "text", raw: "" } }).stream, false);
  assert.throws(() => parseExecutionRequest(request, { allowTerminal: false }), /not supported/);
  assert.deepEqual(parseExecutionRequest({ input: { kind: "argv", argv: [] } }, { allowEmpty: true }).input, { kind: "argv", argv: [] });
});

test("shared validator rejects malformed fields with transport-specific structured codes", () => {
  const base = { input: { kind: "argv", argv: ["node"] } };
  const invalid = [
    null, [], {}, { input: [] }, { input: { kind: "unknown" } },
    { input: { kind: "text", raw: 1 } }, { input: { kind: "text", raw: "bad\u0000script" } },
    { input: { kind: "argv", argv: [] } }, { input: { kind: "argv", argv: ["node", 1] } },
    { ...base, timeoutMs: 0 }, { ...base, timeoutMs: -1 }, { ...base, timeoutMs: 1.5 }, { ...base, timeoutMs: 2147483648 }, { ...base, timeoutMs: "1" },
    { ...base, cwd: "\u0000" }, { ...base, cwd: false }, { ...base, statePolicy: "persist" }, { ...base, stream: "true" },
    { ...base, envDelta: [] }, { ...base, envDelta: { "BAD-NAME": "1" } }, { ...base, envDelta: { KEY: 1 } }, { ...base, envDelta: { KEY: "\u0000" } },
    { ...base, terminal: {} }, { ...base, terminal: { columns: 0, rows: 24 } }, { ...base, terminal: { columns: 80, rows: 32768 } },
  ];
  for (const value of invalid) for (const code of ["HTTP_EXECUTE_INVALID", "CONTROL_REQUEST_INVALID", "CLI_OPTIONS_INVALID"]) {
    assert.throws(() => parseExecutionRequest(value, { code }), (error: any) => error.code === code);
  }
});

test("UTF-8 byte and aggregate argv/environment limits match published schema extensions", () => {
  assert.equal(executionRequestSchema.properties.input.oneOf[0].properties.raw["x-maxUtf8Bytes"], EXECUTION_LIMITS.maxTextBytes);
  assert.doesNotThrow(() => parseExecutionRequest({ input: { kind: "text", raw: "x".repeat(EXECUTION_LIMITS.maxTextBytes) } }));
  assert.throws(() => parseExecutionRequest({ input: { kind: "text", raw: "中".repeat(Math.floor(EXECUTION_LIMITS.maxTextBytes / 3) + 1) } }));
  assert.throws(() => parseExecutionRequest({ input: { kind: "argv", argv: Array(4097).fill("x") } }));
  assert.throws(() => parseExecutionRequest({ input: { kind: "argv", argv: ["x".repeat(32769)] } }));
  assert.throws(() => parseExecutionRequest({ input: { kind: "argv", argv: Array(40).fill("x".repeat(32768)) } }));
  assert.throws(() => parseExecutionRequest({ input: { kind: "text", raw: "" }, envDelta: { A: "x".repeat(EXECUTION_LIMITS.maxEnvironmentBytes) } }));
  assert.throws(() => parseExecutionRequest({ input: { kind: "text", raw: "" }, cwd: "x".repeat(32769) }));
});

test("CLI command options use shared validation without reinterpreting argv", () => {
  const parsed = parseExec(["--cwd", "/workspace", "--isolated", "--timeout", "5", "--dry-run", "--json", "--", "node", "a b", "--timeout", "0"]);
  assert.deepEqual(parsed.argv, ["node", "a b", "--timeout", "0"]);
  assert.equal(parsed.timeoutMs, 5);
  assert.equal(parsed.dryRun && parsed.json && parsed.isolated, true);
  assert.equal(parseShell(["--timeout", "1", "-c", "echo hi"]).raw, "echo hi");
  assert.equal(parseShell(["--stdin"]).stdin, true);
  assert.equal(parseExec(["--pty", "--cols", "120", "--rows", "40", "--", "node"]).columns, 120);
  for (const args of [["--cwd"], ["--timeout", "0", "--", "node"], ["--timeout", "2147483648", "--", "node"], ["--json", "--", "node"], ["--cols", "80", "--", "node"], ["--pty", "--rows", "0", "--", "node"]]) assert.throws(() => parseExec(args));
  for (const args of [[], ["--stdin", "-c", "hi"], ["-c", "hi", "extra"], ["--unknown"], ["--cwd"], ["--json", "-c", "hi"], ["--pty", "--stdin"], ["--timeout", "NaN", "-c", "hi"]]) assert.throws(() => parseShell(args));
});

test("CLI network parsing checks ports, missing values and unknown options", () => {
  assert.equal(parseServeOptions(["--http", "--port", "7331"]).port, 7331);
  assert.equal(parseGuiOptions(["--no-open"]).open, false);
  for (const args of [["--http", "--port", "65536"], ["--http", "--port", "-1"], ["--http", "--host"], ["--http", "--unknown"]]) assert.throws(() => parseServeOptions(args));
  assert.throws(() => parseGuiOptions(["--api-port", "NaN"]));
});
