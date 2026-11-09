"use strict";
/**
 * `.aither` addresses and honest load failures for the desk browser.
 *
 * Public DNS cannot answer `.aither`, so `https://wiby.aither/` loaded as-is is a DNS
 * failure the tab rendered as a blank WHITE page (owner 2026-11-08: "why blank white
 * page, I hate it"). The AitherNet Index answers it: GET
 * https://index.aitherium.com/n/<name>.aither.json -> {type:"web", target:"https://..."}
 * (the same index services/perception/AitherBrowser.py resolves through). Only an https
 * `web` or `space` (AitherSpaces) route is followed -- never a guess, never a DNS lookup.
 *
 * Any main-frame failure renders a dark page that says what failed and why, instead of
 * leaving the view white.
 */

const INDEX_BASE = "https://index.aitherium.com";

/** The `<name>.aither` host in url, or "" when it is not an .aither address. */
function aitherKeyword(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let host;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return "";
  }
  return host.endsWith(".aither") && host.length > ".aither".length ? host : "";
}

/**
 * Resolve an .aither address to its indexed https target (keeping path/query when the
 * target is a bare origin). Non-.aither URLs pass through. Throws Error with a reason
 * the error page shows when the index has no web route or cannot be reached.
 */
async function resolveAitherUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const name = aitherKeyword(url);
  if (!name) return url;
  let hit;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    if (t.unref) t.unref();
    const res = await fetchImpl(`${INDEX_BASE}/n/${encodeURIComponent(name)}.json`, {
      signal: ctl.signal, headers: { "User-Agent": "AitherDesk (.aither resolver)" },
    });
    clearTimeout(t);
    if (res.status === 404) throw new Error(`${name} is not in the AitherNet Index`);
    if (!res.ok) throw new Error(`the AitherNet Index answered HTTP ${res.status} for ${name}`);
    hit = await res.json();
  } catch (error) {
    const msg = String((error && error.message) || error);
    if (/AitherNet Index/.test(msg)) throw error;
    throw new Error(`the AitherNet Index could not be reached (${msg})`, { cause: error });
  }
  const target = String((hit && hit.target) || "");
  if (!hit || (hit.type !== "web" && hit.type !== "space") || !target.startsWith("https://")) {
    throw new Error(`${name} is in the AitherNet Index but is not a web address`);
  }
  try {
    const src = new URL(String(url).includes("://") ? url : `https://${url}`);
    const dst = new URL(target);
    if ((dst.pathname === "/" || dst.pathname === "") && !dst.search && (src.pathname !== "/" || src.search)) {
      dst.pathname = src.pathname;
      dst.search = src.search;
    }
    return dst.toString();
  } catch {
    return target;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** A dark, self-contained page saying what failed -- never a white void. */
function errorPageUrl(url, reason) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Could not open ${esc(url)}</title>
<style>:root{color-scheme:dark}body{margin:0;background:#0b0f17;color:#e6edf3;font:14px/1.5 system-ui,sans-serif;
display:grid;place-items:center;min-height:100vh}main{max-width:620px;padding:32px}h1{font-size:18px;margin:0 0 8px}
code{background:#151b26;padding:2px 6px;border-radius:6px;word-break:break-all}p{color:#a9b4c6}</style></head>
<body><main><h1>This page didn't open</h1><p><code>${esc(url)}</code></p><p>${esc(reason)}</p>
<p>Check the address, or press reload to try again.</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = { INDEX_BASE, aitherKeyword, resolveAitherUrl, errorPageUrl };
