"use strict";

/**
 * display-mode.cjs -- HOW the companion is drawn: the docked avatar, the fairy
 * cluster, or BOTH at once (owner, 2026-11-20, with a screenshot of the VRM and the
 * fairy cluster standing side by side: "I want a mode where the docked avatar AND a
 * fairy -- or a swarm of fairies -- are displayed at the same time").
 *
 * Until now one of the two windows was the companion: `fairy` (the orb and its
 * cluster, the default) or `avatar` (the full VRM). This module adds the two
 * combinations and the pure layout that keeps them from painting over each other:
 *
 *   avatar  the docked VRM only                          cluster off
 *   fairy   the orb and its cluster only                 avatar off   (today's default)
 *   both    the VRM, the cluster beside it               never intersecting
 *   swarm   the VRM, up to N fairy orbs around it        one badge each
 *
 * The ONE-cluster rule is untouched: there is still one cluster, anchored either on
 * the orb (fairy) or on the avatar (both/swarm). A fairy dragged out and released
 * flies to its SLOT when a slot layout owns it (both/swarm) and home otherwise.
 *
 * The settings live in the SAME store as the avatar dock (userData/avatar-dock.json),
 * beside `docked`, so one file answers where and how the companion shows. This
 * module is PURE (no electron, no fs): main injects the store text, orb-window
 * injects the avatar rect and the work area. node --test electron/display-mode.test.cjs
 */

const MODES = Object.freeze(["avatar", "fairy", "both", "swarm"]);
/** What every existing install already shows: the fairy cluster. Never change this
 *  default without a migration -- it is the "ships today" in the owner's ask. */
const DEFAULT_MODE = "fairy";
/** Past six the cluster collapses into a counted bead (fairy-cluster CAP), so a
 *  swarm wider than that would only re-count the same fairies. */
const SWARM_MAX = 6;
const DEFAULT_SWARM = 4;
/** The orb slot a swarm fairy is drawn in (fairy-control's pinned-fairy size). */
const ORB_SIZE = Object.freeze({ width: 44, height: 44 });
const GAP = 12;

const MODE_TEXT = Object.freeze({
  avatar: "Display: avatar only",
  fairy: "Display: fairy only",
  both: "Display: avatar and fairy",
  swarm: "Display: swarm around the avatar",
});
const MODE_HINT = Object.freeze({
  avatar: "The docked body, nothing else on the desk",
  fairy: "The orb and its cluster, no full body (today's default)",
  both: "The body, with the fairy cluster parked beside it -- never on it",
  swarm: "The body, with up to N agent fairies spread around it",
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The saved shape: {mode, swarm}. Anything unknown becomes today's fairy. */
function normalize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    mode: MODES.includes(src.mode) ? src.mode : DEFAULT_MODE,
    swarm: clampInt(src.swarm, 1, SWARM_MAX, DEFAULT_SWARM),
  };
}

/**
 * The avatar-dock.json text -> settings. `docked` and any other key are not ours;
 * neither is losing them. A bad file costs the mode, never a launch.
 */
function readStore(text) {
  let src;
  try { src = JSON.parse(String(text == null ? "" : text)); } catch { /* not ours */ }
  const raw = src && typeof src === "object" && !Array.isArray(src) ? src : {};
  return normalize({ mode: raw.displayMode, swarm: raw.displaySwarm });
}

/** Settings -> the merged store text, preserving every key the avatar dock wrote. */
function writeStore(text, settings) {
  let src;
  try { src = JSON.parse(String(text == null ? "" : text)); } catch { /* not ours */ }
  const base = src && typeof src === "object" && !Array.isArray(src) ? src : {};
  const next = normalize(settings);
  return JSON.stringify({ ...base, displayMode: next.mode, displaySwarm: next.swarm });
}

/** Which of the desk's companion layers this mode allows. `cluster` is the fairy
 *  cluster window; `orb` the 72 px ask orb the cluster normally centres on. */
function layers(mode) {
  switch (normalize({ mode }).mode) {
    case "avatar": return { avatar: true, cluster: false, orb: false };
    case "fairy": return { avatar: false, cluster: true, orb: true };
    case "both": return { avatar: true, cluster: true, orb: false };
    default: return { avatar: true, cluster: true, orb: false }; // swarm
  }
}

/** How many of the live fairies this mode draws. 0 = the cluster is off. */
function capacity(mode, total, settings = {}) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const m = normalize({ mode, swarm: settings.swarm }).mode;
  if (m === "avatar") return 0;
  if (m === "swarm") return Math.min(n, normalize({ swarm: settings.swarm }).swarm);
  return n;
}

/** What the cluster hangs from: "avatar", "orb" or null (the cluster is off). */
function clusterAnchor(mode) {
  const m = normalize({ mode }).mode;
  if (m === "avatar") return null;
  return m === "fairy" ? "orb" : "avatar";
}

