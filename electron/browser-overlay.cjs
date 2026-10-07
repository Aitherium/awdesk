"use strict";

/**
 * browser-overlay.cjs -- AitherOS Online drawn OVER any web page, inside the Aither
 * Browser: the awconnect overlay, at parity (owner, 2026-10-04: "the aitheros online
 * desktop apps can draw over whatever web page like it does in a web browser with
 * awconnect in edge/chrome").
 *
 * PARITY BY REUSE. The page half is awconnect's OWN content script, read from the staged
 * build (browser-extensions.cjs awconnectDir). 4.x ships it as TWO files run in order,
 * content/living-os-core.js then content/living-os-bridge.js (awconnect-next
 * src/background/livingOs.ts LIVING_OS_FILES); 3.x shipped the single
 * content/aither-overlay-bridge.js, still used when the 4.x pair is absent. Either way:
 * the transparent aitherium.com/?mode=overlay iframe, the clip to the OS's os-regions,
 * Alt+` interact, the os->page automation. Only the extension's SERVICE-WORKER half is
 * replaced: the bridge's chrome.runtime calls land in a shim in an ISOLATED world (the
 * page never sees it), which main long-polls, and main answers what the worker answers.
 * 3.x asks by {type}; 4.x by {type:'awconnect:living-os', op} (op identity/token are the
 * os-identity-request/os-token-request below); both land on the same answers:
 *
 *   os-token-request     the bearer the overlay attaches (the iframe is third-party, so
 *                        the session cookie never reaches it -- background.js's reason).
 *                        Read from the signed-in Online partition; it goes out only
 *                        pinned to the OS origin (the bridge's postMessage), never logged.
 *   os-identity-request  main has no identity of its own: the OS keeps what its own verify
 *                        found with the bearer. 4.x is answered {} while signed in (no
 *                        identity key, so the bridge posts nothing) and {identity:null}
 *                        only once signed out -- see answer().
 *   site-adapter         awconnect's adapters/*.json, matched the way background.js does.
 *   probe-node           the same loopback bases the worker probes, the adk daemon first.
 *   daemon-call          the worker's EXACT method+path allowlist onto the local node
 *                        (POST /mcp: JSON-RPC tools/list, and tools/call of the
 *                        read-only tool set only -- BROWSER_SAFE_TOOLS).
 *   os-compose           on this machine's local brain (the node's chat completions); the
 *                        extension runs a WebGPU model in its worker, main has no WebGPU.
 *   anything else        refused by name.
 */

const fs = require("node:fs");
const path = require("node:path");

/** The isolated world the bridge runs in (Electron: any id >= 1000 is ours). */
const WORLD = 1013;
/**
 * The page half, newest first. 4.x: core THEN bridge (the bridge reads the core's
 * globalThis.__awcLivingOsCore, so the order is load-bearing). 3.x: one file. A build
 * missing either 4.x file falls back to the 3.x file rather than half an overlay.
 */
const BRIDGE_SETS = Object.freeze([
  Object.freeze([path.join("content", "living-os-core.js"), path.join("content", "living-os-bridge.js")]),
  Object.freeze([path.join("content", "aither-overlay-bridge.js")]),
]);
/** awconnect 4.x's bridge -> worker envelope (living-os-bridge.js LIVING_OS_MESSAGE). */
const LIVING_OS_MESSAGE = "awconnect:living-os";
/** 4.x op -> the 3.x message type this file already answers. */
const LIVING_OS_OPS = Object.freeze({
  "probe-node": "probe-node", "daemon-call": "daemon-call", "site-adapter": "site-adapter",
  "identity": "os-identity-request", "token": "os-token-request", "os-compose": "os-compose",
});
const OS_ORIGIN = "https://aitherium.com";
const TOKEN_COOKIE = "aither_auth_token";
const TOKEN_URLS = Object.freeze(["https://aitherium.com", "https://app.aitherium.com", "https://portal.aitherium.com"]);
/** The launcher publishes the adk daemon's port here (Windows reserved ranges move it). */
const LAUNCHER_CONNECT_URL = "http://127.0.0.1:8899/connect.json";
const ADK_FALLBACK = "http://127.0.0.1:9001";
/**
 * After the adk daemon, the cross-surface probe order (awconnect livingOs.ts, C1):
 * adk first (the launcher's map, else :9001), then awnode :8090, then :8000, :8080.
 */
