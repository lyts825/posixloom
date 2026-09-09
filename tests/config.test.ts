import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveConfigPaths } from "../src/core/config.js";

test("config paths remain discoverable and reject the unimplemented persistence switch", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "posixloom-config-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const previous = process.env.POSIXLOOM_DATA_ROOT;
  process.env.POSIXLOOM_DATA_ROOT = dataRoot;
  context.after(() => {
    if (previous === undefined) delete process.env.POSIXLOOM_DATA_ROOT;
    else process.env.POSIXLOOM_DATA_ROOT = previous;
  });

  const paths = await resolveConfigPaths(process.cwd());
  assert.equal(paths.userConfigPath, join(dataRoot, "config", "config.json"));
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await writeFile(paths.userConfigPath, JSON.stringify({ session: { persistAcrossRestart: true } }), "utf8");
  await assert.rejects(loadConfig(process.cwd()), (error: any) => error?.code === "CONFIG_UNSUPPORTED");

  await writeFile(paths.userConfigPath, JSON.stringify({ session: { persistAcrossRestart: false } }), "utf8");
  const loaded = await loadConfig(process.cwd());
  assert.equal("persistAcrossRestart" in loaded.runtime.session, false);
  assert.equal(loaded.runtime.session.maxSessions, 1024);
  assert.equal(loaded.runtime.session.idleTimeoutMs, 1_800_000);
  assert.equal(loaded.runtime.process.outputDrainTimeoutMs, 5000);
  assert.equal(loaded.runtime.process.maxReportBytes, 1024 * 1024);
  assert.equal(loaded.runtime.process.maxConcurrent, 8);
  assert.equal(loaded.runtime.protocol.replayWindowSize, 10000);
  assert.equal(loaded.runtime.observability.traceMaxPendingBytes, 1024 * 1024);
  for (const invalid of [
    { process: { maxConcurrent: 0 } }, { process: { maxQueued: -1 } }, { process: { queueTimeoutMs: 2147483648 } },
    { protocol: { maxPendingRequests: 0 } }, { protocol: { idempotencyTtlMs: 0 } }, { protocol: { replayWindowSize: 0 } },
    { observability: { traceMaxFileBytes: 0 } }, { observability: { traceRetainedFiles: -1 } }, { observability: { collectCommandNames: "false" } },
  ]) {
    await writeFile(paths.userConfigPath, JSON.stringify(invalid), "utf8");
    await assert.rejects(loadConfig(process.cwd()), (error: any) => error.code === "CONFIG_INVALID");
  }
  await writeFile(paths.userConfigPath, JSON.stringify({ process: { cancelGraceMs: 0, maxQueued: 0 }, observability: { traceRetainedFiles: 0, traceBufferSize: 0 } }), "utf8");
  assert.equal((await loadConfig(process.cwd())).runtime.process.cancelGraceMs, 0);

  await writeFile(paths.userConfigPath, JSON.stringify({ session: { maxSessions: 0 } }), "utf8");
  await assert.rejects(loadConfig(process.cwd()), (error: any) => error?.code === "CONFIG_INVALID");
});
