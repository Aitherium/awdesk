"use strict";

/**
 * free-space.cjs -- where the fairy may stand without covering something a person clicks.
 *
 * Owner, 2026-11-16 (screenshot): the fairy sat on CertTrack's "Review" tab. It docks on
 * windows and flutters beside the pointer, and neither knew what was under it. This
 * module is the rule: a spot is FREE when the fairy's box (grown by a margin) touches no
 * interactive element; the fairy takes the first free spot of a short list, else the
 * spot that covers least.
 *
 * Only the desk's OWN windows can be asked what is clickable (the probe runs inside the
 * page). A window owned by another program has no page to ask, so for it the title bar
 * and tab strip across its top are treated as one obstacle -- which is where an app's
 * clickable chrome is -- and the fairy stays in the lower part of the window.
 *
 * Coverage of the probe, stated: the main frame and same-origin iframes (to depth 3) of the
 * desk's own windows get the real probe. A cross-origin frame (an embedded third-party
 * site, a <webview>) is opaque to it, so its TOP BAND (OPAQUE_BAND px: where an app's tabs
 * and toolbar are) counts as one obstacle, the same rule as a foreign window's title bar;
 * the fairy then stands in the lower part of the frame. Controls lower in an opaque frame
 * stay invisible to it, and that is the stated limit.
 *
 * PURE: no electron. The caller measures the page and owns the clock.
 */

/** Elements a person clicks, types in or drags. Kept to one selector so the probe is one call. */
const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input", "select", "textarea", "summary", "label[for]",
  "[role=button]", "[role=tab]", "[role=menuitem]", "[role=link]", "[role=checkbox]",
  "[role=switch]", "[role=radio]", "[role=slider]", "[role=option]",
  "[tabindex]:not([tabindex=\"-1\"])", "[contenteditable=\"\"]", "[contenteditable=\"true\"]",
  "canvas[data-interactive]",
].join(",");

const MAX_RECTS = 500;
/** Height of the band across the top of a frame the probe cannot read (CSS px). */
const OPAQUE_BAND = 72;

/**
 * JavaScript to run INSIDE a page; returns [[x, y, w, h], ...] in CSS pixels, for the
 * elements a hand can press: shown (not hidden, not display:none) AND not pointer-events:none
 * (a click goes through those, so the fairy over them covers nothing). Documents are
 * read at nesting depth 0, 1, 2 and 3. A string (not a function) so main can hand it to executeJavaScript.
 */
