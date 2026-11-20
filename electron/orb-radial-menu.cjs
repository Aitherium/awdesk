"use strict";

/**
 * orb-radial-menu.cjs -- the Aither menu as a RADIAL fan (owner, 2026-11-20: today it
 * is "a long vertical stack of pills"; he wants "a ring of sectors or buttons around
 * the orb/avatar, with a centre hub that closes it").
 *
 * The ITEMS are not built here. They are the same {id, label, hint, checked} rows
 * fairy-menu.cjs already produces from the command registry and companion-menu.cjs
 * (`orbItems`), so this module is presentation only: it pages them onto rings, puts
 * the four Display modes on their own inner ring, and places every button inside a
 * square window centred on the click, flipping the fan INWARD at a screen edge so no
 * button ever lands half off the work area.
 *
 * PURE: no electron, no fs, no window. Geometry reuses the desk's ONE radial lane
 * (quick-menu.cjs radialBounds, launcher-core.cjs sliceAngle) instead of a second
 * copy of the maths. node --test electron/orb-radial-menu.test.cjs
 */

const launcherCore = require("./launcher-core.cjs");
const quickMenu = require("./quick-menu.cjs");

/** The square window, in DIPs. An outer pill (132 x 30) at radius 150 fits by 224. */
const RING = Object.freeze({ size: 448, outerRadius: 150, innerRadius: 82, hub: 48 });
const PILL = Object.freeze({ width: 132, height: 30 });
const CHIP = Object.freeze({ width: 64, height: 64 });
/** One ring shows at most this many actions, then a "More" button (owner's cap). */
const PER_RING = 5;
/** The Display modes own the inner ring; four is the whole set. */
const INNER_MAX = 4;

function isDisplayItem(item) {
  return Boolean(item && !item.sep && /^dm:/.test(String(item.id || "")));
}

/**
 * Split the menu into the inner (Display) ring and a page of outer actions.
 * `more` walks to the next page and wraps, so every action stays reachable while a
 * ring never shows more than PER_RING actions + the More button.
 */
function plan(items, { page = 0, perRing = PER_RING } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item && !item.sep);
  const inner = list.filter(isDisplayItem).slice(0, INNER_MAX);
  const actions = list.filter((item) => !isDisplayItem(item));
  const pages = Math.max(1, Math.ceil(actions.length / perRing));
  const raw = Number(page);
  const current = Math.min(Math.max(0, Number.isFinite(raw) ? Math.trunc(raw) : 0), pages - 1);
  const outer = actions.slice(current * perRing, current * perRing + perRing);
  const more = pages > 1
    ? {
      id: `radial:page:${(current + 1) % pages}`,
      label: `More… (${current + 1}/${pages})`,
      hint: "The rest of the menu",
      page: (current + 1) % pages,
    }
    : null;
  return { inner, outer, more, page: current, pages };
}

/**
 * The arc the buttons occupy, in degrees (0 = east, 90 = south, screen convention).
 * The window clamps to the work area; when it had to move on an axis, the fan opens
 * away from that edge (a ring clamped at the left edge only uses its right half).
 */
function fanArc(at, box) {
  const x = Number(at && at.x);
  const y = Number(at && at.y);
  const cx = Number(box && box.center && box.center.x);
  const cy = Number(box && box.center && box.center.y);
  if (![x, y, cx, cy].every(Number.isFinite)) return { start: -90, span: 360 };
  const east = cx > x + 0.5;
  const west = cx < x - 0.5;
  const south = cy > y + 0.5;
  const north = cy < y - 0.5;
  if (east && south) return { start: 0, span: 90 };
  if (east && north) return { start: -90, span: 90 };
  if (west && south) return { start: 90, span: 90 };
  if (west && north) return { start: 180, span: 90 };
  if (east) return { start: -90, span: 180 };
  if (west) return { start: 90, span: 180 };
  if (south) return { start: 0, span: 180 };
  if (north) return { start: 180, span: 180 };
  return { start: -90, span: 360 };
}

function place(center, radius, angle) {
  const rad = (angle * Math.PI) / 180;
  return {
    x: Math.round((center.x + radius * Math.cos(rad)) * 10) / 10,
    y: Math.round((center.y + radius * Math.sin(rad)) * 10) / 10,
  };
}

/**
 * The whole radial model for one page.
 *
 * Args:
 *   items: fairy-menu rows ({id,label,hint,checked,disabled} or {sep:true}).
 *   opts.at: the click point (screen DIPs) -- the ring's anchor.
 *   opts.area: the display's work area (screen DIPs).
 *   opts.page: which ring page; clamped, wrapping via the More button.
 *
 * Returns every button with WINDOW-LOCAL x/y (the renderer places it with
 * transform: translate(-50%,-50%)), plus the window bounds to set.
 */
function radialModel(items, { at = null, area = null, page = 0 } = {}) {
  const p = plan(items, { page });
  const anchor = at && Number.isFinite(Number(at.x)) && Number.isFinite(Number(at.y))
    ? { x: Number(at.x), y: Number(at.y) } : { x: 0, y: 0 };
  const box = quickMenu.radialBounds(anchor, area, RING.size);
  const center = { x: box.width / 2, y: box.height / 2 };
  const arc = fanArc(anchor, box);
  const nodes = [];
  // Inner ring: the four Display modes, clockwise from the top, with keys 1..4.
  p.inner.forEach((item, index) => {
    const angle = launcherCore.sliceAngle(index, p.inner.length);
    const point = place(center, RING.innerRadius, angle);
    nodes.push({
      ...item,
      ring: "inner",
      index,
      key: String(index + 1),
      x: point.x,
      y: point.y,
      width: CHIP.width,
      height: CHIP.height,
      angle,
    });
  });
  // Outer ring: one page of actions, then the More button (also a key).
  const outerCount = p.outer.length + (p.more ? 1 : 0);
  const outerAt = (index) => {
    if (arc.span >= 360) return launcherCore.sliceAngle(index, outerCount);
    return arc.start + (arc.span * (index + 0.5)) / Math.max(1, outerCount);
  };
  p.outer.forEach((item, index) => {
    const angle = outerAt(index);
    const point = place(center, RING.outerRadius, angle);
    nodes.push({
      ...item,
      ring: "outer",
      index,
      key: String(p.inner.length + index + 1),
      x: point.x,
      y: point.y,
      width: PILL.width,
      height: PILL.height,
      angle,
    });
  });
  if (p.more) {
    const index = p.outer.length;
    const angle = outerAt(index);
    const point = place(center, RING.outerRadius, angle);
    nodes.push({
      ...p.more,
      ring: "outer",
      more: true,
      index,
      key: String(p.inner.length + index + 1),
      x: point.x,
      y: point.y,
      width: PILL.width,
      height: PILL.height,
      angle,
    });
  }
  return {
    layout: "radial",
    page: p.page,
    pages: p.pages,
    window: { x: box.x, y: box.y, width: box.width, height: box.height },
    hub: { x: center.x, y: center.y, width: RING.hub, height: RING.hub, label: "Aither" },
    fan: arc,
    nodes,
  };
}

/** A page id from a More button, or null for anything else. */
function pageFromId(id) {
  const m = /^radial:page:(\d+)$/.exec(String(id || ""));
  return m ? Number(m[1]) : null;
}

module.exports = {
  RING, PILL, CHIP, PER_RING, INNER_MAX,
  isDisplayItem, plan, fanArc, radialModel, pageFromId,
};
