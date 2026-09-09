/** Fast pure/module tests can run independently of native-host and packaging integration. */
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const mode = process.argv[2];
if (!["unit", "integration"].includes(mode)) throw new Error("Use: node scripts/run-tests.mjs unit|integration");
const unit = new Set(["admission", "classifier", "env-session", "executable", "execution-request", "gui-output", "idempotency", "path", "plugin-kernel", "process-properties", "replay-window", "trace", "trace-recorder"]);
const files = (await readdir("dist/tests")).filter((name) => name.endsWith(".test.js"))
  .filter((name) => unit.has(name.slice(0, -".test.js".length)) === (mode === "unit")).sort().map((name) => resolve("dist/tests", name));
if (!files.length) throw new Error("No compiled test files; run npm run build first");
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
