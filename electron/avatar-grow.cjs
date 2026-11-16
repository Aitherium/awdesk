"use strict";

/**
 * avatar-grow.cjs -- where Aither's body stands when the fairy grows into it, and the
 * frames of the grow / shrink.
 *
 * Owner, 2026-11-15: "when I click the fairy or right-click and select an option I want
 * it to expand into that avatar". The fairy (orb-window.cjs) asks main through its
 * `expand` hook; main moves its ONE avatar window (no second renderer) through these
 * frames: from a small rect centred on the fairy to the full body standing over the
 * fairy's spot, fading in. Collapse is the same frames reversed.
 *
 * PURE: no electron. node --test.
 */

/** Frames in a grow (~16 ms apart: about 200 ms). Few on purpose: every frame resizes a
 *  WebGL canvas, and perf comes first (owner). */
const FRAMES = 12;
const FRAME_MS = 16;
/** The first frame's size, as a share of the full body. */
const START_SCALE = 0.2;
const START_OPACITY = 0.15;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rect(r, fallback) {
  if (!r || typeof r !== "object") return fallback;
  return {
    x: Math.round(num(r.x, fallback.x)),
    y: Math.round(num(r.y, fallback.y)),
    width: Math.max(1, Math.round(num(r.width, fallback.width))),
    height: Math.max(1, Math.round(num(r.height, fallback.height))),
  };
}

/**
 * The body's bounds: its own size, its feet on the fairy's spot (bottom edge just under
 * the fairy, horizontally centred on it), never off the work area. With no fairy (it was
 * hidden) the body takes the work area's bottom-right corner, where it always stood.
 *
 * Args:
 *   from: the fairy's window bounds, or null.
 *   size: {width, height} of the avatar window.
 *   area: the display work area {x, y, width, height}.
 *   margin: px kept clear of the work area's edge.
 */
function targetBounds(from, size, area, { margin = 24 } = {}) {
  const a = rect(area, { x: 0, y: 0, width: 1920, height: 1080 });
  const w = Math.min(Math.max(1, Math.round(num(size && size.width, 420))), a.width);
  const h = Math.min(Math.max(1, Math.round(num(size && size.height, 640))), a.height);
  let x;
  let y;
  if (from && typeof from === "object" && Number.isFinite(Number(from.x))) {
    const f = rect(from, { x: 0, y: 0, width: 1, height: 1 });
    x = f.x + f.width / 2 - w / 2;
    y = f.y + f.height - h;
  } else {
    x = a.x + a.width - w - margin;
    y = a.y + a.height - h - margin;
  }
  x = Math.min(Math.max(a.x, x), a.x + a.width - w);
  y = Math.min(Math.max(a.y, y), a.y + a.height - h);
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

function easeOut(t) {
  return 1 - (1 - t) ** 3;
}

/**
 * The grow: FRAMES rects + opacities from a small rect centred on the fairy to `to`.
 * The last frame is exactly `to` at opacity 1. With no fairy the body grows from its
 * own centre.
 *
 * Returns [{bounds, opacity}].
 */
function growFrames(from, to, { frames = FRAMES } = {}) {
  const end = rect(to, { x: 0, y: 0, width: 420, height: 640 });
  const centre = from && typeof from === "object" && Number.isFinite(Number(from.x))
    ? { x: num(from.x, 0) + num(from.width, 0) / 2, y: num(from.y, 0) + num(from.height, 0) / 2 }
    : { x: end.x + end.width / 2, y: end.y + end.height / 2 };
  const n = Math.max(1, Math.round(num(frames, FRAMES)));
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const t = easeOut(i / n);
    const scale = START_SCALE + (1 - START_SCALE) * t;
    const w = end.width * scale;
    const h = end.height * scale;
    const cx = centre.x + (end.x + end.width / 2 - centre.x) * t;
    const cy = centre.y + (end.y + end.height / 2 - centre.y) * t;
    out.push({
      bounds: i === n ? { ...end } : {
        x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)),
      },
      opacity: i === n ? 1 : Number((START_OPACITY + (1 - START_OPACITY) * t).toFixed(3)),
    });
  }
  return out;
}

/** The shrink back into the fairy: the grow reversed, ending small and nearly clear. */
function shrinkFrames(body, fairy, opts = {}) {
  // growFrames(fairy -> body) without its last frame (the body as it stands now),
  // walked backwards, then the smallest rect fully clear.
  const grow = growFrames(fairy, body, opts);
  const back = grow.slice(0, -1).reverse();
  const end = rect(body, { x: 0, y: 0, width: 420, height: 640 });
  const centre = fairy && typeof fairy === "object" && Number.isFinite(Number(fairy.x))
    ? { x: num(fairy.x, 0) + num(fairy.width, 0) / 2, y: num(fairy.y, 0) + num(fairy.height, 0) / 2 }
    : { x: end.x + end.width / 2, y: end.y + end.height / 2 };
  const w = Math.max(1, Math.round(end.width * START_SCALE));
  const h = Math.max(1, Math.round(end.height * START_SCALE));
  return [...back, { bounds: { x: Math.round(centre.x - w / 2), y: Math.round(centre.y - h / 2), width: w, height: h }, opacity: 0 }];
}

module.exports = { FRAMES, FRAME_MS, START_SCALE, targetBounds, growFrames, shrinkFrames };
