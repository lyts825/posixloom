import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertControlChild } from "./helpers/control-child.js";

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function singleFileTree(relative: string, contents: Buffer): { rootTreeSha256: string; entrypointSha256: string } {
  const entrypointSha256 = sha256(contents);
  return { entrypointSha256, rootTreeSha256: sha256(`${relative}\0${entrypointSha256}\n`) };
}

const releaseHost = join(process.cwd(), "native", "posixloom-host", "target", "release", "posixloom.exe");

test("release packaging is self-consistent and launcher verifies application hashes", { skip: process.platform !== "win32" || !existsSync(releaseHost) }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-packaging-"));
  try {
    const nodeRoot = join(fixture, "node source");
    const msysRoot = join(fixture, "msys source");
    const gitRoot = join(fixture, "git source");
    const rgPath = join(fixture, "rg.exe");
    const licensesRoot = join(fixture, "licenses");
    const lockPath = join(fixture, "components.lock.json");
    const output = join(fixture, "发布 包");
    const nodeBytes = readFileSync(process.execPath);
    const msysBytes = Buffer.from("fixture-msys-bash");
    const gitBytes = Buffer.from("fixture-mingit");
    const rgBytes = Buffer.from("fixture-ripgrep");
    mkdirSync(nodeRoot, { recursive: true });
    mkdirSync(join(msysRoot, "usr", "bin"), { recursive: true });
    mkdirSync(join(gitRoot, "cmd"), { recursive: true });
    mkdirSync(licensesRoot, { recursive: true });
    writeFileSync(join(nodeRoot, "node.exe"), nodeBytes);
    writeFileSync(join(msysRoot, "usr", "bin", "bash.exe"), msysBytes);
    writeFileSync(join(gitRoot, "cmd", "git.exe"), gitBytes);
    writeFileSync(rgPath, rgBytes);
    writeFileSync(join(licensesRoot, "NOTICE.txt"), "fixture licenses");
    const nodeHashes = singleFileTree("node.exe", nodeBytes);
    const msysHashes = singleFileTree("usr/bin/bash.exe", msysBytes);
    const gitHashes = singleFileTree("cmd/git.exe", gitBytes);
    writeFileSync(lockPath, JSON.stringify({
      lockVersion: 1,
      platform: "win32-x64",
      components: {
        node: { version: process.version, entrypoint: "node.exe", ...nodeHashes },
        msys2: { version: "fixture", entrypoint: "usr/bin/bash.exe", ...msysHashes },
        mingit: { version: "fixture", entrypoint: "cmd/git.exe", ...gitHashes },
        ripgrep: { version: "fixture", entrypoint: "rg.exe", sha256: sha256(rgBytes) },
      },
    }, null, 2));
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const buildArgs = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "packaging", "build-runtime.ps1"),
      "-Mode", "release",
      "-RuntimeId", "runtime-9.9.9-fixture",
      "-RuntimeSemver", "9.9.9",
      "-UpdateSequence", "42",
      "-NodeRoot", nodeRoot,
      "-MsysRoot", msysRoot,
      "-MinGitRoot", gitRoot,
      "-RipgrepExe", rgPath,
      "-LicensesRoot", licensesRoot,
      "-ComponentLock", lockPath,
      "-Output", output,
      "-SourceDateEpoch", "1700000000",
    ];
    const built = spawnSync(powershell, buildArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    assert.equal(existsSync(join(fixture, "runtime-9.9.9-fixture.runtime.zip")), true);
    assert.equal(existsSync(`${output}.zip`), true);
    const overlappingArgs = [...buildArgs];
    overlappingArgs[overlappingArgs.indexOf("-Output") + 1] = nodeRoot;
    const overlapping = spawnSync(powershell, overlappingArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.notEqual(overlapping.status, 0);
    assert.match(`${overlapping.stdout}\n${overlapping.stderr}`, /overlaps a package output target/i);
    assert.equal(existsSync(join(nodeRoot, "node.exe")), true);
    const shortFixture = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-Command",
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${fixture.replaceAll("'", "''")}').ShortPath`,
    ], { encoding: "utf8" });
    assert.equal(shortFixture.status, 0, shortFixture.stderr);
    // Hosted Windows runners can expose TEMP through an 8.3 profile alias.
    // Keep the Unicode leaf to cover mixed short and long path segments.
    for (const packageRoot of new Set([output, join(shortFixture.stdout.trim(), "发布 包")])) {
      const verified = spawnSync(powershell, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "packaging", "verify-runtime.ps1"),
        "-PackageRoot", packageRoot,
      ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    }
    assert.equal(existsSync(join(output, "dist", "tests")), false);
    const launcher = join(output, "posixloom.exe");
    const env = { ...process.env, POSIXLOOM_RUN_ROOT: output, POSIXLOOM_DATA_ROOT: join(fixture, "consumer data"), POSIXLOOM_UPDATE_FEED_URL: "" };
    for (const args of [["version"], ["launch", "version"]]) {
      const version = spawnSync(launcher, args, { cwd: fixture, env, encoding: "utf8", windowsHide: true, timeout: 15_000 });
      assert.equal(version.status, 0, version.stderr);
      assert.match(version.stdout, /PosixLoom Runtime/);
    }
    await assertControlChild(launcher, ["serve", "--stdio"], { cwd: fixture, env });
    for (const helper of ["state-report.sh", "extract-runtime.ps1"]) {
      const path = join(output, "dist", "src", "core", "assets", helper);
      const original = readFileSync(path);
      assert.deepEqual(original, readFileSync(join(process.cwd(), "src", "core", "assets", helper)));
      assert.equal(original.includes(Buffer.from("\r")), false);
      writeFileSync(path, Buffer.concat([original, Buffer.from("\n# tampered asset\n")]));
      const refused = spawnSync(join(output, "posixloom.exe"), ["version"], { encoding: "utf8" });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /SHA-256 mismatch/);
      writeFileSync(path, original);
    }
    const manifest = JSON.parse(readFileSync(join(output, "runtime", "versions", "runtime-9.9.9-fixture", "manifest.json"), "utf8"));
    assert.equal(manifest.required.includes("shims"), true);
    assert.equal(manifest.updateSequence, 42);
    assert.equal(manifest.sourceLock, "components.lock.json");
    assert.deepEqual(JSON.parse(readFileSync(join(output, "runtime", "versions", "runtime-9.9.9-fixture", "components.lock.json"), "utf8")), JSON.parse(readFileSync(lockPath, "utf8")));
    assert.match(manifest.sourceLockSha256, /^[a-f0-9]{64}$/);

    const runtimeModule = join(output, "dist", "src", "core", "runtime.js");
    const runtimeModuleBytes = readFileSync(runtimeModule);
    writeFileSync(runtimeModule, Buffer.concat([runtimeModuleBytes, Buffer.from("\n// tampered module\n")]));
    const moduleLaunch = spawnSync(join(output, "posixloom.exe"), ["version"], { encoding: "utf8" });
    assert.notEqual(moduleLaunch.status, 0);
    assert.match(moduleLaunch.stderr, /SHA-256 mismatch/);
    writeFileSync(runtimeModule, runtimeModuleBytes);

    const controller = join(output, "dist", "src", "cli", "main.js");
    writeFileSync(controller, `${readFileSync(controller, "utf8")}\n// tampered\n`);
    const launched = spawnSync(join(output, "posixloom.exe"), ["launch", "version"], { encoding: "utf8" });
    assert.notEqual(launched.status, 0);
    assert.match(launched.stderr, /SHA-256 mismatch/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
