// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * The universe as a tree: who is under whom, the path down to a node, and what one
 * level shows. Pure: no DOM, no React, no three.
 */
import type { UniverseData, UniverseLink, UniverseNode } from '../types';

export interface UniverseIndex {
  byId: Map<string, UniverseNode>;
  /** Children in data order. Key `null` holds the roots. */
  children: Map<string | null, UniverseNode[]>;
  /** Position of each id in `data.nodes`. */
  order: Map<string, number>;
  root: UniverseNode | null;
}

const cache = new WeakMap<object, UniverseIndex>();

/** Index a universe once per data object (memoised on identity). */
export function indexUniverse(data: Pick<UniverseData, 'nodes'>): UniverseIndex {
  const hit = cache.get(data);
  if (hit) return hit;
  const byId = new Map<string, UniverseNode>();
  const order = new Map<string, number>();
  data.nodes.forEach((node, i) => {
    byId.set(node.id, node);
    order.set(node.id, i);
  });
  const children = new Map<string | null, UniverseNode[]>();
  for (const node of data.nodes) {
    // A parent that is not in the data makes the node a root, never an orphan that
    // no level can show.
    const parent = node.parent != null && byId.has(node.parent) && node.parent !== node.id
      ? node.parent
      : null;
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  const roots = children.get(null) ?? [];
  const root = roots.find((n) => n.id === 'platform')
    ?? roots.find((n) => n.level === 'universe')
    ?? roots[0]
    ?? null;
  const index = { byId, children, order, root };
  cache.set(data, index);
  return index;
}

export function childrenOf(data: Pick<UniverseData, 'nodes'>, id: string | null): UniverseNode[] {
  return indexUniverse(data).children.get(id) ?? [];
}

/** Effective parent: `null` when the declared parent is missing from the data. */
export function parentOf(data: Pick<UniverseData, 'nodes'>, id: string): string | null {
  const { byId } = indexUniverse(data);
  const node = byId.get(id);
  if (!node || node.parent == null || node.parent === id || !byId.has(node.parent)) return null;
  return node.parent;
}

/** Ids from the root down to `id`, inclusive. `[]` for an unknown id. Cycle-safe. */
export function pathTo(data: Pick<UniverseData, 'nodes'>, id: string): string[] {
  const { byId } = indexUniverse(data);
  if (!byId.has(id)) return [];
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    cursor = parentOf(data, cursor);
  }
  return path.reverse();
}

/** The nearest shown node at or above `id`, or null when none of its line is shown. */
function visibleAncestor(
  data: Pick<UniverseData, 'nodes'>,
  id: string,
  shown: Set<string>,
): string | null {
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor != null && !seen.has(cursor)) {
    if (shown.has(cursor)) return cursor;
    seen.add(cursor);
    cursor = parentOf(data, cursor);
  }
  return null;
}

export interface VisibleSet {
  focus: UniverseNode;
  /** The focus first, then its children in data order. */
  nodes: UniverseNode[];
  /**
   * Links among the visible nodes. A link between two descendants is rolled up onto
   * the visible child each sits under (weight = links folded), so traffic between two
   * services still shows at the galaxy level. Self-loops after roll-up are dropped.
   */
  links: UniverseLink[];
  /** Ancestors of the focus, root first. Drawn faded behind the current level. */
  ghosts: UniverseNode[];
}

/** What one level shows: the focus, its children, links among them, ghost ancestors. */
export function visibleAt(data: UniverseData, focusId: string | null): VisibleSet | null {
  const index = indexUniverse(data);
  const focus = (focusId != null ? index.byId.get(focusId) : undefined) ?? index.root;
  if (!focus) return null;
  const kids = index.children.get(focus.id) ?? [];
  const nodes = [focus, ...kids];
  const shown = new Set(nodes.map((n) => n.id));
  const folded = new Map<string, UniverseLink>();
  for (const link of data.links) {
    const a = visibleAncestor(data, link.source, shown);
    const b = visibleAncestor(data, link.target, shown);
    if (a == null || b == null || a === b) continue;
    const key = `${a}\u0000${b}\u0000${link.rel}\u0000${link.kind}`;
    const prior = folded.get(key);
    const weight = link.weight ?? 1;
    if (prior) prior.weight = (prior.weight ?? 1) + weight;
    else folded.set(key, { ...link, source: a, target: b, weight });
  }
  const ghosts = pathTo(data, focus.id)
    .slice(0, -1)
    .map((id) => index.byId.get(id))
    .filter((n): n is UniverseNode => Boolean(n));
  return { focus, nodes, links: [...folded.values()], ghosts };
}
