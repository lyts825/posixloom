import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { RuntimeManager } from "../src/core/runtime.js";
import { PosixLoomService } from "../src/core/service.js";
import { buildNativeEnv } from "../src/core/env.js";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

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
    assert.equal(pwd.stdout.toString().trim(), "/workspace/tests", pwd.stderr.toString());
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

test("Shell bootstraps /tmp in a fresh temporary-drive workspace before POSIX exports", async (context) => {
  const { runtime } = await runtimeFixture(context);
  if (!runtime.findBash()) { context.skip("Bash is unavailable"); return; }
  const service = new PosixLoomService(runtime);
  const completion = await service.execute({ sessionId: service.createSession(), raw: "test -d /tmp && printf '%s|%s' \"$TMP\" \"$TMPDIR\"" });
  assert.deepEqual(completion.command, { kind: "exited", exitCode: 0 }, completion.stderr.toString());
  assert.equal(completion.stdout.toString(), "/tmp|/tmp");
  assert.equal(completion.state.kind, "committed", inspect(completion.state));
});

test("Windows Shell keeps physical cwd and temporary mounts virtual through a directory alias", { skip: process.platform !== "win32" }, async (context) => {
  const outer = await runtimeFixture(context);
  if (!outer.runtime.findBash()) { context.skip("Bash is unavailable"); return; }
  const physical = join(outer.root, "physical temporary directory"), alias = join(outer.root, "temporary alias");
  await mkdir(physical);
  // Junctions exercise the same physical/lexical mismatch as NTFS 8.3 TEMP
  // paths, even on volumes where short-name generation has been disabled.
  await symlink(physical, alias, "junction");
  const previousTmp = process.env.TMP, previousTemp = process.env.TEMP;
  let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
  try {
    process.env.TMP = alias;
    process.env.TEMP = alias;
    fixture = await runtimeFixture(context);
  } finally {
    if (previousTmp === undefined) delete process.env.TMP; else process.env.TMP = previousTmp;
    if (previousTemp === undefined) delete process.env.TEMP; else process.env.TEMP = previousTemp;
  }
  try {
    assert.ok(fixture.root.startsWith(alias));
    await mkdir(join(fixture.root, "tests"));
    await writeFile(join(fixture.runtime.config.dataRoot, "tmp", "marker.txt"), "temporary mount\n");
    const service = new PosixLoomService(fixture.runtime), sessionId = service.createSession();
    const completion = await service.execute({ sessionId, raw: "cd /workspace/tests && /usr/bin/cat /tmp/marker.txt && builtin pwd -P && printf '%s|%s' \"$TMP\" \"$TMPDIR\"" });
    assert.deepEqual(completion.command, { kind: "exited", exitCode: 0 }, completion.stderr.toString());
    assert.equal(completion.stdout.toString(), "temporary mount\n/workspace/tests\n/tmp|/tmp");
    assert.equal(completion.state.kind, "committed", inspect(completion.state));
    assert.equal(service.sessionSnapshot(sessionId).cwd, "/workspace/tests");
  } finally {
    // The outer fixture's cleanup hook removes this nested directory first.
    await fixture.runtime.close();
  }
});
