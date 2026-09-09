import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { RuntimeManager } from "../../src/core/runtime.js";
import type { RuntimePlugin } from "../../src/plugins/kernel.js";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export async function runtimeFixture(context: TestContext, overrides: Record<string, unknown> = {}, plugins: RuntimePlugin[] = []): Promise<{ runtime: RuntimeManager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "posixloom-runtime-test-"));
  let runtime: RuntimeManager | undefined;
  context.after(async () => { await runtime?.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "config"));
  const hostName = process.platform === "win32" ? "posixloom.exe" : "posixloom";
  const host = ["debug", "release"].map((mode) => join(process.cwd(), "native", "posixloom-host", "target", mode, hostName)).find(existsSync);
  if (host) await copyFile(host, join(root, hostName));
  const defaults = JSON.parse(await readFile(join(process.cwd(), "config", "defaults.json"), "utf8"));
  await writeFile(join(root, "config", "defaults.json"), JSON.stringify({ ...defaults, runtime: { workspace: root }, updates: { ...defaults.updates, enabled: false }, ...overrides }));
  const previous = process.env.POSIXLOOM_DATA_ROOT;
  try {
    process.env.POSIXLOOM_DATA_ROOT = join(root, "data");
    runtime = await RuntimeManager.create(root, { plugins });
  } finally {
    if (previous === undefined) delete process.env.POSIXLOOM_DATA_ROOT; else process.env.POSIXLOOM_DATA_ROOT = previous;
  }
  return { runtime, root };
}
