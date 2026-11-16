"use strict";

/**
 * fairy-control.cjs -- fine control over the agent fairies (owner 2026-11-16):
 *
 *   tooltip      a full one per fairy: name, kind, status and what its badge means;
 *   select       a click selects one fairy (an outline; push-to-talk goes to it);
 *   menu         right click: chat, grow, mute, pin, hide, open its session;
 *   pin / join   drag a fairy out of the swarm to pin it on the screen, drag it back
 *                to rejoin;
 *   view modes   gather, scatter, collapse to one orb, dock to a screen edge, filter
 *                by kind, scroll to change the radius;
 *   avoidance    the swarm keeps off the focused window's content area.
 *
 * PURE: no electron, no fs, no clock. orb-window.cjs owns the windows and the state;
 * orb.html carries a copy of the layout block (SWARM_LAYOUT markers) that
 * fairy-control.test.cjs pins to the functions here, the way agent-fairy.test.cjs pins
 * the old ring layout.
 */

const MODES = Object.freeze(["gather", "scatter", "orb", "dock"]);
const KIND_FILTERS = Object.freeze(["all", "agents", "terminals", "subagents", "remote"]);
const RADIUS_MIN = 0.8; // the first ring must stay outside the 30 px disc (44 * 0.8 = 35)
const RADIUS_MAX = 2.5;
const RADIUS_STEP = 0.1;
const DOCK_STEP = 24;
const DOCK_THICK = 44;
const DOCK_MARGIN = 6;
/** Dropped within this many px of the fairy, a pinned fairy rejoins the swarm. */
const REJOIN_PX = 80;
/** The pointer must travel this far with the button down before a press is a drag. */
const DRAG_PX = 8;
const MAX_LIST = 400;
const TITLE_BAR = 32;

const KIND_LABELS = Object.freeze({
  persona: "Discord persona",
  fleet: "Fleet agent",
  session: "Claude terminal session",
  subagent: "Subagent",
  remote: "Remote endpoint",
  goblin: "GargBot goblin",
});

const STATE_LABELS = Object.freeze({
  waiting: "Waiting on you",
  speaking: "Speaking now",
  working: "Working",
  idle: "Idle",
});

function clip(text, max) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Which filter group a companion belongs to. */
function kindGroup(c) {
  const kind = String((c && c.kind) || "");
  const agent = String((c && c.agent) || "");
  if (kind === "session" || agent.startsWith("session-")) return "terminals";
  if (kind === "subagent") return "subagents";
  if (kind === "remote") return "remote";
  return "agents";
}

function kindLabel(c) {
  const kind = String((c && c.kind) || "");
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  if (kindGroup(c) === "terminals") return KIND_LABELS.session;
  return c && c.bot ? "Discord bot agent" : "Agent";
}

function stateLabel(state) {
  return STATE_LABELS[String(state || "")] || STATE_LABELS.idle;
}

/** What the number on the fairy means. "" when it carries no number. */
function badgeMeaning(c) {
  const n = Math.max(0, Number(c && c.count) || 0);
  if (!n) return "";
  return `Badge ${n} = ${n} card${n === 1 ? "" : "s"} waiting on you`;
}

/**
 * The full tooltip: name, kind, status (and the work it is on), what the badge
 * means, and how to act on it. Five lines at most.
 */
function detailLines(c, { muted = false, pinned = false, selected = false } = {}) {
  const name = clip((c && (c.label || c.agent)) || "Agent", 40);
  const lines = [name, kindLabel(c)];
  const st = stateLabel(c && c.state);
  const what = c && c.title && !["idle", "working", "waiting", "speaking"].includes(String(c.title))
    ? ` · ${clip(c.title, 44)}` : "";
  lines.push(`${st}${what}${muted ? " (muted)" : ""}`);
  const badge = badgeMeaning(c);
  if (badge) lines.push(badge);
  const how = pinned ? "Drag to move, drop on the fairy to rejoin" : selected ? "Selected" : "Click to select";
  lines.push(`${how} · right-click for more`);
  return lines;
}

