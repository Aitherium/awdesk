"use strict";

/**
 * browser-panes.cjs -- the split-pane math for the Aither Browser's page area.
 *
 * A "stage" is the page area split into two or three panes side by side (owner,
 * 2026-11-18: "one container with tabs and splits"). browser-window.cjs owns the
 * Electron half -- one WebContentsView per pane, placed from these rects -- and
 * browser-chrome.html draws the dividers in the gaps this module leaves between
 * them, so the chrome page (which sits under the views) keeps the mouse while a
 * divider is dragged.
 *
 * Pure and electron-free: pane rects, divider rects, drag resizing and the session
 * shape are functions of numbers, asserted under node --test. Nothing here reads a
 * window, and no function allocates per frame -- layout runs only when the window
 * resizes or a divider moves.
 *
 * Sizes are FRACTIONS of the pane area and always sum to 1; the minimum width is a
 * floor, not a hard failure: a page area too narrow for every pane's floor splits
 * the room equally instead (the window itself has a minWidth of 720).
 */

/** The narrowest a horizontal pane is allowed to be, in DIP. */
const PANE_MIN = 240;
/** The same floor for a vertical stack. */
const PANE_MIN_VERTICAL = 160;
/** The gap between two panes: the divider the chrome page draws and drags. */
const DIVIDER = 6;
/** Two or three panes: "2 or 3" is the owner's own limit. */
const MAX_PANES = 3;

/** Equal shares for `count` panes, summing to 1. */
function defaultSizes(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * `sizes` as positive fractions summing to 1, exactly `count` long (default: its own
 * length). Garbage becomes an equal share, so a hand-edited layout file can never
 * produce a zero-width pane.
 * @param {number[]} sizes
 * @param {number} [count]
 * @returns {number[]}
 */
function normalizeSizes(sizes, count = Array.isArray(sizes) ? sizes.length : 0) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  const given = Array.isArray(sizes) ? sizes : [];
  const values = [];
  for (let i = 0; i < n; i += 1) {
    const v = Number(given[i]);
    values.push(Number.isFinite(v) && v > 0 ? v : 0);
  }
  let total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) {
    const each = 1 / n;
    return values.map(() => each);
  }
  // A pane the file did not describe (a shorter array) gets the average share.
  const avg = total / values.filter((v) => v > 0).length;
  const filled = values.map((v) => (v > 0 ? v : avg));
  total = filled.reduce((a, b) => a + b, 0);
  return filled.map((v) => v / total);
}

/**
 * Integer pixel spans for `sizes` across `span` px. Fractions are shares of the
 * WHOLE span (not of what is left after the floors), so the answer round-trips:
 * `fitSpan(room, fitSpan(room, sizes).map(w => w / room))` returns the same widths.
 * A pane below the floor is raised to it and the pixels come from the panes above
 * their floor, proportionally; when the span cannot hold every floor, every pane
 * takes an equal share instead. The answer always sums to exactly `span`, so two
 * panes and their divider fill the page area with no gap of rounding debris.
 * @param {number} span
 * @param {number[]} sizes
 * @param {number} [min]
 * @returns {number[]}
 */
function fitSpan(span, sizes, min = PANE_MIN) {
  const list = Array.isArray(sizes) && sizes.length ? sizes : [1];
  const n = list.length;
  const room = Math.max(0, Math.floor(Number(span) || 0));
  if (!room) return list.map(() => 0);
  const fracs = normalizeSizes(list);
  const cap = Math.floor(room / n);
  const floor = Math.max(0, Math.min(Math.floor(Number(min) || 0), cap));
  const widths = fracs.map((f) => Math.round(room * f));
  for (let pass = 0; pass < 2; pass += 1) {
    let deficit = 0;
    for (let i = 0; i < n; i += 1) {
      if (widths[i] < floor) { deficit += floor - widths[i]; widths[i] = floor; }
    }
    if (!deficit) break;
    // Take the deficit from the panes ABOVE the floor, in proportion to their room.
    const donors = [];
    let pool = 0;
    for (let i = 0; i < n; i += 1) {
      const spare = widths[i] - floor;
      if (spare > 0) { donors.push(i); pool += spare; }
    }
    if (!pool) break;
    for (const i of donors) {
      const take = Math.min(widths[i] - floor, Math.round(deficit * ((widths[i] - floor) / pool)));
      widths[i] -= take;
    }
  }
  const short = room - widths.reduce((a, b) => a + b, 0);
  if (short > 0) {
    // The rounding crumbs go to the widest pane, so every pixel is accounted for.
    let widest = 0;
    for (let i = 1; i < n; i += 1) if (widths[i] > widths[widest]) widest = i;
    widths[widest] += short;
  } else if (short < 0) {
    let widest = 0;
    for (let i = 1; i < n; i += 1) if (widths[i] > widths[widest]) widest = i;
    widths[widest] = Math.max(0, widths[widest] + short);
  }
  return widths;
}