const NODE_PORTS = Object.freeze(["http://127.0.0.1:8090", "http://127.0.0.1:8000", "http://127.0.0.1:8080"]);
/** The worker's daemon-call: EXACT method + path, never a prefix (a loopback SSRF surface).
 *  /info and /tools stay for older nodes; /mcp is what new callers use. The legacy
 *  POST /tools/call is NOT here: its body shape differs per daemon, so the read-only
 *  scope below could not be checked on it, and nothing in C1 relies on it any more. */
const DAEMON_ALLOWED = Object.freeze(new Set([
  "GET /health", "GET /info", "GET /v1/models", "POST /v1/chat/completions", "GET /tools",
  "POST /mcp",
]));
/** POST /mcp carries one JSON-RPC 2.0 request; only these methods go through. */
const MCP_METHODS = Object.freeze(new Set(["tools/list", "tools/call"]));
/**
 * Node tool scope rule: daemon-call is driven by the OS frame (a remote web origin), so
 * a tools/call may name only the read-only filesystem + web search set -- the same names
 * awnode serves a browser caller (_BROWSER_SAFE_TOOLS + its list_dir alias). Checked HERE,
 * before any request: main's fetch carries no Origin, so a node cannot tell this apart
 * from its own CLI, and a 401 from the adk daemon would otherwise walk the call on to
 * the next port that does not ask (write_file/run_command on awnode, measured in review).
 */
const BROWSER_SAFE_TOOLS = Object.freeze(new Set(["read_file", "list_directory", "list_dir", "web_search"]));
/** Tool routes also go out marked browser-relayed (what Chrome stamps on the extension's
 *  fetches), so a node applies its own browser scope too. Not the /v1 routes: awnode's
 *  owner gate refuses an Origin-less cross-site request, which would push chat off it. */
const BROWSER_RELAYED_ROUTES = Object.freeze(new Set(["GET /tools", "POST /mcp tools/list", "POST /mcp tools/call"]));
/** Alive, but not serving this route to us: the next base, not a failure. */
const NEXT_NODE_STATUS = Object.freeze(new Set([401, 403, 404]));

/**
 * Routes that carry the owner's local daemon token (~/.aither/daemon-token), and only
 * to the adk daemon's own base -- never to awnode or whatever else holds :8000/:8080.
 * Reads and local chat only: an /mcp tools/call goes without the token, so it reaches a
 * node no more trusted than awconnect does in Chrome. What keeps it read-only is not that
 * (a refusing daemon only sends it on to the next port) but BROWSER_SAFE_TOOLS above.
 */
const DAEMON_TOKEN_ROUTES = Object.freeze(new Set([
  "GET /health", "GET /info", "GET /v1/models", "POST /v1/chat/completions", "GET /tools", "POST /mcp tools/list",
]));

/** How often main takes the bridge's queued calls. Short polls, never a held promise: a
 *  promise left pending in the world stalled the next script into it (measured, smoke). */
const POLL_MS = 150;

/**
 * The chrome.runtime the bridge expects, for the isolated world. sendMessage queues a
 * request that main takes with __aitherTake() and answers with __aitherReply(id, res).
 */
