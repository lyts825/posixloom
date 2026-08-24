/** Shell wrapper and StateReport v1 codec shared by the shell backend plugin and public API. */
import { PosixLoomError } from "./errors.js";
import { canonicalEnvKey } from "./env.js";
import type { ShellExecutionPlan } from "./types.js";

export interface ParsedStateReport {
  exitCode: number;
  cwd: string;
  exportedEnv: Record<string, string>;
}

/** Quote one value as an injection-safe POSIX single-quoted literal. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Convert a Windows path to the forward-slash form understood by MSYS tools. */
export function toMixedPath(path: string): string {
  if (path.startsWith("\\\\")) return `//${path.slice(2).replaceAll("\\", "/")}`;
  return path.replaceAll("\\", "/");
}

/** Build the one-shot Bash wrapper that mounts paths and emits StateReport v1. */
export function buildShellScript(plan: ShellExecutionPlan): string {
  const mountFunction = [
    "__posixloom_mount() {",
    "  mount -f \"$1\" \"$2\" >/dev/null 2>&1 && return 0",
    "  # MSYS/Cygwin may provide /tmp as a fixed system mount that cannot be replaced per session.",
    "  [ \"$2\" = /tmp ] && [ -d /tmp ] && return 0",
    "  return 1",
    "}",
  ].join("\n");
  const mounts = plan.mountBootstrap.map((mount) =>
    `__posixloom_mount ${quotePosix(toMixedPath(mount.hostPath))} ${quotePosix(mount.virtualPath)} || exit 242`,
  ).join("\n");
  const exports = Object.entries(plan.envPosix)
    .filter(([key]) => key !== "PWD")
    .map(([key, value]) => `export ${key}=${quotePosix(value)}`)
    .join("\n");
  return [
    "set +e",
    mountFunction,
    mounts,
    exports,
    `cd -- ${quotePosix(plan.cwdVirtual)} || exit 243`,
    "__posixloom_user_command() {",
    plan.commandBody,
    "}",
    "__posixloom_user_command",
    "__posixloom_command_code=$?",
    "__posixloom_emit_report() {",
    "  local __posixloom_code=\"$1\"",
    "  local __posixloom_cwd64 __posixloom_env_bytes",
    "  __posixloom_cwd64=\"$(pwd -P | tr -d '\\n' | base64 -w 0 2>/dev/null)\" || return 1",
    "  __posixloom_env_bytes=\"$(env -0 | wc -c | tr -d '[:space:]')\" || return 1",
    "  : > \"$POSIXLOOM_STATE_REPORT_PATH\" || return 1",
    "  printf '__POSIXLOOM_REPORT_V1\\nexit-code=%s\\ncwd-b64=%s\\nenv-bytes=%s\\n' \"$__posixloom_code\" \"$__posixloom_cwd64\" \"$__posixloom_env_bytes\" > \"$POSIXLOOM_STATE_REPORT_PATH\"",
    "  env -0 >> \"$POSIXLOOM_STATE_REPORT_PATH\" || return 1",
    "  printf '__POSIXLOOM_REPORT_END\\n' >> \"$POSIXLOOM_STATE_REPORT_PATH\"",
    "}",
    "if __posixloom_emit_report \"$__posixloom_command_code\"; then exit \"$__posixloom_command_code\"; else exit 240; fi",
    "",
  ].join("\n");
}

/** Strictly decode StateReport v1 without accepting truncated or ambiguous data. */
export function parseStateReport(report: Buffer): ParsedStateReport | undefined {
  const header = Buffer.from("__POSIXLOOM_REPORT_V1\n");
  if (!report.length) return undefined;
  if (!report.subarray(0, header.length).equals(header)) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport header is invalid");
  let offset = header.length;
  const readLine = (): string => {
    const end = report.indexOf(0x0a, offset);
    if (end < 0) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport line is truncated");
    const line = report.subarray(offset, end).toString("utf8");
    offset = end + 1;
    return line;
  };
  const exitLine = readLine();
  const cwdLine = readLine();
  const bytesLine = readLine();
  if (!exitLine.startsWith("exit-code=") || !cwdLine.startsWith("cwd-b64=") || !bytesLine.startsWith("env-bytes=")) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport metadata labels are invalid");
  }
  const exitCode = Number(exitLine.slice("exit-code=".length));
  const cwd64 = cwdLine.slice("cwd-b64=".length);
  const envBytes = Number(bytesLine.slice("env-bytes=".length));
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255 || !Number.isSafeInteger(envBytes) || envBytes < 0 || offset + envBytes > report.length) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport metadata is invalid");
  }
  const envBlock = report.subarray(offset, offset + envBytes);
  offset += envBytes;
  const endMarker = Buffer.from("__POSIXLOOM_REPORT_END\n");
  if (!report.subarray(offset, offset + endMarker.length).equals(endMarker)) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport end marker is missing");
  }
  if (offset + endMarker.length !== report.length) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport contains trailing data");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cwd64)) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not canonical Base64");
  }
  const cwdBytes = Buffer.from(cwd64, "base64");
  if (cwdBytes.toString("base64") !== cwd64) throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not canonical Base64");
  let cwd: string;
  try {
    cwd = new TextDecoder("utf-8", { fatal: true }).decode(cwdBytes);
  } catch (error) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport cwd is not valid UTF-8", { cause: String(error) });
  }
  const exportedEnv: Record<string, string> = {};
  const sourceKeys = new Map<string, string>();
  let envText: string;
  try {
    envText = new TextDecoder("utf-8", { fatal: true }).decode(envBlock);
  } catch (error) {
    throw new PosixLoomError("STATE_PROTOCOL_FAILED", "StateReport environment is not valid UTF-8", { cause: String(error) });
  }
  for (const entry of envText.split("\0")) {
    if (!entry) continue;
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const sourceKey = entry.slice(0, equals);
    const key = canonicalEnvKey(sourceKey);
    const prior = sourceKeys.get(key);
    if (prior) throw new PosixLoomError("STATE_PROTOCOL_FAILED", `StateReport environment keys are duplicated or collide on Windows: ${prior} / ${sourceKey}`);
    sourceKeys.set(key, sourceKey);
    exportedEnv[key] = entry.slice(equals + 1);
  }
  return { exitCode, cwd, exportedEnv };
}
