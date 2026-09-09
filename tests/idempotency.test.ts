import assert from "node:assert/strict";
import test from "node:test";
import { IdempotencyStore, requestFingerprint } from "../src/http/idempotency.js";

test("idempotency canonicalization ignores property order but preserves argument order", () => {
  assert.equal(requestFingerprint({ input: { kind: "argv", argv: ["node", "x"] }, envDelta: { A: "1", B: null } }), requestFingerprint({ envDelta: { B: null, A: "1" }, input: { argv: ["node", "x"], kind: "argv" }, omitted: undefined }));
  assert.notEqual(requestFingerprint(["node", "x"]), requestFingerprint(["x", "node"]));
});

test("idempotency preserves pending work, rejects conflict and clones completed receipts", () => {
  let now = 0;
  const store = new IdempotencyStore(1, 10, 10000, () => now);
  assert.deepEqual(store.begin("key", "fingerprint"), { replayed: false });
  now = 100;
  assert.throws(() => store.begin("key", "fingerprint"), (error: any) => error.code === "IDEMPOTENCY_IN_PROGRESS");
  assert.throws(() => store.begin("key", "different"), (error: any) => error.code === "IDEMPOTENCY_CONFLICT");
  assert.throws(() => store.begin("other", "fingerprint"), (error: any) => error.code === "SERVER_BUSY");
  const receipt = { status: 200, body: { nested: { value: 42 } } };
  store.complete("key", receipt);
  receipt.body.nested.value = 0;
  const first = store.begin("key", "fingerprint").receipt!;
  (first.body.nested as any).value = 0;
  assert.equal((store.begin("key", "fingerprint").receipt!.body.nested as any).value, 42);
  assert.equal(store.snapshot().pending, 0);
  now = 109; assert.throws(() => store.begin("new", "f"));
  now = 110; assert.deepEqual(store.begin("key", "fingerprint"), { replayed: false });
  assert.equal(store.snapshot().bytes, 0);
});

test("oversized receipt keeps a tombstone instead of risking duplicate side effects", () => {
  const store = new IdempotencyStore(2, 1000, 40);
  store.begin("large", "f");
  store.complete("large", { status: 200, body: { output: "x".repeat(100) } });
  assert.throws(() => store.begin("large", "f"), (error: any) => error.code === "IDEMPOTENCY_RESULT_UNAVAILABLE");
  assert.equal(store.snapshot().bytes, 0);
  assert.equal(store.snapshot().entries, 1);
  for (const key of ["", "x".repeat(129), "key with spaces", "含中文", "key\u0000"]) assert.throws(() => store.begin(key, "f"), (error: any) => error.code === "HTTP_IDEMPOTENCY_INVALID");
  assert.throws(() => new IdempotencyStore(0, 1000, 1000));
});

test("pre-admission rejections preserve identity while permitting exactly one new attempt", () => {
  let now = 0;
  const store = new IdempotencyStore(1, 10, 1000, () => now);
  store.begin("retry", "original");
  store.retryAfterRejection("retry");
  assert.equal(store.snapshot().pending, 0);
  assert.throws(() => store.begin("retry", "changed"), (error: any) => error.code === "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(store.begin("retry", "original"), { replayed: false });
  assert.throws(() => store.begin("retry", "original"), (error: any) => error.code === "IDEMPOTENCY_IN_PROGRESS");
  store.complete("retry", { status: 200, body: { result: "once" } });
  store.retryAfterRejection("retry");
  assert.equal(store.begin("retry", "original").replayed, true, "a completed result cannot become retryable");
  now = 10;
  store.begin("expiring", "new");
  store.retryAfterRejection("expiring");
  now = 20;
  assert.equal(store.snapshot().entries, 0, "unused retryable reservations still expire");
});
