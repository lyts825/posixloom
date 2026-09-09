/** Shell bootstrap. State collection is an auditable, checksummed Bash asset. */
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ShellExecutionPlan } from "./types.js";
export { parseStateReport, type ParsedStateReport } from "./state-report.js";

/** Quote one value as an injection-safe POSIX single-quoted literal. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Convert a Windows path to the forward-slash form understood by MSYS tools. */
export function toMixedPath(path: string): string {
  if (path.startsWith("\\\\")) return `//${path.slice(2).replaceAll("\\", "/")}`;
  return path.replaceAll("\\", "/");
}

/** Use the same physical Windows path for MSYS startup and mount registration. */
export function canonicalShellHostPath(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : path;
}

const reportHelper = toMixedPath(fileURLToPath(new URL("./assets/state-report.sh", import.meta.url)));

export function buildShellScript(plan: ShellExecutionPlan): string {
  const mountFunction = [
    "__posixloom_mount() {",
    "  mount -f \"$1\" \"$2\" >/dev/null 2>&1 && return 0",
    "  # The immutable usertemp mount must resolve to THIS Runtime's host directory.",
    "  if [[ \"$2\" == /tmp ]]; then",
    "    local actual expected",
    "    actual=\"$(cygpath -am /tmp 2>/dev/null)\" || return 1",
    "    expected=\"$1\"",
    "    [[ \"${actual,,}\" == \"${expected,,}\" && -d /tmp ]] && return 0",
    "    printf '[PosixLoom] MSYS /tmp belongs to another runtime; close other shells using this installation or use a dedicated Runtime.\\n' >&2",
    "    return 1",
    "  fi",
    "  printf '[PosixLoom] Failed to mount %s\\n' \"$2\" >&2",
    "  return 1",
    "}",
  ].join("\n");
  const mounts = plan.mountBootstrap.map((mount) => {
    // MSYS resolves physical cwd to long Windows paths. A mount registered with
    // an 8.3 path (as used by hosted runners' TEMP) or a junction alias cannot
    // reverse-map that cwd, so pwd -P escapes the declared virtual namespace.
    const hostPath = canonicalShellHostPath(mount.hostPath);
    return `__posixloom_mount ${quotePosix(toMixedPath(hostPath))} ${quotePosix(mount.virtualPath)} || exit 242`;
  }).join("\n");
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
    `source ${quotePosix(reportHelper)} "$__posixloom_command_code" ${quotePosix(plan.statePolicy)}`,
    "",
  ].join("\n");
}
