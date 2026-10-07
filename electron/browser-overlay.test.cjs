"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
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


const CONNECT = "http://127.0.0.1:8899/connect.json";

test("daemon-call: exact allowlist, adk first, 401/403/404 mean the next node; compose uses it", async () => {
  const calls = [];
  const chatBodies = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${url}`);
    if (url === CONNECT) throw new Error("no launcher");
    if (url.startsWith("http://127.0.0.1:9001")) throw new Error("down");
    if (url.endsWith("/health")) return { ok: true, status: 200, json: async () => ({}) };
    if (url.startsWith("http://127.0.0.1:8090")) return { ok: false, status: 401, json: async () => null };
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
  assert.equal(r.baseUrl, "http://127.0.0.1:8080", "past adk (down), awnode (401) and :8000 (404)");
  assert.deepEqual(calls.slice(1, 3), ["GET http://127.0.0.1:9001/health", "GET http://127.0.0.1:8090/health"], "adk, then awnode");
  assert.deepEqual(await o.answer({ type: "os-compose", prompt: "x" }), { ok: true, text: "hi" });
  assert.equal(chatBodies.at(-1).model, "idle", "an available, idle model -- never the dead default");
  const p = await o.answer({ type: "probe-node" });
  assert.deepEqual(p, { online: true, baseUrl: "http://127.0.0.1:8090" }, "probe walks the same order");
});

test("a 403 from the only live node is reported, not mistaken for no node", async () => {
  const fetchImpl = async (url) => {
    if (url === CONNECT) throw new Error("no launcher");
    if (url.startsWith("http://127.0.0.1:8090")) {
      return url.endsWith("/health") ? { ok: true, status: 200, json: async () => ({}) } : { ok: false, status: 403, json: async () => null };
    }
    throw new Error("down");
  };
  const o = ov.createOverlay({ dir: () => null, session: () => null, fetchImpl });
  const r = await o.answer({ type: "daemon-call", method: "GET", path: "/v1/models" });
  assert.equal(r.ok, false);
  assert.match(r.error, /8090 answered 403/);
});

test("the launcher's adk base goes first; a non-loopback one is dropped", async () => {
  const order = (adk) => {
    const seen = [];
    const fetchImpl = async (url) => {
      if (url === CONNECT) return { ok: true, json: async () => ({ endpoints: { adk } }) };
      seen.push(new URL(url).origin);
      throw new Error("down");
    };
    return { seen, o: ov.createOverlay({ dir: () => null, session: () => null, fetchImpl }) };
  };
  const a = order("http://127.0.0.1:9123/");
  await a.o.answer({ type: "probe-node" });
  assert.deepEqual(a.seen, ["http://127.0.0.1:9123", "http://127.0.0.1:8090", "http://127.0.0.1:8000", "http://127.0.0.1:8080"]);
  const b = order("http://evil.example:9001/");
  await b.o.answer({ type: "probe-node" });
  assert.equal(b.seen[0], "http://127.0.0.1:9001", "off-box adk refused: the :9001 fallback");
  const c = order("http://127.0.0.1:8090");
  await c.o.answer({ type: "probe-node" });
  assert.deepEqual(c.seen, ["http://127.0.0.1:8090", "http://127.0.0.1:8000", "http://127.0.0.1:8080"], "no base twice");
});

test("the local token rides read/chat/tools-list to the adk base only, never a tool call or another port", async () => {
  const seen = [];
  let healthyAdk = true;
  const fetchImpl = async (url, opts = {}) => {
    if (url === CONNECT) return { ok: true, json: async () => ({ endpoints: { adk: "http://127.0.0.1:9123" } }) };
    if (url.endsWith("/health") && !opts.method) return { ok: healthyAdk || !url.includes(":9123"), status: 200, json: async () => ({}) };
    const u = new URL(url);
    seen.push([`${opts.method} ${u.port} ${u.pathname}`, opts.headers && opts.headers["X-Aither-Local-Token"],
      opts.headers && opts.headers["Sec-Fetch-Site"]]);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const fsImpl = { readFileSync: (f) => { if (f === "TOK") return "secret  "; throw new Error("nope"); } };
  const o = ov.createOverlay({ dir: () => null, session: () => null, fetchImpl, fsImpl, tokenFile: "TOK" });
  const call = (p, method, body) => o.answer({ type: "daemon-call", method, path: p, body });
  await call("/v1/models", "GET");
  await call("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  await call("/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file" } });
  healthyAdk = false;
  await call("/v1/models", "GET");
  // Tool routes go out marked browser-relayed (the node's own browser scope applies);
  // the /v1 routes do not (awnode's owner gate would refuse an Origin-less cross-site).
  assert.deepEqual(seen, [
    ["GET 9123 /v1/models", "secret", undefined],
    ["POST 9123 /mcp", "secret", "cross-site"],
    ["POST 9123 /mcp", undefined, "cross-site"],
    ["GET 8090 /v1/models", undefined, undefined],
  ]);
});

test("POST /mcp: one JSON-RPC 2.0 request, tools/list and tools/call only, refused before any request", async () => {
  let fetched = 0;
  const o = ov.createOverlay({ dir: () => null, session: () => null, fetchImpl: async () => { fetched++; throw new Error("down"); } });
  for (const body of [{ jsonrpc: "2.0", method: "resources/read" }, { method: "tools/list" }, [{ jsonrpc: "2.0", method: "tools/list" }], null]) {
    const r = await o.answer({ type: "daemon-call", method: "POST", path: "/mcp", body });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, /mcp method not allowed/);
  }
  assert.equal(fetched, 0);
  assert.equal((await o.answer({ type: "daemon-call", method: "GET", path: "/mcp" })).ok, false, "GET /mcp is not on the list");
});

test("node tool scope: a write/shell tools/call from the OS frame never reaches a node", async () => {
  // The review's repro: :9001 answers 401, and before the fix the call walked on to
  // awnode :8090 /mcp, Origin-less, and ran there.
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url === CONNECT) throw new Error("no launcher");
    if (url.endsWith("/health") && !opts.method) return { ok: true, status: 200, json: async () => ({}) };
    seen.push([url, opts.headers]);
    return url.includes(":9001") ? { ok: false, status: 401, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ result: {} }) };
  };
  const o = ov.createOverlay({ dir: () => null, session: () => null, fetchImpl, fsImpl: { readFileSync: () => { throw new Error("no token"); } } });
  const ask = (body, op = "daemon-call") => o.answer({ type: ov.LIVING_OS_MESSAGE, op, method: "POST", path: "/mcp", body });
  for (const name of ["run_command", "write_file", "shell", "", undefined, "__proto__"]) {
    const r = await ask({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { command: "calc" } } });
    assert.equal(r.ok, false, String(name));
    assert.match(r.error, /tool not allowed from a browser origin/);
  }
  for (const params of [undefined, null, ["run_command"], "run_command"]) {
    assert.equal((await ask({ jsonrpc: "2.0", id: 1, method: "tools/call", params })).ok, false, JSON.stringify(params));
  }
  const legacy = await o.answer({ type: "daemon-call", method: "POST", path: "/tools/call", body: { name: "run_command" } });
  assert.equal(legacy.ok, false);
  assert.match(legacy.error, /path not allowed/);
  assert.deepEqual(seen, [], "refused before any request");
  // The read-only set still goes through, on past the refusing daemon, marked browser-relayed.
  for (const name of ["read_file", "list_directory", "list_dir", "web_search"]) assert.ok(ov.BROWSER_SAFE_TOOLS.has(name), name);
  const ok = await ask({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "a.txt" } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.baseUrl, "http://127.0.0.1:8090");
  assert.deepEqual(seen.map(([u, h]) => [u, h["Sec-Fetch-Site"]]), [
    ["http://127.0.0.1:9001/mcp", "cross-site"], ["http://127.0.0.1:8090/mcp", "cross-site"],
  ]);
});

function stagedDir(files) {
  return { readFileSync: (f) => { const k = String(f).split(path.sep).join("/"); if (k in files) return files[k]; throw new Error("ENOENT " + k); } };
}

test("awconnect 4.x envelope: {type:'awconnect:living-os', op} gets the same answers", async () => {
  const cookies = { get: async ({ url }) => (url === "https://aitherium.com" ? [{ value: "B4" }] : []) };
  const fsImpl = stagedDir({
    "D/adapters/index.json": JSON.stringify({ adapters: ["x.com"] }),
    "D/adapters/x.com.json": JSON.stringify({ id: "x", match: ["https://x.com/*"] }),
  });
  const o = ov.createOverlay({ dir: () => "D", session: () => ({ cookies }), fsImpl, fetchImpl: async () => { throw new Error("down"); } });
  const m = (op, extra) => o.answer({ type: ov.LIVING_OS_MESSAGE, op, ...extra });
  assert.deepEqual(await m("token"), { token: "B4" });
  assert.deepEqual(await m("identity"), {}, "signed in: no identity key, so the 4.x bridge posts nothing");
  assert.deepEqual(await m("probe-node"), { online: false });
  assert.equal((await m("site-adapter", { host: "x.com", url: "https://x.com/home" })).adapter.id, "x");
  assert.equal((await m("daemon-call", { method: "GET", path: "/admin" })).ok, false);
  const unknown = await m("open-tab");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /open-tab/);
  assert.equal((await m("__proto__")).ok, false, "an inherited key is not an op");
});

test("4.x identity: {} while signed in, {identity:null} once signed out; 3.x keeps null", async () => {
  let signedIn = true;
  const cookies = { get: async ({ url }) => (signedIn && url === "https://aitherium.com" ? [{ value: "B" }] : []) };
  const o = ov.createOverlay({ dir: () => null, session: () => ({ cookies }), fetchImpl: async () => { throw new Error("down"); } });
  assert.deepEqual(await o.answer({ type: ov.LIVING_OS_MESSAGE, op: "identity" }), {});
  assert.deepEqual(await o.answer({ type: "os-identity-request" }), { identity: null }, "3.x posts only a present identity");
  signedIn = false;
  assert.deepEqual(await o.answer({ type: ov.LIVING_OS_MESSAGE, op: "identity" }), { identity: null });
});

// The core that turns the desk's answer into a postMessage to the OS. Its authHandoff
// lands with the C2 sign-out work; until this checkout's awconnect-next carries it,
// AWCONNECT_NEXT_DIR can point the test at a tree that does.
const NEXT_CORES = [process.env.AWCONNECT_NEXT_DIR, path.join(__dirname, "..", "..", "..", "AitherOS", "apps", "awconnect-next")]
  .filter(Boolean).map((d) => path.join(d, "public", "content", "living-os-core.js"))
  .filter((f) => fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("authHandoff"));
test("C2 against awconnect-next's authHandoff: a sign-in or cookie refresh never posts identity:null",
  { skip: !NEXT_CORES.length && "no awconnect-next core with authHandoff (set AWCONNECT_NEXT_DIR)" }, async () => {
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(NEXT_CORES[0], "utf8"), ctx);
    const core = ctx.__awcLivingOsCore;
    for (const signedIn of [true, false]) {
      const cookies = { get: async () => (signedIn ? [{ value: "B" }] : []) };
      const o = ov.createOverlay({ dir: () => null, session: () => ({ cookies }), fetchImpl: async () => { throw new Error("down"); } });
      const res = await o.answer({ type: ov.LIVING_OS_MESSAGE, op: "identity" });
      // clearOnEmpty=true: the bridge's awc_auth listener, which authScript fires both ways.
      const posted = JSON.parse(JSON.stringify(core.authHandoff("identity", res, true)));
      assert.deepEqual(posted, signedIn ? null : { __aither: "os-identity", identity: null }, `signedIn=${signedIn}`);
      // The OS's own ask (no clearOnEmpty) never clears either way.
      assert.equal(core.authHandoff("identity", res, false), null);
    }
  });

test("page half: the 4.x pair (core THEN bridge), else the 3.x file, never half of 4.x", () => {
  const make = (files) => ov.createOverlay({ dir: () => "S", session: () => null, fsImpl: stagedDir(files) });
  const four = { "S/content/living-os-core.js": "CORE", "S/content/living-os-bridge.js": "BRIDGE", "S/content/aither-overlay-bridge.js": "OLD" };
  assert.deepEqual(make(four).bridgeSources(), ["CORE", "BRIDGE"]);
  assert.deepEqual(make({ "S/content/aither-overlay-bridge.js": "OLD" }).bridgeSources(), ["OLD"]);
  assert.deepEqual(make({ "S/content/living-os-bridge.js": "BRIDGE", "S/content/aither-overlay-bridge.js": "OLD" }).bridgeSources(), ["OLD"]);
  assert.equal(make({}).bridgeSources(), null);
  assert.equal(make({}).bridgeSource(), null);
});

test("inject runs the shim, then each file in order, in the isolated world", async () => {
  const four = { "S/content/living-os-core.js": "CORE", "S/content/living-os-bridge.js": "BRIDGE" };
  const o = ov.createOverlay({ dir: () => "S", session: () => null, fsImpl: stagedDir(four) });
  const ran = [];
  let destroyed = false;
  const wc = {
    isDestroyed: () => destroyed, getURL: () => "https://example.com/",
    executeJavaScriptInIsolatedWorld: async (world, [{ code }]) => {
      assert.equal(world, ov.WORLD);
      if (code !== ov.SHIM && /__aitherTake\(\)/.test(code)) return null; // the poll
      ran.push(code === ov.SHIM ? "SHIM" : code);
      return null;
    },
  };
  assert.deepEqual(await o.inject(wc), { ok: true });
  destroyed = true; // ends the poll loop
  assert.deepEqual(ran, ["SHIM", "CORE", "BRIDGE"]);
});

// The real 4.x files, when this checkout carries awconnect-next beside awdesk: the
// names, the order and the envelopes this file depends on are pinned against them.
const NEXT = path.join(__dirname, "..", "..", "..", "AitherOS", "apps", "awconnect-next");
test("pinned against awconnect-next: LIVING_OS_FILES, the envelopes, the core's shared global",
  { skip: !fs.existsSync(NEXT) && "awconnect-next not in this checkout" }, () => {
    const livingOs = fs.readFileSync(path.join(NEXT, "src", "background", "livingOs.ts"), "utf8");
    const files = /LIVING_OS_FILES\s*=\s*\[([^\]]+)\]/.exec(livingOs)[1].match(/'([^']+)'/g).map((q) => q.slice(1, -1));
    assert.deepEqual(files, ov.BRIDGE_SETS[0].map((f) => f.split(path.sep).join("/")));
    const bridge = fs.readFileSync(path.join(NEXT, "public", "content", "living-os-bridge.js"), "utf8");
    assert.ok(bridge.includes(`LIVING_OS_MESSAGE = '${ov.LIVING_OS_MESSAGE}'`), "the worker envelope");
    assert.ok(bridge.includes("CONTROL_MESSAGE = 'awconnect:living-os-control'"), "TEARDOWN's dismiss envelope");
    for (const op of ["identity", "token", "site-adapter", "probe-node"]) assert.ok(bridge.includes(`relayToSW('${op}'`), op);
    assert.ok(bridge.includes("const core = window.__awcLivingOsCore"), "the bridge reads the core's global");
    // Core then bridge share ONE world: running the shim and the core leaves the global the bridge reads.
    const ctx = vm.createContext({});
    vm.runInContext(ov.SHIM, ctx);
    vm.runInContext(fs.readFileSync(path.join(NEXT, "public", "content", "living-os-core.js"), "utf8"), ctx);
    assert.equal(typeof vm.runInContext("globalThis.__awcLivingOsCore.routeOsMessage", ctx), "function");
  });

test("the shim gives 4.x a chrome.storage that remembers and reports awc_auth changes", () => {
  const ctx = vm.createContext({ document: { getElementById: () => null } });
  vm.runInContext(ov.SHIM, ctx);
  let got = null;
  vm.runInContext("chrome.storage.local.set({ 'aither-overlay-ui': { minimized: true } })", ctx);
  ctx.chrome.storage.local.get("aither-overlay-ui", (v) => { got = v; });
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { "aither-overlay-ui": { minimized: true } });
  const changes = [];
  ctx.chrome.storage.onChanged.addListener((c, area) => changes.push([Object.keys(c), area]));
  vm.runInContext(ov.authScript(true), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [[["awc_auth"], "local"]]);
});

test("signed out: identity:null and token:null go to the OS frame, pinned to its origin (C2)", () => {
  const posted = [];
  const frame = { contentWindow: { postMessage: (data, origin) => posted.push([data, origin]) } };
  const host = { querySelector: (sel) => (sel === "iframe" ? frame : null) };
  const ctx = vm.createContext({ document: { getElementById: (id) => (id === "aither-os-overlay" ? host : null) } });
  vm.runInContext(ov.SHIM, ctx);
  const changes = [];
  ctx.chrome.storage.onChanged.addListener((c) => changes.push(c));
  assert.equal(vm.runInContext(ov.authScript(false), ctx), true);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
    [{ __aither: "os-identity", identity: null }, "https://aitherium.com"],
    [{ __aither: "os-token", token: null }, "https://aitherium.com"],
  ]);
  assert.equal(changes.length, 1, "the 4.x bridge's own awc_auth listener runs too");
  posted.length = 0;
  vm.runInContext(ov.authScript(true), ctx);
  assert.equal(posted.length, 0, "signing in posts nothing itself: the bridge re-asks and posts what it gets");
});

test("a bearer-cookie change reaches every page the overlay is on; the watch is once per session", async () => {
  const four = { "S/content/living-os-core.js": "CORE", "S/content/living-os-bridge.js": "BRIDGE" };
  const handlers = [];
  const ses = { cookies: { get: async () => [], on: (ev, fn) => { assert.equal(ev, "changed"); handlers.push(fn); } } };
  const o = ov.createOverlay({ dir: () => "S", session: () => ses, fsImpl: stagedDir(four) });
  const scripts = [];
  let destroyed = false;
  const wc = { isDestroyed: () => destroyed, getURL: () => "https://example.com/",
    executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => { scripts.push(code); return null; } };
  await o.inject(wc);
  assert.equal(o.watchAuth(), true);
  assert.equal(o.watchAuth(), false, "already watching this session");
  scripts.length = 0;
  handlers[0]({}, { name: "unrelated" });
  handlers[0]({}, { name: "aither_auth_token" }, "explicit", true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(scripts.filter((c) => c === ov.authScript(false)).length, 1, "one signed-out notice, no cookie left");
  destroyed = true;
});

test("TEARDOWN dismisses a 4.x bridge through its own control op (twice when it was minimized)", () => {
  let hostPresent = true;
  let dismisses = 0;
  const ctx = vm.createContext({
    document: { getElementById: (id) => (id === "aither-os-overlay" && hostPresent ? { remove() { hostPresent = false; } } : null), querySelectorAll: () => [] },
  });
  ctx.window = ctx;
  vm.runInContext(ov.SHIM, ctx);
  let minimized = true;
  ctx.chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "awconnect:living-os-control" || msg.op !== "dismiss") return;
    dismisses++;
    if (minimized) minimized = false; else hostPresent = false;
  });
  assert.equal(vm.runInContext(ov.TEARDOWN, ctx), true);
  assert.equal(dismisses, 2, "restore, then dismiss");
  assert.equal(hostPresent, false);
  assert.equal(ctx.__aitherOverlay, false);
});