/**
 * Where the panes and the dividers go inside the page area.
 *
 * @param {{x: number, y: number, width: number, height: number}} content
 * @param {number[]} sizes fractions (normalizeSizes' shape)
 * @param {"horizontal"|"vertical"} [axis]
 * @returns {{axis: string, panes: object[], dividers: object[]}}
 *   dividers[i] sits between pane i and pane i+1 and carries its `index`.
 */
function layoutPanes(content, sizes, axis = "horizontal") {
  const horizontal = axis !== "vertical";
  const x = Math.round(Number(content && content.x) || 0);
  const y = Math.round(Number(content && content.y) || 0);
  const width = Math.max(0, Math.round(Number(content && content.width) || 0));
  const height = Math.max(0, Math.round(Number(content && content.height) || 0));
  const list = (Array.isArray(sizes) ? sizes : []).slice(0, MAX_PANES);
  const n = list.length;
  const outAxis = horizontal ? "horizontal" : "vertical";
  if (!n) return { axis: outAxis, panes: [], dividers: [] };
  const span = horizontal ? width : height;
  const gaps = DIVIDER * (n - 1);
  const spans = fitSpan(Math.max(0, span - gaps), list, horizontal ? PANE_MIN : PANE_MIN_VERTICAL);
  const panes = [];
  const dividers = [];
  let at = horizontal ? x : y;
  for (let i = 0; i < n; i += 1) {
    panes.push(horizontal
      ? { x: at, y, width: spans[i], height }
      : { x, y: at, width, height: spans[i] });
    at += spans[i];
    if (i < n - 1) {
      dividers.push(horizontal
        ? { index: i, x: at, y, width: DIVIDER, height }
        : { index: i, x, y: at, width, height: DIVIDER });
      at += DIVIDER;
    }
  }
  return { axis: outAxis, panes, dividers };
}

/**
 * Drag divider `index` by `deltaPx`: its two neighbours trade pixels (never below
 * the floor), and the answer is the new fractions. Returns null when the drag is
 * refused (no such divider, too narrow to move, or no change).
 *
 * @param {number[]} sizes
 * @param {number} index divider i sits between pane i and i+1
 * @param {number} deltaPx pointer movement since the drag began, in DIP
 * @param {{width: number, height: number}} content the page area
 * @param {"horizontal"|"vertical"} [axis]
 * @returns {number[]|null}
 */
function resize(sizes, index, deltaPx, content, axis = "horizontal") {
  const list = Array.isArray(sizes) ? sizes : [];
  const n = list.length;
  const at = Math.floor(Number(index));
  if (!(at >= 0 && at < n - 1)) return null;
  const horizontal = axis !== "vertical";
  const span = Math.max(0, Math.round(Number(horizontal ? content && content.width : content && content.height) || 0));
  const room = Math.max(0, span - DIVIDER * (n - 1));
  const min = horizontal ? PANE_MIN : PANE_MIN_VERTICAL;
  const floor = Math.max(0, Math.min(min, Math.floor(room / n)));
  const widths = fitSpan(room, list, min);
  const pair = widths[at] + widths[at + 1];
  if (pair < floor * 2) return null;
  const want = Math.max(floor, Math.min(pair - floor, widths[at] + Math.round(Number(deltaPx) || 0)));
  if (want === widths[at]) return null;
  widths[at] = want;
  widths[at + 1] = pair - want;
  return normalizeSizes(widths);
}

/** Add one pane at `index`, keeping the other panes' proportions (a new equal share). */
function insertPane(sizes, index) {
  const list = (Array.isArray(sizes) ? sizes : []).map((s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : 1));
  const at = Math.max(0, Math.min(list.length, Math.floor(Number(index) || 0)));
  const share = list.length ? list.reduce((a, b) => a + b, 0) / list.length : 1;
  const next = list.slice();
  next.splice(at, 0, share);
  return normalizeSizes(next);
}

/** Drop pane `index`; the rest keep their proportions. */
function removePane(sizes, index) {
  const list = (Array.isArray(sizes) ? sizes : []).slice();
  const at = Math.floor(Number(index));
  if (at >= 0 && at < list.length) list.splice(at, 1);
  return normalizeSizes(list);
}

/**
 * Rebuild a stage from what the session store kept: entries shaped
 * `{id, pane: {group, index}}` (browser-everyday.cjs writes `pane` for a tab that
 * was in a split). Fewer than two panes restored is no split at all (null).
 * @returns {{axis: string, tabs: number[], sizes: number[], focus: number}|null}
 */
function stageFromSession(entries) {
  const panes = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.id != null && e.pane && Number.isInteger(Number(e.pane.index)))
    .map((e) => ({ id: e.id, index: Number(e.pane.index) }))
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_PANES);
  if (panes.length < 2) return null;
  return { axis: "horizontal", tabs: panes.map((p) => p.id), sizes: defaultSizes(panes.length), focus: 0 };
}

module.exports = {
  DIVIDER,
  MAX_PANES,
  PANE_MIN,
  PANE_MIN_VERTICAL,
  defaultSizes,
  fitSpan,
  insertPane,
  layoutPanes,
  normalizeSizes,
  removePane,
  resize,
  stageFromSession,
};
