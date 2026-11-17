"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const link = require("./vroid-link.cjs");
const { tierAllowed } = require("./avatar-gallery.cjs");

test("models above the audience are not listed -- no name, no picture -- only counted", () => {
  const models = [
    { id: "1", name: "Kid", downloadable: true },
    { id: "2", name: "Spicy", r18: true, image: "https://vroid-hub.pximg.net/x.png" },
    { id: "3", name: "Edgy", r15: true },
  ];
  const hearth = link.visibleModels(models, "everyone", tierAllowed);
  assert.deepEqual(hearth.models.map((m) => m.name), ["Kid"]);
  assert.equal(hearth.hidden, 2);
  assert.ok(!JSON.stringify(hearth).includes("Spicy"));
  assert.equal(link.visibleModels(models, "teen", tierAllowed).models.length, 2);
  assert.equal(link.visibleModels(models, "mature", tierAllowed).models.length, 3);
});

test("only VRoid's own image hosts are fetched", () => {
  assert.equal(link.imageAllowed("https://vroid-hub.pximg.net/images/a.png"), true);
  assert.equal(link.imageAllowed("https://hub.vroid.com/x.png"), true);
  assert.equal(link.imageAllowed("http://vroid-hub.pximg.net/a.png"), false);
  assert.equal(link.imageAllowed("https://evil.example/a.png"), false);
  assert.equal(link.imageAllowed("https://pximg.net.evil.example/a.png"), false);
});

test("code + state from the callback or a pasted address", () => {
  assert.deepEqual(link.codeAndState("/callback?code=abc&state=xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(link.codeAndState("http://127.0.0.1:47835/callback?state=s&code=c"), { code: "c", state: "s" });
  assert.equal(link.codeAndState("/callback?code=abc"), null);
});

test("a link opens his browser and finishes from the loopback return; a busy port falls back to paste", async () => {
  const calls = [];
  const storeRequest = async (p, opts) => {
    calls.push([p, opts && opts.json]);
    if (p === "/vroid/authorize-web") return { ok: true, body: { authorize_url: "https://hub.vroid.com/oauth/authorize?x=1" } };
    return { ok: true, body: {} };
  };
  let handler = null;
  const fakeServer = () => {
    const s = new EventEmitter();
    s.listen = (_port, _host, cb) => cb();
    s.close = () => {};
    return s;
  };
  const opened = [];
  let linked = null;
  const r = await link.startLink({
    storeRequest,
    openExternal: (u) => opened.push(u),
    onLinked: (x) => { linked = x; },
    createServer: (h) => { handler = h; return fakeServer(); },
    catchMs: 50,
  });
  assert.deepEqual(r, { ok: true, opened: true, paste: false });
  assert.deepEqual(opened, ["https://hub.vroid.com/oauth/authorize?x=1"]);
  const res = { writeHead() { return this; }, end() {} };
  await handler({ url: "/callback?code=c1&state=s1" }, res);
  assert.deepEqual(calls[1], ["/vroid/link-web", { code: "c1", state: "s1" }]);
  assert.deepEqual(linked, { ok: true, reason: null });

  const busy = await link.startLink({
    storeRequest,
    openExternal: () => {},
    createServer: () => {
      const s = new EventEmitter();
      s.listen = () => setImmediate(() => s.emit("error", new Error("EACCES")));
      s.close = () => {};
      return s;
    },
  });
  assert.equal(busy.paste, true);
});
