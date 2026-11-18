"use strict";

/**
 * fairy-flight.cjs -- the plan for a fairy to GO DO the work.
 *
 * Owner, 2026-11-18: an agent's tool call makes its fairy fly to the surface that
 * call belongs to and come back; three parallel calls split it into three small
 * sub-fairies that fly at once and merge back when the calls finish. When the
 * target window is not open the fairy hovers just outside the cluster, so the work
 * is still visible without inventing a destination.
 *
 * The planner is the whole rule set and it is PURE: the caller owns the clock, the
 * windows, the cap and whether motion is allowed. No electron, no fs.
 *
 * Coordinates are screen DIPs. `cluster` is the fairy cluster's centre; `surfaces`
 * is {files, library, browser, terminal}, each a {x,y,width,height} rect or null.
 *
 * node --test electron/fairy-flight.test.cjs.
 */

/** No more sub-fairies at once than this unless the caller says otherwise. */
const MAX_SUB_FAIRIES = 4;
/** A finished call's sub-fairy stays visible on its way home for this long. */
const MERGE_MS = 900;
/** A flight takes at least this long, so a target beside the cluster is still seen. */
const MIN_FLIGHT_MS = 420;
const MAX_FLIGHT_MS = 2600;
/** Pixels per millisecond of travel: far windows take longer, gently. */
const SPEED = 0.9;
/** The hover ring around the cluster when there is no window to fly to. */
const HOVER_RADIUS = 46;
/** A call left "running" longer than this (a wedged/pending transcript) is released. */
const MAX_CALL_MS = 6 * 60_000;

const SURFACE_ORDER = Object.freeze(["files", "library", "browser", "terminal"]);

function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** A rectangle's usable centre: the middle of the window, a little above dead centre. */
function surfacePoint(rect) {
  if (!rect) return null;
  const width = finite(rect.width);
  const height = finite(rect.height);
  if (width < 40 || height < 40) return null;
  return {
    x: Math.round(finite(rect.x) + width / 2),
    y: Math.round(finite(rect.y) + Math.min(height * 0.38, 180)),
  };
}

/** Where a fairy waits when its window is missing: a small ring beside the cluster. */
function hoverPoint(cluster, index = 0) {
  const angle = (Math.PI * 2 * (Math.max(0, index) % 8)) / 8 - Math.PI / 2;
  return {
    x: Math.round(finite(cluster && cluster.x) + Math.cos(angle) * HOVER_RADIUS),
    y: Math.round(finite(cluster && cluster.y) + Math.sin(angle) * HOVER_RADIUS),
  };
}

/** How long a flight between two points should take. */
function flightDurationMs(from, to) {
  const distance = Math.hypot(finite(to && to.x) - finite(from && from.x), finite(to && to.y) - finite(from && from.y));
  return Math.round(Math.min(MAX_FLIGHT_MS, Math.max(MIN_FLIGHT_MS, distance / SPEED)));
}

/** One call -> one sub-fairy descriptor. `state` is "out" or "return". */
function flightFor(call, { surfaces, cluster, nowMs, state = "out" }) {
  const surface = String(call.surface || "");
  const centre = { x: finite(cluster && cluster.x), y: finite(cluster && cluster.y) };
  const target = surfacePoint(surfaces && surfaces[surface]);
  const to = target || hoverPoint(centre, Number(call.index) || 0);
  const from = state === "return" ? to : centre;
  const dest = state === "return" ? centre : to;
  return {
    id: String(call.id || `${call.agent || "agent"}:${call.tool || "tool"}`),
    agent: String(call.agent || ""),
    session: String(call.session || ""),
    label: String(call.label || call.agent || "Agent"),
    tool: String(call.tool || ""),
    surface,
    mode: target ? "fly" : "hover",
    state,
    from,
    to: dest,
    durationMs: flightDurationMs(from, dest),
    startedAt: Number(nowMs) || 0,
  };
}

/**
 * A stateless plan: `calls` are the LIVE tool calls
 * [{id, agent, session, label, tool, surface}]. No return legs (the stateful
 * planner below owns completion); this is the shape both use.
 */
function planFlights({ calls = [], surfaces = {}, cluster = null, nowMs = 0, maxSubFairies = MAX_SUB_FAIRIES, reducedMotion = false } = {}) {
  const list = (Array.isArray(calls) ? calls : []).filter((c) => c && c.surface && c.surface !== "unknown");
  if (reducedMotion) return { flights: [], returning: [], hover: [], throttled: list.map((c) => String(c.id || "")), reducedMotion: true };
  const cap = Math.max(0, Math.floor(finite(maxSubFairies, MAX_SUB_FAIRIES)));
  const flights = [];
  const throttled = [];
  list.forEach((call, i) => {
    const c = { ...call, index: i };
    if (flights.length >= cap) {
      throttled.push(String(c.id || ""));
      return;
    }
    flights.push(flightFor(c, { surfaces, cluster, nowMs, state: "out" }));
  });
  const hover = flights.filter((f) => f.mode === "hover").map((f) => f.id);
  return { flights, returning: [], hover, throttled, reducedMotion: false };
}

