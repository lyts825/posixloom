import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeManager } from "../src/core/runtime.js";
import { PosixLoomService } from "../src/core/service.js";

test("argv execution does not reconstruct or reinterpret argument boundaries", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession("/workspace");
  const completion = await service.execute({ kind: "argv", argv: ["node", "-p", "process.argv.at(1)", "a b"], sessionId });
  assert.deepEqual(completion.command, { kind: "exited", exitCode: 0 });
  assert.equal(completion.stdout.toString().trim(), "a b");
});

test("workspace-guard rejects an unmounted drive cwd", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession("/workspace");
  await assert.rejects(
    service.execute({ kind: "argv", argv: ["node", "-p", "1"], cwd: "/c/Windows", sessionId }),
    (error: any) => error?.code === "POLICY_CWD_DENIED",
  );
});
