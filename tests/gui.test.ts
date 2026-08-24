import assert from "node:assert/strict";
import test from "node:test";
import { startGuiServer } from "../src/gui/server.js";

test("standalone GUI serves immutable assets and points at an external API", async (context) => {
  const apiBaseUrl = "http://127.0.0.1:19091";
  const gui = await startGuiServer({ host: "127.0.0.1", port: 0, apiBaseUrl });
  context.after(() => gui.close());

  const pageResponse = await fetch(`${gui.origin}/`);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /PosixLoom Console/);
  assert.equal(page.includes(apiBaseUrl), false);
  assert.match(pageResponse.headers.get("content-security-policy") ?? "", /connect-src 'self' http:\/\/127\.0\.0\.1:19091/);

  const configuration = await fetch(`${gui.origin}/config.json`).then((response) => response.json());
  assert.deepEqual(configuration, { apiVersion: 1, apiBaseUrl, product: "PosixLoom" });
  const script = await fetch(`${gui.origin}/app.js`);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await script.text(), /application\/x-ndjson/);
  assert.equal((await fetch(`${gui.origin}/missing`)).status, 404);
  assert.equal((await fetch(`${gui.origin}/`, { method: "POST" })).status, 405);
});

