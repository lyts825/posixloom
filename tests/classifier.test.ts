import test from "node:test";
import assert from "node:assert/strict";
import { classify, tokenizeSimple } from "../src/core/classifier.js";

test("classifier keeps simple argv commands native-eligible", () => {
  assert.deepEqual(tokenizeSimple("rg -n \"TODO\" src"), ["rg", "-n", "TODO", "src"]);
  assert.equal(classify("rg TODO src").kind, "simple");
  assert.equal(classify("cd /workspace").kind, "builtin");
});

test("classifier sends shell syntax to bash", () => {
  assert.equal(classify("cat a | grep b").kind, "shell-required");
  assert.equal(classify("echo $(pwd)").kind, "shell-required");
  assert.equal(classify("bash -c 'echo hi'").kind, "explicit-shell");
  assert.equal(classify("./build.sh").kind, "explicit-shell");
});
