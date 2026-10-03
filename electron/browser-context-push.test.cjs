"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const push = require("./browser-context-push.cjs");

test("only http(s) pages are pushed; DESK_BROWSER_CONTEXT_PUSH=0 turns it off", () => {
  assert.equal(push.pushable("https://example.com/a"), true);
  assert.equal(push.pushable("http://localhost:3000/"), true);
  for (const url of ["about:blank", "data:text/html,x", "file:///C:/x", "chrome://settings", "", null]) {
    assert.equal(push.pushable(url), false, String(url));
  }
  assert.equal(push.enabled({}), true);
  assert.equal(push.enabled({ DESK_BROWSER_CONTEXT_PUSH: "0" }), false);
});

test("buildPush: the router's shape, this window as the source, no text field", () => {
  const body = push.buildPush({
    url: "https://x.test/p", origin: "https://x.test", pathname: "/p", title: "T", lang: "en",
    opengraph: { "og:title": "T" }, json_ld: [{ "@type": "Thing" }], feeds: [], forms: [{ fields: [] }],
  }, { trigger: "page_loaded", now: () => new Date("2026-10-03T00:00:00Z") });
  assert.equal(body.source, "aither-browser");
  assert.equal(body.trigger, "page_loaded");
  assert.equal(body.timestamp, "2026-10-03T00:00:00.000Z");
  assert.equal(body.agent_richness_score, 6);
  assert.ok(!("text_content" in body), "page text never leaves the window");
  assert.deepEqual(push.buildPush(null).json_ld, [], "a page script that returned nothing still builds");
});

test("the page script never reads a field value or the body text", () => {
  assert.doesNotMatch(push.CONTEXT_SCRIPT, /\.value\b/);
  assert.doesNotMatch(push.CONTEXT_SCRIPT, /innerText|body\.textContent/);
  assert.doesNotThrow(() => new Function(`return ${push.CONTEXT_SCRIPT}`));
});

test("postPush: POSTs JSON with the bearer to Veil's Genesis bridge, and a failure is a verdict", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = req.headers.authorization === "Bearer good" ? 200 : 401;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await push.postPush({ url: "https://x.test/" }, { url: base + push.PUSH_PATH, token: "good" });
  assert.deepEqual(ok, { ok: true, status: 200 });
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/browser/agent-context/push");
  assert.equal(push.GENESIS_BRIDGE_URL, "http://127.0.0.1:3000/api/bridge/genesis");
  assert.equal(seen[0].body.url, "https://x.test/");
  const denied = await push.postPush({ url: "https://x.test/" }, { url: base + push.PUSH_PATH, token: "bad" });
  assert.deepEqual(denied, { ok: false, status: 401 });
  assert.equal((await push.postPush({}, { token: "" })).reason, "no session bearer");
  const dead = await push.postPush({}, { url: "http://127.0.0.1:1/x", token: "good" });
  assert.equal(dead.ok, false);
  assert.equal(dead.status, 0);
});

test("browser-window pushes on did-stop-loading, debounced, and shows the last verdict in its state", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(src, /wc\.on\("did-stop-loading", \(\) => scheduleContextPush\(wc\)\)/);
  assert.match(src, /contextPush: lastContextPush/);
  assert.match(src, /if \(!contextPush\.enabled\(\)\) return;/);
});
