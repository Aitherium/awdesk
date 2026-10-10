"use strict";

/**
 * plane-client — read-only status of the platform planes (Strata, Pulse, Watch,
 * Flux, Nexus) for the console's plane pages.
 *
 * CONTRACT, same as ops-client.cjs: the ONLY transport is gateway-mcp.cjs. Each
 * plane is a fixed list of READS -- existing gateway MCP tools, named here and
 * nowhere else (AitherOS/apps/awnode/tools/mcp/: mcp_strata.py, mcp_watch.py,
 * mcp_flux_context.py, mcp_search.py, mcp_services.py). No plane page can run a
 * mutating tool: watch_restart_component, /disk/reclaim and every artifact
 * write are absent from this table on purpose, and planeHandlers refuses any
 * plane id that is not in it.
 *
 * 🚩 A failure must never read as an empty result. Every read is answered on
 * its own ({ok:true,data} | {ok:false,error}), so one dead service costs its
 * own section, and a tool that answers {"error": ...} is a FAILED read, never
 * "nothing to show" -- the same rule ops-client.cjs carries.
 */

const { callTool } = require("./gateway-mcp.cjs");

/**
 * Genesis /services row for a plane: is the service itself up.
 *
 * 🚩 Genesis GET /services IGNORES the `services` filter and answers the whole
 * services.yaml inventory (~160 rows). The arg is still sent (harmless, and
 * right if Genesis ever honours it), but `service` names the ONE row this
 * plane is about and pickServiceRow() keeps only that row -- otherwise every
 * plane page graded the whole fleet.
 */
function serviceRead(name) {
  return Object.freeze({
    id: "service", label: `${name} service`, tool: "get_service_status", service: name,
    args: Object.freeze({ services: name }),
  });
}

/**
 * Keep only `name`'s row of a /services answer: {service, listed, services:{Name: row}}.
 * A missing row is `listed:false` with no rows -- the page says "not listed",
 * never borrows another service's status. A non-inventory answer is passed through.
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

const PLANES = Object.freeze({
  strata: Object.freeze({
    label: "Strata", hint: "Storage tiers, artifacts, health",
    reads: Object.freeze([
      serviceRead("Strata"),
      Object.freeze({ id: "stats", label: "Tiers and health", tool: "get_strata_stats", args: Object.freeze({}) }),
      Object.freeze({
        id: "artifacts", label: "Recent artifacts (warm)", tool: "list_artifacts",
        args: Object.freeze({ tier: "warm", limit: 25 }),
      }),
    ]),
  }),
  pulse: Object.freeze({
    label: "Pulse", hint: "Platform heartbeat and disk headroom",
    reads: Object.freeze([
      serviceRead("Pulse"),
      Object.freeze({ id: "disk", label: "Disk headroom", tool: "pulse_disk_status", args: Object.freeze({}) }),
    ]),
  }),
  watch: Object.freeze({
    label: "Watch", hint: "Startup state, plugins, alerts",
    reads: Object.freeze([
      serviceRead("Watch"),
      Object.freeze({ id: "alerts", label: "Plugin alerts", tool: "watch_plugin_alerts", args: Object.freeze({}) }),
      Object.freeze({ id: "startup", label: "Startup status", tool: "watch_startup_status", args: Object.freeze({}) }),
      Object.freeze({ id: "plugins", label: "Loaded plugins", tool: "watch_list_plugins", args: Object.freeze({}) }),
    ]),
  }),
  flux: Object.freeze({
    label: "Flux", hint: "Live system context and events",
    reads: Object.freeze([
      serviceRead("Flux"),
      Object.freeze({ id: "context", label: "System context", tool: "flux_context", args: Object.freeze({ aspect: "all" }) }),
      Object.freeze({
        id: "events", label: "Recent events", tool: "flux_recent_events",
        args: Object.freeze({ event_type: "", limit: 30 }),
      }),
    ]),
  }),
  nexus: Object.freeze({
    label: "Nexus", hint: "Knowledge search and mirrored bases",
    reads: Object.freeze([
      serviceRead("Nexus"),
      Object.freeze({ id: "kbs", label: "Knowledge bases", tool: "list_knowledge_bases", args: Object.freeze({}) }),
    ]),
  }),
  // The distributed fleet (owner, 2026-10-04: "aithermesh / aithernet home LAN and
  // distributed fleet management"): every registered node, what each machine stores,
  // and the network policies in force. Read-only, like every plane.
  mesh: Object.freeze({
    label: "Mesh", hint: "Your machines: nodes, storage, network policy",
    reads: Object.freeze([
      serviceRead("Mesh"),
      Object.freeze({ id: "nodes", label: "Compute nodes", tool: "compute_list_nodes", args: Object.freeze({ include_offline: true }) }),
      Object.freeze({ id: "storage", label: "Storage by machine", tool: "storage_nodes", args: Object.freeze({}) }),
      Object.freeze({ id: "policies", label: "AitherNet policies", tool: "aithernet_policies", args: Object.freeze({}) }),
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
 * Build a client over an injectable `call(name, args) -> Promise<string>`
 * (gateway-mcp's callTool by default) so tests need no live gateway.
 *
 * `store` (last-good-cache.cjs) keeps each read's last good answer on disk. A failed
 * read with a saved answer comes back `ok:true, stale:true` with `savedAt` and the live
 * `error`, so the page shows the offline copy under a stale pill instead of a blank
 * card. A failed read with nothing saved is still `ok:false` -- never an empty result.
 */
function createPlaneClient({ call = callTool, now = () => Date.now(), store = null } = {}) {
  async function read(spec, planeId) {
    const started = now();
    const key = `plane-${planeId}-${spec.id}`;
    try {
      const text = await call(spec.tool, { ...spec.args });
      const parsed = parseToolJson(spec.tool, text);
      const data = spec.service ? pickServiceRow(spec.service, parsed) : parsed;
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

    /** Every read of one plane, in parallel; never throws for a failed READ. */
    snapshot: async (planeId) => {
      const id = String(planeId || "");
      const plane = Object.prototype.hasOwnProperty.call(PLANES, id) ? PLANES[id] : null;
      if (!plane) throw new Error(`unknown plane ${id || "(none)"}`);
      const reads = await Promise.all(plane.reads.map((spec) => read(spec, id)));
      const failed = reads.filter((r) => !r.ok).length;
      const stale = reads.filter((r) => r.stale).length;
      return { plane: id, label: plane.label, hint: plane.hint, at: new Date(now()).toISOString(),
        reads, failed, stale, ok: failed === 0 && stale === 0 };
    },
  };
}

module.exports = { createPlaneClient, parseToolJson, pickServiceRow, PLANES, PLANE_IDS };