const SHIM = `(() => {
  if (globalThis.__aitherShim) return;
  globalThis.__aitherShim = true;
  const pending = new Map();
  const queue = [];
  const listeners = [];
  let seq = 0;
  const push = (req) => { if (queue.length < 200) queue.push(req); };
  globalThis.__aitherTake = () => queue.splice(0, queue.length);
  globalThis.__aitherReply = (id, res) => {
    const cb = pending.get(id);
    pending.delete(id);
    if (cb) { try { cb(res); } catch { /* the bridge's own callback */ } }
  };
  globalThis.__aitherPush = (msg) => { for (const fn of listeners) { try { fn(msg, {}, () => {}); } catch { /* next */ } } };
  // 4.x keeps its minimized state in chrome.storage.local and re-asks for identity +
  // bearer on an awc_auth change: a per-document memory store, and main fires the change.
  const store = {};
  const changed = [];
  globalThis.__aitherStorageChanged = (changes) => { for (const fn of changed) { try { fn(changes, "local"); } catch { /* next */ } } };
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) { const id = ++seq; if (typeof cb === "function") pending.set(id, cb); push({ id, msg }); },
      onMessage: { addListener(fn) { if (typeof fn === "function") listeners.push(fn); } },
    },
    storage: {
      local: {
        get(key, cb) {
          const out = {};
          for (const k of (Array.isArray(key) ? key : [key])) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          if (typeof cb === "function") cb(out);
          return Promise.resolve(out);
        },
        set(items, cb) { Object.assign(store, items || {}); if (typeof cb === "function") cb(); return Promise.resolve(); },
      },
      onChanged: { addListener(fn) { if (typeof fn === "function") changed.push(fn); } },
    },
  };
})();`;

/**
 * Remove the overlay from the page, so a later toggle re-injects it. 4.x first: the
 * worker's control 'dismiss' runs the bridge's OWN teardown (page padding, timers), and
 * on a MINIMIZED overlay that same op restores instead -- hence up to two. Then the DOM
 * ids of both generations, for a 3.x bridge or a 4.x one that did not answer.
 */
const TEARDOWN = `(() => {
  if (typeof __aitherPush === "function") {
    for (let i = 0; i < 2 && document.getElementById("aither-os-overlay"); i++) __aitherPush({ type: "awconnect:living-os-control", op: "dismiss" });
  }
  for (const id of ["aither-os-overlay", "aither-os-hint", "aither-os-min", "aither-os-close", "aither-os-restore"]) { const el = document.getElementById(id); if (el) el.remove(); }
  for (const b of document.querySelectorAll("button")) { if (b.parentElement === document.documentElement && /^(\\u25be|\\u26a1)$/.test(b.textContent)) b.remove(); }
  window.__aitherOverlay = false;
  return true;
})()`;

/**
 * Signed out (cross-surface contract C2): the OS frame must drop its host identity
 * and bearer. Posted from the bridge's world straight to the OS frame, pinned to
 * OS_ORIGIN as the bridge posts, so it holds even for a bridge that only republishes
 * a PRESENT token; then the 4.x bridge's own awc_auth listener runs, as in Chrome
 * when the side panel signs out. Signed in again: only that listener (it re-asks).
 */
function authScript(signedIn) {
  return `(() => {
  if (${signedIn ? "false" : "true"}) {
    const host = document.getElementById("aither-os-overlay");
    const frame = host && host.querySelector("iframe");
    if (frame && frame.contentWindow) {
      try {
        frame.contentWindow.postMessage({ __aither: "os-identity", identity: null }, ${JSON.stringify(OS_ORIGIN)});
        frame.contentWindow.postMessage({ __aither: "os-token", token: null }, ${JSON.stringify(OS_ORIGIN)});
      } catch { /* frame gone */ }
    }
  }
  if (typeof __aitherStorageChanged === "function") __aitherStorageChanged({ awc_auth: { newValue: ${signedIn ? "{}" : "undefined"} } });
  return true;
})()`;
}

function isAitheriumHost(host) {
  return /(^|\.)aitherium\.com$/i.test(String(host || ""));
}

/** May the overlay go over this page? Ordinary https/http web pages only, never the OS over itself. */
function overlayAllowed(url) {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (isAitheriumHost(parsed.hostname)) return false;
  return !/^(localhost|127\.|\[::1\])/.test(parsed.hostname);
}

