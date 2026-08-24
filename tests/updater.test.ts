import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeManager } from "../src/core/runtime.js";
import { canonicalJson, compareRuntimeRelease, compareSemver, resolveUpdateResource, RuntimeUpdater, verifyUpdateFeed, type RuntimeUpdateFeed } from "../src/core/updater.js";
import type { RuntimeComponentManifest, RuntimeManifest } from "../src/core/types.js";

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function treeSha256(entries: Array<[string, Buffer]>): string {
  return sha256(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, contents]) => `${name}\0${sha256(contents)}\n`).join(""));
}

test("update feed signatures cover canonical signed metadata", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const feed: RuntimeUpdateFeed = {
    feedVersion: 1,
    signed: { channel: "stable", generatedAt: new Date(0).toISOString(), runtimes: [] },
    signatures: [],
  };
  feed.signatures.push({
    keyId: "test",
    algorithm: "ed25519",
    value: sign(null, Buffer.from(canonicalJson(feed.signed)), privateKey).toString("base64"),
  });
  const keys = { test: publicKey.export({ format: "pem", type: "spki" }).toString() };
  assert.doesNotThrow(() => verifyUpdateFeed(feed, "stable", true, keys));
  feed.signed.channel = "modified";
  assert.throws(() => verifyUpdateFeed(feed, "modified", true, keys), /valid signature/);
});

test("update feed rejects malformed Runtime release records", () => {
  const feed = {
    feedVersion: 1,
    signed: { channel: "stable", generatedAt: new Date(0).toISOString(), runtimes: [{ runtimeId: "../../escape" }] },
    signatures: [],
  } as unknown as RuntimeUpdateFeed;
  assert.throws(() => verifyUpdateFeed(feed, "stable", false, {}), /invalid Runtime release/);
});

test("update feed rejects malformed signatures with structured errors", () => {
  const feed = {
    feedVersion: 1,
    signed: { channel: "stable", generatedAt: new Date(0).toISOString(), runtimes: [] },
    signatures: [null],
  } as unknown as RuntimeUpdateFeed;
  assert.throws(() => verifyUpdateFeed(feed, "stable", true, {}), /no valid signature/);
  assert.throws(() => verifyUpdateFeed(null as unknown as RuntimeUpdateFeed, "stable", false, {}), /schema is invalid/);
});

test("semantic version comparison keeps stable releases above prereleases", () => {
  assert.equal(compareSemver("1.2.0", "1.1.9") > 0, true);
  assert.equal(compareSemver("1.2.0", "1.2.0-rc.1") > 0, true);
  assert.equal(compareSemver("1.2.0-rc.2", "1.2.0-rc.1") > 0, true);
});

test("Runtime update sequence orders environment rebuilds within one core version", () => {
  assert.equal(compareRuntimeRelease({ runtimeSemver: "1.2.3", updateSequence: 11 }, { runtimeSemver: "1.2.3", updateSequence: 10 }) > 0, true);
  assert.equal(compareRuntimeRelease({ runtimeSemver: "1.2.4", updateSequence: 1 }, { runtimeSemver: "1.2.3", updateSequence: 999 }) > 0, true);
  assert.equal(compareRuntimeRelease({ runtimeSemver: "1.2.3" }, { runtimeSemver: "1.2.3", updateSequence: 1 }) < 0, true);
});

test("relative update archives resolve beside a Windows local feed", { skip: process.platform !== "win32" }, () => {
  assert.equal(resolveUpdateResource("D:\\updates\\stable\\feed.json", "runtime.zip"), "D:\\updates\\stable\\runtime.zip");
  assert.equal(resolveUpdateResource("https://updates.example.test/stable/feed.json", "runtime.zip"), "https://updates.example.test/stable/runtime.zip");
});

test("release Runtime update checks cannot disable signature verification", async () => {
  const runtime = await RuntimeManager.create(process.cwd());
  runtime.snapshot.manifest.mode = "release";
  runtime.config.runtime.updates.feedUrl = "unused.json";
  runtime.config.runtime.updates.requireSignature = false;
  await assert.rejects(
    () => new RuntimeUpdater(runtime).check({ force: true }),
    (error: any) => error?.code === "UPDATE_SIGNATURE_REQUIRED",
  );
  runtime.snapshot.manifest.mode = "development";
  (runtime.snapshot as any).source = "data";
  await assert.rejects(
    () => new RuntimeUpdater(runtime).check({ force: true }),
    (error: any) => error?.code === "UPDATE_SIGNATURE_REQUIRED",
  );
});

