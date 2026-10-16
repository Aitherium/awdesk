/**
 * One level of the universe as the REAL bead-space engine's data (createBeadSpace).
 *
 * The engine draws a flat graph: planets in clusters, links, ships. The universe (U1,
 * Genesis /beadspace/universe via electron/space-client.cjs) is a tree. A level is the
 * focus and ONE ring of its children: the universe shows its galaxies, a galaxy its solar
 * systems, a solar system its systems. Two rings turned the root into ~55 planets and the
 * fleet galaxy into an unlabelled ~200-planet ball (owner review 2026-10-15); one ring
 * stays under the engine's always-labelled count (MAX_LEVEL_NODES), and everything else
 * is one click deeper. Each child is its own cluster (its own spot on a ring around the
 * focus, which sits in the middle: `anchors`).
 *
 * The engine knows status, owner and links -- not health, not asks. So:
 *   health down / degraded -> blocked (orange ring); parked -> deferred (greyed by the
 *     desk stylesheet); ok / starting / unknown -> open.
 *   No node gets an owner. An owner makes the engine fly a ship, and the ship circling an
 *     asking planet sat right on the ask marker (review r2). Asks and health are drawn by
 *     the DESK over the engine's planets (SpaceView `decorate`): a full gold ring with a
 *     count badge for asks (`meta.asks`), a health rim whose arcs are the healthy / sick /
 *     not-reporting shares (`meta.mix`).
 *   Colour is the node's STABLE hue (`hueOf(id)`): the same galaxy is the same colour at
 *     every level, and an ask never recolours a planet. `palette` is index-aligned with
 *     `clusterOrder` because the engine tints a cluster with clusterPalette[its index].
 *
 * Titles are made unambiguous on the level: a child named like the focus or like a
 * sibling (case-insensitively: "DGX" / "dgx", "Mesh" in Mesh) is qualified with what it
 * is ("Mesh · group"). Category aliases are merged before any level is built
 * (normaliseUniverse: "Infra" into "Infrastructure"), and the source's catch-all bucket
 * ("Ungrouped") reads "Unsorted (n)".
 *
 * Links: tree edges are parent-child. Everything else in U1 is rolled up onto the
 * nearest node on screen (the universe/levels visibleAt rule); a roll-up between two
 * children is a sibling cross-link, weighted by how many raw links folded into it.
 * `blocks` survive; `related` keep at most RELATED_PER_NODE per planet and RELATED_MAX
 * per level, strongest first -- a full roll-up drew a dense purple web over the map.
 *
 * Pure: no DOM, no engine.
 */
import { hash } from '../vendor/bead-space/core/hash';
import { childrenOf, indexUniverse, parentOf } from '../vendor/bead-space/universe';
import type {
  BeadAsk, BeadLinkKind, BeadStatus, UniverseData, UniverseLink, UniverseNode,
} from '../vendor/bead-space/types';

/** The one colour that means "asks you": the panel's ask gold. No cluster uses it. */
export const ASK_COLOR = '#EAB532';
/**
 * Cluster hues: the engine's default cycle WITHOUT its red, orange and yellow -- red and
 * orange are the health rim's sick colours, and yellow collided with the ask gold.
 */
export const CLUSTER_PALETTE = [
  '#4dabf7', '#69db7c', '#b197fc', '#38d9a9', '#f783ac', '#74c0fc', '#e599f7', '#63e6be', '#9775fa', '#91a7ff',
];
/** The engine labels every planet at or below this count; a level never exceeds it. */
export const MAX_LEVEL_NODES = 60;
/** Strongest sibling `related` links kept per planet... */
export const RELATED_PER_NODE = 2;
/** ...and per level: more than a handful of dashed lines turns the ring into a web. */
export const RELATED_MAX = 5;

/** How the things under a node are doing: its rollup, or its own state counted as one. */
export interface HealthMix {
  ok: number;
  /** degraded or starting */
  warn: number;
  down: number;
  unknown: number;
  /** 0 for a parked node: nothing is expected to report. */
  total: number;
}

export interface LevelNode {
  id: string;
  title: string;
  cluster: string;
  status: BeadStatus;
  assignee: null;
  createdAt: string;
  meta: {
    level: string; health: string; reason: string; asks: number; hasChildren: boolean; children: number;
    mix: HealthMix; hue: string;
  };
}

export interface LevelLink {
  source: string;
  target: string;
  kind: BeadLinkKind;
}

export interface BeadLevelData {
  focusId: string;
  nodes: LevelNode[];
  links: LevelLink[];
  /** Cluster names in a stable order (the engine's clusterOrder). */
  clusterOrder: string[];
  /** The hue of each cluster, index-aligned with clusterOrder (the engine's clusterPalette). */
  palette: string[];
  /** Normalised [x, y] per cluster: the focus in the middle, the children on a ring. */
  anchors: Record<string, [number, number]>;
  /** Root first, the focus last: the breadcrumb. */
  path: Array<{ id: string; title: string }>;
  /** Children not drawn because the level is full. */
  hidden: number;
}

