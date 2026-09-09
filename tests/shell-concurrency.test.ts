import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PosixLoomService } from "../src/core/service.js";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

async function pair(context: TestContext) {
  const one = await runtimeFixture(context), two = await runtimeFixture(context);
  if (!one.runtime.findBash() || !two.runtime.findBash()) { context.skip("MSYS Bash unavailable"); return; }
  assert.ok(one.runtime.findNativeHost(), "Windows Shell integration fixtures must include Native Host");
  assert.ok(two.runtime.findNativeHost(), "Windows Shell integration fixtures must include Native Host");
  assert.equal(one.runtime.findBash(), two.runtime.findBash());
  for (const [label, item] of [["A", one], ["B", two]] as const) {
    await mkdir(join(item.root, "tests"));
    await writeFile(join(item.root, "marker.txt"), label);
    await writeFile(join(item.runtime.config.dataRoot, "tmp", "marker.txt"), label);
  }
  const a = new PosixLoomService(one.runtime), b = new PosixLoomService(two.runtime);
  return { one, two, a, b, sessionA: a.createSession("/workspace/tests"), sessionB: b.createSession("/workspace/tests") };
}

function startHolder(service: PosixLoomService, sessionId: string, raw: string) {
  let ready!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  let output = "";
  const completion = service.execute({ sessionId, statePolicy: "isolated", raw: `builtin printf 'HOLDER_READY\\n'; ${raw}` }, {
    onOutput(event) {
      if (event.stream === "stdout") { output += event.data.toString(); if (output.includes("HOLDER_READY\n")) ready(); }
    },
  });
  void completion.then((result) => {
    if (!output.includes("HOLDER_READY\n")) rejectReady(new Error(`Holder failed before readiness: ${JSON.stringify(result.command)} ${result.stderr}`));
  }, rejectReady);
  return { started, completion };
}

test("Windows Shell runtimes sharing MSYS keep workspace and temporary mounts isolated", { skip: process.platform !== "win32" }, async (context) => {
  const fixture = await pair(context);
  if (!fixture) return;
  const { a, b, sessionA, sessionB } = fixture;
  const holder = startHolder(a, sessionA, "/usr/bin/cat /workspace/marker.txt; /usr/bin/sleep 0.4; /usr/bin/cat /workspace/marker.txt; /usr/bin/cat /tmp/marker.txt; builtin pwd -P");
  await holder.started;
  const other = b.execute({ sessionId: sessionB, statePolicy: "isolated", raw: "/usr/bin/cat /workspace/marker.txt; /usr/bin/cat /tmp/marker.txt; builtin pwd -P" });
  const [first, second] = await Promise.all([holder.completion, other]);
  assert.deepEqual(first.command, { kind: "exited", exitCode: 0 }, first.stderr.toString());
  assert.deepEqual(second.command, { kind: "exited", exitCode: 0 }, second.stderr.toString());
  assert.equal(first.stdout.toString(), "HOLDER_READY\nAAA/workspace/tests\n");
  assert.equal(second.stdout.toString(), "BB/workspace/tests\n");
});

for (const mode of ["cancel", "timeout"] as const) {
  test(`Windows Shell ${mode} while waiting for another Runtime never starts the waiting command`, { skip: process.platform !== "win32" }, async (context) => {
    const fixture = await pair(context);
    if (!fixture) return;
    const { one, two, a, b, sessionA, sessionB } = fixture;
    const holder = startHolder(a, sessionA, "/usr/bin/sleep 1.2; /usr/bin/cat /workspace/marker.txt");
    await holder.started;
    const controller = new AbortController();
    const waiting = b.execute({ sessionId: sessionB, statePolicy: "isolated", raw: "builtin printf started > /workspace/started.txt", timeoutMs: mode === "timeout" ? 250 : 5000, signal: controller.signal });
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 250) : undefined;
    try {
      const blocked = await waiting;
      assert.deepEqual(blocked.command, { kind: mode === "cancel" ? "cancelled" : "timed-out" });
      assert.equal(blocked.stdout.length, 0);
      assert.equal(blocked.state.kind, "not-produced");
      const original = await holder.completion;
      assert.deepEqual(original.command, { kind: "exited", exitCode: 0 }, original.stderr.toString());
      assert.equal(original.stdout.toString(), "HOLDER_READY\nA");
      assert.equal(existsSync(join(one.root, "started.txt")), false);
      assert.equal(existsSync(join(two.root, "started.txt")), false);
    } finally {
      if (timer) clearTimeout(timer);
      await holder.completion;
    }
  });
}

test("Windows Shell normal completion removes background MSYS descendants before releasing mounts", { skip: process.platform !== "win32" }, async (context) => {
  const fixture = await pair(context);
  if (!fixture) return;
  const { one, two, a, b, sessionA, sessionB } = fixture;
  const first = await a.execute({ sessionId: sessionA, statePolicy: "isolated", raw: "(/usr/bin/sleep 0.5; builtin printf leaked > /workspace/leaked.txt) & builtin printf completed" });
  assert.deepEqual(first.command, { kind: "exited", exitCode: 0 }, first.stderr.toString());
  assert.equal(first.stdout.toString(), "completed");
  const second = await b.execute({ sessionId: sessionB, statePolicy: "isolated", raw: "/usr/bin/sleep 0.8; /usr/bin/cat /workspace/marker.txt; /usr/bin/cat /tmp/marker.txt" });
  assert.deepEqual(second.command, { kind: "exited", exitCode: 0 }, second.stderr.toString());
  assert.equal(second.stdout.toString(), "BB");
  assert.equal(existsSync(join(one.root, "leaked.txt")), false);
  assert.equal(existsSync(join(two.root, "leaked.txt")), false);
});
