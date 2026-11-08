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
  // The WORKING catalog first: marketplace_browse -> Genesis /v1/marketplace/catalog.
  // agent_marketplace_browse's backend (the standalone marketplace service) does not
  // resolve on the fleet, so on its own the Deck showed "market unavailable" while the
  // catalog was one tool away. It stays as the fallback, never the only door.
  const reasons = [];
  const primary = await browseCatalog(query, type, limit);
  if (primary.ok) return primary;
  reasons.push(`marketplace_browse: ${primary.reason}`);
  const legacy = await browseLegacy(query, type, limit);
  if (legacy.ok) return legacy;
  reasons.push(`agent_marketplace_browse: ${legacy.reason}`);
  return { ok: false, listings: [], reason: reasons.join("; ").slice(0, 300) };
}

/** Map a catalog listing onto the fields the Deck renders, adding only what exists. */
function normalizeListing(l) {
  if (!l || typeof l !== "object") return null;
  const out = { ...l };
  if (out.listing_type === undefined && typeof l.kind === "string") out.listing_type = l.kind;
  if (out.short_description === undefined && typeof l.summary === "string") out.short_description = l.summary;
  if (typeof out.id !== "string" || !out.id) return null;
  return out;
}

function matchesQuery(l, q) {
  if (!q) return true;
  const hay = [l.id, l.name, l.description, l.short_description, ...(Array.isArray(l.tags) ? l.tags : [])];
  return hay.some((h) => typeof h === "string" && h.toLowerCase().includes(q));
}

async function browseCatalog(query, type, limit) {
  try {
    // marketplace_browse has no free-text query: fetch a wider page, filter here.
    const text = await callTool("marketplace_browse", {
      max_results: Math.max(limit * 4, 100),
      ...(type ? { kind: type } : {}),
    });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, listings: [], reason: String(text).slice(0, 300) };
    }
    if (!parsed || !Array.isArray(parsed.listings)) {
      return { ok: false, listings: [], reason: String(text).slice(0, 300) };
    }
    const q = String(query || "").trim().toLowerCase();
    const listings = parsed.listings.map(normalizeListing).filter((l) => l && matchesQuery(l, q)).slice(0, limit);
    return { ok: true, listings, count: listings.length, source: "marketplace_browse" };
  } catch (error) {
    return { ok: false, listings: [], reason: String(error?.message || error).slice(0, 300) };
  }
}

async function browseLegacy(query, type, limit) {
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
      return { ok: true, listings: [], note: String(text).slice(0, 500) };
    }
    if (!parsed.listings) {
      return { ok: false, listings: [], reason: String(text).slice(0, 300) };
    }
    return { ok: true, listings: parsed.listings, count: parsed.count ?? parsed.listings.length, source: "agent_marketplace_browse" };
  } catch (error) {
    return { ok: false, listings: [], reason: String(error?.message || error).slice(0, 300) };
  }
}

// ─── install: the same `adk pack install` every other surface runs ─────────────
//
// The desk never installs anything itself: it runs awdk's one resolver
// (adk.addons: awpack, then Library, then awnode ext), which installs through
// the owning brick and writes the one lock record (source + sha256). The id is
// validated here and passed as ONE argv element (no shell), so a listing id can
// never become a flag or a command.

const LISTING_ID_RE = /^(community:)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function installArgv(listingId, { allowCommunity = false } = {}) {
  const id = String(listingId || "");
  if (!LISTING_ID_RE.test(id)) return null;
  return ["-m", "adk.cli", "pack", "install", id, "--json", ...(allowCommunity ? ["--allow-community"] : [])];
}

