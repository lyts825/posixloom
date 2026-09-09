#!/usr/bin/env bash
# StateReport v1 writer. Shipped as readable Bash, covered by package checksums.
# Only writes the caller-selected local report; stdout/stderr remain user output.
# Isolated commands need only a completion receipt. Bash builtins avoid spawning
# env/base64/wc/tr or serializing state that will never be committed.
if [[ "${2:-cwd-env}" == isolated ]]; then
  if builtin printf '__POSIXLOOM_COMPLETION_V1\nexit-code=%s\n__POSIXLOOM_REPORT_END\n' "$1" > "$POSIXLOOM_STATE_REPORT_PATH"; then
    exit "$1"
  else
    exit 240
  fi
fi
__posixloom_emit_report() {
  local __posixloom_code="$1"
  local __posixloom_cwd64 __posixloom_env_bytes
  __posixloom_cwd64="$(pwd -P | tr -d '\n' | base64 -w 0 2>/dev/null)" || return 1
  __posixloom_env_bytes="$(env -0 | wc -c | tr -d '[:space:]')" || return 1
  : > "$POSIXLOOM_STATE_REPORT_PATH" || return 1
  printf '__POSIXLOOM_REPORT_V1\nexit-code=%s\ncwd-b64=%s\nenv-bytes=%s\n' "$__posixloom_code" "$__posixloom_cwd64" "$__posixloom_env_bytes" > "$POSIXLOOM_STATE_REPORT_PATH"
  env -0 >> "$POSIXLOOM_STATE_REPORT_PATH" || return 1
  printf '__POSIXLOOM_REPORT_END\n' >> "$POSIXLOOM_STATE_REPORT_PATH"
}
if __posixloom_emit_report "$1"; then exit "$1"; else exit 240; fi
