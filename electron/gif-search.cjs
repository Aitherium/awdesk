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
const KEY_NOTE = "Searching the web for GIFs. Better results with a key: TENOR_API_KEY or GIPHY_API_KEY in the vault.";

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

// ── keyless: the web adapter (2026-11-07) ────────────────────────────────────
//
// No Tenor or Giphy key exists in the vault, so with no key the picker searches
// through the desk's OWN web search (search-client.cjs `awfind q`, the same path the
// launcher's Web group and the spirit's web trip use -- DuckDuckGo behind awfind) and
// maps result pages to media with no key:
//
//   giphy.com/gifs/<slug>-<ID>     -> media.giphy.com/media/<ID>/giphy.gif (+ 200w.gif preview)
//   giphy.com/explore|search/...   -> the page's own gif links and media ids, read once
//   tenor.com/view/...             -> the page's og:image, only when it is a .gif on
//                                     Tenor's media host (no keyless direct mapping)
//
// awfind's provider ignores `site:`, so the query is "giphy <words> gifs"; when the
// web answers with no Giphy page, giphy.com/search/<words> is read directly. Only
// giphy.com / tenor.com pages are ever fetched (https, 8 s, 2 MB). Results carry no
// rating, so with the adult gate CLOSED only GIFs whose slug names them are kept and
// a word filter drops anything suggestive. Deduped, at most 24.

