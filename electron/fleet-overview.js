/* global module, window */
/*
 * fleet-overview.js -- what the Fleet window says FIRST, as pure functions.
 *
 * Owner, 2026-11-18, on a window that read "RUNNING ? MASKED ? VRAM ?" over a 224-node
 * hairball: "can we make this better and work?" The default view is now an answer, not a
 * map: the real counts in the header, the services that are down or degraded as a short
 * ranked list (each with restart / logs), then every group collapsed to one line of
 * counts. The network is still there, behind a toggle.
 *
 * No DOM here: fleet-page.js renders these, and fleet-overview.test.cjs asserts them under
 * `node --test`. Loaded by the page as a classic script (window.FleetOverview) and by node
 * as a CommonJS module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FleetOverview = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  "use strict";

  /** Worst first. `unknown` ranks above ok: a service nobody could judge is not healthy. */
  const SEVERITY = Object.freeze({ down: 0, degraded: 1, starting: 2, unknown: 3, parked: 4, ok: 5 });
  const NEEDS_YOU = new Set(["down", "degraded"]);
  const CRITICALITY = Object.freeze({ core: 0, critical: 0, important: 1, optional: 2 });

  function stateOf(n) {
    const s = n && n.health && n.health.state;
    return Object.prototype.hasOwnProperty.call(SEVERITY, s) ? s : "unknown";
  }

  /**
   * The services that need the owner, ranked: down before degraded, core before optional,
   * then by name. Parked is a choice, not a fault, so it is never on this list.
   */
  function attentionList(nodes, { limit = 12 } = {}) {
    const rows = (Array.isArray(nodes) ? nodes : [])
      .filter((n) => NEEDS_YOU.has(stateOf(n)))
      .map((n) => ({
        id: n.id,
        title: String(n.title || n.id),
        group: String(n.group || ""),
        state: stateOf(n),
        reason: String((n.health && n.health.reason) || ""),
        unit: n.unit || null,
        criticality: n.criticality || null,
      }));
    rows.sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state]
      || (CRITICALITY[a.criticality] ?? 3) - (CRITICALITY[b.criticality] ?? 3)
      || a.title.localeCompare(b.title));
    return { rows: rows.slice(0, limit), more: Math.max(0, rows.length - limit), total: rows.length };
  }

  /** One line per group: its counts by state, the worst groups first. */
  function groupSummary(nodes) {
    const by = new Map();
    for (const n of Array.isArray(nodes) ? nodes : []) {
      const g = String(n.group || "other");
      if (!by.has(g)) by.set(g, { group: g, total: 0, ok: 0, degraded: 0, down: 0, parked: 0, starting: 0, unknown: 0, members: [] });
      const row = by.get(g);
      const s = stateOf(n);
      row.total += 1;
      row[s] += 1;
      row.members.push({ id: n.id, title: String(n.title || n.id), state: s, reason: String((n.health && n.health.reason) || "") });
    }
    const out = [...by.values()];
    for (const r of out) r.members.sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state] || a.title.localeCompare(b.title));
    out.sort((a, b) => b.down - a.down || b.degraded - a.degraded || b.total - a.total || a.group.localeCompare(b.group));
    return out;
  }

  /** "Watch: offline" -> the first clause, so a stat's caption stays one short line. */
  function firstClause(why) {
    return String(why || "no verdict").split(/(?<=\.)\s/)[0].replace(/\.$/, "").slice(0, 160);
  }

  /** Why a header number is unknown, in words -- never a bare "?". Null when it is known. */
  function unknownWhy(status) {
    if (!status) return "status not probed yet";
    if (status.cannotJudge) return `status probe failed: ${firstClause(status.error)}`;
    return null;
  }

  /**
   * The header's four numbers and where each came from:
   *   running  containers running (the fleet probe; the host probe when that is all we have)
   *   down     services down (+ degraded), from the service map
   *   parked   services parked on purpose, from the service map
   *   vram     used / free GiB on the 5090 (the fleet probe)
   * A number that cannot be read is `null` with its `why`.
   */
  function hudCounts(status, net, hostVerdict) {
    const stale = status && status.cannotJudge && status.stale ? status.stale : null;
    const src = stale ? stale.verdict : status && !status.cannotJudge ? status : null;
    const why = unknownWhy(status);
    const fl = (src && src.fleet) || {};
    const out = { running: null, runningFrom: null, down: null, degraded: null, parked: null, vram: null, why, staleS: null };
    if (stale) out.staleS = Math.round(Number(stale.age_ms || 0) / 1000);
    if (fl.running != null) { out.running = Number(fl.running); out.runningFrom = stale ? "stale" : "fleet"; }
    else {
      const hp = hostVerdict && hostVerdict.probe && hostVerdict.probe.running;
      if (hp != null && hp !== "" && Number.isFinite(Number(hp))) { out.running = Number(hp); out.runningFrom = "host"; }
    }
    if (net && net.ok && Array.isArray(net.nodes)) {
      out.down = 0; out.degraded = 0; out.parked = 0;
      for (const n of net.nodes) {
        const s = stateOf(n);
        if (s === "down") out.down += 1;
        else if (s === "degraded") out.degraded += 1;
        else if (s === "parked") out.parked += 1;
      }
    }
    const v = src && src.vram;
    if (v && Number(v.total_mib) > 0) {
      const used = Number(v.used_mib) / 1024;
      const total = Number(v.total_mib) / 1024;
      out.vram = { usedGiB: used, freeGiB: Math.max(0, total - used), totalGiB: total };
    }
    return out;
  }

  /** Where the service map came from, in words; says WHY when it is not live. */
  function mapSource(net, nowMs = Date.now()) {
    if (!net || !net.ok) return null;
    if (net.source === "remote") return "live";
    if (net.source === "genesis") return "live from Genesis";
    if (net.source === "last-good") {
      const at = Date.parse(net.savedAt || "");
      const ageH = Number.isFinite(at) ? (nowMs - at) / 3_600_000 : null;
      const age = ageH == null ? "" : ageH < 1.5 ? ` (${Math.max(1, Math.round(ageH * 60))} min old)`
        : ageH < 48 ? ` (${Math.round(ageH)} h old)` : ` (${Math.round(ageH / 24)} days old)`;
      return `saved copy${age}${net.error ? ` -- live read failed: ${firstClause(net.error)}` : ""}`;
    }
    return `local skeleton${net.error ? ` -- ${firstClause(net.error)}` : ""}`;
  }

  return { SEVERITY, attentionList, groupSummary, hudCounts, unknownWhy, mapSource, firstClause };
});