function detailText(c, flags) {
  return detailLines(c, flags).join("\n");
}

// -- the view state (persisted in orb.json) ----------------------------------------

function clampRadius(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(n * 100) / 100));
}

/** One wheel notch: scroll up grows the swarm, scroll down tightens it. */
function stepRadius(current, deltaY) {
  const d = Number(deltaY) || 0;
  if (!d) return clampRadius(current);
  return clampRadius(Number(current) + (d < 0 ? RADIUS_STEP : -RADIUS_STEP));
}

function agentList(raw) {
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const s = String(v || "").trim().toLowerCase().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function normalizeView(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const pins = {};
  const rawPins = src.pins && typeof src.pins === "object" ? src.pins : {};
  for (const [agent, at] of Object.entries(rawPins).slice(0, MAX_LIST)) {
    const key = String(agent || "").trim().toLowerCase().slice(0, 40);
    const x = Number(at && at.x);
    const y = Number(at && at.y);
    if (key && Number.isFinite(x) && Number.isFinite(y)) pins[key] = { x: Math.round(x), y: Math.round(y) };
  }
  return {
    mode: MODES.includes(src.mode) ? src.mode : "gather",
    radius: clampRadius(src.radius == null ? 1 : src.radius),
    kind: KIND_FILTERS.includes(src.kind) ? src.kind : "all",
    avoid: src.avoid !== false,
    hidden: agentList(src.hidden),
    muted: agentList(src.muted),
    pins,
  };
}

/**
 * Split the live companions by the view: the ring (not hidden, not pinned, passes the
 * kind filter) and the pinned ones (each its own small window). Hidden and pinned are
 * by agent id, so an agent that leaves and returns keeps its place.
 */
function applyView(companions, view) {
  const v = normalizeView(view);
  const all = Array.isArray(companions) ? companions : [];
  const visible = [];
  const pinned = [];
  let hidden = 0;
  for (const c of all) {
    if (!c || !c.agent) continue;
    if (v.pins[c.agent]) { pinned.push(c); continue; }
    if (v.hidden.includes(c.agent)) { hidden += 1; continue; }
    if (v.kind !== "all" && kindGroup(c) !== v.kind) continue;
    visible.push(c);
  }
  return { visible, pinned, hidden, total: all.length, view: v };
}

/** What the page needs beside the core companion row: tooltip text and the marks. */
function decorate(c, view, { selected = "" } = {}) {
  const v = normalizeView(view);
  const muted = v.muted.includes(c.agent);
  const pinned = Boolean(v.pins[c.agent]);
  const isSelected = selected === c.agent;
  return {
    ...c,
    group: kindGroup(c),
    kindLabel: kindLabel(c),
    muted,
    pinned,
    selected: isSelected,
    detail: detailText(c, { muted, pinned, selected: isSelected }),
  };
}

// -- layout (the page carries a copy of this block) -------------------------------

/* SWARM_LAYOUT:begin */
function swarmSlots(mode, n, scale) {
  const sc = Math.min(2.5, Math.max(0.8, Number(scale) || 1));
  const spread = mode === "scatter";
  const size = Math.max(9, 14 - 0.25 * Math.max(0, n - 6));
  const hit = Math.max(16, size + 4);
  const slots = [];
  let ring = 0;
  let left = n;
  while (left > 0) {
    const cap = spread ? 4 + ring * 3 : 6 + ring * 4;
    const on = Math.min(cap, left);
    const base = spread ? 70 + ring * 46 : 44 + ring * 18;
    for (let i = 0; i < on; i += 1) slots.push({ ring, radius: base * sc, index: i, of: on, size, hit, squash: spread ? 0.92 : 0.82 });
    left -= on;
    ring += 1;
  }
  return slots;
}
function swarmOffset(slot, now) {
  const dir = slot.ring % 2 === 0 ? 1 : -1;
  const turn = (now / (9000 + slot.ring * 3000)) * dir;
  const a = 2 * Math.PI * (slot.index / Math.max(1, slot.of)) + 2 * Math.PI * turn + slot.ring * 0.4;
  return { x: Math.round(Math.cos(a) * slot.radius), y: Math.round(Math.sin(a) * slot.radius * slot.squash) };
}
function dockOffset(i, n, edge) {
  const along = (i - (n - 1) / 2) * 24;
  return edge === "top" || edge === "bottom" ? { x: Math.round(along), y: 0 } : { x: 0, y: Math.round(along) };
}
function avoidPoint(p, rect, margin) {
  if (!rect) return p;
  const l = rect.l - margin;
  const t = rect.t - margin;
  const r = rect.r + margin;
  const b = rect.b + margin;
  if (p.x < l || p.x > r || p.y < t || p.y > b) return p;
  const dl = p.x - l;
  const dr = r - p.x;
  const dt = p.y - t;
  const db = b - p.y;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: l, y: p.y };
  if (m === dr) return { x: r, y: p.y };
  if (m === dt) return { x: p.x, y: t };
  return { x: p.x, y: b };
}
/* SWARM_LAYOUT:end */