const WEB_LIMIT = 24;
const GIPHY_PAGE = /^https:\/\/(?:www\.)?giphy\.com\/(?:gifs|stickers)\/(?:([A-Za-z0-9-]*?)-)?([A-Za-z0-9]{6,40})\/?(?:[?#].*)?$/;
const GIPHY_LIST = /^https:\/\/(?:www\.)?giphy\.com\/(?:explore|search)\/[^?#]+/;
const TENOR_VIEW = /^https:\/\/(?:www\.)?tenor\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?view\/[A-Za-z0-9-]+/;
const FETCH_HOSTS = /^(?:www\.)?(?:giphy\.com|tenor\.com)$/i;
// Strict mode's word filter (on the slug/title a GIF page gives it).
const UNSAFE = /\b(nsfw|sexy|sex|sexual|nude|nudes|naked|porn|xxx|boobs?|butt|booty|twerk(ing)?|thong|lingerie|hentai|horny|thirsty|stripper|drunk|weed|stoned|gore|bloody|blood|kill(ing)?|gun|shoot(ing)?|fuck|shit|bitch|damn|wtf)\b/i;

function slugTitle(slug) {
  const t = String(slug || "").replace(/-/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "GIF";
}

/** {id, slug} for a giphy.com/gifs|stickers page, else null. */
function giphyFromPage(url) {
  const m = GIPHY_PAGE.exec(String(url || ""));
  return m ? { id: m[2], slug: m[1] || "" } : null;
}

function giphyResult(id, slug) {
  return {
    id: `web:giphy:${id}`, provider: "web", title: slugTitle(slug).slice(0, 120),
    url: `https://media.giphy.com/media/${id}/giphy.gif`,
    preview: `https://media.giphy.com/media/${id}/200w.gif`,
    width: 0, height: 0, slug: String(slug || ""),
  };
}

/** Every GIF a Giphy list page (explore/search) names: its gif links first, then bare media ids. */
function parseGiphyHtml(html) {
  const text = String(html || "");
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(/giphy\.com\/(?:gifs|stickers)\/([A-Za-z0-9-]*?)-([A-Za-z0-9]{6,40})(?=["'\\/?\s<])/g)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push(giphyResult(m[2], m[1]));
  }
  for (const m of text.matchAll(/media\d*\.giphy\.com\/media\/(?:v1\.[A-Za-z0-9_.=-]+\/)?([A-Za-z0-9]{6,40})\//g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(giphyResult(m[1], ""));
  }
  return out;
}

/** A Tenor page's og:image, when it is a .gif on Tenor's media host; else null. */
function tenorOgGif(html, pageUrl = "") {
  const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(String(html || ""))
    || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(String(html || ""));
  const url = m ? mediaUrl(m[1]) : null;
  if (!url || !/\.gif(?:$|\?)/i.test(new URL(url).pathname + new URL(url).search)) return null;
  const slug = (/\/view\/([A-Za-z0-9-]+)/.exec(String(pageUrl)) || [])[1] || "";
  const id = slug ? slug.replace(/-gif-/, "-").slice(-40) : new URL(url).pathname.split("/").filter(Boolean)[0];
  return { id: `web:tenor:${id}`, provider: "web", title: slugTitle(slug.replace(/-gif-\d+$/, "")).slice(0, 120),
    url, preview: url, width: 0, height: 0, slug };
}

/** Strict (gate closed): only GIFs with a slug, and nothing the word filter flags. */
function safeForStrict(item) {
  if (!item.slug) return false;
  return !UNSAFE.test(String(item.slug).replace(/-/g, " ")) && !UNSAFE.test(item.title || "");
}

/** The desk's own web search (search-client.cjs, awfind) -> [{url, title}]. */
async function deskWebSearch(query, { limit = 10, signal = null } = {}) {
  const client = require("./search-window.cjs").client();
  const r = await client.search("q", query, { limit, signal });
  if (!r || !r.ok) throw new Error((r && r.error) || "the web search did not answer");
  return (r.results || []).map((row) => ({ url: String(row.url || ""), title: String(row.title || "") }));
}

/** Fetch one giphy.com / tenor.com page (https only, 8 s, 2 MB). Resolves "" on any failure. */
async function fetchGifPage(url, { fetchImpl = (...a) => fetch(...a), timeoutMs = 8000 } = {}) {
  let u;
  try { u = new URL(url); } catch { return ""; }
  if (u.protocol !== "https:" || !FETCH_HOSTS.test(u.hostname)) return "";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const res = await fetchImpl(u.toString(), { signal: ctl.signal, redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) awdesk", accept: "text/html" } });
    if (!res || !res.ok) return "";
    const text = await res.text();
    return String(text).slice(0, 2 * 1024 * 1024);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The keyless source. search(query) -> {ok, results, pages} | {ok:false, reason, offline?}.
 * `webSearch(q, {limit})` and `fetchPage(url)` are injected (tests replay fixtures).
 */
function createWebGifSource({ webSearch = deskWebSearch, fetchPage = (u) => fetchGifPage(u), strict = () => true } = {}) {
  async function search(query, { limit = WEB_LIMIT } = {}) {
    const q = cleanQuery(query);
    if (!q) return { ok: false, reason: "type a word to search GIFs" };
    const cap = Math.max(1, Math.min(WEB_LIMIT, Math.trunc(Number(limit)) || WEB_LIMIT));
    let rows;
    try {
      const [giphy, tenor] = await Promise.all([
        webSearch(`giphy ${q} gifs`, { limit: 10 }),
        webSearch(`tenor ${q} gif`, { limit: 6 }).catch(() => []),
      ]);
      rows = [...(giphy || []), ...(tenor || [])];
    } catch (error) {
      return { ok: false, offline: true, reason: `the web search did not answer (${String((error && error.message) || error).slice(0, 120)})` };
    }
    const results = [];
    const seen = new Set();
    const add = (item) => {
      if (!item || seen.has(item.id) || !mediaUrl(item.url)) return;
      seen.add(item.id);
      results.push(item);
    };
    const lists = [];
    const tenors = [];
    for (const row of rows) {
      const page = giphyFromPage(row.url);
      if (page) add(giphyResult(page.id, page.slug));
      else if (GIPHY_LIST.test(row.url)) lists.push(row.url);
      else if (TENOR_VIEW.test(row.url)) tenors.push(row.url);
    }
    // No Giphy list page from the web: read Giphy's own search page for the words.
    if (!lists.length && results.length < cap) lists.push(`https://giphy.com/search/${encodeURIComponent(q.replace(/\s+/g, "-"))}`);
    for (const url of lists.slice(0, 2)) {
      if (results.length >= cap * 2) break;
      for (const item of parseGiphyHtml(await fetchPage(url))) add(item);
    }
    for (const url of tenors.slice(0, 3)) add(tenorOgGif(await fetchPage(url), url));
    const isStrict = (() => { try { return strict() !== false; } catch { return true; } })();
    const kept = (isStrict ? results.filter(safeForStrict) : results).slice(0, cap);
    return { ok: true, results: kept, pages: lists.length + tenors.length };
  }
  return { search };
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
  // The keyless web adapter (above); null turns it off (tests of the key path).
  web = undefined,
} = {}) {
  const webSource = web === null ? null : (web || createWebGifSource({ strict }));
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
    if (!chosen) {
      if (!webSource) return { ok: false, needsKey: true, reason: ADD_KEY };
      // No key: the web adapter. A key is an upgrade (better ranking, sizes), not a wall.
      const r = await webSource.search(query, { limit: Math.min(Number(limit) || WEB_LIMIT, WEB_LIMIT) });
      if (!r.ok) return { ok: false, needsKey: true, offline: Boolean(r.offline), reason: `${r.reason} — or ${ADD_KEY}` };
      const results = r.results.map((item) => { const rest = { ...item }; delete rest.slug; return rest; });
      remember(results);
      const isStrict = (() => { try { return strict() !== false; } catch { return true; } })();
      return { ok: true, provider: "web", rating: isStrict ? "word-filtered" : "web", query, results, note: KEY_NOTE };
    }
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
  /** "ready" (a key) | "web" (keyless search) | "needs-key" (neither). */
  async function keyStatus() {
    if (await pick()) return "ready";
    return webSource ? "web" : "needs-key";
  }

  return {
    search,
    keyStatus,
    lookup: (id) => known.get(String(id || "")) || null,
    forgetKeys: () => keys.clear(),
  };
}

module.exports = {
  PROVIDERS, KEY_NAMES, ADD_KEY, KEY_NOTE, MEDIA_HOST, WEB_LIMIT,
  giphyFromPage, giphyResult, parseGiphyHtml, tenorOgGif, safeForStrict, createWebGifSource, fetchGifPage, deskWebSearch,
  cleanQuery, mediaUrl, ratingFor, requestUrl, parseTenor, parseGiphy, secretValue, createGifSearch, defaultStrict,
};
