"use strict";

/**
 * plane-client — read-only status of the platform planes (Strata, Pulse, Watch,
 * Flux, Nexus, Mesh) for the console's plane pages.
 *
 * TRANSPORT: Veil's operator-only route GET https://api.aitherium.com/api/admin/planes/<id>
 * (AitherVeil src/app/api/admin/planes/[plane]/route.ts, table lib/plane-reads.ts),
 * carrying the desk's ONE identity -- the Online session's platform bearer
 * (browser-window onlineToken(), the same bearer desk-thread.cjs sends to
 * api.aitherium.com). Veil verifies that bearer at Identity, requires a platform
 * operator, and reads the services in-network with the fleet internal key.
 *
 * Why not the gateway any more: these reads were gateway MCP tools (get_strata_stats,
 * pulse_disk_status, ...) that the gateway's tier rules refuse to the owner's platform
 * tier ("Tool 'get_strata_stats' is not available on the platform tier"). Those tier
 * rules are the owner's call and are not changed; the read data comes through Veil.
 *
 * Read-only by construction: each plane is a fixed list of read ids that Veil maps to
 * fixed GETs; there is no verb here but a snapshot, and planeHandlers refuses any
 * plane id that is not in PLANES.
 *
 * 🚩 A failure must never read as an empty result. Every read is answered on
 * its own ({ok:true,data} | {ok:false,error}), so one dead service costs its
 * own section; a whole-route failure (signed out, 403, offline) fails every read,
 * and each then falls back to its own last good answer (last-good-cache.cjs).
 */

const API_BASE = "https://api.aitherium.com";
const ROUTE = "/api/admin/planes/";
const FETCH_TIMEOUT_MS = 45000;

/**
 * Keep only `name`'s row of a /services answer: {service, listed, services:{Name: row}}.
 * Veil already picks the row; this stays so a full inventory can never grade a page.
 * A missing row is `listed:false` with no rows. A non-inventory answer is passed through.
 */
function pickServiceRow(name, data) {
  const rows = data && !Array.isArray(data) && data.services && typeof data.services === "object"
    ? data.services : null;
  if (!rows) return data;
  const want = String(name).toLowerCase();
  let key;
  if (Array.isArray(rows)) {
    const row = rows.find((r) => r && typeof r === "object"
      && String(r.name || r.service || "").toLowerCase() === want);
    return row ? { service: name, listed: true, services: { [name]: row } }
      : { service: name, listed: false, services: {} };
  }
  key = Object.keys(rows).find((k) => k.toLowerCase() === want) || null;
  if (key === null || !rows[key] || typeof rows[key] !== "object") {
    return { service: name, listed: false, services: {} };
  }
  return { service: name, listed: true, services: { [key]: rows[key] } };
}

/** One read: its id in Veil's table, its card label, and the upstream it names. */
function readSpec(id, label, tool, extra = {}) {
  return Object.freeze({ id, label, tool, ...extra });
}
function serviceRead(name) {
  return readSpec("service", `${name} service`, "genesis /services", { service: name });
}

const PLANES = Object.freeze({
  strata: Object.freeze({
    label: "Strata", hint: "Storage tiers, artifacts, health",
    reads: Object.freeze([
      serviceRead("Strata"),
      readSpec("stats", "Tiers and health", "strata /strata/stats"),
      readSpec("pools", "Storage tier pools", "strata /disks/pools"),
      readSpec("artifacts", "Recent artifacts (warm)", "strata /strata/list/warm/artifacts"),
    ]),
  }),
  pulse: Object.freeze({
    label: "Pulse", hint: "Platform heartbeat and disk headroom",
    reads: Object.freeze([
      serviceRead("Pulse"),
      readSpec("disk", "Disk headroom", "pulse /disk/status"),
    ]),
  }),
  watch: Object.freeze({
    label: "Watch", hint: "Startup state, plugins, alerts",
    reads: Object.freeze([
      serviceRead("Watch"),
      readSpec("alerts", "Plugin alerts", "watch /plugins/alerts"),
      readSpec("startup", "Startup status", "watch /debug/all-startup"),
      readSpec("plugins", "Loaded plugins", "watch /plugins"),
    ]),
  }),
  flux: Object.freeze({
    label: "Flux", hint: "Event bus: stats and connected services",
    reads: Object.freeze([
      serviceRead("Flux"),
      readSpec("stats", "Event bus stats", "flux /stats"),
      readSpec("services", "Services on the bus", "flux /services"),
    ]),
  }),
  nexus: Object.freeze({
    label: "Nexus", hint: "Knowledge collections",
    reads: Object.freeze([
      serviceRead("Nexus"),
      readSpec("collections", "Knowledge collections", "nexus /collections"),
    ]),
  }),
  // The distributed fleet (owner, 2026-10-04: "aithermesh / aithernet home LAN and
  // distributed fleet management"): every registered node, what each machine stores,
  // and the network policies in force. Read-only, like every plane.
  mesh: Object.freeze({
    label: "Mesh", hint: "Your machines: nodes, storage, network policy",
    reads: Object.freeze([
      serviceRead("Mesh"),
      readSpec("nodes", "Compute nodes", "genesis /compute/nodes"),
      readSpec("storage", "Storage by machine", "genesis /api/v1/storage/nodes"),
      readSpec("policies", "AitherNet policies", "aithernet /policies"),
    ]),
  }),
});

const PLANE_IDS = Object.freeze(Object.keys(PLANES));

/**
 * Parse one tool answer; throw on anything that is not a usable JSON value.
 * Arrays are allowed (some tools answer a bare list). An `error` key throws
 * with the tool's own `message`/`detail` beside it, so "no_caller_token"
 * arrives with the sentence that says what to do about it.
 */
