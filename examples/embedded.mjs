import { PosixLoomService, RuntimeManager } from "posixloom-runtime";
import { resolve } from "node:path";

const runRoot = process.argv[2];
if (!runRoot) throw new Error("Usage: node embedded.mjs <installed-runtime-or-repository-root>");

// The SDK orchestrates an existing runtime; it does not bundle third-party tools.
const runtime = await RuntimeManager.create(resolve(runRoot));
try {
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession();
  const result = await service.execute({
    sessionId,
    kind: "argv",
    argv: ["node", "-p", "'hello from PosixLoom'"],
    statePolicy: "isolated",
    timeoutMs: 10_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.command.kind === "exited") process.exitCode = result.command.exitCode;
  else throw new Error(`Command did not exit normally: ${JSON.stringify(result.command)}`);
} finally {
  await runtime.close();
}