function probeSource() {
  return `(() => {
    const out = [];
    const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const BAND = ${OPAQUE_BAND};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const walk = (doc, ox, oy, depth) => {
      const win = doc.defaultView;
      for (const el of doc.querySelectorAll(SEL)) {
        if (out.length >= ${MAX_RECTS}) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const left = r.left + ox, top = r.top + oy;
        if (left + r.width < 0 || top + r.height < 0 || top > vh || left > vw) continue;
        const cs = win.getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none") continue;
        out.push([Math.round(left), Math.round(top), Math.round(r.width), Math.round(r.height)]);
      }
      if (depth >= 3) return; // this document (depth 3) is already read above; only frames INSIDE it are not
      // Same-origin frames (an app panel in an iframe) are probed with their offset.
      // A cross-origin frame has no readable document: it contributes nothing here, and
      // the module header says which windows rely on the title-bar fallback instead.
      for (const f of doc.querySelectorAll("iframe, frame, webview, embed, object")) {
        const fr = f.getBoundingClientRect();
        if (fr.width < 40 || fr.height < 40) continue;
        let inner = null;
        try { inner = f.contentDocument; } catch { inner = null; }
        if (!inner || !inner.documentElement) {
          // Opaque (cross-origin or not a document): its top band is one obstacle.
          const fcs = win.getComputedStyle(f);
          if (fcs.visibility === "hidden" || fcs.display === "none") continue;
          out.push([Math.round(fr.left + ox), Math.round(fr.top + oy), Math.round(fr.width), Math.round(Math.min(fr.height, BAND))]);
          continue;
        }
        walk(inner, ox + fr.left, oy + fr.top, depth + 1);
      }
    };
    walk(document, 0, 0, 0);
    return out;
  })()`;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Page rects ([x,y,w,h] CSS px) to screen rects ({x,y,width,height}). Bad rows are dropped. */
function toScreenRects(rows, contentBounds, zoom = 1) {
  const b = contentBounds || { x: 0, y: 0 };
  const z = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [x, y, w, h] = row.map((v) => num(v, NaN));
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    out.push({
      x: Math.round(num(b.x) + x * z),
      y: Math.round(num(b.y) + y * z),
      width: Math.round(w * z),
      height: Math.round(h * z),
    });
    if (out.length >= MAX_RECTS) break;
  }
  return out;
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The title bar and tab strip of a window we cannot read: one obstacle across its top. */
function chromeObstacle(bounds, { height = 56 } = {}) {
  if (!bounds || !(num(bounds.width) > 0)) return null;
  return { x: Math.round(num(bounds.x)), y: Math.round(num(bounds.y)), width: Math.round(num(bounds.width)), height };
}

/** How much of the fairy's box (grown by `pad`) lies on something clickable. */
function coverage(spot, size, obstacles, pad = 0) {
  const w = num(size && size.width);
  const h = num(size && size.height);
  const box = { x: num(spot.x) - pad, y: num(spot.y) - pad, width: w + pad * 2, height: h + pad * 2 };
  let total = 0;
  for (const o of Array.isArray(obstacles) ? obstacles : []) total += overlapArea(box, o);
  return total;
}

/**
 * The first candidate (top-left of the fairy's window) that covers nothing; else the one
 * that covers least (the earlier one on a tie, so the preferred spot wins). Candidates
 * that leave `area` are skipped unless every one does.
 */
function pickFree(candidates, size, obstacles, { pad = 8, area = null } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && Number.isFinite(num(c.x, NaN)) && Number.isFinite(num(c.y, NaN)));
  if (!list.length) return null;
  const inside = (c) => !area
    || (c.x >= area.x && c.y >= area.y && c.x + num(size && size.width) <= area.x + area.width && c.y + num(size && size.height) <= area.y + area.height);
  const usable = list.filter(inside);
  const pool = usable.length ? usable : list;
  let best = null;
  for (const c of pool) {
    const cost = coverage(c, size, obstacles, pad);
    if (cost === 0) return { x: c.x, y: c.y, free: true, covered: 0 };
    if (!best || cost < best.covered) best = { x: c.x, y: c.y, free: false, covered: cost };
  }
  return best;
}

/**
 * Spots around a window the fairy may dock on, most wanted first, all INSIDE the window
 * and clear of its bottom bar: bottom-right, bottom-left, bottom-middle, then the right
 * and left edges below the header. `first` (the existing dock spot, e.g. one that already
 * avoids a tenant companion) leads the list.
 */
function dockCandidates(bounds, size, { first = null, bar = 64, gap = 18, header = 120 } = {}) {
  const b = bounds || { x: 0, y: 0, width: 1280, height: 800 };
  const w = num(size && size.width, 72);
  const h = num(size && size.height, 72);
  const left = num(b.x) + gap;
  const right = num(b.x) + num(b.width) - w - gap;
  const bottom = num(b.y) + Math.max(h + 56, num(b.height) - bar) - h - gap;
  const midX = Math.round(num(b.x) + (num(b.width) - w) / 2);
  const top = num(b.y) + header;
  const midY = Math.round((top + bottom) / 2);
  const out = [];
  if (first) out.push({ x: Math.round(first.x), y: Math.round(first.y) });
  out.push(
    { x: Math.round(right), y: Math.round(bottom) },
    { x: Math.round(left), y: Math.round(bottom) },
    { x: midX, y: Math.round(bottom) },
    { x: Math.round(right), y: Math.round(midY) },
    { x: Math.round(left), y: Math.round(midY) },
    { x: Math.round(right), y: Math.round(top) },
  );
  return out;
}

module.exports = {
  INTERACTIVE_SELECTOR, MAX_RECTS, OPAQUE_BAND, probeSource, toScreenRects, overlapArea, chromeObstacle, coverage, pickFree, dockCandidates,
};