/** Half the side of the square the ring layouts need. */
function swarmExtent(mode, n, scale) {
  const slots = swarmSlots(mode, Math.max(0, Math.floor(Number(n) || 0)), scale);
  if (!slots.length) return 0;
  const outer = slots[slots.length - 1];
  return Math.ceil(outer.radius + Math.max(outer.size, outer.hit) / 2 + 8);
}

// -- docking -------------------------------------------------------------------------

/** The screen edge nearest to `center` ({x,y}) inside `area` ({x,y,width,height}). */
function dockEdge(center, area) {
  const a = area || { x: 0, y: 0, width: 1920, height: 1080 };
  const dist = {
    left: Math.abs(center.x - a.x),
    right: Math.abs(a.x + a.width - center.x),
    top: Math.abs(center.y - a.y),
    bottom: Math.abs(a.y + a.height - center.y),
  };
  return Object.keys(dist).sort((p, q) => dist[p] - dist[q])[0];
}

/** The window rect of a docked strip: along the edge, centred on the fairy's height / width. */
function dockBounds(edge, n, center, area) {
  const a = area || { x: 0, y: 0, width: 1920, height: 1080 };
  const long = Math.max(DOCK_THICK, Math.max(1, n) * DOCK_STEP + 16);
  if (edge === "top" || edge === "bottom") {
    const w = Math.min(long, a.width);
    const x = Math.min(Math.max(a.x, Math.round(center.x - w / 2)), a.x + a.width - w);
    return { x, y: edge === "top" ? a.y + DOCK_MARGIN : a.y + a.height - DOCK_THICK - DOCK_MARGIN, width: w, height: DOCK_THICK };
  }
  const h = Math.min(long, a.height);
  const y = Math.min(Math.max(a.y, Math.round(center.y - h / 2)), a.y + a.height - h);
  return { x: edge === "left" ? a.x + DOCK_MARGIN : a.x + a.width - DOCK_THICK - DOCK_MARGIN, y, width: DOCK_THICK, height: h };
}

/**
 * The swarm window's rect for a view: the ring square around `center`, or the docked
 * strip. null = no window (collapsed to one orb, or nothing to draw).
 */
function boundsFor(view, count, center, area) {
  const v = normalizeView(view);
  if (!count || v.mode === "orb") return null;
  if (v.mode === "dock") {
    const edge = dockEdge(center, area);
    return { ...dockBounds(edge, count, center, area), edge };
  }
  const half = Math.max(48, swarmExtent(v.mode, count, v.radius));
  return {
    x: Math.round(center.x - half), y: Math.round(center.y - half), width: half * 2, height: half * 2, edge: "",
  };
}

