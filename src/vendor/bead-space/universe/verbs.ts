// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * What a node offers, capped so the panel never becomes a menu: one obvious action,
 * at most two more, and "Explore with Aither".
 */
import type { BeadAsk, BeadExplore, BeadVerb, UniverseData, UniverseNode } from '../types';
import { indexUniverse, parentOf } from './levels';

export const MAX_SECONDARY_VERBS = 2;

/** The node's own first explore prompt, or a generic one built from its name. */
export function exploreFor(node: UniverseNode): BeadExplore {
  const own = node.explore?.find((e) => e && e.prompt);
  if (own) return own;
  return {
    label: 'Explore with Aither',
    prompt: `Tell me about ${node.title} (${node.id}): what it is, how it is doing right now, and anything that needs my attention.`,
  };
}

/** The node's top ask: lowest rank, then the order it was attached in. */
export function topAskOf(node: UniverseNode): BeadAsk | null {
  const asks = node.asks ?? [];
  if (!asks.length) return null;
  let best = asks[0];
  for (const ask of asks) {
    if ((ask.rank ?? Infinity) < (best.rank ?? Infinity)) best = ask;
  }
  return best;
}

export type PrimaryAction =
  | { kind: 'ask'; ask: BeadAsk }
  | { kind: 'verb'; verb: BeadVerb }
  | { kind: 'explore'; explore: BeadExplore };

/** The one obvious thing to do: answer the top ask, else the primary verb, else explore. */
export function primaryAction(node: UniverseNode): PrimaryAction {
  const ask = topAskOf(node);
  if (ask) return { kind: 'ask', ask };
  const verb = (node.verbs ?? []).find((v) => v.primary);
  if (verb) return { kind: 'verb', verb };
  return { kind: 'explore', explore: exploreFor(node) };
}

export interface NodeVerbs {
  primary: BeadVerb | null;
  /** At most MAX_SECONDARY_VERBS. */
  secondary: BeadVerb[];
  explore: BeadExplore;
}

/**
 * The verbs the panel shows. The primary is the one marked `primary`, else the first;
 * `preferId` (a verb a search phrase named) takes the primary slot when present.
 */
export function verbsFor(node: UniverseNode, preferId?: string | null): NodeVerbs {
  const verbs = (node.verbs ?? []).filter((v) => v && v.id && v.label);
  const primary = (preferId ? verbs.find((v) => v.id === preferId) : undefined)
    ?? verbs.find((v) => v.primary)
    ?? verbs[0]
    ?? null;
  const secondary = verbs.filter((v) => v !== primary).slice(0, MAX_SECONDARY_VERBS);
  return { primary, secondary, explore: exploreFor(node) };
}

/** Asks on each node plus every ancestor, so a galaxy glows for an ask deep inside it. */
export function glowCounts(data: UniverseData): Map<string, number> {
  const { byId } = indexUniverse(data);
  const counts = new Map<string, number>();
  for (const node of data.nodes) {
    const n = node.asks?.length ?? 0;
    if (!n) continue;
    const seen = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor != null && !seen.has(cursor) && byId.has(cursor)) {
      seen.add(cursor);
      counts.set(cursor, (counts.get(cursor) ?? 0) + n);
      cursor = parentOf(data, cursor);
    }
  }
  return counts;
}

/** Every ask in the universe, best first (rank, then urgency, then data order). */
export function allAsks(data: UniverseData): Array<{ node: UniverseNode; ask: BeadAsk }> {
  const urgency: Record<string, number> = { critical: 0, urgent: 0, high: 1, normal: 2, low: 3 };
  const out: Array<{ node: UniverseNode; ask: BeadAsk; seq: number }> = [];
  let seq = 0;
  for (const node of data.nodes) {
    for (const ask of node.asks ?? []) out.push({ node, ask, seq: seq++ });
  }
  out.sort((a, b) =>
    (a.ask.rank ?? Infinity) - (b.ask.rank ?? Infinity)
    || (urgency[a.ask.urgency] ?? 2) - (urgency[b.ask.urgency] ?? 2)
    || a.seq - b.seq);
  return out.map(({ node, ask }) => ({ node, ask }));
}

/** True for the urgencies drawn in forge orange rather than gold. */
export function isUrgent(urgency: string | undefined): boolean {
  return urgency === 'high' || urgency === 'urgent' || urgency === 'critical';
}
