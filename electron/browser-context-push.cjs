"use strict";

/**
 * browser-context-push.cjs -- the Aither Browser tells AitherDesktop what is open.
 *
 * AitherDesktop's "what is the user looking at" tools (browser_context,
 * browser_context_history, the desk's desktopSnapshot) read Genesis
 * /browser/agent-context, which only awconnect fed: a page open in the Aither
 * Browser was invisible to every agent asking. This module pushes the same shape
 * awconnect pushes, through the same door awconnect uses by default: Veil's
 * Genesis bridge on loopback (:3000/api/bridge/genesis), plain HTTP, the session
 * bearer. Measured 2026-10-03: the gateway :8182 has no /proxy/genesis (404) and
 * awnode :8090 was not listening; the Veil bridge answered 200.
 * DESK_GENESIS_BRIDGE_URL overrides the base.
 *
 * What it sends is the page's MACHINE layer (title, language, OpenGraph, JSON-LD,
 * feeds, form field NAMES and labels) -- never page text and never a field VALUE.
 * DESK_BROWSER_CONTEXT_PUSH=0 turns it off. Fails soft: a dead gateway or a 401 is
 * a verdict ({ok:false,status}), never an exception into the window.
 */

const { bearer } = require("./gateway-mcp.cjs");

const GENESIS_BRIDGE_URL = String(process.env.DESK_GENESIS_BRIDGE_URL || "http://127.0.0.1:3000/api/bridge/genesis")
  .replace(/\/+$/, "");
const PUSH_PATH = "/browser/agent-context/push";
const SOURCE = "aither-browser";
const MAX_JSONLD = 5;
const MAX_JSONLD_CHARS = 4000;
const MAX_FORMS = 10;
const MAX_FIELDS = 20;
const PUSH_TIMEOUT_MS = 5000;

function enabled(env = process.env) {
  return String(env.DESK_BROWSER_CONTEXT_PUSH ?? "1") !== "0";
}

/** Only real web pages are worth telling the desktop about. */
function pushable(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The isolated-world script that reads the page's machine layer. Pure string,
 * no arguments. Never reads a field's value or the body text.
 */
const CONTEXT_SCRIPT = `(() => {
  const clean = (t, n = 200) => String(t == null ? "" : t).replace(/\\s+/g, " ").trim().slice(0, n);
  const og = {};
  for (const m of document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')) {
    const key = m.getAttribute("property") || m.getAttribute("name");
    if (key && Object.keys(og).length < 30) og[key] = clean(m.getAttribute("content"), 300);
  }
  const jsonLd = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (jsonLd.length >= ${MAX_JSONLD}) break;
    const raw = String(s.textContent || "");
    if (raw.length > ${MAX_JSONLD_CHARS}) continue;
    try { jsonLd.push(JSON.parse(raw)); } catch (e) { /* a broken block is skipped, not guessed */ }
  }
  const feeds = Array.from(document.querySelectorAll('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]'))
    .slice(0, 10).map((l) => ({ title: clean(l.title, 120), href: l.href, type: l.type }));
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria, 80);
    if (el.id) {
      try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.textContent, 80); }
      catch (e) { /* an id CSS.escape cannot handle */ }
    }
    const wrap = el.closest("label");
    if (wrap) {
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll("select, textarea, input, button, option").forEach((n) => n.remove());
      if (clean(copy.textContent)) return clean(copy.textContent, 80);
    }
    return clean(el.placeholder || el.name, 80);
  };
  const forms = Array.from(document.forms).slice(0, ${MAX_FORMS}).map((f) => ({
    action: clean(f.action, 300), method: clean(f.method, 10),
    fields: Array.from(f.elements).filter((e) => e.type !== "hidden" && e.tagName !== "FIELDSET")
      .slice(0, ${MAX_FIELDS}).map((e) => ({ name: clean(e.name, 80), type: clean(e.type, 30), label: labelOf(e) })),
  }));
  return { url: location.href, origin: location.origin, pathname: location.pathname, title: clean(document.title, 300),
    lang: clean(document.documentElement.lang, 20), opengraph: og, json_ld: jsonLd, feeds, forms };
})()`;

/**
 * The push body: the router's BrowserContextPush shape, with this window named
 * as the source.
 */
function buildPush(page, { trigger = "page_loaded", dwellMs = 0, now = () => new Date() } = {}) {
  const p = page && typeof page === "object" ? page : {};
  const richness = (p.json_ld && p.json_ld.length ? 3 : 0) + (p.opengraph && Object.keys(p.opengraph).length ? 2 : 0)
    + (p.feeds && p.feeds.length ? 1 : 0) + (p.forms && p.forms.length ? 1 : 0);
  return {
    url: String(p.url || ""),
    origin: p.origin || null,
    pathname: p.pathname || null,
    title: p.title || null,
    lang: p.lang || null,
    timestamp: now().toISOString(),
    opengraph: p.opengraph || {},
    json_ld: Array.isArray(p.json_ld) ? p.json_ld : [],
    feeds: Array.isArray(p.feeds) ? p.feeds : [],
    forms: Array.isArray(p.forms) ? p.forms : [],
    agent_richness_score: richness,
    trigger,
    source: SOURCE,
    dwell_ms: Math.max(0, Math.floor(Number(dwellMs) || 0)),
  };
}

/** POST one push. Resolves {ok, status}, never rejects. */
function postPush(body, { url = GENESIS_BRIDGE_URL + PUSH_PATH, token = bearer(), request = null } = {}) {
  return new Promise((resolve) => {
    if (!token) return resolve({ ok: false, status: 0, reason: "no session bearer" });
    const data = Buffer.from(JSON.stringify(body));
    let req;
    try {
      const http = request || require("node:http");
      req = http.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length, Authorization: `Bearer ${token}` },
        timeout: PUSH_TIMEOUT_MS,
      }, (res) => {
        res.resume();
        res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      });
    } catch (error) {
      return resolve({ ok: false, status: 0, reason: String(error && error.message || error) });
    }
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ ok: false, status: 0, reason: String(error && error.message || error) }));
    req.end(data);
  });
}

module.exports = { CONTEXT_SCRIPT, GENESIS_BRIDGE_URL, PUSH_PATH, SOURCE, buildPush, enabled, postPush, pushable };
