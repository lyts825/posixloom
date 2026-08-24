import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { RuntimeManager } from "../src/core/runtime.js";
import { PosixLoomService } from "../src/core/service.js";
import { buildNativeEnv } from "../src/core/env.js";

test("one-shot shell preserves cwd and exported env in a SessionState", { skip: !existsSync("C:\\Program Files\\Git\\usr\\bin\\bash.exe") }, async () => {
  const previous = process.env.POSIXLOOM_BASH;
  process.env.POSIXLOOM_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
  try {
    const runtime = await RuntimeManager.create(process.cwd());
    const service = new PosixLoomService(runtime);
    const sessionId = service.createSession("/workspace");
    const cd = await service.execute({ raw: "cd /workspace/tests", sessionId });
    assert.equal(cd.command.kind, "exited");
    assert.equal(cd.state.kind, "committed");
    const pwd = await service.execute({ raw: "pwd", sessionId });
    assert.equal(pwd.stdout.toString().trim(), "/workspace/tests");
    const exportResult = await service.execute({ raw: "export POSIXLOOM_INTEGRATION_OK=yes", sessionId });
    assert.equal(exportResult.state.kind, "committed");
    const print = await service.execute({ raw: "printf '%s\\n' \"$POSIXLOOM_INTEGRATION_OK\"", sessionId });
    assert.equal(print.stdout.toString().trim(), "yes");
    const state = service.sessionSnapshot(sessionId);
    assert.equal(state.exportedEnv.PATH, "/posixloom/bin:/usr/bin");
    const nativeEnv = buildNativeEnv(state, undefined, runtime.snapshot.runtimeRoot, runtime.config.dataRoot, runtime.mountTable.toHost(state.cwd));
    assert.match(nativeEnv.PATH, /native[\\/]mingit[\\/]cmd/i);
    assert.equal(nativeEnv.PATH.includes("/posixloom/bin:/usr/bin"), false);
  } finally {
    if (previous === undefined) delete process.env.POSIXLOOM_BASH;
    else process.env.POSIXLOOM_BASH = previous;
  }
});
