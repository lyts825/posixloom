/** Copy the standalone GUI's non-TypeScript assets into the compiled tree. */
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve("src/gui/public");
const targetRoot = resolve("dist/src/gui/public");
const assets = ["index.html", "app.css", "app.js", "console-output.js", "workbench.js", "favicon.svg"];

await mkdir(targetRoot, { recursive: true });
await Promise.all(assets.map((asset) => copyFile(resolve(sourceRoot, asset), resolve(targetRoot, asset))));
console.error(`copied ${assets.length} GUI assets`);
const vendorRoot = resolve(targetRoot, "vendor/xterm");
await mkdir(vendorRoot, { recursive: true });
for (const [source, target] of [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/xterm/LICENSE", "xterm-LICENSE"],
  ["@xterm/addon-fit/LICENSE", "addon-fit-LICENSE"],
]) await copyFile(resolve("node_modules", source), resolve(vendorRoot, target));
await mkdir(resolve("dist/src/core/assets"), { recursive: true });
for (const asset of ["state-report.sh", "extract-runtime.ps1"]) await copyFile(resolve("src/core/assets", asset), resolve("dist/src/core/assets", asset));
console.error("copied audited Runtime script assets");
