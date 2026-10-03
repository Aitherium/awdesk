"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createBridgeServer } = require("./bridge-server.cjs");

const EXTENSION = "chrome-extension://hlmfknhcfhjjngckfpacgleffckpmphe";

function call(port, { method = "POST", origin, body }) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: `127.0.0.1:${port}` };
    if (origin) headers.origin = origin;
    if (data) Object.assign(headers, { "content-type": "application/json", "content-length": data.length });
    const req = http.request({ host: "127.0.0.1", port, path: "/browser/open", method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("POST /browser/open: the pinned awconnect extension opens a page; a website cannot", async (t) => {
  const opened = [];
  const server = createBridgeServer({
    port: 0,
    onEvent: () => {},
    bridgeToken: null,
    browserHandler: (url) => {
      opened.push(url);
      return /^https?:/.test(url) ? { ok: true, url } : { ok: false, error: "only http and https pages can be opened" };
    },
  });
  const { port } = await server.listen();
  t.after(() => server.close());

  const ok = await call(port, { origin: EXTENSION, body: { url: "https://example.com/a" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, url: "https://example.com/a" });
  assert.deepEqual(opened, ["https://example.com/a"]);

  const site = await call(port, { origin: "https://evil.test", body: { url: "https://phish.test/" } });
  assert.equal(site.status, 403, "an arbitrary website must not open pages on the desk");
  assert.equal(opened.length, 1);

  const refused = await call(port, { origin: EXTENSION, body: { url: "javascript:alert(1)" } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.ok, false);

  const get = await call(port, { method: "GET", origin: EXTENSION });
  assert.equal(get.status, 405);
});

test("no browserHandler: the route is absent (404), never a silent 200", async (t) => {
  const server = createBridgeServer({ port: 0, onEvent: () => {}, bridgeToken: null });
  const { port } = await server.listen();
  t.after(() => server.close());
  assert.equal((await call(port, { origin: EXTENSION, body: { url: "https://example.com/" } })).status, 404);
});
