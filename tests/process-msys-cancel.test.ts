import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../src/core/process.js";
import { shellNamespaceIdentity } from "../src/core/shell-namespace.js";

const nativeHost = join(process.cwd(), "native", "posixloom-host", "target", "debug", "posixloom.exe");
const bash = process.env.POSIXLOOM_BASH ?? "C:\\Program Files\\Git\\usr\\bin\\bash.exe";

test("Native Host cancellation owns MSYS descendants across Windows fork/exec parent changes", {
  skip: process.platform !== "win32" || !existsSync(nativeHost) || !existsSync(bash),
}, async () => {
  const controller = new AbortController();
  let output = "";
  let windowsPid: number | undefined;
  const result = await runProcess({
    program: bash,
    args: ["--noprofile", "--norc", "-c", "/usr/bin/sleep 30 & child=$!; /usr/bin/sleep 0.2; /usr/bin/ps -p \"$child\"; wait \"$child\""],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    hostPath: nativeHost,
    // Coordinate even this direct process test with Runtime-driven Shell tests.
    shellNamespace: shellNamespaceIdentity(bash),
    // Other integration files may hold the same installation lock before this starts.
    timeoutMs: 30000,
    cancelGraceMs: 1000,
    maxOutputBytes: 4096,
    signal: controller.signal,
    onOutput(event) {
      if (event.stream !== "stdout") return;
      output += event.data.toString();
      // MSYS ps columns: PID PPID PGID WINPID TTY UID STIME COMMAND. The POSIX
      // PID is not suitable for process.kill(), especially after MSYS exec().
      const row = /^\s*\d+\s+\d+\s+\d+\s+(\d+)\s+[^\r\n]*\/usr\/bin\/sleep\s*$/m.exec(output);
      if (row) { windowsPid = Number(row[1]); controller.abort(); }
    },
  });
  assert.deepEqual(result.outcome, { kind: "cancelled" }, result.stderr.toString());
  assert.ok(windowsPid !== undefined, `Expected the sleep process Windows PID in: ${output}`);
  assert.throws(() => process.kill(windowsPid!, 0), "the MSYS descendant must be gone before completion");
});
