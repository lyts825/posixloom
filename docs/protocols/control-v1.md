# PosixLoom Harness control protocol v1

`posixloom serve --stdio` exposes a long-lived control plane for a Harness or another
local orchestrator. The protocol is deliberately small: it carries exact
`argv` commands and raw Shell text as different input types, while keeping
session state and process cancellation explicit.

`posixloom` is the canonical command for PosixLoom Runtime. The command name,
environment prefix, and protocol namespace use the same project identity.

## Transport

Each message is one UTF-8 JSON object preceded by a 4-byte little-endian
unsigned payload length. The payload limit is 16 MiB. Frames may be split or
coalesced by the pipe; the receiver must buffer until a complete frame is
available. A malformed length, invalid UTF-8/JSON, or an oversized frame is a
protocol error and must terminate the connection rather than guessing at the
message boundary.

Every message contains `protocolVersion: 1`. The server sends `hello` first:

```json
{"protocolVersion":1,"type":"hello","maxFrameBytes":16777216,
 "capabilities":["session","argv","shell","cancel","runtime-doctor",
 "runtime-info","execute-plan","stream-output-v1","trace-list","trace-summary","pty-v1",
 "metrics-v1","bounded-replay-v1"],
 "replayWindow":{"maximum":10000,"ttlMs":1800000},
 "limits":{"maxPendingRequests":256,"maxConcurrent":8,"maxConcurrentPerClient":4,
 "maxQueued":128,"maxQueuedPerClient":32,"queueTimeoutMs":30000}}
```

Terminal responses are asynchronous, so clients correlate them by `id`. Each request
must use a non-empty `id` (at most 128 characters) that is unique for the
connection. A terminal response is
either `{ "type": "result", "id": ..., "result": ... }` or
`{ "type": "error", "id": ..., "code": ..., "message": ... }`. An execute
request that explicitly opts into streaming may receive correlated `event` frames
before its one terminal response.

Clients should always generate fresh IDs. The server rejects active duplicates and
retains completed IDs for up to 30 minutes or the newest 10000 completed requests,
whichever ends first (actual limits are advertised in hello). Active IDs are never
evicted. This is not a result cache or an exactly-once guarantee after expiry/reconnect;
retrying a side-effecting command under a new ID can repeat it.

## Requests

The supported request types are:

- `session.create`: optional `cwd`; returns `sessionId` and the initial state.
- `session.snapshot`: requires `sessionId`; returns `version` (decimal string),
  `cwd`, and `exportedEnv`.
- `session.close`: closes an inactive session; running or queued work yields `SESSION_BUSY`.
- `execute`: requires `id`, `sessionId`, and `input`. `input` is either
  `{ "kind":"argv", "argv":[...] }` for an exact executable/argument vector,
  or `{ "kind":"text", "raw":"..." }` for one Shell script. Optional
  `cwd`, `envDelta`, `statePolicy` (`isolated` or `cwd-env`), `timeoutMs`, and
  boolean `stream`, and optional terminal dimensions
  `{ "terminal": { "columns": 80, "rows": 24 } }` have the same meaning as
  the CLI. Terminal execution requires `stream: true`.
- `execute.plan`: validates and prepares the same execution plan as `execute`, but
  does not create a process or commit session state. The result includes the selected
  backend, sanitized argv, cwd translation, policy profile, and path decisions. It
  never contains environment values, generated Shell wrapper text, or StateReport paths.
- `cancel`: requires its own correlation `id` plus `targetId`, which names the
  in-flight execute request to abort. The two IDs must differ. The response
  reports `{ "targetId": ..., "cancelling": true|false }`; the execute request
  emits its own final result or error.
- `runtime.doctor`: returns the runtime validation report.
- `runtime.info`: returns the active Runtime identity, snapshot, mounts, backend paths,
  policy profile, and Native Registry command names without running an external command.
- `trace.list`: returns recent in-memory trace events. Optional `limit` must be an
  integer from 1 through 5000 and defaults to 50.
- `trace.summary`: summarizes the same bounded sample, including phase timings and
  opt-in command-name fallback candidates. The same limit bounds apply.
- `metrics`: returns shared admission/trace diagnostics, replay ID count, pending RPCs
  and overload rejections. The pending count includes the metrics RPC itself.
