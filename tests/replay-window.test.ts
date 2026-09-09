import assert from "node:assert/strict";
import test from "node:test";
import { ReplayWindow } from "../src/core/replay-window.js";

test("request replay history stays bounded while active IDs are never evicted", () => {
  const window = new ReplayWindow(3, 1000, () => 0);
  assert.ok(window.begin("active"));
  for (let index = 0; index < 10000; index += 1) {
    const id = String(index);
    assert.ok(window.begin(id)); window.finish(id);
    assert.ok(window.size <= 4);
  }
  assert.equal(window.begin("active"), false);
  assert.equal(window.begin("9999"), false);
  assert.equal(window.begin("0"), true);
  window.finish("0"); window.finish("active"); window.finish("active");
  assert.equal(window.size, 3);
});

test("completed IDs expire exactly at TTL while pending IDs survive", () => {
  let now = 0;
  const window = new ReplayWindow(2, 10, () => now);
  window.begin("running"); window.begin("done"); window.finish("done");
  now = 9; assert.equal(window.begin("done"), false);
  now = 10; assert.equal(window.begin("done"), true);
  now = 1000; assert.equal(window.begin("running"), false);
  assert.equal(window.size, 2);
  assert.throws(() => new ReplayWindow(0, 10));
  assert.throws(() => new ReplayWindow(1, 0));
});