// -- the focused window --------------------------------------------------------------

/** The content area of a window rect {x,y,width,height}: below its title bar. */
function contentRect(r, titleBar = TITLE_BAR) {
  if (!r) return null;
  const x = Number(r.x);
  const y = Number(r.y);
  const w = Number(r.width);
  const h = Number(r.height);
  if (![x, y, w, h].every(Number.isFinite) || w < 80 || h < 80) return null;
  return { x, y: y + titleBar, width: w, height: Math.max(0, h - titleBar) };
}

/** `rect` (screen) as {l,t,r,b} relative to a centre point: what the page pushes against. */
function relativeRect(rect, center) {
  if (!rect) return null;
  return {
    l: Math.round(rect.x - center.x), t: Math.round(rect.y - center.y),
    r: Math.round(rect.x + rect.width - center.x), b: Math.round(rect.y + rect.height - center.y),
  };
}

/** Pure parse of the foreground probe's one JSON line. null = no usable window. */
function parseForeground(line) {
  let row;
  try { row = JSON.parse(String(line || "").trim()); } catch { return null; }
  if (!row || typeof row !== "object" || !row.ok) return null;
  const x = Number(row.x);
  const y = Number(row.y);
  const w = Number(row.w);
  const h = Number(row.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const cls = String(row.cls || "");
  if (/^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd)$/.test(cls)) return null;
  return { x, y, width: w, height: h, cls, title: clip(row.title || "", 80) };
}

function sameRect(a, b, tol = 3) {
  if (!a || !b) return a === b;
  return ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) <= tol);
}

/** Dropped at `point`, does a pinned fairy rejoin the swarm around `center`? */
function joinsCluster(point, center, radius = REJOIN_PX) {
  return Math.hypot(point.x - center.x, point.y - center.y) <= radius;
}

// -- menus ---------------------------------------------------------------------------

/**
 * The right-click control rows on an agent's fairy.
 *   chat, grow, mute, pin, hide, open session, and the swarm layout menu.
 */
function controlItems({ label = "", agent = "", muted = false, pinned = false, hasSession = false, canGrow = true } = {}) {
  const who = clip(label || agent || "this agent", 24);
  return [
    { id: "fc:chat", label: `Chat with ${who}`, hint: "Open a chat with this agent" },
    canGrow
      ? { id: "fc:grow", label: "Grow into an avatar", hint: "This fairy becomes a full avatar on the stage" }
      : { id: "fc:grow", label: "Grow into an avatar", disabled: true, hint: "No body for this agent" },
    { id: "fc:mute", label: muted ? "Unmute" : "Mute", hint: muted ? "Let it nudge you again" : "No more nudges from it; it stays on the badge" },
    { id: "fc:pin", label: pinned ? "Unpin (rejoin the swarm)" : "Pin to the screen", hint: pinned ? "Back into the ring around the fairy" : "Keep it where you put it, out of the ring" },
    { id: "fc:hide", label: "Hide this fairy", hint: "Out of sight until you show hidden fairies" },
    hasSession
      ? { id: "fc:session", label: "Open session", hint: "Bring its terminal tab to the front" }
      : { id: "fc:session", label: "Open session", disabled: true, hint: "This agent has no terminal session" },
    { id: "sv:menu", label: "Swarm layout…", hint: "Gather, scatter, one orb, dock to the edge, filter by kind" },
  ];
}

const MODE_ROWS = Object.freeze([
  ["gather", "Gather around the fairy", "A tight ring (scroll over a fairy to resize it)"],
  ["scatter", "Scatter", "A wide loose spread"],
  ["orb", "Collapse into one orb", "Hide the ring; the orb alone, with the count"],
  ["dock", "Dock to the screen edge", "A column along the nearest edge"],
]);
const FILTER_ROWS = Object.freeze([
  ["all", "Show every kind"],
  ["agents", "Show agents only (Discord, fleet)"],
  ["terminals", "Show terminal sessions only"],
  ["subagents", "Show subagents only"],
  ["remote", "Show remote endpoints only"],
]);

