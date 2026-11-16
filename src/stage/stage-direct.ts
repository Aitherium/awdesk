/**
 * Stages by direct manipulation (owner 2026-11-16): the verbs the tray and the MCP already
 * had (join, leave, move) as things you do with the mouse.
 *
 *   drop a body onto another   -> they join one stage (dropTarget)
 *   right-click > Leave stage  -> main (electron/agent-swarm-host.cjs stageOp 'leave')
 *   a handle over the group    -> drag it to move the whole stage (shiftGroup)
 *
 * PURE: the stage's bounds live in useAvatarLayout (POSITION_BOUND), so the clamp is here
 * beside them and unit-tested without a window.
 */

import { POSITION_BOUND } from '../hooks/useAvatarLayout';

/** A dropped body joins another when it lands this close (world units, ground plane). */
export const JOIN_X = 0.85;
export const JOIN_Z = 0.9;

export interface Spot {
  slotId: string;
  x: number;
  z: number;
}

/**
 * The body a dragged one was dropped on, or null: the nearest other body within reach.
 * Reach is wider in x than z because the stage is a row; a body behind another is not "on" it.
 */
export function dropTarget(dragged: Spot, others: Spot[], reach = { x: JOIN_X, z: JOIN_Z }): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of others) {
    if (o.slotId === dragged.slotId) continue;
    const dx = Math.abs(o.x - dragged.x);
    const dz = Math.abs(o.z - dragged.z);
    if (dx > reach.x || dz > reach.z) continue;
    const d = Math.hypot(dx / reach.x, dz / reach.z);
    if (d < bestD) { bestD = d; best = o.slotId; }
  }
  return best;
}

/** One stage as main describes it (`stage-groups` desk event). */
export interface StageGroup {
  id: string;
  slots: string[];
  members: string[];
  locked: boolean;
}

/** Whatever arrived on the event, as groups of two or more bodies on this stage. */
export function sanitizeGroups(raw: unknown, knownSlots?: Iterable<string>): StageGroup[] {
  if (!Array.isArray(raw)) return [];
  const known = knownSlots ? new Set(knownSlots) : null;
  const out: StageGroup[] = [];
  for (const g of raw.slice(0, 16)) {
    if (!g || typeof g !== 'object') continue;
    const row = g as Record<string, unknown>;
    const slots = (Array.isArray(row.slots) ? row.slots : [])
      .filter((s): s is string => typeof s === 'string' && s.length > 0 && (!known || known.has(s)));
    if (typeof row.id !== 'string' || slots.length < 2) continue;
    const members = (Array.isArray(row.members) ? row.members : []).filter((m): m is string => typeof m === 'string');
    out.push({ id: row.id, slots: [...new Set(slots)], members, locked: row.locked === true });
  }
  return out;
}

/** The handle's text: "Stage 1 · 3 bodies", with a lock mark while locked. */
export function handleLabel(group: StageGroup): string {
  const n = group.slots.length;
  const num = group.id.replace(/^stage/i, '');
  return `Stage${num ? ` ${num}` : ''} · ${n} bodies${group.locked ? ' · locked' : ''}`;
}

/** The centre of a group on the ground plane, or null when none of its bodies is placed. */
export function groupCentre(slots: string[], positions: Record<string, [number, number, number] | undefined>): { x: number; z: number } | null {
  const pts = slots.map((s) => positions[s]).filter((p): p is [number, number, number] => Array.isArray(p));
  if (!pts.length) return null;
  return {
    x: pts.reduce((a, p) => a + p[0], 0) / pts.length,
    z: pts.reduce((a, p) => a + p[2], 0) / pts.length,
  };
}

/**
 * Move a whole group by (dx, dz) from where it started, never past the stage bound: the
 * move stops when the first body reaches it (the shape of the group is kept, never squashed).
 */
export function shiftGroup(
  start: Record<string, [number, number, number]>,
  dx: number,
  dz = 0,
  bound = POSITION_BOUND,
): Record<string, [number, number, number]> {
  const ps = Object.values(start);
  if (!ps.length) return {};
  const clamp = (d: number, axis: 0 | 2) => {
    const lo = -bound - Math.min(...ps.map((p) => p[axis]));
    const hi = bound - Math.max(...ps.map((p) => p[axis]));
    return Math.min(Math.max(d, Math.min(lo, hi)), Math.max(lo, hi));
  };
  const mx = clamp(dx, 0);
  const mz = clamp(dz, 2);
  const out: Record<string, [number, number, number]> = {};
  for (const [slot, p] of Object.entries(start)) out[slot] = [Number((p[0] + mx).toFixed(4)), p[1], Number((p[2] + mz).toFixed(4))];
  return out;
}