test("Runtime selection restores the prior pointer when update state commit fails", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-update-transaction-"));
  const dataRoot = join(fixture, "data");
  const previousDataRoot = process.env.POSIXLOOM_DATA_ROOT;
  try {
    process.env.POSIXLOOM_DATA_ROOT = dataRoot;
    const runtime = await RuntimeManager.create(process.cwd());
    const pointer = join(dataRoot, "runtime", "current");
    mkdirSync(join(dataRoot, "runtime"), { recursive: true });
    writeFileSync(pointer, "runtime-old");
    mkdirSync(join(dataRoot, "updates", "state.json"), { recursive: true });
    const updater = new RuntimeUpdater(runtime) as any;

    await assert.rejects(
      () => updater.commitSelection("runtime-new", { history: [] }),
      (error: any) => error?.code === "UPDATE_STATE_COMMIT_FAILED",
    );
    assert.equal(readFileSync(pointer, "utf8"), "runtime-old");
  } finally {
    if (previousDataRoot === undefined) delete process.env.POSIXLOOM_DATA_ROOT;
    else process.env.POSIXLOOM_DATA_ROOT = previousDataRoot;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("stale update lock recovery cannot delete a replacement lock", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-update-lock-"));
  const previousDataRoot = process.env.POSIXLOOM_DATA_ROOT;
  try {
    process.env.POSIXLOOM_DATA_ROOT = fixture;
    const runtime = await RuntimeManager.create(process.cwd());
    const updater = new RuntimeUpdater(runtime) as any;
    const lockPath = join(fixture, "updates", "update.lock");
    const first = await updater.acquireLock(lockPath);
    const stale = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(lockPath, stale, stale);
    const replacement = await updater.acquireLock(lockPath);
    await first.release();
    assert.equal(existsSync(lockPath), true);
    await replacement.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (previousDataRoot === undefined) delete process.env.POSIXLOOM_DATA_ROOT;
    else process.env.POSIXLOOM_DATA_ROOT = previousDataRoot;
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("runtime updater validates, installs and atomically selects a complete Runtime", { skip: process.platform !== "win32" }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-update-"));
  const runRoot = join(fixture, "run");
  const dataRoot = join(fixture, "data");
  const workspace = join(fixture, "工作 空间");
  const candidate = join(fixture, "candidate");
  const archive = join(fixture, "runtime.zip");
  const maliciousArchive = join(fixture, "runtime-malicious.zip");
  const previousDataRoot = process.env.POSIXLOOM_DATA_ROOT;
  const previousHost = process.env.POSIXLOOM_NATIVE_HOST;
  try {
    mkdirSync(join(runRoot, "config"), { recursive: true });
    mkdirSync(join(runRoot, "runtime", "versions", "runtime-dev"), { recursive: true });
    mkdirSync(join(dataRoot, "config"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    cpSync(join(process.cwd(), "config", "defaults.json"), join(runRoot, "config", "defaults.json"));
    writeFileSync(join(runRoot, "runtime", "current"), "runtime-dev");
    writeFileSync(join(runRoot, "runtime", "versions", "runtime-dev", "manifest.json"), JSON.stringify({ manifestVersion: 1, runtimeId: "runtime-dev", runtimeSemver: "0.1.0-dev", mode: "development", required: [] }));

    const components: RuntimeComponentManifest[] = [];
    const definitions = [
      ["node", "node", "node/node.exe"],
      ["msys2", "msys", "msys/usr/bin/bash.exe"],
      ["mingit", "native/mingit", "native/mingit/cmd/git.exe"],
      ["ripgrep", "native/rg", "native/rg/rg.exe"],
      ["posixloom", "native/posixloom-host", "native/posixloom-host/posixloom.exe"],
      ["shims", "shims", "shims/node"],
    ];
    for (const [id, root, entrypoint] of definitions) {
      const target = join(candidate, ...entrypoint.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      const contents = Buffer.from(`${id}-fixture`);
      writeFileSync(target, contents);
      const entryHash = createHash("sha256").update(contents).digest("hex");
      components.push({
        id,
        version: "fixture",
        root,
        entrypoint,
        sha256: entryHash,
        treeSha256: createHash("sha256").update(`${entrypoint.slice(root.length + 1)}\0${entryHash}\n`).digest("hex"),
        fileCount: 1,
      });
    }
    const shimEntries: Array<[string, Buffer]> = [
      ["git", Buffer.from("shims-git-fixture")],
      ["node", Buffer.from("shims-fixture")],
      ["rg", Buffer.from("shims-rg-fixture")],
    ];
    for (const [name, contents] of shimEntries.filter(([name]) => name !== "node")) writeFileSync(join(candidate, "shims", name), contents);
    const shimComponent = components.find((component) => component.id === "shims")!;
    shimComponent.treeSha256 = treeSha256(shimEntries);
    shimComponent.fileCount = shimEntries.length;
    const manifest: RuntimeManifest = {
      manifestVersion: 1,
      runtimeId: "runtime-1.0.0-test",
      runtimeSemver: "1.0.0",
      mode: "release",
      required: definitions.map(([id]) => id),
      components,
      licenses: ["licenses/NOTICE.txt"],
      sourceLockSha256: "ab".repeat(32),
    };
    mkdirSync(join(candidate, "licenses"), { recursive: true });
    writeFileSync(join(candidate, "licenses", "NOTICE.txt"), "fixture licenses");
    writeFileSync(join(candidate, "SBOM.spdx.json"), JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [] }));
    manifest.sbom = "SBOM.spdx.json";
    writeFileSync(join(candidate, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Path (Join-Path $env:POSIXLOOM_TEST_CANDIDATE '*') -DestinationPath $env:POSIXLOOM_TEST_ARCHIVE -Force"], {
      env: { ...process.env, POSIXLOOM_TEST_CANDIDATE: candidate, POSIXLOOM_TEST_ARCHIVE: archive },
    });
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", [
      "Add-Type -AssemblyName System.IO.Compression",
      "$stream = [IO.File]::Open($env:POSIXLOOM_TEST_MALICIOUS_ARCHIVE, [IO.FileMode]::Create)",
      "try {",
      "  $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)",
      "  try {",
      "    $entry = $zip.CreateEntry('../escaped.txt')",
      "    $writer = [IO.StreamWriter]::new($entry.Open())",
      "    try { $writer.Write('escape') } finally { $writer.Dispose() }",
      "  } finally { $zip.Dispose() }",
      "} finally { $stream.Dispose() }",
    ].join("; ")], { env: { ...process.env, POSIXLOOM_TEST_MALICIOUS_ARCHIVE: maliciousArchive } });
    const archiveBytes = readFileSync(archive);
    const feedPath = join(fixture, "feed.json");
    const feed: RuntimeUpdateFeed = {
      feedVersion: 1,
      signed: {
        channel: "stable",
        generatedAt: new Date().toISOString(),
        runtimes: [{
          runtimeId: manifest.runtimeId,
          runtimeSemver: manifest.runtimeSemver,
          platform: `${process.platform}-${process.arch}`,
          archiveUrl: archive,
          archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
          archiveBytes: archiveBytes.length,
        }],
      },
      signatures: [],
    };
    writeFileSync(feedPath, JSON.stringify(feed));
    writeFileSync(join(dataRoot, "config", "config.json"), JSON.stringify({
      runtime: { workspace },
      updates: { feedUrl: feedPath, requireSignature: false, autoApply: false, checkIntervalMs: 0 },
    }));
    process.env.POSIXLOOM_DATA_ROOT = dataRoot;
    process.env.POSIXLOOM_NATIVE_HOST = join(process.cwd(), "native", "posixloom-host", "target", "debug", "posixloom.exe");
    const runtime = await RuntimeManager.create(runRoot);
    runtime.snapshot.manifest.runtimeSemver = "999.0.0";
    (runtime as any).recoveryRequired = true;
    const maliciousBytes = readFileSync(maliciousArchive);
    const validRelease = feed.signed.runtimes[0];
    feed.signed.runtimes = [{
      ...validRelease,
      archiveUrl: maliciousArchive,
      archiveSha256: createHash("sha256").update(maliciousBytes).digest("hex"),
      archiveBytes: maliciousBytes.length,
    }];
    writeFileSync(feedPath, JSON.stringify(feed));
    runtime.config.runtime.updates.checkIntervalMs = 86_400_000;
    await assert.rejects(
      () => new RuntimeUpdater(runtime).update({ force: true }),
      (error: any) => error?.code === "UPDATE_EXTRACTION_FAILED" && /Unsafe Runtime archive entry/.test(String(error?.details?.stderr)),
    );
    await assert.rejects(
      () => new RuntimeUpdater(runtime).update(),
      (error: any) => error?.code === "UPDATE_EXTRACTION_FAILED",
    );
    assert.equal(existsSync(join(dataRoot, "runtime", "staging", "escaped.txt")), false);
    feed.signed.runtimes = [validRelease];
    writeFileSync(feedPath, JSON.stringify(feed));
    const conflictingRuntime = join(dataRoot, "runtime", "versions", manifest.runtimeId);
    cpSync(candidate, conflictingRuntime, { recursive: true });
    writeFileSync(join(conflictingRuntime, "manifest.json"), `${JSON.stringify({ ...manifest, notes: "different immutable content" }, null, 2)}\n`);
    await assert.rejects(
      () => new RuntimeUpdater(runtime).update({ force: true }),
      (error: any) => error?.code === "UPDATE_DESTINATION_CONFLICT",
    );
    assert.equal(existsSync(join(dataRoot, "runtime", "current")), false);
    rmSync(conflictingRuntime, { recursive: true, force: true });
    const result = await new RuntimeUpdater(runtime).update({ force: true });
    assert.equal(result.status, "installed");
    assert.equal(readFileSync(join(dataRoot, "runtime", "current"), "utf8"), manifest.runtimeId);
    const selected = await RuntimeManager.create(runRoot);
    assert.equal(selected.snapshot.runtimeId, manifest.runtimeId);
    assert.equal(selected.snapshot.source, "data");
    const integrityTarget = join(dataRoot, "runtime", "versions", manifest.runtimeId, "native", "rg", "rg.exe");
    const integrityBytes = readFileSync(integrityTarget);
    writeFileSync(integrityTarget, "mutated after startup");
    await assert.rejects(() => selected.assertRuntimeIntegrity("post-command"), (error: any) => error?.code === "RUNTIME_INTEGRITY_CHANGED");
    writeFileSync(integrityTarget, integrityBytes);
    await assert.doesNotReject(() => selected.assertRuntimeIntegrity("pre-command"));
    const rollback = await new RuntimeUpdater(selected).rollback();
    assert.equal(rollback.runtimeId, "runtime-dev");
    assert.equal(existsSync(join(dataRoot, "runtime", "current")), false);
    const restored = await RuntimeManager.create(runRoot);
    assert.equal(restored.snapshot.runtimeId, "runtime-dev");
    assert.equal(restored.snapshot.source, "development");
    selected.dispose();
    writeFileSync(join(dataRoot, "updates", "state.json"), JSON.stringify({ history: [{ runtimeId: "runtime-missing", source: "bundled" }] }));
    await assert.rejects(
      () => new RuntimeUpdater(restored).rollback(),
      (error: any) => error?.code === "UPDATE_ROLLBACK_INVALID",
    );
    writeFileSync(join(dataRoot, "updates", "state.json"), JSON.stringify({ history: [{ runtimeId: "../../outside", source: "data" }] }));
    await assert.rejects(() => new RuntimeUpdater(restored).rollback(), /Unable to read update state/);
  } finally {
    if (previousDataRoot === undefined) delete process.env.POSIXLOOM_DATA_ROOT;
    else process.env.POSIXLOOM_DATA_ROOT = previousDataRoot;
    if (previousHost === undefined) delete process.env.POSIXLOOM_NATIVE_HOST;
    else process.env.POSIXLOOM_NATIVE_HOST = previousHost;
    rmSync(fixture, { recursive: true, force: true });
  }
});