function normRect(rect) {
  if (!rect) return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function rectOf(center, half, size) {
  return { x: Math.round(center.x - half), y: Math.round(center.y - half), width: size, height: size };
}

function intersect(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

function insideArea(rect, area) {
  return rect.x >= area.x && rect.y >= area.y
    && rect.x + rect.width <= area.x + area.width
    && rect.y + rect.height <= area.y + area.height;
}

function clampRect(rect, area) {
  const x = Math.min(Math.max(area.x, rect.x), area.x + area.width - rect.width);
  const y = Math.min(Math.max(area.y, rect.y), area.y + area.height - rect.height);
  return { ...rect, x: Math.round(x), y: Math.round(y) };
}

/**
 * The cluster WINDOW rect for a mode. It is square (half the side): on the orb
 * (fairy), centred on the avatar (swarm, whose orbs are outside it), or parked
 * BESIDE the avatar (both). `both` never intersects the avatar: the four candidate
 * sides are tried in order and the one with room wins; with no room the side with the
 * most space is clamped into the work area. null = no cluster.
 */
function clusterRect(mode, { avatarRect = null, orbCenter = null, clusterHalf = 0, area = null } = {}) {
  const m = normalize({ mode }).mode;
  if (m === "avatar") return null;
  const half = Math.max(1, Math.round(Number(clusterHalf) || 0));
  const size = half * 2;
  const work = normRect(area) || { x: 0, y: 0, width: 1920, height: 1080 };
  if (m === "fairy") {
    const c = orbCenter && Number.isFinite(Number(orbCenter.x)) && Number.isFinite(Number(orbCenter.y))
      ? { x: Number(orbCenter.x), y: Number(orbCenter.y) } : { x: work.x + work.width / 2, y: work.y + work.height / 2 };
    return clampRect(rectOf(c, half, size), work);
  }
  const avatar = normRect(avatarRect);
  if (!avatar) return clusterRect("fairy", { orbCenter, clusterHalf: half, area: work });
  const cx = avatar.x + avatar.width / 2;
  const cy = avatar.y + avatar.height / 2;
  // `swarm` is a ring OF the avatar, not beside it: the transparent overlay is centred
  // on the body and the orbs (swarmOrbs) stand on a radius outside it.
  if (m === "swarm") return clampRect(rectOf({ x: cx, y: cy }, half, size), work);
  const candidates = [
    { side: "right", point: { x: avatar.x + avatar.width + GAP + half, y: cy } },
    { side: "left", point: { x: avatar.x - GAP - half, y: cy } },
    { side: "bottom", point: { x: cx, y: avatar.y + avatar.height + GAP + half } },
    { side: "top", point: { x: cx, y: avatar.y - GAP - half } },
  ];
  for (const c of candidates) {
    const rect = rectOf(c.point, half, size);
    if (insideArea(rect, work)) return rect;
  }
  // No side has the room (a body wider than the work area): the side with the most
  // space still wins, clamped, and the caller's assertion (non-intersection) holds
  // for every realistic work area because `both` needs an avatar the owner can see.
  const space = {
    right: work.x + work.width - (avatar.x + avatar.width),
    left: avatar.x - work.x,
    bottom: work.y + work.height - (avatar.y + avatar.height),
    top: avatar.y - work.y,
  };
  const side = Object.keys(space).sort((a, b) => space[b] - space[a])[0];
  return clampRect(rectOf(candidates.find((c) => c.side === side).point, half, size), work);
}

/** The cluster's CENTRE (what orb-window's follow/swarm maths wants). */
function clusterCenter(mode, opts = {}) {
  const rect = clusterRect(mode, opts);
  return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
}

/**
 * Up to `max` fairy orbs spread around the avatar, each carrying its own agent
 * badge. Ring order follows the roster; duplicates collapse. Any orb the work area
 * (or another orb) would cover is pushed outward from the avatar before it is
 * clamped, so the rects never intersect the body or each other.
 */
function swarmOrbs(avatarRect, companions, { max = DEFAULT_SWARM, area = null, size = ORB_SIZE } = {}) {
  const avatar = normRect(avatarRect);
  const work = normRect(area) || { x: 0, y: 0, width: 1920, height: 1080 };
  const count = Math.min(SWARM_MAX, Math.max(0, Math.floor(Number(max) || 0)));
  if (!avatar || !count) return [];
  const seen = new Set();
  const rows = [];
  for (const c of Array.isArray(companions) ? companions : []) {
    const agent = String((c && c.agent) || "").trim().toLowerCase();
    if (!agent || seen.has(agent)) continue;
    seen.add(agent);
    rows.push(c);
    if (rows.length >= count) break;
  }
  const w = Math.max(ORB_SIZE.width, Number(size && size.width) || ORB_SIZE.width);
  const h = Math.max(ORB_SIZE.height, Number(size && size.height) || ORB_SIZE.height);
  const cx = avatar.x + avatar.width / 2;
  const cy = avatar.y + avatar.height / 2;
  const radius = Math.max(avatar.width, avatar.height) / 2 + GAP + Math.max(w, h) / 2;
  const orbs = rows.map((c, index) => {
    // Start at the top and go clockwise, so a three-fairy swarm reads as a tripod.
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / rows.length;
    let rect = {
      x: Math.round(cx + Math.cos(angle) * radius - w / 2),
      y: Math.round(cy + Math.sin(angle) * radius - h / 2),
      width: w,
      height: h,
    };
    // An edge-clamped slot must not slide onto the body: push it back out first.
    if (intersect(rect, avatar)) {
      const dx = rect.x + w / 2 - cx;
      const dy = rect.y + h / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      rect = {
        ...rect,
        x: Math.round(cx + (dx / d) * (radius + w / 2) - w / 2),
        y: Math.round(cy + (dy / d) * (radius + h / 2) - h / 2),
      };
    }
    return {
      agent: String(c.agent).toLowerCase(),
      label: String(c.label || c.agent || ""),
      count: Math.max(0, Number(c.count) || 0),
      // The badge IS the agent: two fairies never share one.
      badge: String(c.agent).toLowerCase(),
      index,
      rect: clampRect(rect, work),
    };
  });
  // Pairwise de-overlap (a tiny work area can fold two slots together).
  for (let i = 0; i < orbs.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      let guard = 0;
      while (intersect(orbs[i].rect, orbs[j].rect) && guard < 8) {
        orbs[i].rect = clampRect({ ...orbs[i].rect, x: orbs[i].rect.x + w, y: orbs[i].rect.y }, work);
        guard += 1;
      }
    }
  }
  return orbs;
}

/**
 * Where a released fairy goes. With a slot layout (both/swarm) it flies back to its
 * ring slot; on the orb-anchored fairy it flies home to the resting spot.
 */
function releaseTarget({ mode, slot = null, home = null } = {}) {
  const m = normalize({ mode }).mode;
  const usable = (p) => Boolean(p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  if ((m === "both" || m === "swarm") && usable(slot)) {
    return { to: "slot", point: { x: Math.round(Number(slot.x)), y: Math.round(Number(slot.y)) } };
  }
  return { to: "home", point: usable(home) ? { x: Math.round(Number(home.x)), y: Math.round(Number(home.y)) } : null };
}

/**
 * What a mode switch must put away. There is one cluster and one veil; a switch
 * must never leave a painted trail, a pinned fairy or a menu from the old layout.
 * `reanchor` names what the cluster hangs from next ("orb" | "avatar" | null).
 */
function settle(from, to) {
  const a = normalize({ mode: from }).mode;
  const b = normalize({ mode: to }).mode;
  if (a === b) {
    return { changed: false, hideTrail: false, hideMenu: false, clearHover: false, clearPins: false, reanchor: clusterAnchor(b) };
  }
  return {
    changed: true,
    hideTrail: true,
    hideMenu: true,
    clearHover: true,
    // A slot layout owns where every fairy stands; a stray pin would float over it.
    clearPins: b === "both" || b === "swarm",
    reanchor: clusterAnchor(b),
  };
}

/** The four mode rows the desk's fairy/avatar menus carry, one checked. */
function modeItems(settings = {}) {
  const s = normalize(settings);
  return MODES.map((mode) => ({
    id: `dm:${mode}`,
    label: s.mode === mode ? `${MODE_TEXT[mode]} ✓` : MODE_TEXT[mode],
    hint: MODE_HINT[mode],
    checked: s.mode === mode,
  }));
}

/** Apply a `dm:<mode>` pick. Returns {settings, changed} or {error}. */
function applyModePick(settings, id) {
  const what = String(id || "");
  const mode = what.startsWith("dm:") ? what.slice(3) : "";
  if (!MODES.includes(mode)) return { error: `unknown display mode ${mode || what}` };
  const cur = normalize(settings);
  return { settings: { ...cur, mode }, changed: cur.mode !== mode };
}

/** The keyboard cycle: fairy -> both -> swarm -> avatar -> fairy. */
function cycle(mode) {
  const order = ["fairy", "both", "swarm", "avatar"];
  const i = order.indexOf(normalize({ mode }).mode);
  return order[(i + 1) % order.length];
}

module.exports = {
  MODES, DEFAULT_MODE, SWARM_MAX, DEFAULT_SWARM, ORB_SIZE,
  normalize, readStore, writeStore,
  layers, capacity, clusterAnchor, clusterRect, clusterCenter, swarmOrbs,
  releaseTarget, settle, modeItems, applyModePick, cycle,
};
