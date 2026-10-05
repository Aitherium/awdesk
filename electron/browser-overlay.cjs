"use strict";

/**
 * browser-overlay.cjs -- AitherOS Online drawn OVER any web page, inside the Aither
 * Browser: the awconnect overlay, at parity (owner, 2026-10-04: "the aitheros online
 * desktop apps can draw over whatever web page like it does in a web browser with
 * awconnect in edge/chrome").
 *
 * PARITY BY REUSE. The page half is awconnect's OWN content/aither-overlay-bridge.js,
 * read from the staged build (browser-extensions.cjs awconnectDir): the transparent
 * aitherium.com/?mode=overlay iframe, the clip to the OS's os-regions, Alt+` interact,
 * the os->page automation. Only the extension's SERVICE-WORKER half is replaced: the
 * bridge's chrome.runtime calls land in a shim in an ISOLATED world (the page never
 * sees it), which main long-polls, and main answers what background.js answers:
 *
 *   os-token-request     the bearer the overlay attaches (the iframe is third-party, so
 *                        the session cookie never reaches it -- background.js's reason).
 *                        Read from the signed-in Online partition; it goes out only
 *                        pinned to the OS origin (the bridge's postMessage), never logged.
 *   os-identity-request  null: the OS keeps what its own verify found with that bearer.
 *   site-adapter         awconnect's adapters/*.json, matched the way background.js does.
 *   probe-node           the same loopback ports background.js probes.
 *   daemon-call          background.js's EXACT method+path allowlist onto the local node.
 *   os-compose           on this machine's local brain (the node's chat completions); the
 *                        extension runs a WebGPU model in its worker, main has no WebGPU.
 *   anything else        refused by name.
 */

const fs = require("node:fs");
const path = require("node:path");

/** The isolated world the bridge runs in (Electron: any id >= 1000 is ours). */
const WORLD = 1013;
const BRIDGE_FILE = path.join("content", "aither-overlay-bridge.js");
const OS_ORIGIN = "https://aitherium.com";
const TOKEN_COOKIE = "aither_auth_token";
const TOKEN_URLS = Object.freeze(["https://aitherium.com", "https://app.aitherium.com", "https://portal.aitherium.com"]);
const NODE_PORTS = Object.freeze(["http://127.0.0.1:8090", "http://127.0.0.1:8000", "http://127.0.0.1:9001", "http://127.0.0.1:8080"]);
/** background.js daemon-call: EXACT method + path, never a prefix (a loopback SSRF surface). */
const DAEMON_ALLOWED = Object.freeze(new Set([
  "GET /health", "GET /info", "GET /v1/models", "POST /v1/chat/completions", "GET /tools", "POST /tools/call",
]));

/**
 * Routes that carry the owner's local daemon token (~/.aither/daemon-token). Reads and
 * local chat only: POST /tools/call runs tools with filesystem access, and a remote
 * origin driving them needs more than an open overlay -- it goes without the token
 * (the daemon refuses it, exactly as it refuses awconnect in Chrome).
 */
const DAEMON_TOKEN_ROUTES = Object.freeze(new Set([
  "GET /health", "GET /info", "GET /v1/models", "POST /v1/chat/completions", "GET /tools",
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
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) { const id = ++seq; if (typeof cb === "function") pending.set(id, cb); push({ id, msg }); },
      onMessage: { addListener(fn) { if (typeof fn === "function") listeners.push(fn); } },
    },
  };
})();`;

/** Remove the overlay from the page (the bridge's own ids), so a later toggle re-injects it. */
const TEARDOWN = `(() => {
  for (const id of ["aither-os-overlay", "aither-os-hint"]) { const el = document.getElementById(id); if (el) el.remove(); }
  for (const b of document.querySelectorAll("button")) { if (b.parentElement === document.documentElement && /^(\\u25be|\\u26a1)$/.test(b.textContent)) b.remove(); }
  window.__aitherOverlay = false;
  return true;
})()`;

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

  function bridgeSource() {
    const d = dir();
    if (!d) return null;
    try { return fsImpl.readFileSync(path.join(d, BRIDGE_FILE), "utf8"); } catch { return null; }
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

  async function probeNode() {
    for (const u of NODE_PORTS) {
      try {
        const r = await fetchImpl(`${u}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return { online: true, baseUrl: u };
      } catch { /* next */ }
    }
    return { online: false };
  }

  /** background.js daemon-call, same probe order and the same 404-means-next-node rule. */
  async function daemonCall(method, callPath, body) {
    const m = String(method || "GET").toUpperCase();
    const p = String(callPath || "");
    if (!DAEMON_ALLOWED.has(`${m} ${p}`)) return { ok: false, error: `path not allowed: ${m} ${p}` };
    let last = "no local node answered";
    for (const base of NODE_PORTS) {
      try {
        const health = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(1500) });
        if (!health.ok) continue;
        const headers = { "Content-Type": "application/json" };
        if (DAEMON_TOKEN_ROUTES.has(`${m} ${p}`)) {
          let local = "";
          try { local = fsImpl.readFileSync(tokenFile, "utf8").trim(); } catch { /* no token: the daemon decides */ }
          if (local) headers["X-Aither-Local-Token"] = local;
        }
        const res = await fetchImpl(`${base}${p}`, {
          method: m, headers,
          body: m === "POST" ? JSON.stringify(body || {}) : undefined,
          signal: AbortSignal.timeout(m === "POST" ? 180_000 : 15_000),
        });
        if (res.status === 404) continue;
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
    const type = msg && msg.type;
    if (type === "os-token-request") return { token: await token() };
    if (type === "os-identity-request") return { identity: null };
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
    const source = bridgeSource();
    if (!source) return { ok: false, error: "no awconnect build is staged (adk awconnect setup stages one)" };
    await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SHIM }]);
    const generation = (loops.get(wc) || 0) + 1;
    loops.set(wc, generation);
    void serve(wc, generation);
    await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: source }]);
    return { ok: true };
  }

  async function remove(wc) {
    if (!wc || wc.isDestroyed()) return;
    loops.delete(wc);
    try { await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: TEARDOWN }]); } catch { /* gone */ }
  }

  /** A new document: its world (and the old loop's promise) are gone. */
  function forget(wc) { loops.delete(wc); }

  /** The overlay's OS frame in this page, or null. */
  function osFrame(wc) {
    if (!wc || wc.isDestroyed() || !wc.mainFrame) return null;
    return wc.mainFrame.framesInSubtree.find((f) => f !== wc.mainFrame && f.origin === OS_ORIGIN) || null;
  }

  return { inject, remove, forget, osFrame, answer, bridgeSource };
}

module.exports = { WORLD, OS_ORIGIN, SHIM, TEARDOWN, createOverlay, overlayAllowed, adapterFor };
