/**
 * Animation sub-stepping (plan 2027, slice S1, cause 2).
 *
 * `Avatar.tsx` used to feed three-vrm `Math.min(delta, 1/30)`. That clamp exists because
 * the spring chains integrate the RAW delta: one second-sized step overshoots every hair
 * and tool joint into a horizontal smear (owner, 2026-09-11). But the frame governor drops
 * to 15 fps at idle, so a 66 ms frame advanced only 33 ms of animation — idle ran at half
 * speed, and it read as lag.
 *
 * The fix is not to remove the clamp but to SUB-STEP: the same wall time is integrated in
 * pieces no longer than 1/30 s, so the springs stay stable and the animation still keeps
 * up with the clock. Pure and unit-tested; Avatar.tsx only applies it.
 */

/** The largest step three-vrm's springs integrate stably (the old clamp). */
export const MAX_STEP_S = 1 / 30;

/** The most wall time one frame may catch up on. A real stall (a second of blocked
 *  main process) is not elapsed animation time — integrating all of it would run the
 *  springs 30+ times in one frame for nothing anyone saw. */
export const MAX_CATCHUP_S = 0.5;

/**
 * Pure: split `delta` seconds into consecutive integration steps, each <= `maxStep`, whose
 * SUM is `min(delta, capSeconds)`. A 200 ms gap at the default max step yields 6 steps of
 * 33.3 ms (the last one carrying the remainder), i.e. 200 ms of animation for 200 ms of
 * wall time. Input that is not a finite positive number yields no steps.
 */
export function subSteps(delta: number, maxStep = MAX_STEP_S, capSeconds = MAX_CATCHUP_S): number[] {
  const total = Math.min(Number(delta), capSeconds);
  if (!(total > 0) || !(maxStep > 0)) return [];
  const steps: number[] = [];
  let left = total;
  // A small epsilon: 0.2 / (1/30) is 5.999999999999999 in binary floating point.
  while (left > 1e-9) {
    const step = Math.min(maxStep, left);
    steps.push(step);
    left -= step;
    if (steps.length > 4096) break; // pathological input can never spin forever
  }
  return steps;
}

/**
 * Advance `update` with `delta` seconds of animation, sub-stepped. Returns how much wall
 * time was actually integrated (0 when `delta` was not a usable number). A stalled frame
 * therefore advances at most `capSeconds`, and a normal 15 fps idle frame advances exactly
 * its own delta.
 */
export function advanceSubStepped(
  delta: number,
  update: (stepSeconds: number) => void,
  maxStep = MAX_STEP_S,
  capSeconds = MAX_CATCHUP_S,
): number {
  let advanced = 0;
  for (const step of subSteps(delta, maxStep, capSeconds)) {
    update(step);
    advanced += step;
  }
  return advanced;
}
