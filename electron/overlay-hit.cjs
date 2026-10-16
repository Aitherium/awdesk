"use strict";

/**
 * overlay-hit -- is the cursor over overlay UI, or over the user's real desktop?
 *
 * The AitherOS Online overlay is one transparent window the size of the work area. Where
 * it draws UI it must take the click; everywhere else the click must reach Windows. The
 * main process flips setIgnoreMouseEvents by this verdict every ~60 ms.
 *
 * Until 2026-10-16 the rule was "no fresh hit-areas from the page => the WHOLE window is
 * clickable" (fail-interactive). On a customer's install that blocked his real desktop
 * entirely: the tenant page sends no hit-areas at all, and the apex page posts them only
 * when they change, so a still screen went "stale" after 5 s. Now, in order:
 *
 *   regions     hit-areas reported within REGIONS_FRESH_MS: the page knows best.
 *   point       the preload's own probe at the cursor (document.elementFromPoint plus the
 *               computed paint of that element and its ancestors), fresh and for this
 *               spot: works on any page, protocol or not.
 *   last-known  the last hit-areas the page ever sent: a still screen has not moved.
 *   fallback    nothing at all yet: only a bottom dock band is clickable.
 *
 * Pure: geometry in, verdict out.
 */

const REGIONS_FRESH_MS = 3000;
const POINT_FRESH_MS = 750;
const POINT_NEAR_PX = 24;
const REGION_PAD = 8;
const FALLBACK_DOCK = Object.freeze({ edge: "bottom", thickness: 56 });
/** An element covering at least this share of the viewport is the backdrop, not UI. */
const BACKDROP_AREA = 0.9;
const CONTROL_TAGS = new Set(["button", "input", "textarea", "select", "a", "img", "video", "iframe", "svg", "label", "summary"]);

function inDock(dock, x, y, bounds) {
  if (!dock || typeof dock.thickness !== "number" || dock.thickness <= 0) return false;
  const t = dock.thickness + REGION_PAD;
  return (dock.edge === "bottom" && y >= bounds.height - t) || (dock.edge === "top" && y <= t)
    || (dock.edge === "left" && x <= t) || (dock.edge === "right" && x >= bounds.width - t);
}

function inRegions(regions, x, y) {
  for (const r of Array.isArray(regions) ? regions : []) {
    if (!r) continue;
    if (x >= r.x - REGION_PAD && x <= r.x + r.w + REGION_PAD && y >= r.y - REGION_PAD && y <= r.y + r.h + REGION_PAD) return true;
  }
  return false;
}

/**
 * Does the probed chain (hit element first, then its ancestors up to <body>) paint
 * anything? Each entry: {tag, bgAlpha, bgImage, borderAlpha, borderWidth, area (share of
 * the viewport), opacity, pointerEvents, role}.
 */
function isPainted(chain) {
  if (!Array.isArray(chain)) return false;
  for (const el of chain) {
    if (!el || typeof el !== "object") continue;
    if (el.pointerEvents === "none") continue; // the page itself says "not this one"
    if (typeof el.opacity === "number" && el.opacity <= 0.02) continue; // invisible
    if (typeof el.area === "number" && el.area >= BACKDROP_AREA) continue; // a full-screen wrapper or canvas
    const tag = String(el.tag || "").toLowerCase();
    if (CONTROL_TAGS.has(tag)) return true;
    if (typeof el.role === "string" && /^(button|dialog|menu|menuitem|link|tab|textbox|listbox|option|toolbar)$/.test(el.role)) return true;
    if ((Number(el.bgAlpha) || 0) > 0.05) return true;
    if (el.bgImage === true) return true;
    if ((Number(el.borderWidth) || 0) > 0 && (Number(el.borderAlpha) || 0) > 0.05) return true;
  }
  return false;
}

/**
 * @param {{now: number, bounds: {x,y,width,height}, cursor: {x,y},
 *          hit: {regions: object[], dock: object|null, reportedAt: number},
 *          point: {x, y, at, chain}|null}} input  cursor/bounds in screen DIP, point in window DIP
 * @returns {{interactive: boolean, source: "outside"|"regions"|"point"|"last-known"|"fallback"}}
 */
function hitVerdict({ now, bounds, cursor, hit, point }) {
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return { interactive: false, source: "outside" };
  const h = hit || { regions: [], dock: null, reportedAt: 0 };
  if (h.reportedAt > 0 && now - h.reportedAt <= REGIONS_FRESH_MS) {
    return { interactive: inDock(h.dock, x, y, bounds) || inRegions(h.regions, x, y), source: "regions" };
  }
  if (point && now - point.at <= POINT_FRESH_MS
    && Math.abs(point.x - x) <= POINT_NEAR_PX && Math.abs(point.y - y) <= POINT_NEAR_PX) {
    return { interactive: isPainted(point.chain), source: "point" };
  }
  if (h.reportedAt > 0) {
    return { interactive: inDock(h.dock, x, y, bounds) || inRegions(h.regions, x, y), source: "last-known" };
  }
  return { interactive: inDock(FALLBACK_DOCK, x, y, bounds), source: "fallback" };
}

module.exports = { BACKDROP_AREA, FALLBACK_DOCK, POINT_FRESH_MS, REGIONS_FRESH_MS, REGION_PAD, hitVerdict, isPainted };