function parseToolJson(tool, text) {
  let value;
  try {
    value = JSON.parse(String(text == null ? "" : text));
  } catch {
    const head = String(text || "").trim().slice(0, 160);
    throw new Error(`${tool}: unparseable answer${head ? `: ${head}` : " (empty)"}`);
  }
  if (value == null || typeof value !== "object") {
    throw new Error(`${tool}: expected JSON, got ${value === null ? "null" : typeof value}`);
  }
  if (!Array.isArray(value) && value.error) {
    const why = typeof value.error === "string" ? value.error : JSON.stringify(value.error);
    const more = [value.message, value.detail].find((m) => typeof m === "string" && m && m !== why);
    throw new Error(`${tool}: ${why}${more ? ` -- ${more.slice(0, 300)}` : ""}`);
  }
  if (!Array.isArray(value) && value.detail && Object.keys(value).length === 1) {
    const why = typeof value.detail === "string" ? value.detail : JSON.stringify(value.detail);
    throw new Error(`${tool}: ${why}`);
  }
  return value;
}

function errorText(error) {
  return String((error && error.message) || error || "unknown error");
}

/**
 * The default transport: one GET per plane to Veil with the desk's Online bearer.
 * Resolves Veil's body ({plane, reads:{id:{ok,data}|{ok:false,error}}}); throws on a
 * missing bearer, a non-200 or an unusable body -- the caller turns that into a
 * failed read for every read of the plane.
 */
function veilPlaneFetcher({ token, fetchImpl = globalThis.fetch, apiBase = API_BASE, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return async function fetchPlane(planeId) {
    let bearer = null;
    try { bearer = token ? await token() : null; } catch { bearer = null; }
    if (!bearer) throw new Error("signed out: sign in on the desk to read the platform planes");
    let res;
    try {
      res = await fetchImpl(`${apiBase}${ROUTE}${encodeURIComponent(planeId)}`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`plane route unreachable: ${errorText(error)}`);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("HTTP 401: the desk session is not signed in (or expired) -- sign in again");
    if (res.status === 403) throw new Error("HTTP 403: platform operator only");
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.trim().slice(0, 200)}` : ""}`);
    const body = parseToolJson("plane route", text);
    if (!body || typeof body.reads !== "object" || body.reads === null || Array.isArray(body.reads)) {
      throw new Error("plane route: answer has no reads");
    }
    return body;
  };
}

/** The desk's Online bearer, resolved lazily so requiring this module needs no Electron. */
function deskToken() {
  return require("./browser-window.cjs").onlineToken();
}

/**
 * Build a client over an injectable `fetchPlane(planeId) -> Promise<{reads}>` (Veil by
 * default) so tests need no network.
 *
 * `store` (last-good-cache.cjs) keeps each read's last good answer on disk. A failed
 * read with a saved answer comes back `ok:true, stale:true` with `savedAt` and the live
 * `error`, so the page shows the offline copy under a stale pill instead of a blank
 * card. A failed read with nothing saved is still `ok:false` -- never an empty result.
 */
function createPlaneClient({ fetchPlane = veilPlaneFetcher({ token: deskToken }), now = () => Date.now(), store = null } = {}) {
  function answerOf(spec, body) {
    const r = body.reads[spec.id];
    if (!r || typeof r !== "object") throw new Error(`${spec.tool}: the plane route did not answer this read`);
    if (r.ok !== true) throw new Error(String(r.error || `${spec.tool}: failed`));
    if (r.data == null || typeof r.data !== "object") throw new Error(`${spec.tool}: empty answer`);
    return spec.service ? pickServiceRow(spec.service, r.data) : r.data;
  }

  function settle(spec, planeId, started, body, failure) {
    const key = `plane-${planeId}-${spec.id}`;
    try {
      if (failure) throw failure;
      const data = answerOf(spec, body);
      if (store) store.remember(key, data);
      return { id: spec.id, label: spec.label, tool: spec.tool, ok: true, data, ms: now() - started };
    } catch (error) {
      const saved = store ? store.recall(key) : null;
      if (saved && saved.value != null) {
        return { id: spec.id, label: spec.label, tool: spec.tool, ok: true, stale: true, data: saved.value,
          savedAt: saved.savedAt, error: errorText(error), ms: now() - started };
      }
      return { id: spec.id, label: spec.label, tool: spec.tool, ok: false, error: errorText(error),
        ms: now() - started };
    }
  }

  return {
    planes: () => PLANE_IDS.map((id) => ({ id, label: PLANES[id].label, hint: PLANES[id].hint,
      tools: PLANES[id].reads.map((r) => r.tool) })),

    /** Every read of one plane (one route call); never throws for a failed READ. */
    snapshot: async (planeId) => {
      const id = String(planeId || "");
      const plane = Object.prototype.hasOwnProperty.call(PLANES, id) ? PLANES[id] : null;
      if (!plane) throw new Error(`unknown plane ${id || "(none)"}`);
      const started = now();
      let body = null;
      let failure = null;
      try { body = await fetchPlane(id); } catch (error) { failure = error instanceof Error ? error : new Error(errorText(error)); }
      const reads = plane.reads.map((spec) => settle(spec, id, started, body, failure));
      const failed = reads.filter((r) => !r.ok).length;
      const stale = reads.filter((r) => r.stale).length;
      return { plane: id, label: plane.label, hint: plane.hint, at: new Date(now()).toISOString(),
        reads, failed, stale, ok: failed === 0 && stale === 0 };
    },
  };
}

module.exports = { createPlaneClient, veilPlaneFetcher, parseToolJson, pickServiceRow, PLANES, PLANE_IDS, API_BASE, ROUTE };