function defaultRunPython(argv) {
  const { spawnSync } = require("node:child_process");
  const python = process.env.AITHER_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const r = spawnSync(python, argv, {
    encoding: "utf-8", timeout: INSTALL_TIMEOUT_MS, windowsHide: true,
  });
  return { status: r.error ? null : r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

/**
 * Install one listing through `adk pack install <id> --json`.
 * Resolves {ok, id, kind, detail, record, next, needsCommunityConsent}; never throws.
 * `needsCommunityConsent` = adk refused a third-party add-on until the person says
 * so explicitly (the caller asks, then retries with allowCommunity).
 */
async function install(listingId, { allowCommunity = false, runPython = defaultRunPython } = {}) {
  const argv = installArgv(listingId, { allowCommunity });
  if (!argv) return { ok: false, id: String(listingId || ""), detail: "not a pack id", needsCommunityConsent: false };
  let r;
  try {
    r = await runPython(argv);
  } catch (error) {
    return { ok: false, id: listingId, detail: String(error?.message || error).slice(0, 300), needsCommunityConsent: false };
  }
  if (!r || r.status === null) {
    const why = r && r.error ? String(r.error.message || r.error) : "python did not start";
    return { ok: false, id: listingId, detail: `could not run adk (${why}); install awdk: pip install -U awdk`, needsCommunityConsent: false };
  }
  let obj = null;
  for (const line of String(r.stdout || "").trim().split(/\r?\n/).reverse()) {
    if (line.trim().startsWith("{")) {
      try { obj = JSON.parse(line); break; } catch { /* keep looking */ }
    }
  }
  if (!obj) {
    const tail = String(r.stderr || r.stdout || "").trim().split(/\r?\n/).slice(-2).join(" ");
    return { ok: false, id: listingId, detail: `adk exited ${r.status}${tail ? `: ${tail.slice(0, 240)}` : ""}`, needsCommunityConsent: false };
  }
  const detail = String(obj.detail || "");
  return {
    ok: obj.ok === true && r.status === 0,
    id: String(obj.id || listingId),
    kind: String(obj.kind || ""),
    detail,
    record: obj.record || null,
    next: String(obj.next || ""),
    needsCommunityConsent: obj.ok !== true && detail.includes("--allow-community"),
  };
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

/**
 * Install with the person's say-so, twice for third-party code.
 * `confirm(step, info)` resolves true/false: step "install" before anything runs;
 * step "community" only when adk refused a third-party add-on, before the retry
 * with --allow-community. Nothing installs on a false. Resolves install()'s shape
 * plus {cancelled}.
 */
async function installWithConsent(listingId, { confirm, runPython } = {}) {
  const ask = typeof confirm === "function" ? confirm : async () => false;
  if (!(await ask("install", { id: listingId }))) {
    return { ok: false, id: String(listingId || ""), detail: "cancelled", cancelled: true, needsCommunityConsent: false };
  }
  const first = await install(listingId, { runPython });
  if (first.ok || !first.needsCommunityConsent) return { ...first, cancelled: false };
  if (!(await ask("community", { id: listingId, detail: first.detail }))) {
    return { ...first, cancelled: true };
  }
  return { ...(await install(listingId, { allowCommunity: true, runPython })), cancelled: false };
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
async function storeRequest(pathname, { method = "GET", query = null, binary = false, json = undefined, form = null, ...deps } = {}) {
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
    const headers = { Authorization: `Bearer ${token}`, Accept: binary ? "model/gltf-binary" : "application/json" };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      body = form; // FormData: fetch writes the multipart boundary itself
    }
    const res = await fetchImpl(url.toString(), {
      method,
      headers,
      body,
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

const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * The ONE catalog every device reads (aither-avatars GET /avatars/catalog, 2026-10-16):
 * {ok, avatars, starters, agents:{agent: avatarId}, active, reason}. Shapes always present.
 */
async function avatarCatalog(deps = {}) {
  const r = await storeRequest("/catalog", deps);
  if (!r.ok) return { ok: false, avatars: [], starters: [], agents: {}, active: null, reason: r.reason, refused: r.refused };
  const b = r.body || {};
  const agents = {};
  for (const [k, v] of Object.entries(b.agents && typeof b.agents === "object" ? b.agents : {})) {
    if (AGENT_RE.test(k) && typeof v === "string") agents[k] = v;
  }
  return {
    ok: true,
    avatars: Array.isArray(b.avatars) ? b.avatars : [],
    starters: Array.isArray(b.starters) ? b.starters : [],
    agents,
    active: b.active || null,
  };
}

/** Dress (or with null, undress) one agent in the person's library: {ok, reason}. */
async function putAgentAvatar(agent, avatarId, deps = {}) {
  if (!AGENT_RE.test(String(agent || ""))) return { ok: false, reason: "not an agent name" };
  if (avatarId !== null && !AVATAR_ID_RE.test(String(avatarId || ""))) return { ok: false, reason: "not an avatar id" };
  const r = await storeRequest(`/agents/${agent}`, { ...deps, method: "PUT", json: { id: avatarId } });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason, refused: r.refused };
}

/** Upload one .vrm the person owns into their library: {ok, record} | {ok:false, reason}. */
async function uploadAvatar(bytes, name, rating = "unknown", deps = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, reason: "no model bytes" };
  if (bytes.length > MAX_MODEL_BYTES) return { ok: false, reason: "the model is larger than an avatar may be" };
  // the owner's imported bodies (asset.extras.dm_import) are local-only: refused here, whoever the caller is
  const localOnly = require("./local-only.cjs");
  if (localOnly.isLocalOnlyModel(bytes)) return { ok: false, reason: localOnly.LOCAL_ONLY_REASON, refused: "local-only" };
  if (typeof FormData !== "function" || typeof Blob !== "function") return { ok: false, reason: "no FormData in this runtime" };
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "model/gltf-binary" }), "model.vrm");
  form.append("name", String(name || "avatar").slice(0, 80));
  form.append("rating", ["general", "r15", "r18"].includes(rating) ? rating : "unknown");
  const r = await storeRequest("", { ...deps, method: "POST", form, timeoutMs: deps.timeoutMs || 120000 });
  return r.ok && r.body && typeof r.body.id === "string"
    ? { ok: true, record: r.body }
    : { ok: false, reason: r.reason || "the library did not return a record", refused: r.refused };
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
  install,
  installArgv,
  installWithConsent,
  normalizeListing,
  detail,
  avatarLibrary,
  avatarCatalog,
  putAgentAvatar,
  uploadAvatar,
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
