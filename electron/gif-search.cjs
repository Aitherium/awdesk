"use strict";

/**
 * gif-search.cjs -- GIF search for the desk (owner 2026-11-07: "searching for
 * GIFs and pinning them on the desktop"). ONE interface over two providers:
 *
 *   tenor   Tenor API v2  GET https://tenor.googleapis.com/v2/search
 *           key: TENOR_API_KEY   filter: contentfilter=high (G) | medium (PG-13)
 *   giphy   Giphy API v1  GET https://api.giphy.com/v1/gifs/search
 *           key: GIPHY_API_KEY   filter: rating=g | pg-13
 *
 * search(query) -> {ok:true, provider, results:[GifResult]} | {ok:false, reason, needsKey?}
 *   GifResult = {id, provider, title, url, preview, width, height}
 *   `id` is "<provider>:<their id>"; the renderer only ever hands an id back and
 *   main resolves it through lookup() -- a page never names a URL to fetch.
 *
 * KEYS come from the vault, never from code, env or the renderer: the injected
 * getSecret(name) defaults to the gateway's get_secret MCP tool (gateway-mcp.cjs,
 * the desk's one door to the fleet). A key is held in this module's memory only,
 * is never logged, and never appears in a reason: a failed request reports the
 * HTTP status, never the URL (the URL carries the key). No key anywhere = the
 * {needsKey:true} state, which the picker renders as "add a GIF key".
 *
 * CONTENT RATING is always on. strict() (default: content-rating.cjs's adult gate
 * closed, or a kid desk) selects the G filter; otherwise PG-13. There is no path
 * to an unfiltered search.
 *
 * Electron-free; fetch, the key reader, the clock and strict() are injected so
 * gif-search.test.cjs runs it against fixtures under `node --test`.
 */

const PROVIDERS = Object.freeze(["tenor", "giphy"]);
const KEY_NAMES = Object.freeze({ tenor: "TENOR_API_KEY", giphy: "GIPHY_API_KEY" });
const MAX_QUERY = 100;
const DEFAULT_LIMIT = 24;
const KEY_TTL_MS = 10 * 60_000;
const NO_KEY_TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const MEDIA_HOST = /^(media\d*\.tenor\.com|c\.tenor\.com|media\d*\.giphy\.com|i\.giphy\.com)$/i;
const ADD_KEY = "add a GIF key — store TENOR_API_KEY (or GIPHY_API_KEY) in the vault, then search again";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function cleanQuery(text) {
  return String(text == null ? "" : text).replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
}

