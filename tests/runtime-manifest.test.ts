import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { validateRuntimeManifest } from "../src/core/runtime.js";
import type { RuntimeManifest } from "../src/core/types.js";

function manifestFor(root: string, hash: string): RuntimeManifest {
  const component = (id: string, componentRoot: string, entrypoint: string, sha256: string) => ({
    id,
    version: `${id}-test`,
    root: componentRoot,
    entrypoint,
    sha256,
    treeSha256: createHash("sha256").update(`${entrypoint.slice(componentRoot.length + 1)}\0${sha256}\n`).digest("hex"),
    fileCount: 1,
  });
  const shimEntries = ["git", "node", "rg"].map((name) => [name, createHash("sha256").update(name === "node" ? "shims-test" : `shims-${name}-test`).digest("hex")] as const);
  const shimTreeSha256 = createHash("sha256").update(shimEntries.map(([name, entryHash]) => `${name}\0${entryHash}\n`).join("")).digest("hex");
  return {
    manifestVersion: 1,
    runtimeId: "runtime-test",
    runtimeSemver: "0.0.0-test",
    mode: "release",
    required: ["node", "msys2", "mingit", "ripgrep", "posixloom", "shims"],
    licenses: ["licenses/NOTICE.txt"],
    sbom: "SBOM.spdx.json",
    sourceLockSha256: "ab".repeat(32),
    components: [
      component("node", "node", "node/node.exe", hash),
      component("msys2", "msys", "msys/usr/bin/bash.exe", createHash("sha256").update("msys2-test").digest("hex")),
      component("mingit", "native/mingit", "native/mingit/cmd/git.exe", createHash("sha256").update("mingit-test").digest("hex")),
      component("ripgrep", "native/rg", "native/rg/rg.exe", createHash("sha256").update("ripgrep-test").digest("hex")),
      component("posixloom", "native/posixloom-host", "native/posixloom-host/posixloom.exe", createHash("sha256").update("posixloom-test").digest("hex")),
      {
        ...component("shims", "shims", "shims/node", createHash("sha256").update("shims-test").digest("hex")),
        treeSha256: shimTreeSha256,
        fileCount: shimEntries.length,
      },
    ],
  };
}

test("release manifest validates component entrypoint hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "posixloom-manifest-"));
  try {
    const files = [
      ["node", "node/node.exe", "node-test"],
      ["msys2", "msys/usr/bin/bash.exe", "msys2-test"],
      ["mingit", "native/mingit/cmd/git.exe", "mingit-test"],
      ["ripgrep", "native/rg/rg.exe", "ripgrep-test"],
      ["posixloom", "native/posixloom-host/posixloom.exe", "posixloom-test"],
      ["shims", "shims/node", "shims-test"],
      ["shims-git", "shims/git", "shims-git-test"],
      ["shims-rg", "shims/rg", "shims-rg-test"],
    ];
    for (const [, relative, value] of files) {
      const entrypoint = join(root, relative);
      mkdirSync(join(entrypoint, ".."), { recursive: true });
      writeFileSync(entrypoint, value);
    }
    const contents = Buffer.from("node-test");
    mkdirSync(join(root, "licenses"));
    writeFileSync(join(root, "licenses", "NOTICE.txt"), "notice");
    writeFileSync(join(root, "SBOM.spdx.json"), "{\"spdxVersion\":\"SPDX-2.3\"}\n");
    const hash = createHash("sha256").update(contents).digest("hex");
    assert.deepEqual(validateRuntimeManifest(manifestFor(root, hash), root), []);
    const checks = validateRuntimeManifest(manifestFor(root, "00".repeat(32)), root);
    assert.equal(checks.some((check) => check.id === "manifest.component.node.hash" && check.level === "FAIL"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release manifest rejects component paths escaping RuntimeRoot", () => {
  const root = mkdtempSync(join(tmpdir(), "posixloom-manifest-"));
  try {
    const manifest = manifestFor(root, "00".repeat(32));
    manifest.components![0].entrypoint = "../node.exe";
    const checks = validateRuntimeManifest(manifest, root);
    assert.equal(checks.some((check) => check.id === "manifest.component.node" && check.level === "FAIL"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release manifest requires every basic Runtime component", () => {
  const root = mkdtempSync(join(tmpdir(), "posixloom-manifest-"));
  try {
    const manifest = manifestFor(root, "00".repeat(32));
    manifest.components = manifest.components!.filter((component) => component.id !== "msys2");
    const checks = validateRuntimeManifest(manifest, root);
    assert.equal(checks.some((check) => check.id === "manifest.required.msys2" && check.level === "FAIL"), true);
    const wrongLayout = manifestFor(root, "00".repeat(32));
    wrongLayout.components!.find((component) => component.id === "msys2")!.entrypoint = "msys/bash.exe";
    const layoutChecks = validateRuntimeManifest(wrongLayout, root);
    assert.equal(layoutChecks.some((check) => check.id === "manifest.component.msys2.layout" && check.level === "FAIL"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest validation reports malformed field types without throwing", () => {
  const checks = validateRuntimeManifest({
    manifestVersion: 1,
    runtimeId: "runtime-test",
    runtimeSemver: "1.0.0",
    mode: "release",
    required: [null],
    components: [{ id: "node", version: "test", root: "node", entrypoint: "node/node.exe", sha256: {} }],
    licenses: "licenses/NOTICE.txt",
    sbom: {},
  }, process.cwd());
  assert.equal(checks.some((check) => check.level === "FAIL"), true);
});
