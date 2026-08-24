import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function importedSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1].replaceAll("\\", "/"));
}

test("GUI, HTTP, and plugin implementations do not import one another", async () => {
  const httpImports = importedSpecifiers(await readFile("src/http/server.ts", "utf8"));
  const guiImports = importedSpecifiers(await readFile("src/gui/server.ts", "utf8"));
  const pluginImports = importedSpecifiers(await readFile("src/plugins/marketplace.ts", "utf8"));

  assert.equal(httpImports.some((specifier) => /\/(?:gui|plugins|composition)(?:\/|$)/.test(specifier)), false, httpImports.join("\n"));
  assert.equal(guiImports.some((specifier) => /\/(?:http|plugins|composition)(?:\/|$)/.test(specifier)), false, guiImports.join("\n"));
  assert.equal(pluginImports.some((specifier) => /\/(?:http|gui|composition)(?:\/|$)/.test(specifier)), false, pluginImports.join("\n"));
});

test("cross-component knowledge is isolated in the explicit composition adapter", async () => {
  const imports = importedSpecifiers(await readFile("src/composition/plugin-http.ts", "utf8"));
  assert.equal(imports.some((specifier) => specifier.includes("/http/")), true);
  assert.equal(imports.some((specifier) => specifier.includes("/plugins/")), true);
  assert.equal(imports.some((specifier) => specifier.includes("/gui/")), false);
});

