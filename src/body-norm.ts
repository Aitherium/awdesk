/**
 * Body size and fit (owner P0, 2026-11-17).
 *
 * A session actor wore a model whose humanoid stands 1.86 m to the head bone (the desk's own
 * bodies are 1.2-1.57) at a persisted layout scale near the old 3x cap: it towered over the
 * other bodies, over his Discord. And a stage showed a body sliced in half at the window's
 * edge, because the camera framed the stage once (when the set of bodies changed) and a body
 * that moved, grew or finished loading afterwards was left outside the frame.
 *
 * Three pure rules, used by useVrmLoader.ts and Scene.tsx:
 *   1. heightNormFactor  -- a model's native head height is pulled into the persona band
 *                           (no giant or doll-sized models, whatever the file says);
 *   2. clampBodyScale    -- the layout scale on top of that is clamped to [0.3, 1.25] -- a quarter over the
 *                           norm at most;
 *   3. outsideView       -- a body whose projected box leaves the view is re-framed.
 */

/** Head-bone height of the desk's reference body (aither-v2 measures 1.51, charlie 1.57). */
export const NORM_HEAD_HEIGHT = 1.45;
/** How far a model may differ from the norm before it is pulled in: 0.8x .. 1.1x. */
export const NORM_BAND_MIN = 0.8;
export const NORM_BAND_MAX = 1.1;
export const MIN_BODY_SCALE = 0.3;
export const MAX_BODY_SCALE = 1.25;

/** The factor that brings a native head height into the band (1 when it is already in it). */
export function heightNormFactor(headHeight: number): number {
  if (!Number.isFinite(headHeight) || headHeight <= 0.05) return 1;
  const lo = NORM_HEAD_HEIGHT * NORM_BAND_MIN;
  const hi = NORM_HEAD_HEIGHT * NORM_BAND_MAX;
  const target = Math.min(hi, Math.max(lo, headHeight));
  const factor = target / headHeight;
  return Math.abs(factor - 1) < 1e-6 ? 1 : factor;
}

/** The layout scale a body may be drawn at. A bad value is 1, never a giant. */
export function clampBodyScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_BODY_SCALE, Math.max(MIN_BODY_SCALE, scale));
}

/**
 * Is any corner of a body's box outside the view? `ndc` is the box's corners already
 * projected to normalised device coordinates (x, y in -1..1 when on screen). A corner behind
 * the camera (z > 1) counts as outside. `margin` lets the edge itself count as clipping.
 */
export function outsideView(ndc: ReadonlyArray<{ x: number; y: number; z: number }>, margin = 0.01): boolean {
  const lim = 1 - margin;
  for (const p of ndc) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return true;
    if (p.z > 1 || p.x < -lim || p.x > lim || p.y < -lim || p.y > lim) return true;
  }
  return false;
}