/** Only https media from the provider CDNs survives into a result. */
function mediaUrl(text) {
  try {
    const url = new URL(String(text || ""));
    if (url.protocol !== "https:" || !MEDIA_HOST.test(url.hostname) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The rating parameter each provider takes, strict (G) or standard (PG-13). */
function ratingFor(provider, strict) {
  if (provider === "tenor") return strict ? "high" : "medium";
  return strict ? "g" : "pg-13";
}

function requestUrl(provider, { query, key, limit, strict }) {
  const n = String(Math.max(1, Math.min(50, Math.trunc(Number(limit)) || DEFAULT_LIMIT)));
  if (provider === "tenor") {
    const q = new URLSearchParams({ q: query, key, client_key: "awdesk", limit: n,
      contentfilter: ratingFor("tenor", strict), media_filter: "gif,tinygif" });
    return `https://tenor.googleapis.com/v2/search?${q.toString()}`;
  }
  const q = new URLSearchParams({ api_key: key, q: query, limit: n, rating: ratingFor("giphy", strict), lang: "en" });
  return `https://api.giphy.com/v1/gifs/search?${q.toString()}`;
}

function dims(a) {
  return Array.isArray(a) && a.length >= 2 ? { width: Number(a[0]) || 0, height: Number(a[1]) || 0 } : { width: 0, height: 0 };
}

/** Tenor v2 JSON -> GifResult[]. Rows without a usable https CDN URL are dropped. */
function parseTenor(json) {
  const rows = json && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const r of rows) {
    if (!r || !r.id || !r.media_formats) continue;
    const full = r.media_formats.gif || {};
    const tiny = r.media_formats.tinygif || full;
    const url = mediaUrl(full.url);
    const preview = mediaUrl(tiny.url) || url;
    if (!url) continue;
    const d = dims(full.dims);
    out.push({ id: `tenor:${String(r.id).slice(0, 40)}`, provider: "tenor",
      title: String(r.content_description || r.title || "GIF").slice(0, 120), url, preview, ...d });
  }
  return out;
}

/** Giphy v1 JSON -> GifResult[]. */
function parseGiphy(json) {
  const rows = json && Array.isArray(json.data) ? json.data : [];
  const out = [];
  for (const r of rows) {
    if (!r || !r.id || !r.images) continue;
    const full = r.images.original || r.images.downsized || {};
    const small = r.images.fixed_width_small || r.images.fixed_width || full;
    const url = mediaUrl(full.url);
    const preview = mediaUrl(small.url) || url;
    if (!url) continue;
    out.push({ id: `giphy:${String(r.id).slice(0, 40)}`, provider: "giphy",
      title: String(r.title || "GIF").slice(0, 120), url, preview,
      width: Number(full.width) || 0, height: Number(full.height) || 0 });
  }
  return out;
}

/**
 * The value a get_secret answer carries, or null. NEVER echoes the answer into an
 * error (plane-client parseToolJson would quote it -- not usable for a secret).
 */
function secretValue(answer) {
  if (answer == null) return null;
  let value = answer;
  if (typeof answer === "string") {
    const text = answer.trim();
    if (!text) return null;
    try { value = JSON.parse(text); } catch { return /^[A-Za-z0-9._~+/=-]{8,512}$/.test(text) ? text : null; }
  }
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || value.error) return null;
  for (const k of ["value", "secret", "data"]) {
    const v = value[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && typeof v.value === "string" && v.value.trim()) return v.value.trim();
  }
  return null;
}

/** The default key reader: the gateway's get_secret tool. Resolves null on any failure. */
async function vaultSecret(name) {
  try {
    const { callTool } = require("./gateway-mcp.cjs");
    return secretValue(await callTool("get_secret", { name }));
  } catch {
    return null;
  }
}

/** The adult gate (content-rating.cjs): closed or unreadable = strict. */
function defaultStrict() {
  try {
    const rating = require("./content-rating.cjs");
    return !(rating.isAdultContentVisible() && rating.getSafetyExplicitAllowed() !== false);
  } catch {
    return true;
  }
}

/**
 * @param {{getSecret?: (name: string) => Promise<string|null>, fetchImpl?: typeof fetch,
 *   strict?: () => boolean, now?: () => number, providers?: string[], timeoutMs?: number}} [opts]
 */
function createGifSearch({
  getSecret = vaultSecret,
  fetchImpl = (...args) => fetch(...args),
  strict = defaultStrict,
  now = () => Date.now(),
  providers = PROVIDERS,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const keys = new Map(); // provider -> {value|null, at}
  const known = new Map(); // result id -> GifResult (the last 400 seen)

  async function keyFor(provider) {
    const cached = keys.get(provider);
    if (cached && now() - cached.at < (cached.value ? KEY_TTL_MS : NO_KEY_TTL_MS)) return cached.value;
    let value;
    try { value = await getSecret(KEY_NAMES[provider]); } catch { value = null; }
    value = typeof value === "string" && value.trim() ? value.trim() : null;
    keys.set(provider, { value, at: now() });
    return value;
  }

  /** {provider, key} for the first provider with a key, else null. */
  async function pick() {
    for (const p of providers) {
      if (!PROVIDERS.includes(p)) continue;
      const key = await keyFor(p);
      if (key) return { provider: p, key };
    }
    return null;
  }

  function remember(results) {
    for (const r of results) known.set(r.id, r);
    while (known.size > 400) known.delete(known.keys().next().value);
  }

  async function search(text, { limit = DEFAULT_LIMIT, signal = null } = {}) {
    const query = cleanQuery(text);
    if (!query) return { ok: false, reason: "type a word to search GIFs" };
    const chosen = await pick();
    if (!chosen) return { ok: false, needsKey: true, reason: ADD_KEY };
    const isStrict = (() => { try { return strict() !== false; } catch { return true; } })();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    if (timer.unref) timer.unref();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(requestUrl(chosen.provider, { query, key: chosen.key, limit, strict: isStrict }),
        { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!res || !res.ok) {
        const status = res ? res.status : 0;
        if (status === 401 || status === 403) keys.delete(chosen.provider);
        return { ok: false, provider: chosen.provider,
          reason: `${chosen.provider} answered HTTP ${status}${status === 401 || status === 403 ? " — the GIF key was refused; replace it in the vault" : ""}` };
      }
      const json = await res.json();
      const results = chosen.provider === "tenor" ? parseTenor(json) : parseGiphy(json);
      remember(results);
      return { ok: true, provider: chosen.provider, rating: ratingFor(chosen.provider, isStrict), query, results };
    } catch (error) {
      const aborted = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
      return { ok: false, provider: chosen.provider,
        reason: aborted ? `${chosen.provider} took over ${Math.round(timeoutMs / 1000)} s` : `${chosen.provider} could not be reached` };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /** "ready" | "needs-key" -- for the picker's empty state. */
  async function keyStatus() {
    return (await pick()) ? "ready" : "needs-key";
  }

  return {
    search,
    keyStatus,
    lookup: (id) => known.get(String(id || "")) || null,
    forgetKeys: () => keys.clear(),
  };
}

module.exports = {
  PROVIDERS, KEY_NAMES, ADD_KEY, MEDIA_HOST,
  cleanQuery, mediaUrl, ratingFor, requestUrl, parseTenor, parseGiphy, secretValue, createGifSearch, defaultStrict,
};
