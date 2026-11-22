/**
 * The pure math behind the entity verbs walkTo(screenRect) and lookAt(screenPoint) (owner 2026-11-16:
 * "entity verbs for later tasks: perceive(view), act(tool), walkTo(screenRect), lookAt(screenPoint),
 * and a screen-context subscribe hook"). The renderer turns a point on the SCREEN into a place on
 * the stage; main (electron/agent-swarm-host.cjs) sends the rect / point in window client pixels.
 *
 * Written so the stage can move onto the DarkMatter engine later (board 21db327b-c63): nothing here
 * knows three.js or React, only "a body at world x, drawn at client x, with this many world units
 * per pixel".
 */

import { POSITION_BOUND } from '../hooks/useAvatarLayout';

export interface ClientRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The point on a rect a body walks to: its horizontal centre. */
export function rectTargetX(rect: ClientRect): number {
  return rect.x + rect.width / 2;
}

/**
 * Where (world x) a body must stand so it is drawn under `targetClientX`, given where it is drawn now.
 * Screen-space on purpose (the same linear mapping a drag uses, hooks/avatarDragMath), clamped to the
 * stage so a target far off the window only walks to its edge.
 */
export function walkTargetX(
  bodyWorldX: number,
  bodyClientX: number,
  targetClientX: number,
  worldPerPx: number,
  bound = POSITION_BOUND,
): number {
  if (!Number.isFinite(worldPerPx) || worldPerPx <= 0) return bodyWorldX;
  const x = bodyWorldX + (targetClientX - bodyClientX) * worldPerPx;
  return Math.min(bound, Math.max(-bound, Number(x.toFixed(4))));
}

/** A body's yaw (radians, 0 = facing the camera) to look toward a client point. Clamped: a look is a turn of
 *  the shoulders, never a back turned to the owner. */
export function lookYaw(bodyClientX: number, targetClientX: number, viewportWidth: number, maxYaw = 0.9): number {
  const w = Math.max(1, viewportWidth);
  const t = Math.max(-1, Math.min(1, (targetClientX - bodyClientX) / (w / 2)));
  return Number((t * maxYaw).toFixed(4));
}

/** The steps of a walk: `n` positions from `from` to `to`, eased in and out, the last exactly `to`. */
export function walkSteps(from: number, to: number, n = 24): number[] {
  const count = Math.max(2, Math.round(n));
  const out: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    const t = i / count;
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    out.push(i === count ? to : Number((from + (to - from) * e).toFixed(4)));
  }
  return out;
}

/** What the walk's turn is: face the way it goes (+ right), 0 when it barely moves. */
export function walkYaw(from: number, to: number, maxYaw = 0.6): number {
  const d = to - from;
  if (Math.abs(d) < 0.05) return 0;
  return Number((Math.sign(d) * Math.min(maxYaw, Math.abs(d) * 0.4)).toFixed(4));
}

/** Validate a rect / point from the bridge: finite numbers only, else null. */
export function cleanRect(raw: unknown): ClientRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width ?? r.w ?? 0);
  const height = Number(r.height ?? r.h ?? 0);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}