/**
 * The live planner. `plan(calls, opts)` remembers when each call was first seen and
 * when it ended, so a finished call produces a RETURN leg (its sub-fairy flies home
 * and merges) for MERGE_MS before it is forgotten.
 *
 * The caller passes the surface rectangles fresh on every plan; a window opening or
 * closing moves the current flights on the next update, with no per-frame work.
 */
function createFlightPlanner({ mergeMs = MERGE_MS, maxCallMs = MAX_CALL_MS } = {}) {
  const seen = new Map(); // id -> {firstSeen, call}
  const ended = new Map(); // id -> {endedAt, call}
  return {
    plan(calls = [], {
      surfaces = {}, cluster = null, nowMs = 0, maxSubFairies = MAX_SUB_FAIRIES, reducedMotion = false,
    } = {}) {
      const now = Number(nowMs) || Date.now();
      const live = new Map();
      for (const call of Array.isArray(calls) ? calls : []) {
        if (!call || !call.surface || call.surface === "unknown") continue;
        const id = String(call.id || `${call.agent || "agent"}:${call.tool || "tool"}`);
        if (!seen.has(id)) seen.set(id, { firstSeen: now, call });
        const first = seen.get(id).firstSeen;
        if (now - first > maxCallMs) continue; // a wedged transcript never pins a fairy
        live.set(id, { ...call, id });
      }
      // A call that is no longer live goes home, once.
      for (const [id, row] of seen) {
        if (live.has(id)) continue;
        if (!ended.has(id)) ended.set(id, { endedAt: now, call: { ...row.call, id } });
        seen.delete(id);
      }
      // Returning legs: the call ENDED; start the trip home at the end.
      const returningAll = [];
      for (const [id, row] of ended) {
        if (now - row.endedAt >= mergeMs) { ended.delete(id); continue; }
        returningAll.push({
          at: row.endedAt,
          flight: flightFor({ ...row.call, index: 0 }, { surfaces, cluster, nowMs: row.endedAt, state: "return" }),
        });
      }
      if (reducedMotion) {
        return { flights: [], returning: [], hover: [], throttled: [...live.keys()], reducedMotion: true };
      }
      const cap = Math.max(0, Math.floor(finite(maxSubFairies, MAX_SUB_FAIRIES)));
      const flights = [];
      const throttled = [];
      let i = 0;
      for (const call of live.values()) {
        if (flights.length >= cap) { throttled.push(call.id); continue; }
        // Start the leg when the call was FIRST seen: a re-plan every feed tick must
        // not restart a fairy that is already standing at its window.
        const first = seen.get(call.id) ? seen.get(call.id).firstSeen : now;
        flights.push(flightFor({ ...call, index: i }, { surfaces, cluster, nowMs: first, state: "out" }));
        i += 1;
      }
      // The cap is on SUB-FAIRIES, not on calls: a burst of finished calls gets the
      // newest trips home and the rest are counted, never a screenful of them.
      const room = Math.max(0, cap - flights.length);
      const returning = returningAll.sort((a, b) => b.at - a.at).slice(0, room).map((r) => r.flight);
      if (returningAll.length > returning.length) {
        for (const r of returningAll.slice(room)) throttled.push(`return:${r.flight.id}`);
      }
      return {
        flights,
        returning,
        hover: flights.filter((f) => f.mode === "hover").map((f) => f.id),
        throttled,
        reducedMotion: false,
      };
    },
    /** Desk start / the owner turning flights off: nothing is carried over. */
    reset() {
      seen.clear();
      ended.clear();
    },
    size() {
      return { live: seen.size, returning: ended.size };
    },
  };
}

/** Where a flight is at `nowMs` along its eased arc (the renderer mirrors this). */
function positionAt(flight, nowMs) {
  if (!flight) return null;
  const t = Math.min(1, Math.max(0, (Number(nowMs) - Number(flight.startedAt)) / Math.max(1, Number(flight.durationMs))));
  const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  const from = flight.from || { x: 0, y: 0 };
  const to = flight.to || { x: 0, y: 0 };
  const x = finite(from.x) + (finite(to.x) - finite(from.x)) * eased;
  const y = finite(from.y) + (finite(to.y) - finite(from.y)) * eased;
  // A soft arc: lift the middle of the path a little, never below the chord.
  const lift = Math.sin(Math.PI * t) * Math.min(70, Math.abs(finite(to.x) - finite(from.x)) / 6);
  return { x: Math.round(x), y: Math.round(y - lift), t, done: t >= 1 };
}

module.exports = {
  MAX_SUB_FAIRIES, MERGE_MS, MIN_FLIGHT_MS, MAX_FLIGHT_MS, HOVER_RADIUS, MAX_CALL_MS, SURFACE_ORDER,
  surfacePoint, hoverPoint, flightDurationMs, flightFor, planFlights, createFlightPlanner, positionAt,
};
