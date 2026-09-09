import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.js";

test("benchmark loads the candidate modules and rejects results from failed candidate code", async (context) => {
  const { root, runtime } = await runtimeFixture(context);
  await mkdir(join(root, "dist"));
  await cp("dist/src", join(root, "dist", "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const reportPath = join(root, "measurement.json");
  const args = [resolve("scripts/benchmark.mjs"), "--run-root", root, "--case", "warm.explain", "--samples", "3", "--warmup", "0", "--output", reportPath];
  const run = () => spawnSync(process.execPath, args, { windowsHide: true, encoding: "utf8", timeout: 30000 });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.environment.moduleRoot, join(root, "dist", "src"));
  assert.equal(report.results["warm.explain"].samples.length, 3);
  assert.match(report.methodology.resources, /excludes child/);
  if (runtime.findBash()) {
    await writeFile(join(root, "dist", "src", "core", "assets", "state-report.sh"), '#!/usr/bin/env bash\nexit "$1"\n');
    const incomplete = spawnSync(process.execPath, args.map((arg) => arg === "warm.explain" ? "warm.shell" : arg), { windowsHide: true, encoding: "utf8", timeout: 30000 });
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /did not produce a valid completion/);
  }
  await appendFile(join(root, "dist", "src", "core", "service.js"), "\nthrow new Error('candidate-module-sentinel');\n");
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /candidate-module-sentinel/);
});