const EPOCH = Date.UTC(2026, 0, 1);
const LEVEL_NOUN: Record<string, string> = {
  universe: 'universe', galaxy: 'galaxy', solar: 'group', system: 'system', moon: 'part',
};

/** A node's stable hue: the same thing is the same colour at every level. */
export function hueOf(id: string): string {
  return CLUSTER_PALETTE[hash(id) % CLUSTER_PALETTE.length];
}

export function healthMix(node: UniverseNode): HealthMix {
  const r = node.health?.rollup;
  if (r) {
    const total = r.ok + r.degraded + r.starting + r.down + r.unknown;
    if (total > 0) return { ok: r.ok, warn: r.degraded + r.starting, down: r.down, unknown: r.unknown, total };
  }
  const state = node.health?.state ?? 'unknown';
  if (state === 'parked') return { ok: 0, warn: 0, down: 0, unknown: 0, total: 0 };
  return {
    ok: state === 'ok' ? 1 : 0,
    warn: state === 'degraded' || state === 'starting' ? 1 : 0,
    down: state === 'down' ? 1 : 0,
    unknown: state === 'unknown' ? 1 : 0,
    total: 1,
  };
}

function askCounts(data: UniverseData): Map<string, number> {
  // Own asks plus every descendant's: a galaxy glows when one of its moons is asking.
  const counts = new Map<string, number>();
  for (const node of data.nodes) {
    const n = node.asks?.length ?? 0;
    if (!n) continue;
    const seen = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      counts.set(cursor, (counts.get(cursor) ?? 0) + n);
      cursor = parentOf(data, cursor);
    }
  }
  return counts;
}

export function statusOf(node: UniverseNode): { status: BeadStatus; assignee: null } {
  switch (node.health?.state) {
    case 'down':
    case 'degraded':
      return { status: 'blocked', assignee: null };
    case 'parked':
      return { status: 'deferred', assignee: null };
    default:
      return { status: 'open', assignee: null };
  }
}

/** Group names the source title-cases from a slug ("gpu" -> "Gpu"): written as the acronym. */
const ACRONYMS: Record<string, string> = { gpu: 'GPU', ui: 'UI', api: 'API', cpu: 'CPU', dns: 'DNS', llm: 'LLM' };
/** The source's catch-all buckets. */
const UNSORTED = /^(ungrouped|other|misc)$/i;
/**
 * Category names the source spells two ways under one parent (lower-cased alias ->
 * lower-cased canonical). Siblings that land on one key are merged; a plural and its
 * singular ("Agent" / "Agents") land on one key too.
 */
export const CATEGORY_ALIASES: Record<string, string> = {
  infra: 'infrastructure',
  'infra & ops': 'infrastructure',
  observability: 'monitoring',
  comms: 'communication',
  communications: 'communication',
};

/** What the owner reads for a node's name: the source's catch-all bucket gets a real word. */
export function baseTitle(node: UniverseNode, data?: UniverseData): string {
  const title = (node.title || node.id).trim();
  if (UNSORTED.test(title)) {
    const n = data ? childrenOf(data, node.id).length : 0;
    return n > 0 ? `Unsorted (${n})` : 'Unsorted';
  }
  return ACRONYMS[title.toLowerCase()] && /^[A-Z][a-z]+$/.test(title) ? ACRONYMS[title.toLowerCase()] : title;
}

export function canonicalKey(node: UniverseNode): string {
  const raw = (node.title || node.id).trim().toLowerCase();
  const key = CATEGORY_ALIASES[raw] ?? raw;
  return key.length > 3 && key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1) : key;
}

function sumRollup(nodes: UniverseNode[]): UniverseNode['health'] {
  const r = { ok: 0, degraded: 0, down: 0, starting: 0, unknown: 0 };
  for (const n of nodes) {
    const own = n.health?.rollup;
    if (own) {
      r.ok += own.ok; r.degraded += own.degraded; r.down += own.down; r.starting += own.starting; r.unknown += own.unknown;
    } else {
      const s = n.health?.state ?? 'unknown';
      if (s === 'ok' || s === 'degraded' || s === 'down' || s === 'starting' || s === 'unknown') r[s] += 1;
    }
  }
  const state = r.down ? 'down' : r.degraded ? 'degraded' : r.ok ? 'ok' : r.starting ? 'starting' : 'unknown';
  return { state, rollup: r };
}

