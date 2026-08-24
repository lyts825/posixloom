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
write session environment values to disk.

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

`runtime info` reports the immutable snapshot id, Runtime source and mode, mounts,
policy profile, resolved Bash and Native Host paths, and Native Fast Path commands.

`trace list` reads the tail of `<DataRoot>/logs/posixloom-trace.jsonl`. Persistent trace
recording is disabled by default; enable `observability.writeTraceFile` in the user
configuration when historical diagnostics are required. Trace records contain command
metadata and outcomes, not command text or environment values.
