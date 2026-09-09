import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { PosixLoomError } from "./errors.js";

/** Resolve standard MSYS/Cygwin layouts, including Git's bin/bash.exe forwarder. */
export function shellNamespaceIdentity(bash: string): string {
  const directory = dirname(realpathSync(bash));
  const candidates = [join(directory, "msys-2.0.dll"), join(directory, "cygwin1.dll"), join(directory, "..", "usr", "bin", "msys-2.0.dll")];
  const dll = candidates.find(existsSync);
  if (!dll) throw new PosixLoomError("BASH_RUNTIME_UNKNOWN", "Cannot locate the MSYS/Cygwin DLL for shared mount coordination; use the installation's usr/bin/bash.exe", { bash });
  const user = userInfo();
  // The profile path distinguishes equal account names from different domains.
  return createHash("sha256").update(`${user.username.toLowerCase()}\0${user.homedir.toLowerCase()}\0${realpathSync(dll).toLowerCase()}`).digest("hex");
}