/**
 * The universe with aliased sibling categories merged: "Infra" and "Infrastructure" under
 * one galaxy become ONE "Infrastructure" holding both groups' children, links and asks.
 * Only nodes that HAVE children are merged (two leaves are two things); the survivor is
 * the one with the most children (its title is the one the owner reads). Ids of merged-away nodes are
 * kept in `meta.mergedInto` so a deep link to one still lands. Same object back when
 * nothing merges.
 */
export function normaliseUniverse(data: UniverseData): UniverseData {
  const kids = new Map<string, UniverseNode[]>();
  for (const n of data.nodes) {
    if (n.parent == null) continue;
    const list = kids.get(n.parent) ?? [];
    list.push(n);
    kids.set(n.parent, list);
  }
  const into = new Map<string, string>();
  for (const siblings of kids.values()) {
    const byKey = new Map<string, UniverseNode[]>();
    for (const s of siblings) {
      if (!kids.has(s.id)) continue;
      const list = byKey.get(canonicalKey(s)) ?? [];
      list.push(s);
      byKey.set(canonicalKey(s), list);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const size = (n: UniverseNode) => kids.get(n.id)?.length ?? 0;
      const keep = [...group].sort((a, b) => size(b) - size(a) || a.id.localeCompare(b.id))[0];
      for (const n of group) if (n !== keep) into.set(n.id, keep.id);
    }
  }
  if (!into.size) return data;
  const to = (id: string) => into.get(id) ?? id;
  const nodes: UniverseNode[] = [];
  for (const n of data.nodes) {
    if (into.has(n.id)) continue;
    const merged = data.nodes.filter((m) => into.get(m.id) === n.id);
    const parent = n.parent != null ? to(n.parent) : null;
    if (!merged.length) {
      nodes.push(parent === n.parent ? n : { ...n, parent });
      continue;
    }
    const all = [n, ...merged];
    const asks: BeadAsk[] = all.flatMap((m) => m.asks ?? []);
    nodes.push({
      ...n,
      parent,
      health: { ...n.health, ...sumRollup(all) },
      ...(asks.length ? { asks } : {}),
      meta: { ...(n.meta ?? {}), mergedFrom: merged.map((m) => m.id) },
    });
  }
  const seen = new Set<string>();
  const links: UniverseLink[] = [];
  for (const l of data.links) {
    const source = to(l.source);
    const target = to(l.target);
    if (source === target) continue;
    const key = `${source}\u0000${target}\u0000${l.kind}\u0000${l.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(source === l.source && target === l.target ? l : { ...l, source, target });
  }
  return { ...data, nodes, links, meta: { ...data.meta, mergedInto: Object.fromEntries(into) } };
}

function nearestShown(data: UniverseData, id: string, shown: Set<string>): string | null {
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor != null && !seen.has(cursor)) {
    if (shown.has(cursor)) return cursor;
    seen.add(cursor);
    cursor = parentOf(data, cursor);
  }
  return null;
}

/** The node on `level` that holds `id` (itself or its nearest ancestor on screen). */
export function shownAncestor(data: UniverseData, level: BeadLevelData, id: string): string | null {
  return nearestShown(data, id, new Set(level.nodes.map((n) => n.id)));
}

/** Normalised ring anchors: the first name in the middle, the rest around it. */
function ringAnchors(focusCluster: string, ring: string[]): Record<string, [number, number]> {
  const anchors: Record<string, [number, number]> = { [focusCluster]: [0.5, 0.5] };
  const r = ring.length <= 6 ? 0.26 : 0.34;
  ring.forEach((name, i) => {
    const angle = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2;
    anchors[name] = [0.5 + Math.cos(angle) * r, 0.5 + Math.sin(angle) * r];
  });
  return anchors;
}

/** The level whose focus is `focusId` (unknown or null -> the root). null on an empty universe. */
export function beadLevel(data: UniverseData, focusId: string | null): BeadLevelData | null {
  const index = indexUniverse(data);
  const focus = (focusId != null ? index.byId.get(focusId) : undefined) ?? index.root;
  if (!focus) return null;
  const asks = askCounts(data);

  // Asking and sick children first when a level is too full to draw whole.
  const allKids = childrenOf(data, focus.id);
  const rank = (n: UniverseNode) => ((asks.get(n.id) ?? 0) > 0 ? 0
    : n.health?.state === 'down' || n.health?.state === 'degraded' ? 1 : 2);
  const kids = allKids.length < MAX_LEVEL_NODES ? allKids
    : [...allKids].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_LEVEL_NODES - 1);
  const hidden = allKids.length - kids.length;

  // Unambiguous titles on this screen.
  const focusTitle = baseTitle(focus, data);
  const counts = new Map<string, number>();
  for (const kid of kids) {
    const key = baseTitle(kid, data).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const titleOf = (kid: UniverseNode): string => {
    const t = baseTitle(kid, data);
    const key = t.toLowerCase();
    if (key !== focusTitle.toLowerCase() && (counts.get(key) ?? 0) < 2) return t;
    return `${t} · ${LEVEL_NOUN[kid.level] ?? kid.level}`;
  };

  const nodes: LevelNode[] = [];
  const shown = new Set<string>();
  const used = new Set<string>();
  const add = (node: UniverseNode, title: string, cluster: string, age: number) => {
    shown.add(node.id);
    // The focus holds every ask on the level by roll-up; its own ring would only say
    // "something somewhere", so it counts only the asks ON it.
    const n = node.id === focus.id ? node.asks?.length ?? 0 : asks.get(node.id) ?? 0;
    const children = childrenOf(data, node.id).length;
    nodes.push({
      id: node.id,
      title,
      cluster,
      ...statusOf(node),
      createdAt: new Date(EPOCH + age * 60_000).toISOString(),
      meta: {
        level: node.level,
        health: node.health?.state ?? 'unknown',
        reason: node.health?.reason ?? '',
        asks: n,
        hasChildren: children > 0,
        children,
        mix: healthMix(node),
        hue: hueOf(node.id),
      },
    });
  };

  // Cluster names are the display titles, made unique (two clusters may never merge).
  const clusterName = (title: string) => {
    let name = title;
    for (let i = 2; used.has(name); i += 1) name = `${title} (${i})`;
    used.add(name);
    return name;
  };
  const focusCluster = clusterName(focusTitle);
  add(focus, focusTitle, focusCluster, 0);
  const palette = [hueOf(focus.id)];
  const ring: string[] = [];
  const tree: LevelLink[] = [];
  kids.forEach((kid, i) => {
    const title = titleOf(kid);
    const cluster = clusterName(title);
    ring.push(cluster);
    palette.push(hueOf(kid.id));
    add(kid, title, cluster, i + 1);
    tree.push({ source: focus.id, target: kid.id, kind: 'parent-child' });
  });

  // Roll every other link up onto what is on screen; weigh sibling pairs.
  const treeKeys = new Set(tree.map((l) => `${l.source}\u0000${l.target}`));
  const pairs = new Map<string, { source: string; target: string; blocks: boolean; weight: number }>();
  for (const link of data.links) {
    const a = nearestShown(data, link.source, shown);
    const b = nearestShown(data, link.target, shown);
    if (a == null || b == null || a === b) continue;
    if (treeKeys.has(`${a}\u0000${b}`) || treeKeys.has(`${b}\u0000${a}`)) continue;
    const [s, t] = a < b ? [a, b] : [b, a];
    const key = `${s}\u0000${t}`;
    const pair = pairs.get(key) ?? { source: a, target: b, blocks: false, weight: 0 };
    pair.weight += 1;
    if (link.kind === 'blocks') {
      pair.blocks = true;
      pair.source = a;
      pair.target = b;
    }
    pairs.set(key, pair);
  }
  const blocks: LevelLink[] = [];
  const related = [...pairs.values()].filter((p) => {
    if (!p.blocks) return true;
    blocks.push({ source: p.source, target: p.target, kind: 'blocks' });
    return false;
  }).sort((x, y) => y.weight - x.weight || (x.source + x.target).localeCompare(y.source + y.target));
  const perNode = new Map<string, number>();
  const kept: LevelLink[] = [];
  for (const p of related) {
    if (kept.length >= RELATED_MAX) break;
    if ((perNode.get(p.source) ?? 0) >= RELATED_PER_NODE || (perNode.get(p.target) ?? 0) >= RELATED_PER_NODE) continue;
    perNode.set(p.source, (perNode.get(p.source) ?? 0) + 1);
    perNode.set(p.target, (perNode.get(p.target) ?? 0) + 1);
    kept.push({ source: p.source, target: p.target, kind: 'related' });
  }

  const path = [];
  const seenPath = new Set<string>();
  let cursor: string | null = focus.id;
  while (cursor != null && !seenPath.has(cursor)) {
    seenPath.add(cursor);
    const node = index.byId.get(cursor);
    if (node) path.unshift({ id: node.id, title: baseTitle(node, data) });
    cursor = parentOf(data, cursor);
  }
  return {
    focusId: focus.id,
    nodes,
    links: [...tree, ...blocks, ...kept],
    clusterOrder: [focusCluster, ...ring],
    palette,
    anchors: ringAnchors(focusCluster, ring),
    path,
    hidden,
  };
}

/** Where a click on `id` goes: into it (it has children and is not the focus) or onto it. */
export function clickIntent(data: UniverseData, focusId: string | null, id: string): 'descend' | 'select' {
  if (id === focusId) return 'select';
  return childrenOf(data, id).length > 0 ? 'descend' : 'select';
}
