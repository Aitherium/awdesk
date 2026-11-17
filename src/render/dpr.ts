/**
 * Pixel ratio policy (owner 2026-11-16: "allow DPR up to 2 when idle FPS is low").
 *
 * The scene was pinned to dpr 1 so a moving, speaking body stays cheap (about 2.25x the fill rate at 1.5).
 * But the frame budget already drops to 5 then 2 frames a second while nothing moves, so a still body can be
 * drawn at full density at almost no cost: when the scene is idle the ratio rises to the display's own
 * (at most 2); the moment anything moves, speaks or is touched it drops back to 1.
 */

export const DPR_ACTIVE = 1;
export const DPR_IDLE_MAX = 2;
/** How long nothing may have moved before the ratio rises (the governor's idle tail is 1.5 s). */
export const DPR_QUIET_MS = 2500;

export function chooseDpr(opts: { active: boolean; sinceInputMs: number; devicePixelRatio: number; hidden?: boolean }): number {
  const display = Number.isFinite(opts.devicePixelRatio) && opts.devicePixelRatio > 0 ? opts.devicePixelRatio : 1;
  if (opts.hidden || opts.active || opts.sinceInputMs < DPR_QUIET_MS) return DPR_ACTIVE;
  return Math.max(DPR_ACTIVE, Math.min(DPR_IDLE_MAX, display));
}
