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

  await writeFile(paths.userConfigPath, JSON.stringify({ session: { maxSessions: 0 } }), "utf8");
  await assert.rejects(loadConfig(process.cwd()), (error: any) => error?.code === "CONFIG_INVALID");
});
