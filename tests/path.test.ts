import test from "node:test";
import assert from "node:assert/strict";
import { MountTable, normalizeVirtual } from "../src/core/path.js";

test("mount table performs longest-prefix virtual to host translation", () => {
  const table = new MountTable({
    "/workspace": "C:\\work\\repo",
    "/workspace/cache": "D:\\cache",
  });
  assert.equal(table.toHost("/workspace/src"), "C:\\work\\repo\\src");
  assert.equal(table.toHost("/workspace/cache/a"), "D:\\cache\\a");
});

test("drive and UNC paths round trip", () => {
  const table = new MountTable({ "/workspace": "C:\\work" });
  assert.equal(table.toHost("/d/tmp/a"), "D:\\tmp\\a");
  assert.equal(table.toHost("//server/share/a"), "\\\\server\\share\\a");
  assert.equal(table.toVirtual("D:\\tmp\\a"), "/d/tmp/a");
  assert.equal(table.toVirtual("\\\\server\\share\\a"), "//server/share/a");
});

test("virtual root traversal is rejected", () => {
  assert.throws(() => normalizeVirtual("/workspace/../../Windows"), /escapes virtual root/);
});

test("host-to-virtual translation chooses the most specific host mount", () => {
  const table = new MountTable([
    { virtualPath: "/very-long-general-name", hostPath: "C:\\work" },
    { virtualPath: "/short", hostPath: "C:\\work\\nested" },
  ]);
  assert.equal(table.toVirtual("C:\\work\\nested\\file.txt"), "/short/file.txt");
});