/** The swarm layout menu. counts: {total, hidden, pinned}. */
function viewItems(view, counts = {}) {
  const v = normalizeView(view);
  const mark = (on, text) => (on ? `${text} ✓` : text);
  const items = MODE_ROWS.map(([id, label, hint]) => ({ id: `sv:mode:${id}`, label: mark(v.mode === id, label), hint, checked: v.mode === id }));
  items.push({ sep: true });
  for (const [id, label] of FILTER_ROWS) items.push({ id: `sv:kind:${id}`, label: mark(v.kind === id, label), checked: v.kind === id });
  items.push({ sep: true });
  items.push({ id: "sv:avoid", label: mark(v.avoid, "Keep off the focused window"), hint: "The ring moves aside rather than cover what you are working in", checked: v.avoid });
  items.push({ id: "sv:radius:reset", label: "Reset the size", hint: "Scroll over a fairy to change the radius", disabled: v.radius === 1 });
  const hidden = Math.max(0, Number(counts.hidden) || 0);
  const pinned = Math.max(0, Number(counts.pinned) || 0);
  items.push(hidden
    ? { id: "sv:unhide", label: `Show ${hidden} hidden fairy${hidden === 1 ? "" : "s"}` }
    : { id: "sv:unhide", label: "Show hidden fairies", disabled: true, hint: "None are hidden" });
  items.push(pinned
    ? { id: "sv:unpin", label: `Unpin ${pinned} pinned fairy${pinned === 1 ? "" : "s"}` }
    : { id: "sv:unpin", label: "Unpin all", disabled: true, hint: "None are pinned" });
  const total = Math.max(0, Number(counts.total) || 0);
  return { header: `Swarm · ${total} agent${total === 1 ? "" : "s"}`, items };
}

/** Apply a "sv:..." pick to a view. Returns {view, changed} or {error}. */
function applyViewPick(view, id) {
  const v = normalizeView(view);
  const what = String(id || "");
  if (what.startsWith("sv:mode:")) {
    const mode = what.slice(8);
    return MODES.includes(mode) ? { view: { ...v, mode }, changed: v.mode !== mode } : { error: `unknown mode ${mode}` };
  }
  if (what.startsWith("sv:kind:")) {
    const kind = what.slice(8);
    return KIND_FILTERS.includes(kind) ? { view: { ...v, kind }, changed: v.kind !== kind } : { error: `unknown kind ${kind}` };
  }
  if (what === "sv:avoid") return { view: { ...v, avoid: !v.avoid }, changed: true };
  if (what === "sv:radius:reset") return { view: { ...v, radius: 1 }, changed: v.radius !== 1 };
  if (what === "sv:unhide") return { view: { ...v, hidden: [] }, changed: v.hidden.length > 0 };
  if (what === "sv:unpin") return { view: { ...v, pins: {} }, changed: Object.keys(v.pins).length > 0 };
  return { error: `unknown swarm row ${what}` };
}

function toggleIn(list, agent) {
  const a = String(agent || "").trim().toLowerCase();
  return list.includes(a) ? list.filter((x) => x !== a) : [...list, a];
}

module.exports = {
  MODES, KIND_FILTERS, RADIUS_MIN, RADIUS_MAX, RADIUS_STEP, DOCK_STEP, DOCK_THICK, REJOIN_PX, DRAG_PX, TITLE_BAR,
  kindGroup, kindLabel, stateLabel, badgeMeaning, detailLines, detailText,
  clampRadius, stepRadius, normalizeView, applyView, decorate,
  swarmSlots, swarmOffset, dockOffset, avoidPoint, swarmExtent,
  dockEdge, dockBounds, boundsFor,
  contentRect, relativeRect, parseForeground, sameRect, joinsCluster,
  controlItems, viewItems, applyViewPick, toggleIn,
};
