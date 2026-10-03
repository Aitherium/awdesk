"use strict";

/**
 * market-client — the Desk's window onto the Aitherium marketplace.
 *
 * One-stop-shop foundation (owner 2026-08-25: "browse agent packs from
 * aitherium + avatars ... one stop shop"): the desk panel and Aitheros Online
 * both need the SAME marketplace data. The MCP transport lives in
 * gateway-mcp.cjs (one transport, one identity story for every desk data
 * client); this module is only the marketplace shape on top of it. A down
 * gateway or missing bearer yields {ok:false, reason} — the panel renders
 * "market unavailable", never a half-truth.
 */

const { callTool } = require("./gateway-mcp.cjs");

/**
 * Browse the marketplace: query + optional type filter, sorted listings.
 * Returns {ok:true, listings:[{id,name,type,description,short,tags,price}]}
 * or {ok:false, listings:[], reason}.
 *
 * 🚨 `listings` is ALWAYS present, even on failure — the Deck panel reads
 * `market.listings.slice(...)` unconditionally, and a missing key crashed
 * the whole deck window to BLANK on every error path (measured 2026-08-27:
 * the panel opened empty, `Cannot read properties of undefined (reading
 * 'slice')` at boot, so the decisions list, the character gallery and the
 * settings tabs all read as dead buttons).
 */
async function browse(query = "", type = "", limit = 24) {
  try {
    const text = await callTool("agent_marketplace_browse", {
      query,
      // sort enum is popular|rating|newest|name|revenue — "recent" is a
      // validation error that silently reads as zero listings.
      sort: "newest",
      limit,
      ...(type ? { type } : {}),
    });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Some tools return plain prose; wrap it rather than guessing.
      return { ok: true, listings: [], note: text.slice(0, 500) };
    }
    if (!parsed.listings) {
      // A validation error (or prose) has no listings — say so loudly,
      // but keep the declared shape: the panel renders listings key
      // unconditionally (2026-08-27 blank-deck-window crash).
      return { ok: false, listings: [], reason: text.slice(0, 300) };
    }
    return { ok: true, listings: parsed.listings, count: parsed.count ?? parsed.listings.length };
  } catch (error) {
    return { ok: false, listings: [], reason: String(error?.message || error).slice(0, 300) };
  }
}

