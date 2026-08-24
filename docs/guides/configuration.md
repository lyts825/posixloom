# Configuration and diagnostics

PosixLoom merges the packaged `config/defaults.json` with the optional user file at
`<DataRoot>/config/config.json`. Arrays and scalar values replace defaults; nested
objects are merged recursively. A malformed user file fails closed with
`CONFIG_INVALID` rather than silently falling back to defaults.

## Configuration commands

```powershell
posixloom config path
posixloom config show
posixloom config validate
posixloom config validate --json
```

`config show` prints the normalized effective configuration after path templates and
environment overrides have been resolved. Sessions are process-local: closing the
control service discards their cwd and exported environment state. PosixLoom does not
write session environment values to disk. The previously declared but unimplemented
`session.persistAcrossRestart` option is no longer supported: `true` fails validation
with `CONFIG_UNSUPPORTED`; legacy `false` is tolerated and omitted from the effective
configuration so existing non-persistent installations can migrate safely.

## Resource boundaries

The packaged defaults keep process-local state and child-process data bounded:

```json
{
  "session": {
    "maxSessions": 1024,
    "idleTimeoutMs": 1800000
  },
  "process": {
    "maxOutputBytes": 8388608,
    "outputDrainTimeoutMs": 5000,
    "maxReportBytes": 1048576
  }
}
```

Expired sessions are reclaimed lazily. At capacity, the least recently used inactive
session is reclaimed; if every slot is executing or queued, creation fails with
`SESSION_LIMIT_REACHED`. `maxOutputBytes` applies independently to stdout and stderr,
`outputDrainTimeoutMs` prevents a stalled streaming client from holding completion
open forever, and `maxReportBytes` is a separate hard limit for StateReport data.

## Execution plan preview

Use `explain` to run the same integrity, cwd, policy, classification, Native Registry,
and plan-building stages as a real command without creating the target process:

```powershell
posixloom explain exec -- rg TODO /workspace/src
posixloom explain --json shell -c 'git status | grep modified'
posixloom exec --dry-run --json -- rg TODO /workspace/src
```

`exec --dry-run` and `shell --dry-run` are convenience aliases for the corresponding
`explain` forms. `--json` on these direct forms is accepted only together with
`--dry-run`, so a normal command never changes its output format accidentally.

The preview contains the Runtime and session versions it observed. A later execution
creates a new plan and revalidates current state, so a preview is diagnostic evidence,
not a reusable authorization token. Environment variable names may be listed, but
their values, the generated Shell wrapper, and StateReport paths are omitted.

## Runtime and trace diagnostics

```powershell
posixloom runtime info
posixloom runtime info --json
posixloom trace list --limit 50
posixloom trace list --limit 50 --json
```

`runtime info` reports the immutable snapshot and plugin-graph hashes, Runtime source
and mode, mounts, policy profile, resolved Bash and Native Host paths, Native Fast
Path commands, and a data-only inventory of active runtime plugins.

`trace list` reads the tail of `<DataRoot>/logs/posixloom-trace.jsonl`. Persistent trace
recording is disabled by default; enable `observability.writeTraceFile` in the user
configuration when historical diagnostics are required. Trace records contain command
metadata and outcomes, not command text or environment values.

## Interactive terminal mode

On Windows, `--pty` runs the command through ConPTY and forwards stdin, terminal
resize events, ANSI color, and prompts. `--cols` and `--rows` set the initial
viewport when no attached terminal size is available.

```powershell
posixloom exec --pty -- python -i
posixloom shell --pty --cols 120 --rows 40 -c 'read -p "value: " value; echo "$value"'
```

PTY mode is intentionally separate from `--stdin`: interactive stdin remains attached
until EOF, while `--stdin` first consumes a complete Shell script. Non-Windows hosts
return `PTY_UNAVAILABLE` rather than silently falling back to ordinary pipes.
