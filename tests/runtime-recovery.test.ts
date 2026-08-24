import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveGitBashCandidates, RuntimeManager } from "../src/core/runtime.js";

const launcher = join(process.cwd(), "native", "posixloom-host", "target", "debug", process.platform === "win32" ? "posixloom.exe" : "posixloom");

test("Git for Windows installation paths expose their bundled Bash", { skip: process.platform !== "win32" }, () => {
  assert.deepEqual(deriveGitBashCandidates([
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\tools\\unrelated\\git.exe",
  ]), [
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ]);
});

test("Native launcher reaches doctor through an invalid active pointer", { skip: !existsSync(launcher) }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-launcher-recovery-"));
  try {
    mkdirSync(join(fixture, "runtime"), { recursive: true });
    writeFileSync(join(fixture, "runtime", "current"), "../escape");
    const result = spawnSync(launcher, ["launch", "runtime", "doctor", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, POSIXLOOM_RUN_ROOT: process.cwd(), POSIXLOOM_DATA_ROOT: fixture, POSIXLOOM_NODE: process.execPath },
    });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.checks.some((check: any) => check.id === "runtime.pointer" && check.level === "FAIL"), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("RuntimeManager can enter recovery mode when the active manifest is corrupt", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-recovery-"));
  const runRoot = join(fixture, "run");
  const dataRoot = join(fixture, "data");
  const previousDataRoot = process.env.POSIXLOOM_DATA_ROOT;
  try {
    mkdirSync(join(runRoot, "config"), { recursive: true });
    mkdirSync(join(runRoot, "runtime", "versions", "runtime-corrupt"), { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    cpSync(join(process.cwd(), "config", "defaults.json"), join(runRoot, "config", "defaults.json"));
    writeFileSync(join(runRoot, "runtime", "current"), "runtime-corrupt");
    writeFileSync(join(runRoot, "runtime", "versions", "runtime-corrupt", "manifest.json"), "{ not-json");
    process.env.POSIXLOOM_DATA_ROOT = dataRoot;

    await assert.rejects(() => RuntimeManager.create(runRoot), /Unable to parse runtime manifest/);
    const recovery = await RuntimeManager.create(runRoot, { allowInvalidRuntime: true });
    assert.equal(recovery.recoveryRequired, true);
    assert.equal(recovery.snapshot.runtimeId, "runtime-corrupt");
    assert.equal(recovery.snapshot.manifest.mode, "release");
    assert.equal(recovery.doctor().ok, false);
    assert.equal(recovery.doctor().checks.some((check) => check.id === "runtime.manifest-read" && check.level === "FAIL"), true);
  } finally {
    if (previousDataRoot === undefined) delete process.env.POSIXLOOM_DATA_ROOT;
    else process.env.POSIXLOOM_DATA_ROOT = previousDataRoot;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("RuntimeManager recovery ignores an invalid DataRoot pointer but reports it", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-pointer-recovery-"));
  const runRoot = join(fixture, "run");
  const dataRoot = join(fixture, "data");
  const previousDataRoot = process.env.POSIXLOOM_DATA_ROOT;
  try {
    mkdirSync(join(runRoot, "config"), { recursive: true });
    mkdirSync(join(runRoot, "runtime", "versions", "runtime-dev"), { recursive: true });
    mkdirSync(join(dataRoot, "runtime"), { recursive: true });
    cpSync(join(process.cwd(), "config", "defaults.json"), join(runRoot, "config", "defaults.json"));
    cpSync(join(process.cwd(), "runtime", "versions", "runtime-dev", "manifest.json"), join(runRoot, "runtime", "versions", "runtime-dev", "manifest.json"));
    writeFileSync(join(runRoot, "runtime", "current"), "runtime-dev");
    writeFileSync(join(dataRoot, "runtime", "current"), "../escape");
    process.env.POSIXLOOM_DATA_ROOT = dataRoot;

    await assert.rejects(() => RuntimeManager.create(runRoot), /Invalid runtime id in pointer/);
    const recovery = await RuntimeManager.create(runRoot, { allowInvalidRuntime: true });
    assert.equal(recovery.recoveryRequired, true);
    assert.equal(recovery.snapshot.runtimeId, "runtime-dev");
    assert.equal(recovery.snapshot.source, "development");
    assert.equal(recovery.config.runtimePointerIssues.length, 1);
    assert.equal(recovery.doctor().checks.some((check) => check.id === "runtime.pointer" && check.level === "FAIL"), true);
  } finally {
    if (previousDataRoot === undefined) delete process.env.POSIXLOOM_DATA_ROOT;
    else process.env.POSIXLOOM_DATA_ROOT = previousDataRoot;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("RuntimeManager rejects a development-mode manifest selected as an installed Runtime", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-mode-recovery-"));
  const runRoot = join(fixture, "run");
  const dataRoot = join(fixture, "data");
  const previousDataRoot = process.env.POSIXLOOM_DATA_ROOT;
  try {
    mkdirSync(join(runRoot, "config"), { recursive: true });
    mkdirSync(join(runRoot, "runtime"), { recursive: true });
    mkdirSync(join(dataRoot, "runtime", "versions", "runtime-installed"), { recursive: true });
    cpSync(join(process.cwd(), "config", "defaults.json"), join(runRoot, "config", "defaults.json"));
    writeFileSync(join(runRoot, "runtime", "current"), "runtime-dev");
    writeFileSync(join(dataRoot, "runtime", "current"), "runtime-installed");
    writeFileSync(join(dataRoot, "runtime", "versions", "runtime-installed", "manifest.json"), JSON.stringify({
      manifestVersion: 1,
      runtimeId: "runtime-installed",
      runtimeSemver: "1.0.0",
      mode: "development",
      required: [],
    }));
    process.env.POSIXLOOM_DATA_ROOT = dataRoot;

    await assert.rejects(
      () => RuntimeManager.create(runRoot),
      (error: any) => error?.code === "RUNTIME_MODE_MISMATCH",
    );
    const recovery = await RuntimeManager.create(runRoot, { allowInvalidRuntime: true });
    assert.equal(recovery.recoveryRequired, true);
    assert.equal(recovery.doctor().checks.some((check) => check.id === "runtime.selection-mode" && check.level === "FAIL"), true);
  } finally {
    if (previousDataRoot === undefined) delete process.env.POSIXLOOM_DATA_ROOT;
    else process.env.POSIXLOOM_DATA_ROOT = previousDataRoot;
    rmSync(fixture, { recursive: true, force: true });
  }
});