/** background.js's adapter match: glob over the whole URL, anchored. */
function adapterFor(adapters, url) {
  for (const a of adapters) {
    const hit = (a.match || []).some((pat) => {
      const rx = new RegExp("^" + String(pat).split("*").map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      return rx.test(String(url || ""));
    });
    if (hit) return a;
  }
  return null;
}

/**
 * @param {object} deps
 * @param {() => string|null} deps.dir      the staged awconnect folder (browser-extensions awconnectDir)
 * @param {() => object|null} deps.session  the signed-in Online session (its cookies hold the bearer)
 * @param {Function} [deps.fetchImpl]
 * @param {object} [deps.fsImpl]
 */
function createOverlay({ dir, session, fetchImpl = globalThis.fetch, fsImpl = fs,
  tokenFile = path.join(require("node:os").homedir(), ".aither", "daemon-token") }) {
  let adapterCache = null;
  const loops = new WeakMap(); // webContents -> generation; a navigation ends its loop
  const live = new Set(); // pages the overlay is on now (for a sign-in/out notice)

  /** The page half to run, in order (4.x core + bridge, else the 3.x file); null when none. */
  function bridgeSources() {
    const d = dir();
    if (!d) return null;
    for (const set of BRIDGE_SETS) {
      try { return set.map((f) => fsImpl.readFileSync(path.join(d, f), "utf8")); } catch { /* the next generation */ }
    }
    return null;
  }

  /** One string, for callers that only ask "is a bridge staged?" (kept from the 3.x API). */
  function bridgeSource() {
    const parts = bridgeSources();
    return parts ? parts.join("\n;\n") : null;
  }

  function adapters() {
    if (adapterCache) return adapterCache;
    const d = dir();
    const out = [];
    try {
      const idx = JSON.parse(fsImpl.readFileSync(path.join(d, "adapters", "index.json"), "utf8"));
      for (const id of idx.adapters || []) {
        if (!/^[a-z0-9.-]{1,80}$/i.test(String(id))) continue;
        try { out.push(JSON.parse(fsImpl.readFileSync(path.join(d, "adapters", `${id}.json`), "utf8"))); } catch { /* skip one */ }
      }
    } catch { /* no adapters staged: every site has none */ }
    adapterCache = out;
    return out;
  }

  async function token() {
    const ses = session();
    if (!ses) return null;
    for (const url of TOKEN_URLS) {
      try {
        const [c] = await ses.cookies.get({ url, name: TOKEN_COOKIE });
        if (c && c.value) return c.value;
      } catch { /* next */ }
    }
    return null;
  }

  /**
   * The adk daemon's base: the launcher's connect.json `endpoints.adk` when it is an
   * http URL on 127.0.0.1 (data from a local process, so validated: anything else would
   * send prompts off-box), else :9001. Never throws.
   */
  async function adkBase() {
    try {
      const r = await fetchImpl(LAUNCHER_CONNECT_URL, { cache: "no-store", signal: AbortSignal.timeout(1200) });
      if (r && r.ok) {
        const body = await r.json();
        const v = body && body.endpoints && body.endpoints.adk;
        const u = typeof v === "string" ? new URL(v) : null;
        if (u && u.protocol === "http:" && u.hostname === "127.0.0.1" && !u.username && !u.password) return u.origin;
      }
    } catch { /* no launcher: ordinary state */ }
    return ADK_FALLBACK;
  }

  /** adk first, then the rest of the contract order, without repeating adk's base. */
  async function localBases() {
    const adk = await adkBase();
    return { adk, bases: [adk, ...NODE_PORTS.filter((b) => b !== adk)] };
  }

  async function probeNode() {
    const { bases } = await localBases();
    for (const u of bases) {
      try {
        const r = await fetchImpl(`${u}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return { online: true, baseUrl: u };
      } catch { /* next */ }
    }
    return { online: false };
  }

  /** The worker's daemon-call: same probe order, and 401/403/404 mean "the next node". */
  async function daemonCall(method, callPath, body) {
    const m = String(method || "GET").toUpperCase();
    const p = String(callPath || "");
    if (!DAEMON_ALLOWED.has(`${m} ${p}`)) return { ok: false, error: `path not allowed: ${m} ${p}` };
    let route = `${m} ${p}`;
    if (route === "POST /mcp") {
      const rpc = body && typeof body === "object" && !Array.isArray(body) ? body : null;
      if (!rpc || rpc.jsonrpc !== "2.0" || !MCP_METHODS.has(rpc.method)) {
        return { ok: false, error: `mcp method not allowed: ${rpc && typeof rpc.method === "string" ? rpc.method : "(none)"}` };
      }
      route = `POST /mcp ${rpc.method}`;
      if (rpc.method === "tools/call") {
        const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params) ? rpc.params : null;
        const name = params && typeof params.name === "string" ? params.name : "";
        if (!BROWSER_SAFE_TOOLS.has(name)) {
          return { ok: false, error: `tool not allowed from a browser origin: ${name || "(none)"} (read-only filesystem and web search only)` };
        }
      }
    }
    const { adk, bases } = await localBases();
    let last = "no local node answered";
    for (const base of bases) {
      try {
        const health = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(1500) });
        if (!health.ok) continue;
        const headers = { "Content-Type": "application/json" };
        if (BROWSER_RELAYED_ROUTES.has(route)) headers["Sec-Fetch-Site"] = "cross-site";
        if (base === adk && DAEMON_TOKEN_ROUTES.has(route)) {
          let local = "";
          try { local = fsImpl.readFileSync(tokenFile, "utf8").trim(); } catch { /* no token: the daemon decides */ }
          if (local) headers["X-Aither-Local-Token"] = local;
        }
        const res = await fetchImpl(`${base}${p}`, {
          method: m, headers,
          body: m === "POST" ? JSON.stringify(body || {}) : undefined,
          signal: AbortSignal.timeout(m === "POST" ? 180_000 : 15_000),
        });
        if (NEXT_NODE_STATUS.has(res.status)) {
          last = `the local node at ${base} answered ${res.status} to ${m} ${p}`;
          continue;
        }
        const data = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, data, baseUrl: base };
      } catch (e) {
        // A live node that timed out says so: "no node" would send the owner looking
        // for a daemon that is running with an unhealthy model behind it.
        if (e && e.name === "TimeoutError") last = `the local node at ${base} did not answer ${m} ${p} in time`;
      }
    }
    return { ok: false, error: last };
  }

  /** The node's first AVAILABLE model (its /v1/models health), idle before busy; null when none. */
  async function liveModel() {
    const r = await daemonCall("GET", "/v1/models");
    const list = r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : [];
    const up = list.filter((m) => m && m.aither && m.aither.available);
    const pick = up.find((m) => !m.aither.busy) || up[0];
    return pick ? String(pick.id) : null;
  }

  async function compose(msg) {
    // The node's DEFAULT model may be down (measured 2026-10-04: aither-orchestrator
    // unavailable, the call hung 120 s+); ask for one its own health says is up.
    const model = await liveModel();
    if (!model) return { ok: false, reason: "no-local-model", error: "the local node lists no available model" };
    const r = await daemonCall("POST", "/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: String(msg.prompt || "") }],
      max_tokens: Math.min(Number(msg.maxTokens) || 256, 2048),
      temperature: Number.isFinite(Number(msg.temperature)) ? Number(msg.temperature) : 0.7,
    });
    const text = r.ok && r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message
      ? String(r.data.choices[0].message.content || "") : "";
    return text ? { ok: true, text } : { ok: false, reason: "no-local-model",
      error: r.error || (r.data && r.data.error ? String(r.data.error.message || r.data.error) : "the local node gave no text") };
  }

  /** What background.js would answer. Never throws. */
  async function answer(msg) {
    // 4.x: {type:"awconnect:living-os", op, ...payload} -> the 3.x type of the same answer.
    const type = msg && msg.type === LIVING_OS_MESSAGE
      ? (Object.prototype.hasOwnProperty.call(LIVING_OS_OPS, msg.op) ? LIVING_OS_OPS[msg.op] : `op ${String(msg.op)}`)
      : msg && msg.type;
    if (type === "os-token-request") return { token: await token() };
    // 4.x posts {identity:null} on to the OS as a SIGN-OUT (its awc_auth listener asks
    // with clearOnEmpty, and authScript fires that listener on sign-in and on every
    // bearer-cookie refresh too). Main has no identity to give, so while signed in it
    // answers with no identity key at all: the bridge posts nothing and the OS keeps its
    // session. 3.x only ever posts a present identity, so null stays its answer.
    if (type === "os-identity-request") {
      if (msg && msg.type === LIVING_OS_MESSAGE) return (await token()) ? {} : { identity: null };
      return { identity: null };
    }
    if (type === "probe-node") return probeNode();
    if (type === "site-adapter") return { ok: true, adapter: adapterFor(adapters(), msg.url) };
    if (type === "daemon-call") return daemonCall(msg.method, msg.path, msg.body);
    if (type === "os-compose") return compose(msg);
    return { ok: false, error: `${String(type || "this request")} is not answered inside the Aither Browser yet` };
  }

  async function serve(wc, generation) {
    while (!wc.isDestroyed() && loops.get(wc) === generation) {
      let reqs;
      try { reqs = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: "typeof __aitherTake === 'function' ? __aitherTake() : null" }]); } catch { return; }
      if (loops.get(wc) !== generation) return;
      for (const req of Array.isArray(reqs) ? reqs : []) {
        if (!req || typeof req.id !== "number") continue;
        void answer(req.msg).catch(() => ({ ok: false, error: "failed" })).then((res) => {
          if (loops.get(wc) !== generation || wc.isDestroyed()) return;
          return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `__aitherReply(${req.id}, ${JSON.stringify(res)})` }]);
        }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /** Put the overlay on this page (idempotent per document). */
  async function inject(wc) {
    if (!wc || wc.isDestroyed() || !overlayAllowed(wc.getURL())) return { ok: false, error: "not a web page" };
    const sources = bridgeSources();
    if (!sources) return { ok: false, error: "no awconnect build is staged (adk awconnect setup stages one)" };
    await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SHIM }]);
    const generation = (loops.get(wc) || 0) + 1;
    loops.set(wc, generation);
    live.add(wc);
    void serve(wc, generation);
    // One script per file, in order, as chrome.scripting.executeScript({files}) runs them.
    for (const code of sources) await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
    return { ok: true };
  }

  async function remove(wc) {
    if (!wc || wc.isDestroyed()) return;
    loops.delete(wc);
    live.delete(wc);
    try { await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: TEARDOWN }]); } catch { /* gone */ }
  }

  /** A new document: its world (and the old loop's promise) are gone. */
  function forget(wc) { loops.delete(wc); live.delete(wc); }

  /**
   * The Online session signed in or out: tell every page the overlay is on (C2). Out
   * posts identity:null + token:null to the OS frame; either way the bridge re-asks.
   */
  async function authChanged(signedIn) {
    const code = authScript(Boolean(signedIn));
    await Promise.all([...live].map(async (wc) => {
      if (wc.isDestroyed()) { live.delete(wc); return; }
      try { await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); } catch { /* navigating */ }
    }));
  }

  /** The overlay's OS frame in this page, or null. */
  function osFrame(wc) {
    if (!wc || wc.isDestroyed() || !wc.mainFrame) return null;
    return wc.mainFrame.framesInSubtree.find((f) => f !== wc.mainFrame && f.origin === OS_ORIGIN) || null;
  }

  /**
   * Follow the Online session's bearer cookie: a sign-out there must reach the OS frames
   * the overlay is on (C2), not wait for their next token request. Debounced, and the
   * verdict is the cookie jar's, not the event's: an overwrite fires removed-then-set.
   */
  const watched = new WeakSet();
  let authTimer = null;
  function watchAuth() {
    const ses = session();
    if (!ses || !ses.cookies || typeof ses.cookies.on !== "function" || watched.has(ses)) return false;
    watched.add(ses);
    ses.cookies.on("changed", (_event, cookie) => {
      if (!cookie || cookie.name !== TOKEN_COOKIE) return;
      clearTimeout(authTimer);
      authTimer = setTimeout(() => { void token().then((t) => authChanged(Boolean(t))).catch(() => {}); }, 250);
    });
    return true;
  }

  return { inject, remove, forget, osFrame, answer, authChanged, watchAuth, bridgeSource, bridgeSources };
}

module.exports = { WORLD, OS_ORIGIN, SHIM, TEARDOWN, BRIDGE_SETS, LIVING_OS_MESSAGE, DAEMON_ALLOWED, BROWSER_SAFE_TOOLS,
  authScript, createOverlay, overlayAllowed, adapterFor };
