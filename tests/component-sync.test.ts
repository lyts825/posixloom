import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function treeHash(entries: Array<[string, Buffer]>): string {
  return sha256(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, contents]) => `${name}\0${sha256(contents)}\n`).join(""));
}

test("locked environment components materialize reproducibly and reject a changed tree", { skip: process.platform !== "win32" }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-components-"));
  try {
    const policy = {
      policyVersion: 1,
      platform: "win32-x64",
      components: {
        node: { provider: "fixture", licensePaths: ["LICENSE"] },
        msys2: { provider: "fixture", licensePaths: ["usr/share/licenses"] },
        mingit: { provider: "fixture", licensePaths: ["mingw64/share/licenses/git"] },
        ripgrep: { provider: "fixture", licensePaths: ["COPYING", "LICENSE-MIT", "UNLICENSE"] },
      },
    };
    const policyPath = join(fixture, "policy.json");
    const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
    writeFileSync(policyPath, policyBytes);
    const definitions: Record<string, { root: string; entrypoint: string; entries: Array<[string, Buffer]> }> = {
      node: {
        root: "node-v1-win-x64",
        entrypoint: "node.exe",
        entries: [["node.exe", Buffer.from("node")], ["LICENSE", Buffer.from("node-license")]],
      },
      msys2: {
        root: "msys64",
        entrypoint: "usr/bin/bash.exe",
        entries: [["usr/bin/bash.exe", Buffer.from("bash")], ["usr/share/licenses/base/LICENSE", Buffer.from("msys-license")]],
      },
      mingit: {
        root: ".",
        entrypoint: "cmd/git.exe",
        entries: [["cmd/git.exe", Buffer.from("git")], ["mingw64/share/licenses/git/COPYING", Buffer.from("git-license")]],
      },
      ripgrep: {
        root: "ripgrep-1-x86_64-pc-windows-msvc",
        entrypoint: "rg.exe",
        entries: [["rg.exe", Buffer.from("rg")], ["COPYING", Buffer.from("copying")], ["LICENSE-MIT", Buffer.from("mit")], ["UNLICENSE", Buffer.from("unlicense")]],
      },
    };
    const components: Record<string, any> = {};
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    for (const [id, definition] of Object.entries(definitions)) {
      const source = join(fixture, `${id}-source`);
      for (const [relative, contents] of definition.entries) {
        const target = join(source, ...(definition.root === "." ? relative : `${definition.root}/${relative}`).split("/"));
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, contents);
      }
      const archive = join(fixture, `${id}.zip`);
      execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Path (Join-Path $env:POSIXLOOM_COMPONENT_SOURCE '*') -DestinationPath $env:POSIXLOOM_COMPONENT_ARCHIVE -Force"], {
        env: { ...process.env, POSIXLOOM_COMPONENT_SOURCE: source, POSIXLOOM_COMPONENT_ARCHIVE: archive },
      });
      const archiveBytes = readFileSync(archive);
      const entrypointBytes = definition.entries.find(([name]) => name === definition.entrypoint)![1];
      components[id] = {
        version: "1.0.0",
        upstreamTag: "fixture",
        archiveUrl: archive,
        archiveSha256: sha256(archiveBytes),
        archiveBytes: archiveBytes.length,
        archiveFormat: "zip",
        archiveRoot: definition.root,
        entrypoint: definition.entrypoint,
        entrypointSha256: sha256(entrypointBytes),
        rootTreeSha256: treeHash([...definition.entries]),
        fileCount: definition.entries.length,
        ...(id === "ripgrep" ? { sha256: sha256(entrypointBytes) } : {}),
      };
    }
    const lockPath = join(fixture, "lock.json");
    const lock = { lockVersion: 2, platform: "win32-x64", updateSequence: 1, generatedAt: new Date(0).toISOString(), policySha256: sha256(policyBytes), components };
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const output = join(fixture, "materialized components");
    const common = [
      join(process.cwd(), "scripts", "sync-components.mjs"),
      "--locked",
      "--policy", policyPath,
      "--lock", lockPath,
      "--output", output,
      "--cache", join(fixture, "cache"),
    ];
    const first = spawnSync(process.execPath, common, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(existsSync(join(output, "node", "node.exe")), true);
    assert.equal(existsSync(join(output, "licenses", "ripgrep", "LICENSE-MIT")), true);
    const descriptor = JSON.parse(readFileSync(join(output, "resolved-components.json"), "utf8"));
    assert.equal(descriptor.ripgrepExe, join(output, "ripgrep", "rg.exe"));
    const before = statSync(join(output, "node", "node.exe")).mtimeMs;

    lock.components.node.rootTreeSha256 = "00".repeat(32);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const rejected = spawnSync(process.execPath, common, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /does not match the committed tree lock/);
    assert.equal(statSync(join(output, "node", "node.exe")).mtimeMs, before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
