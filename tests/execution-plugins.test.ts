import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeManager } from "../src/core/runtime.js";
import { PosixLoomService } from "../src/core/service.js";
import { COMMAND_CLASSIFIERS, EXECUTION_BACKENDS, EXECUTION_HOOKS, NATIVE_COMMAND_ADAPTERS, NATIVE_COMMANDS } from "../src/plugins/contracts.js";
import type { RuntimePlugin } from "../src/plugins/kernel.js";

test("custom plugins can extend classification, backend execution, and lifecycle hooks", async () => {
  const events: string[] = [];
  const output = Buffer.from("hello from plugin\n");
  const extension: RuntimePlugin = {
    manifest: {
      id: "test.virtual-command",
      version: "1.0.0",
      description: "A virtual command used to prove the full plugin pipeline",
      requires: ["core.native-toolchain"],
      provides: [COMMAND_CLASSIFIERS.id, EXECUTION_BACKENDS.id, EXECUTION_HOOKS.id],
    },
    activate(context) {
      context.provide(COMMAND_CLASSIFIERS, {
        id: "test.virtual-classifier",
        classify({ input }) {
          if (input.kind !== "text" || input.raw !== "virtual:hello") return undefined;
          return { kind: "simple", argv: ["node", "--version"], reason: "virtual command supplied by plugin" };
        },
      }, { priority: 10_000 });
      context.provide(EXECUTION_BACKENDS, {
        id: "test.virtual-native-backend",
        mode: "native",
        async execute() {
          events.push("backend");
          return {
            outcome: { kind: "exited", exitCode: 0 },
            stdout: output,
            stderr: Buffer.alloc(0),
            report: Buffer.alloc(0),
            stdoutBytes: output.length,
            stderrBytes: 0,
            truncated: false,
            processMode: "node-fallback",
          };
        },
      }, { priority: 10_000 });
      context.provide(EXECUTION_HOOKS, {
        id: "test.audit-hook",
        beforePrepare: () => { events.push("before"); },
        afterPrepare: () => { events.push("planned"); },
        afterExecute: () => { events.push("executed"); },
      });
    },
  };

  const runtime = await RuntimeManager.create(process.cwd(), { plugins: [extension] });
  const service = new PosixLoomService(runtime);
  const sessionId = service.createSession();
  const preview = await service.explain({ raw: "virtual:hello", sessionId });
  assert.equal(preview.mode, "native");
  assert.match(preview.reason, /native registry hit: node/);

  const completion = await service.execute({ raw: "virtual:hello", sessionId });
  assert.equal(completion.stdout.toString(), "hello from plugin\n");
  assert.deepEqual(events, ["before", "planned", "before", "planned", "backend", "executed"]);
  assert.equal(runtime.plugins.inspect().find((plugin) => plugin.id === "test.virtual-command")?.state, "active");
});

test("native command descriptors and argv adapters are plugin contributions", async () => {
  const nativeTool: RuntimePlugin = {
    manifest: {
      id: "test.native-tool",
      version: "2.0.0",
      description: "A native command and adapter supplied outside core",
      provides: [NATIVE_COMMANDS.id, NATIVE_COMMAND_ADAPTERS.id],
    },
    activate(context) {
      context.provide(NATIVE_COMMAND_ADAPTERS, {
        id: "test-passthrough-v1",
        adapt(argv) { return { argv: [...argv], decisions: [] }; },
      });
      context.provide(NATIVE_COMMANDS, {
        name: "plugin-node",
        executable: process.execPath,
        adapterId: "test-passthrough-v1",
        shellEquivalent: true,
      });
    },
  };

  const baseline = await RuntimeManager.create(process.cwd());
  const extended = await RuntimeManager.create(process.cwd(), { plugins: [nativeTool] });
  assert.notEqual(extended.snapshot.pluginsHash, baseline.snapshot.pluginsHash);
  assert.notEqual(extended.snapshot.snapshotId, baseline.snapshot.snapshotId);
  assert.equal(extended.info().nativeCommands.includes("plugin-node"), true);

  const service = new PosixLoomService(extended);
  const sessionId = service.createSession();
  const preview = await service.explain({ kind: "argv", argv: ["plugin-node", "--version"], sessionId });
  assert.equal(preview.mode, "native");
  assert.equal(preview.executable, process.execPath);
  assert.match(preview.reason, /plugin-node/);
});
