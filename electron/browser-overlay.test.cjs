"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const ov = require("./browser-overlay.cjs");

test("over web pages only: never the OS over itself, never loopback or local schemes", () => {
  for (const u of ["https://www.reddit.com/r/x", "http://example.com/"]) assert.equal(ov.overlayAllowed(u), true, u);
  for (const u of ["https://aitherium.com/", "https://app.aitherium.com/", "aither://search/", "file:///C:/x",
    "http://127.0.0.1:3002/", "http://localhost:8080/", "chrome-extension://abc/x.html", "not a url"]) assert.equal(ov.overlayAllowed(u), false, u);
});

test("adapters match background.js: anchored glob, a lookalike host never matches", () => {
  const a = [{ id: "discord", match: ["https://discord.com/*"] }];
  assert.equal(ov.adapterFor(a, "https://discord.com/channels/1").id, "discord");
  assert.equal(ov.adapterFor(a, "https://evil-discord.com.attacker.net/"), null);
  assert.equal(ov.adapterFor(a, "https://example.com/?https://discord.com/"), null);
});

test("the shim queues the bridge's calls for main and routes the reply to its callback", async () => {
  const ctx = vm.createContext({ setTimeout, Promise });
  vm.runInContext(ov.SHIM, ctx);
  let got = null;
  ctx.chrome.runtime.sendMessage({ type: "os-token-request" }, (res) => { got = res; });
  const [req] = vm.runInContext("__aitherTake()", ctx);
  assert.equal(vm.runInContext("__aitherTake()", ctx).length, 0, "taken once");
  assert.deepEqual(JSON.parse(JSON.stringify(req)), { id: 1, msg: { type: "os-token-request" } });
  vm.runInContext(`__aitherReply(${req.id}, {"token":"t"})`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { token: "t" });
});

test("answers what background.js answers; the bearer comes from the signed-in Online session", async () => {
  const cookies = { get: async ({ url, name }) => (name === "aither_auth_token" && url === "https://app.aitherium.com" ? [{ value: "B" }] : []) };
  const o = ov.createOverlay({ dir: () => null, session: () => ({ cookies }), fetchImpl: async () => { throw new Error("down"); } });
  assert.deepEqual(await o.answer({ type: "os-token-request" }), { token: "B" });
  assert.deepEqual(await o.answer({ type: "os-identity-request" }), { identity: null });
  assert.deepEqual(await o.answer({ type: "probe-node" }), { online: false });
  assert.deepEqual(await o.answer({ type: "site-adapter", url: "https://x.com/" }), { ok: true, adapter: null });
  const refused = await o.answer({ type: "open-tab" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /open-tab/);
  const none = ov.createOverlay({ dir: () => null, session: () => null });
  assert.deepEqual(await none.answer({ type: "os-token-request" }), { token: null }, "null, never an empty string");
});

test("no staged awconnect: inject refuses by name instead of a half overlay", async () => {
  const o = ov.createOverlay({ dir: () => null, session: () => null });
  const wc = { isDestroyed: () => false, getURL: () => "https://example.com/" };
  const r = await o.inject(wc);
  assert.equal(r.ok, false);
  assert.match(r.error, /awconnect/);
});

test("daemon-call: exact allowlist, the first live node, 404 means the next node; compose uses it", async () => {
  const calls = [];
  const chatBodies = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${url}`);
    if (url.startsWith("http://127.0.0.1:8090")) throw new Error("down");
    if (url.endsWith("/health")) return { ok: true, status: 200, json: async () => ({}) };
    if (url.startsWith("http://127.0.0.1:8000")) return { ok: false, status: 404, json: async () => null };
    if (url.endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [
      { id: "down", aither: { available: false } }, { id: "busy", aither: { available: true, busy: true } },
      { id: "idle", aither: { available: true } }] }) };
    if (opts.body) chatBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
  };
  const o = ov.createOverlay({ dir: () => null, session: () => null, fetchImpl });
  const denied = await o.answer({ type: "daemon-call", method: "POST", path: "/v1/chat/completions/../../admin" });
  assert.equal(denied.ok, false);
  assert.equal(calls.length, 0, "refused before any request");
  assert.equal((await o.answer({ type: "daemon-call", method: "DELETE", path: "/tools" })).ok, false, "method pinned");
  const r = await o.answer({ type: "daemon-call", method: "POST", path: "/v1/chat/completions", body: {} });
  assert.equal(r.baseUrl, "http://127.0.0.1:9001");
  assert.deepEqual(await o.answer({ type: "os-compose", prompt: "x" }), { ok: true, text: "hi" });
  assert.equal(chatBodies.at(-1).model, "idle", "an available, idle model -- never the dead default");
});

test("the local token rides read/chat routes only, never /tools/call", async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith("/health") && !opts.method) return { ok: true, status: 200, json: async () => ({}) };
    seen.push([`${opts.method} ${new URL(url).pathname}`, opts.headers && opts.headers["X-Aither-Local-Token"]]);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const fsImpl = { readFileSync: (f) => { if (f === "TOK") return "secret  "; throw new Error("nope"); } };
  const o = ov.createOverlay({ dir: () => null, session: () => null, fetchImpl, fsImpl, tokenFile: "TOK" });
  await o.answer({ type: "daemon-call", method: "GET", path: "/v1/models" });
  await o.answer({ type: "daemon-call", method: "POST", path: "/tools/call", body: {} });
  assert.deepEqual(seen, [["GET /v1/models", "secret"], ["POST /tools/call", undefined]]);
});
