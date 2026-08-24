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
 "capabilities":["session","argv","shell","cancel","runtime-doctor"]}
```

Responses are asynchronous, so clients correlate them by `id`. Each request
must use a non-empty `id` (at most 128 characters) that is unique for the
connection. A response is
either `{ "type": "result", "id": ..., "result": ... }` or
`{ "type": "error", "id": ..., "code": ..., "message": ... }`.

## Requests

The supported request types are:

- `session.create`: optional `cwd`; returns `sessionId` and the initial state.
- `session.snapshot`: requires `sessionId`; returns `version` (decimal string),
  `cwd`, and `exportedEnv`.
- `session.close`: closes a session.
- `execute`: requires `id`, `sessionId`, and `input`. `input` is either
  `{ "kind":"argv", "argv":[...] }` for an exact executable/argument vector,
  or `{ "kind":"text", "raw":"..." }` for one Shell script. Optional
  `cwd`, `envDelta`, `statePolicy` (`isolated` or `cwd-env`), and `timeoutMs`
  have the same meaning as the CLI.
- `cancel`: requires its own correlation `id` plus `targetId`, which names the
  in-flight execute request to abort. The two IDs must differ. The response
  reports `{ "targetId": ..., "cancelling": true|false }`; the execute request
  emits its own final result or error.
- `runtime.doctor`: returns the runtime validation report.
- `shutdown`: cancels in-flight work and asks the server to close after queued
  requests finish.

An `argv` request is never reconstructed by joining strings. Shell quoting,
pipelines, redirects, substitutions, and `cd` are available only through the
`text` input kind. This boundary prevents an argument containing spaces or
metacharacters from changing command meaning.

## Execute result

The result contains the original normalized command, state outcome, byte
counts, backend, plan/trace metadata, and `stdoutBase64`/`stderrBase64`. Binary
output is therefore lossless. A committed session version is encoded as a
decimal string because JavaScript `bigint` is not JSON-native. A timeout,
cancellation, policy rejection, or native-host failure is represented by the
typed `state`/error code; it is not converted into a successful empty result.

The protocol is local-process IPC, not a security sandbox. Policy profiles are
guardrails for cwd, executable, and write paths; callers must still treat the
runtime as trusted code execution.
