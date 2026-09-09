import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { clearExecutableLookupCache, discoverExecutables, findAllOnPath } from "../src/core/executable.js";

test("PATH discovery handles quoting, Unicode, PATHEXT priority, duplicates and invalid candidates", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "posixloom-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "目录 with spaces"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  const extension = process.platform === "win32" ? ".exe" : "";
  const one = join(first, "loom-test" + extension), two = join(second, "loom-test" + extension);
  await writeFile(one, "fixture"); await writeFile(two, "fixture"); await chmod(one, 0o755); await chmod(two, 0o755);
  const path = ['"' + first + '"', second, first].join(delimiter);
  assert.deepEqual(discoverExecutables("loom-test", path, ".EXE;.CMD", root), [one, two].map((p) => process.platform === "win32" ? p.replace(/\.exe$/, ".EXE") : p));
  assert.equal(discoverExecutables("loom-test" + extension, path, undefined, root).length, 2);
  assert.equal(discoverExecutables(one, "", undefined, root).length, 1);
  assert.deepEqual(discoverExecutables("*", path), []);
  assert.deepEqual(discoverExecutables("bad\u0000name", path), []);
  assert.deepEqual(discoverExecutables("missing", path, ".EXE;.CMD", root), []);
});

test("PATH lookup caches are defensive and keyed by environment changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "posixloom-path-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PATH;
  context.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; clearExecutableLookupCache(); });
  const name = "posixloom-lookup-unique" + (process.platform === "win32" ? ".exe" : "");
  const path = join(root, name); await writeFile(path, "fixture"); await chmod(path, 0o755);
  process.env.PATH = root; clearExecutableLookupCache();
  const first = findAllOnPath(name); assert.equal(first.length, 1); first.length = 0;
  assert.equal(findAllOnPath(name).length, 1);
  process.env.PATH = ""; assert.deepEqual(findAllOnPath(name), []);
});