- `terminal.input`: requires its own correlation `id`, an in-flight terminal
  execute request in `targetId`, and canonical Base64 bytes in `dataBase64`.
  Each decoded input frame is limited to 64 KiB.
- `terminal.resize`: requires `targetId`, `columns`, and `rows`; both dimensions
  must be positive integers no greater than 32767.
- `terminal.eof`: sends the platform terminal EOF indication to `targetId`.
- `shutdown`: cancels in-flight work and asks the server to close after queued
  requests finish.

An `argv` request is never reconstructed by joining strings. Shell quoting,
pipelines, redirects, substitutions, and `cd` are available only through the
`text` input kind. This boundary prevents an argument containing spaces or
metacharacters from changing command meaning.

## Streaming output

An `execute` request may opt into streaming with `"stream": true`. Existing clients
that omit the field continue to receive exactly one terminal `result` or `error`.
Streaming clients receive a `started` event, zero or more `output` events, and then
the normal terminal response:

```json
{"protocolVersion":1,"type":"event","id":"e1","event":"started",
 "planId":"...","backend":"native"}
{"protocolVersion":1,"type":"event","id":"e1","event":"output",
 "sequence":0,"stream":"stdout","dataBase64":"aGVsbG8K"}
{"protocolVersion":1,"type":"result","id":"e1","result":{"command":{"kind":"exited","exitCode":0}}}
```

`sequence` is monotonic across stdout and stderr for one execution. Output data is
Base64 so arbitrary bytes remain lossless. The server waits for each event write
before reading more process output, propagating backpressure to the child pipes. All
output events are written before the terminal response. Cancellation, timeout, and
connection-loss behavior is unchanged.

Execution and preview requests are admitted through the shared Runtime scheduler.
Full queues return SERVER_BUSY; queue expiry returns QUEUE_TIMEOUT. Queued cancellation
never starts the process. Cancel can also abort an in-flight execute.plan request.
Stdio keeps 16 reserved RPC slots for cancel/shutdown/terminal controls. The output
deadline applies to all response frames, including hello and final results: an
unresponsive sink ends the connection with CONTROL_OUTPUT_TIMEOUT.

CLI, stdio and HTTP share execution validation: text and total argv JSON are limited
to 1 MiB UTF-8; argv has at most 4096 elements of at most 32768 bytes each; environment
delta JSON has a separate 1 MiB limit. NUL and invalid environment names are rejected.
Timeouts are integers from 1 through 2147483647; terminal dimensions are 1..32767.

## Interactive terminals

The `pty-v1` capability exposes a Windows ConPTY session. The terminal keeps stdin
open for `terminal.input`, accepts live `terminal.resize` requests, and preserves
ANSI/control bytes. ConPTY produces one terminal output stream, so all interactive
bytes are emitted as `stdout` events and the final `stderrBase64` is empty. A
disconnect, cancellation, or timeout closes the associated Job Object and terminal.

Terminal requests receive their own correlated success or error response. A client
must wait for the execute request's final response after `terminal.eof`; EOF is not
itself a process-completion acknowledgement.

## Execute result

The terminal result contains the normalized command outcome, state outcome, byte
counts, backend, plan/trace metadata, and `stdoutBase64`/`stderrBase64`. Binary
encoding is lossless; retention is bounded by the process output limits and the
16 MiB completion-frame limit. The server budgets the complete UTF-8 JSON envelope,
metadata and both Base64 fields together. If the captured output cannot fit, it
retains each stream's head and tail with an output-truncation marker and sets
`result.truncated: true`. Space unused by one stream is available to the other.
`stdoutBytes`/`stderrBytes` still report the original process byte counts; the
command and state outcomes are preserved. Trace metadata describes process capture,
while `result.truncated` also includes transport truncation. Streaming `output`
events remain complete and are unaffected by the completion-frame budget.

A committed session version is encoded as a
decimal string because JavaScript `bigint` is not JSON-native. A timeout,
cancellation, policy rejection, or native-host failure is represented by the
typed `state`/error code; it is not converted into a successful empty result.

The protocol is local-process IPC, not a security sandbox. Policy profiles are
guardrails for cwd, executable, and write paths; callers must still treat the
runtime as trusted code execution.
