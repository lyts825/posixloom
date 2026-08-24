import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyUpdateFeed, type RuntimeUpdateFeed } from "../src/core/updater.js";
import type { RuntimeComponentManifest, RuntimeManifest } from "../src/core/types.js";

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function treeSha256(entries: Array<[string, Buffer]>): string {
  return sha256(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, contents]) => `${name}\0${sha256(contents)}\n`).join(""));
}

test("update feed generator signs only an archive matching a complete Runtime", { skip: process.platform !== "win32" }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-feed-script-"));
  try {
    const runtimeRoot = join(fixture, "runtime root");
    const archive = join(fixture, "runtime archive.zip");
    const output = join(fixture, "feed.json");
    const keyPath = join(fixture, "private.pem");
    const definitions = [
      ["node", "node", "node/node.exe"],
      ["msys2", "msys", "msys/usr/bin/bash.exe"],
      ["mingit", "native/mingit", "native/mingit/cmd/git.exe"],
      ["ripgrep", "native/rg", "native/rg/rg.exe"],
      ["posixloom", "native/posixloom-host", "native/posixloom-host/posixloom.exe"],
      ["shims", "shims", "shims/node"],
    ];
    const components: RuntimeComponentManifest[] = definitions.map(([id, root, entrypoint]) => {
      const contents = Buffer.from(`${id}-signed-fixture`);
      const target = join(runtimeRoot, ...entrypoint.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, contents);
      const entryName = entrypoint.slice(root.length + 1);
      const entryHash = sha256(contents);
      return {
        id,
        version: "fixture",
        root,
        entrypoint,
        sha256: entryHash,
        treeSha256: sha256(`${entryName}\0${entryHash}\n`),
        fileCount: 1,
      };
    });
    const shimEntries: Array<[string, Buffer]> = [
      ["git", Buffer.from("shims-git-signed-fixture")],
      ["node", Buffer.from("shims-signed-fixture")],
      ["rg", Buffer.from("shims-rg-signed-fixture")],
    ];
    for (const [name, contents] of shimEntries.filter(([name]) => name !== "node")) writeFileSync(join(runtimeRoot, "shims", name), contents);
    const shimComponent = components.find((component) => component.id === "shims")!;
    shimComponent.treeSha256 = treeSha256(shimEntries);
    shimComponent.fileCount = shimEntries.length;
    mkdirSync(join(runtimeRoot, "licenses"), { recursive: true });
    writeFileSync(join(runtimeRoot, "licenses", "NOTICE.txt"), "fixture licenses");
    writeFileSync(join(runtimeRoot, "SBOM.spdx.json"), JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [] }));
    const manifest: RuntimeManifest = {
      manifestVersion: 1,
      runtimeId: "runtime-2.0.0-test",
      runtimeSemver: "2.0.0",
      updateSequence: 42,
      mode: "release",
      required: definitions.map(([id]) => id),
      components,
      licenses: ["licenses/NOTICE.txt"],
      sbom: "SBOM.spdx.json",
      sourceLockSha256: "ab".repeat(32),
    };
    const manifestPath = join(runtimeRoot, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Path (Join-Path $env:POSIXLOOM_FEED_TEST_ROOT '*') -DestinationPath $env:POSIXLOOM_FEED_TEST_ARCHIVE -Force"], {
      env: { ...process.env, POSIXLOOM_FEED_TEST_ROOT: runtimeRoot, POSIXLOOM_FEED_TEST_ARCHIVE: archive },
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    const commonArgs = [
      join(process.cwd(), "scripts", "create-update-feed.mjs"),
      "--runtime-root", runtimeRoot,
      "--archive", archive,
      "--archive-url", "runtime.zip",
      "--key-id", "test-key",
      "--private-key", keyPath,
    ];
    const generated = spawnSync(process.execPath, [...commonArgs, "--output", output], { encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const feed = JSON.parse(readFileSync(output, "utf8")) as RuntimeUpdateFeed;
    verifyUpdateFeed(feed, "stable", true, { "test-key": publicKey.export({ format: "pem", type: "spki" }).toString() });
    assert.equal(feed.signed.runtimes[0].updateSequence, 42);

    const injected = structuredClone(feed);
    injected.signed.runtimes.push({ ...injected.signed.runtimes[0], runtimeId: "runtime-injected", archiveUrl: "injected.zip" });
    writeFileSync(output, JSON.stringify(injected));
    const resignInjected = spawnSync(process.execPath, [...commonArgs, "--output", output], { encoding: "utf8" });
    assert.notEqual(resignInjected.status, 0);
    assert.match(resignInjected.stderr, /not signed by the supplied release key/i);
    writeFileSync(output, JSON.stringify(feed));

    const tamperedRoot = join(fixture, "tampered runtime");
    const tamperedArchive = join(fixture, "tampered archive.zip");
    cpSync(runtimeRoot, tamperedRoot, { recursive: true });
    writeFileSync(join(tamperedRoot, "node", "node.exe"), "tampered component");
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Path (Join-Path $env:POSIXLOOM_FEED_TEST_ROOT '*') -DestinationPath $env:POSIXLOOM_FEED_TEST_ARCHIVE -Force"], {
      env: { ...process.env, POSIXLOOM_FEED_TEST_ROOT: tamperedRoot, POSIXLOOM_FEED_TEST_ARCHIVE: tamperedArchive },
    });
    const tamperedArgs = [...commonArgs];
    tamperedArgs[tamperedArgs.indexOf("--archive") + 1] = tamperedArchive;
    const tampered = spawnSync(process.execPath, [...tamperedArgs, "--output", join(fixture, "tampered.json")], { encoding: "utf8" });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /archive contents do not match/i);

    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, notes: "changed after archiving" }, null, 2)}\n`);
    const mismatch = spawnSync(process.execPath, [...commonArgs, "--output", join(fixture, "mismatch.json")], { encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /archive manifest does not match/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
