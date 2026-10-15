// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * Deterministic positions for the universe. No force simulation: the same data gives
 * the same Float32Array byte for byte, and a node arriving does not reshuffle the sky.
 *
 * 3D: the root sits at the origin, its children (the galaxies) on a Fibonacci sphere,
 * every other parent's children on a tilted ring around it. A child's angle comes from
 * `hash(id)` alone, never from its index among siblings, so adding a sibling does not
 * move the others. Ring radius grows with sqrt(childCount), quantised to the next power
 * of two, so it only steps when the sibling count crosses 4, 8, 16, ...
 *
 * 2D: the focus at the origin and its children on concentric rings, seeded the same way.
 */
import { hash } from '../core/hash';
import type { BeadLevel, UniverseData, UniverseNode } from '../types';
import { indexUniverse } from './levels';
import type { VisibleSet } from './levels';

/** Distance of a galaxy from the root. */
export const GALAXY_DISTANCE = 1000;
/** Fibonacci sphere slots for the root's children. */
const SPHERE_SLOTS = 48;
/** Base ring radius by the PARENT's level (scaled by sqrt of the quantised child count). */
export const RING_BASE: Record<BeadLevel, number> = {
  universe: GALAXY_DISTANCE,
  galaxy: 150,
  solar: 34,
  system: 7.5,
  moon: 2,
};

const TAU = Math.PI * 2;

/** `hash` mapped to [0, 1). */
export function hashFrac(text: string): number {
  return hash(text) / 4294967296;
}

function bucket(count: number): number {
  let b = 4;
  while (b < count) b *= 2;
  return b;
}

/** Radius of the ring a parent's children sit on. */
export function ringRadius(level: BeadLevel, childCount: number): number {
  return RING_BASE[level] * Math.sqrt(bucket(childCount) / 4);
}

function sphereSlot(k: number): [number, number, number] {
  const y = 1 - (2 * (k + 0.5)) / SPHERE_SLOTS;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = k * Math.PI * (3 - Math.sqrt(5));
  // Flattened a little: a galaxy straight above the root reads as "missing".
  return [Math.cos(phi) * r, y * 0.6, Math.sin(phi) * r];
}

/** xyz for every node in `data.nodes` order (length = 3 * nodes). */
export function layout3d(data: Pick<UniverseData, 'nodes'>): Float32Array {
  const index = indexUniverse(data);
  const out = new Float32Array(data.nodes.length * 3);
  const placed = new Set<string>();
  const put = (node: UniverseNode, x: number, y: number, z: number) => {
    const i = index.order.get(node.id);
    if (i == null) return;
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
    placed.add(node.id);
  };
  const at = (id: string): [number, number, number] => {
    const i = index.order.get(id) ?? 0;
    return [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
  };

  const roots = index.children.get(null) ?? [];
  const root = index.root;
  if (root) put(root, 0, 0, 0);

  // The root's children plus any stray roots go on the sphere. Slots are claimed in
  // hash order with linear probing, so the assignment never depends on data order.
  const sphere = [
    ...(root ? index.children.get(root.id) ?? [] : []),
    ...roots.filter((n) => n !== root),
  ].sort((a, b) => hash(a.id) - hash(b.id) || (a.id < b.id ? -1 : 1));
  const taken = new Set<number>();
  for (const node of sphere) {
    let slot = hash(`${node.id}#slot`) % SPHERE_SLOTS;
    for (let tries = 0; taken.has(slot) && tries < SPHERE_SLOTS; tries += 1) {
      slot = (slot + 1) % SPHERE_SLOTS;
    }
    taken.add(slot);
    const [x, y, z] = sphereSlot(slot);
    put(node, x * GALAXY_DISTANCE, y * GALAXY_DISTANCE, z * GALAXY_DISTANCE);
  }

  // Breadth-first so every parent is placed before its children.
  const queue: UniverseNode[] = [...sphere];
  for (let q = 0; q < queue.length; q += 1) {
    const parent = queue[q];
    const kids = index.children.get(parent.id) ?? [];
    if (!kids.length) continue;
    const [px, py, pz] = at(parent.id);
    const radius = ringRadius(parent.level, kids.length);
    const azimuth = hashFrac(`${parent.id}#axis`) * TAU;
    const tilt = (hashFrac(`${parent.id}#tilt`) - 0.5) * 0.9;
    const ux = Math.cos(azimuth);
    const uz = Math.sin(azimuth);
    const vx = -Math.sin(azimuth) * Math.cos(tilt);
    const vy = Math.sin(tilt);
    const vz = Math.cos(azimuth) * Math.cos(tilt);
    for (const kid of kids) {
      if (placed.has(kid.id)) continue;
      const theta = hashFrac(kid.id) * TAU;
      const r = radius * (0.82 + 0.36 * hashFrac(`${kid.id}#r`));
      const c = Math.cos(theta) * r;
      const s = Math.sin(theta) * r;
      put(kid, px + c * ux + s * vx, py + s * vy, pz + c * uz + s * vz);
      queue.push(kid);
    }
  }
  // Anything a cycle kept out of the tree still gets a stable, finite place.
  for (const node of data.nodes) {
    if (placed.has(node.id)) continue;
    const [x, y, z] = sphereSlot(hash(node.id) % SPHERE_SLOTS);
    put(node, x * GALAXY_DISTANCE * 1.4, y * GALAXY_DISTANCE * 1.4, z * GALAXY_DISTANCE * 1.4);
  }
  return out;
}

/** Spacing between 2D rings, in SVG user units. */
export const RING_2D = 120;

/** Children per 2D ring: ring k (1-based) holds 8k. */
function ringCapacity(k: number): number {
  return 8 * k;
}

/** xy for every node in `visible.nodes` order (focus at the origin). */
export function layout2d(visible: Pick<VisibleSet, 'focus' | 'nodes'>): Float32Array {
  const out = new Float32Array(visible.nodes.length * 2);
  const slotOf = new Map<string, [number, number]>();
  const kids = visible.nodes
    .filter((n) => n.id !== visible.focus.id)
    .sort((a, b) => hash(a.id) - hash(b.id) || (a.id < b.id ? -1 : 1));
  let k = 1;
  let start = 0;
  while (start < kids.length) {
    const cap = ringCapacity(k);
    const ring = kids.slice(start, start + cap);
    const offset = hashFrac(`${visible.focus.id}#ring${k}`) * TAU;
    ring.forEach((node, j) => {
      const theta = offset + (TAU * j) / ring.length;
      slotOf.set(node.id, [Math.cos(theta) * RING_2D * k, Math.sin(theta) * RING_2D * k]);
    });
    start += cap;
    k += 1;
  }
  visible.nodes.forEach((node, i) => {
    const [x, y] = slotOf.get(node.id) ?? [0, 0];
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  });
  return out;
}

/** Outer radius of a 2D layout of `childCount` children. */
export function extent2d(childCount: number): number {
  let k = 0;
  let left = childCount;
  while (left > 0) {
    k += 1;
    left -= ringCapacity(k);
  }
  return RING_2D * Math.max(1, k);
}
