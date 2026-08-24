import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionPoint, PluginKernel, type RuntimePlugin } from "../src/plugins/kernel.js";

const TEXT = createExtensionPoint<string>("test.text", "test values");

function definition(
  id: string,
  options: {
    requires?: string[];
    provides?: string[];
    activate?: RuntimePlugin["activate"];
    deactivate?: RuntimePlugin["deactivate"];
  } = {},
): RuntimePlugin {
  return {
    manifest: {
      id,
      version: "1.0.0",
      description: `Test plugin ${id}`,
      requires: options.requires,
      provides: options.provides ?? [],
    },
    activate: options.activate ?? (() => undefined),
    deactivate: options.deactivate,
  };
}

test("plugin kernel orders dependencies and contributions deterministically", async () => {
  const events: string[] = [];
  const base = definition("test.base", {
    provides: [TEXT.id],
    activate(context) {
      events.push("activate:base");
      context.provide(TEXT, "base", { priority: 1 });
      context.defer(() => { events.push("cleanup:base"); });
    },
    deactivate: () => { events.push("deactivate:base"); },
  });
  const feature = definition("test.feature", {
    requires: ["test.base"],
    provides: [TEXT.id],
    activate(context) {
      events.push(`activate:feature:${context.extension(TEXT)}`);
      context.provide(TEXT, "feature", { priority: 10 });
      context.defer(() => { events.push("cleanup:feature"); });
    },
    deactivate: () => { events.push("deactivate:feature"); },
  });

  // Register dependent first to prove dependency order is graph-driven, not array-driven.
  const kernel = new PluginKernel([feature, base]);
  await Promise.all([kernel.start(), kernel.start()]);
  assert.deepEqual(kernel.extensions(TEXT), ["feature", "base"]);
  assert.deepEqual(events, ["activate:base", "activate:feature:base"]);
  assert.equal(kernel.inspect().every((plugin) => plugin.state === "active"), true);

  await Promise.all([kernel.stop(), kernel.stop()]);
  assert.deepEqual(events, [
    "activate:base",
    "activate:feature:base",
    "deactivate:feature",
    "cleanup:feature",
    "deactivate:base",
    "cleanup:base",
  ]);
});

test("plugin activation is transactional and rolls back partial contributions", async () => {
  const events: string[] = [];
  const kernel = new PluginKernel([
    definition("test.base", {
      provides: [TEXT.id],
      activate(context) {
        context.provide(TEXT, "base");
        context.defer(() => { events.push("cleanup:base"); });
      },
    }),
    definition("test.broken", {
      requires: ["test.base"],
      provides: [TEXT.id],
      activate(context) {
        context.provide(TEXT, "partial");
        context.defer(() => { events.push("cleanup:broken"); });
        throw new Error("boom");
      },
    }),
  ]);

  await assert.rejects(kernel.start(), /boom/);
  assert.equal(kernel.state, "failed");
  assert.deepEqual(events, ["cleanup:broken", "cleanup:base"]);
  assert.throws(() => kernel.extensions(TEXT), (error: any) => error?.code === "PLUGIN_KERNEL_NOT_READY");
  assert.deepEqual(kernel.inspect().map(({ id, state }) => [id, state]), [
    ["test.base", "stopped"],
    ["test.broken", "failed"],
  ]);
});

test("plugin kernel rejects missing and cyclic dependencies before activation", async () => {
  const missing = new PluginKernel([definition("test.consumer", { requires: ["test.absent"] })]);
  await assert.rejects(missing.start(), (error: any) => error?.code === "PLUGIN_DEPENDENCY_MISSING");

  const cyclic = new PluginKernel([
    definition("test.left", { requires: ["test.right"] }),
    definition("test.right", { requires: ["test.left"] }),
  ]);
  await assert.rejects(cyclic.start(), (error: any) => error?.code === "PLUGIN_DEPENDENCY_CYCLE");
});

test("plugins may only contribute declared capabilities", async () => {
  const kernel = new PluginKernel([definition("test.undeclared", {
    activate(context) { context.provide(TEXT, "nope"); },
  })]);
  await assert.rejects(kernel.start(), (error: any) => error?.code === "PLUGIN_CAPABILITY_UNDECLARED");
});

test("a retained activation context cannot mutate the running capability graph", async () => {
  let retained: Parameters<RuntimePlugin["activate"]>[0] | undefined;
  const kernel = new PluginKernel([definition("test.retained", {
    provides: [TEXT.id],
    activate(context) {
      retained = context;
      context.provide(TEXT, "stable");
    },
  })]);
  await kernel.start();
  assert.deepEqual(kernel.extensions(TEXT), ["stable"]);
  assert.throws(() => retained!.provide(TEXT, "late"), (error: any) => error?.code === "PLUGIN_CONTEXT_CLOSED");
  assert.deepEqual(kernel.extensions(TEXT), ["stable"]);
});