/** One listing's full detail (invoke/pricing metadata). */
async function detail(listingId) {
  try {
    const text = await callTool("agent_marketplace_get_listing", {
      listing_id: listingId,
    });
    return { ok: true, detail: text };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

// ─── the avatar store: your library + VRoid Hub, through the broker ──────────
//
// Owner, 2026-10-03 (W4-04): the Deck's Models section shows the signed-in
// person's OWN avatar library (Genesis /avatars, W2-11) and searches VRoid Hub
// with their OWN VRoid account (Genesis /avatars/vroid, W3-06). Genesis
// publishes no host port, so the desk goes through the portal's pass-through
// (Veil /api/avatars/* -> Genesis /avatars/*) with the person's Identity token
// from ~/.aither/auth.json (desk-session.cjs: the one login every local tool
// reads). The owner is decided by Genesis from that token; nothing here sends a
// user, tenant or workspace id. This replaces model-browser.py, the standalone
// python page whose VRoid search dialled a Persona MCP port (:47831) that no
// longer exists.
//
// Every function keeps its declared shape on every path (`avatars`/`models`
// always arrays) -- the same blank-deck crash class browse() pins above.

const STORE_TIMEOUT_MS = 20000;
/** Mirrors lib/avatars/library.py MAX_VRM_BYTES: a body larger than the
 *  library would ever store is not a model, it is a fault. */
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const VROID_SOURCES = Object.freeze(["search", "staff_picks", "hearts", "mine"]);
const AVATAR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VROID_MODEL_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const VROID_TICKET_RE = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,128}$/;
/** What the Deck shows when the broker's audience excludes this account. */
const STORE_CLOSED = "The VRoid store is not open for this account yet.";

function storeDeps(deps = {}) {
  const origin = deps.origin || require("./signed-approval.cjs").portalOrigin();
  let token = deps.token;
  if (token === undefined) {
    const found = require("./desk-session.cjs").readAuthStoreToken();
    token = found ? found.token : "";
  }
  return { origin, token, fetchImpl: deps.fetchImpl || globalThis.fetch };
}

/** The broker's refusal sentence: {detail:{refused,reason}} | {detail:"..."} | text. */
function refusalText(status, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const detail = body && typeof body === "object" ? body.detail ?? body.error ?? body.reason : null;
  if (detail && typeof detail === "object") {
    return { refused: String(detail.refused || ""), reason: String(detail.reason || `HTTP ${status}`) };
  }
  if (typeof detail === "string" && detail) return { refused: "", reason: detail.slice(0, 300) };
  return { refused: "", reason: `HTTP ${status}${text ? `: ${String(text).slice(0, 200)}` : ""}` };
}

/**
 * One request to the portal's /api/avatars pass-through.
 * Resolves {ok:true, status, body} (JSON, or a Buffer when `binary`) or
 * {ok:false, status, refused, reason}. Never throws, never logs the token.
 */
async function storeRequest(pathname, { method = "GET", query = null, binary = false, ...deps } = {}) {
  const { origin, token, fetchImpl } = storeDeps(deps);
  if (!token) {
    return { ok: false, status: 0, refused: "signed_out", reason: "Sign in to Aitherium on this desk to see your avatars." };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, status: 0, refused: "", reason: "no fetch in this runtime" };
  }
  const url = new URL(`/api/avatars${pathname}`, origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), deps.timeoutMs || STORE_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: binary ? "model/gltf-binary" : "application/json" },
      signal: ctl ? ctl.signal : undefined,
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, ...refusalText(res.status, text) };
    }
    if (binary) {
      const declared = Number(res.headers && res.headers.get ? res.headers.get("content-length") : NaN);
      if (Number.isFinite(declared) && declared > MAX_MODEL_BYTES) {
        return { ok: false, status: res.status, refused: "size", reason: "the model is larger than an avatar may be" };
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_MODEL_BYTES) {
        return { ok: false, status: res.status, refused: "size", reason: "the model is larger than an avatar may be" };
      }
      return { ok: true, status: res.status, body: bytes };
    }
    const text = await res.text();
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, refused: "", reason: `not JSON: ${text.slice(0, 120)}` };
    }
  } catch (error) {
    const reason = error && error.name === "AbortError" ? "the avatar store timed out" : String(error?.message || error).slice(0, 300);
    return { ok: false, status: 0, refused: "", reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The signed-in person's own avatar library: {ok, avatars, active, reason}. */
async function avatarLibrary(deps = {}) {
  const r = await storeRequest("", deps);
  if (!r.ok) return { ok: false, avatars: [], active: null, reason: r.reason, refused: r.refused };
  const avatars = Array.isArray(r.body && r.body.avatars) ? r.body.avatars : [];
  return { ok: true, avatars, active: (r.body && r.body.active) || null };
}

/** The bytes of one of the caller's own library avatars: {ok, bytes} | {ok:false, reason}. */
async function libraryModel(avatarId, deps = {}) {
  if (!AVATAR_ID_RE.test(String(avatarId || ""))) return { ok: false, reason: "not an avatar id" };
  const r = await storeRequest(`/${avatarId}/model`, { ...deps, binary: true });
  return r.ok ? { ok: true, bytes: r.body } : { ok: false, reason: r.reason, refused: r.refused };
}

/**
 * Search VRoid Hub with the caller's own VRoid account.
 * {ok, source, models:[{id,name,image,downloadable,hearts,r15,r18,url}], next, closed, linked, reason}
 * `closed` = the broker's audience excludes this account (the store-closed sentence);
 * `linked:false` = the account has no VRoid link yet (409 not_linked).
 */
async function vroidBrowse(source = "search", keyword = "", cursor = "", deps = {}) {
  const src = VROID_SOURCES.includes(source) ? source : "search";
  const r = await storeRequest(`/vroid/browse/${src}`, {
    ...deps,
    query: { keyword: String(keyword || "").slice(0, 200), cursor: String(cursor || "").slice(0, 2000), count: 24 },
  });
  if (!r.ok) {
    const closed = r.status === 403 && r.refused === "audience";
    const unlinked = r.status === 409 && r.refused === "not_linked";
    return {
      ok: false, source: src, models: [], next: "", closed, linked: unlinked ? false : null,
      reason: closed ? STORE_CLOSED : r.reason, refused: r.refused,
    };
  }
  const models = Array.isArray(r.body && r.body.models) ? r.body.models : [];
  return { ok: true, source: src, models, next: (r.body && r.body.next) || "", closed: false, linked: true };
}

/** Ticket, then download, for ONE downloadable VRoid model: {ok, bytes} | {ok:false, reason}. */
async function vroidModel(modelId, deps = {}) {
  if (!VROID_MODEL_ID_RE.test(String(modelId || ""))) return { ok: false, reason: "not a VRoid model id" };
  const t = await storeRequest(`/vroid/models/${modelId}/ticket`, { ...deps, method: "POST" });
  if (!t.ok) {
    const closed = t.status === 403 && t.refused === "audience";
    return { ok: false, reason: closed ? STORE_CLOSED : t.reason, refused: t.refused };
  }
  const ticket = String((t.body && t.body.ticket) || "");
  if (!VROID_TICKET_RE.test(ticket)) return { ok: false, reason: "the broker returned no usable ticket" };
  const r = await storeRequest(`/vroid/download/${ticket}`, { ...deps, binary: true });
  return r.ok ? { ok: true, bytes: r.body } : { ok: false, reason: r.reason, refused: r.refused };
}

module.exports = {
  browse,
  detail,
  avatarLibrary,
  libraryModel,
  vroidBrowse,
  vroidModel,
  storeRequest,
  MAX_MODEL_BYTES,
  STORE_CLOSED,
  VROID_SOURCES,
};

if (require.main === module) {
  // Self-test: one live browse round-trip. Exit 0 = market reachable and the
  // listing shape parses; exit 1 = unreachable (gateway/bearer); exit 2 = the
  // module itself is broken.
  (async () => {
    try {
      const result = await browse("agent", "", 5);
      if (!result.ok) {
        console.error(`MARKET UNREACHABLE: ${result.reason}`);
        process.exit(1);
      }
      console.log(`MARKET OK: ${result.listings.length} listing(s)`);
      for (const l of result.listings.slice(0, 3)) {
        console.log(`  - ${l.name ?? l.id ?? "(unnamed)"} [${l.type ?? "?"}]`);
      }
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
