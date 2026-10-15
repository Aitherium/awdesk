// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * Everything the 3D scene draws, as flat typed arrays. Pure (no three, no DOM) so it is
 * tested in node and the renderer only copies buffers.
 */
import type { BeadLevel, UniverseData } from '../types';
import { indexUniverse } from '../universe/levels';
import type { VisibleSet } from '../universe/levels';
import { layout3d } from '../universe/layout';
import { isUrgent } from '../universe/verbs';
import { healthColor, hexToRgb, isHollow, isQuiet } from './palette';

export interface Positions {
  /** Id → index into `xyz` (triples). */
  order: Map<string, number>;
  xyz: Float32Array;
}

/** The deterministic 3D layout of a whole universe, addressable by id. */
export function positions3d(data: UniverseData): Positions {
  return { order: indexUniverse(data).order, xyz: layout3d(data) };
}

export function positionOf(positions: Positions, id: string): [number, number, number] | null {
  const i = positions.order.get(id);
  if (i == null) return null;
  return [positions.xyz[i * 3], positions.xyz[i * 3 + 1], positions.xyz[i * 3 + 2]];
}

/** Body radius by level, before the child-count bonus. */
export const BODY_RADIUS: Record<BeadLevel, number> = {
  universe: 46,
  galaxy: 30,
  solar: 7,
  system: 1.6,
  moon: 0.45,
};

export function bodyRadius(level: BeadLevel, childCount: number): number {
  return (BODY_RADIUS[level] ?? 1) * (1 + 0.12 * Math.sqrt(Math.max(0, childCount)));
}

export interface AskGlow {
  /** Asks on each node and every ancestor. */
  counts: Map<string, number>;
  /** Nodes carrying, or containing, a high/urgent ask. */
  urgent: Set<string>;
}

/** Ask counts and urgency, propagated to every ancestor. */
export function askGlow(data: UniverseData): AskGlow {
  const { byId } = indexUniverse(data);
  const counts = new Map<string, number>();
  const urgent = new Set<string>();
  for (const node of data.nodes) {
    const asks = node.asks ?? [];
    if (!asks.length) continue;
    const hot = asks.some((a) => isUrgent(a.urgency));
    const seen = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      counts.set(cursor, (counts.get(cursor) ?? 0) + asks.length);
      if (hot) urgent.add(cursor);
      const parent: string | null = byId.get(cursor)?.parent ?? null;
      cursor = parent != null && byId.has(parent) ? parent : null;
    }
  }
  return { counts, urgent };
}

export interface Beacon {
  id: string;
  /** Instance index. */
  index: number;
  count: number;
  urgent: boolean;
}

export interface SceneInstances {
  /** Instances = ghost ancestors (root first) then the visible nodes (focus first). */
  count: number;
  ids: string[];
  centers: Float32Array;
  /** sRGB 0..1 triples, already dimmed for quiet and ghost instances. */
  colors: Float32Array;
  scales: Float32Array;
  /** 1 = draw as wireframe (unknown health). */
  hollow: Uint8Array;
  /** 1 = a faded ancestor behind the current level. */
  ghost: Uint8Array;
  /** Visible (non-ghost) instances with asks on or under them. */
  glowIds: string[];
  beacons: Beacon[];
  /** Solid link segments (6 floats each). */
  linkPositions: Float32Array;
  /** blocks / related link segments, drawn dashed. */
  dashedLinkPositions: Float32Array;
  /** rel=traffic segments, the comets' paths. */
  trafficPositions: Float32Array;
}

export interface BuildOptions {
  /** The full universe, for child counts. */
  data?: UniverseData;
  glow?: AskGlow;
}

const GHOST_DIM = 0.3;
const QUIET_DIM = 0.45;

export function buildInstances(
  visible: VisibleSet,
  positions: Positions,
  options: BuildOptions = {},
): SceneInstances {
  const all = [...visible.ghosts, ...visible.nodes];
  const count = all.length;
  const ids: string[] = [];
  const centers = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const hollow = new Uint8Array(count);
  const ghost = new Uint8Array(count);
  const glowIds: string[] = [];
  const beacons: Beacon[] = [];
  const children = options.data ? indexUniverse(options.data).children : null;
  const nGhosts = visible.ghosts.length;

  all.forEach((node, i) => {
    ids.push(node.id);
    const p = positionOf(positions, node.id) ?? [0, 0, 0];
    centers.set(p, i * 3);
    const isGhost = i < nGhosts;
    ghost[i] = isGhost ? 1 : 0;
    const state = node.health?.state;
    hollow[i] = isHollow(state) ? 1 : 0;
    const dim = isGhost ? GHOST_DIM : isQuiet(state) ? QUIET_DIM : 1;
    const [r, g, b] = hexToRgb(healthColor(state));
    colors[i * 3] = r * dim;
    colors[i * 3 + 1] = g * dim;
    colors[i * 3 + 2] = b * dim;
    const kids = children?.get(node.id)?.length ?? 0;
    scales[i] = bodyRadius(node.level, kids);
    if (!isGhost) {
      const n = options.glow ? options.glow.counts.get(node.id) ?? 0 : node.asks?.length ?? 0;
      if (n > 0) {
        glowIds.push(node.id);
        const urgent = options.glow
          ? options.glow.urgent.has(node.id)
          : (node.asks ?? []).some((a) => isUrgent(a.urgency));
        beacons.push({ id: node.id, index: i, count: n, urgent });
      }
    }
  });

  const solid: number[] = [];
  const dashed: number[] = [];
  const traffic: number[] = [];
  for (const link of visible.links) {
    const a = positionOf(positions, link.source);
    const b = positionOf(positions, link.target);
    if (!a || !b) continue;
    const seg = [...a, ...b];
    if (link.kind === 'blocks' || link.kind === 'related') dashed.push(...seg);
    else solid.push(...seg);
    if (link.rel === 'traffic') traffic.push(...seg);
  }

  return {
    count,
    ids,
    centers,
    colors,
    scales,
    hollow,
    ghost,
    glowIds,
    beacons,
    linkPositions: new Float32Array(solid),
    dashedLinkPositions: new Float32Array(dashed),
    trafficPositions: new Float32Array(traffic),
  };
}
