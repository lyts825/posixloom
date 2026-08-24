/** Copy the standalone GUI's non-TypeScript assets into the compiled tree. */
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve("src/gui/public");
const targetRoot = resolve("dist/src/gui/public");
const assets = ["index.html", "app.css", "app.js", "favicon.svg"];

await mkdir(targetRoot, { recursive: true });
await Promise.all(assets.map((asset) => copyFile(resolve(sourceRoot, asset), resolve(targetRoot, asset))));
console.log(`copied ${assets.length} GUI assets`);

