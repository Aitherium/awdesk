// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * Decision cards become objects in the universe: each card is attached to the node it
 * concerns (its `subject`), so an ask glows on the system it is about instead of
 * sitting in a list.
 *
 * Runs entirely client-side. Card text is read here and never sent anywhere.
 */
import type { BeadAsk, DeskCard, UniverseData, UniverseNode } from '../types';
import { indexUniverse } from './levels';

/** The universe id grammar. Anything else is not a subject. */
export const ID_PATTERN = /^(platform|[a-z]+:[A-Za-z0-9._/@:-]{1,160})$/;

/** Kinds that get a virtual moon when no node exists for them yet. */
const VIRTUAL_PARENTS: Record<string, string[]> = {
  secret: ['svc:Secrets', 'galaxy:data'],
  session: ['solar:agents/sessions', 'galaxy:agents'],
  routine: ['galaxy:fleet'],
  repo: ['galaxy:cloud'],
  agent: ['galaxy:agents'],
};

const REPO_ID = 'repo:Aitherium/AitherOS';

export interface SubjectIndex {
  ids: Set<string>;
  /** Agent names that have an `agent:` node, lower-cased → id. */
  agents: Map<string, string>;
  /** `svc:` titles, longest first, with a whole-word matcher each. */
  services: Array<{ id: string; title: string; re: RegExp }>;
  /** Host names that mean "the fleet PC". */
  fleetHosts: Set<string>;
}

export interface Subject {
  id: string;
  how: string;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the lookup `subjectOf` needs. `fleetHosts` adds to galaxy:fleet's host_name. */
export function subjectIndex(data: UniverseData, fleetHosts: string[] = []): SubjectIndex {
  const ids = new Set(data.nodes.map((n) => n.id));
  const agents = new Map<string, string>();
  const services: SubjectIndex['services'] = [];
  const hosts = new Set(fleetHosts.map((h) => h.toLowerCase()).filter(Boolean));
  for (const node of data.nodes) {
    if (node.id.startsWith('agent:')) agents.set(node.id.slice(6).toLowerCase(), node.id);
    if (node.id.startsWith('svc:')) {
      const title = (node.title || node.id.slice(4)).trim();
      // Two-letter titles ("UI", "DB") match far too much prose to be evidence.
      if (title.length >= 3) {
        services.push({ id: node.id, title, re: new RegExp(`(^|[^A-Za-z0-9])${escapeRe(title)}($|[^A-Za-z0-9])`, 'i') });
      }
    }
    if (node.id === 'galaxy:fleet' && typeof node.meta?.host_name === 'string') {
      hosts.add(String(node.meta.host_name).toLowerCase());
    }
  }
  services.sort((a, b) => b.title.length - a.title.length || (a.id < b.id ? -1 : 1));
  return { ids, agents, services, fleetHosts: hosts };
}

function kindOf(id: string): string {
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(0, colon) : id;
}

/** True when `id` is a node, or a well-formed id a virtual moon can hold. */
function resolves(id: string, index: SubjectIndex): boolean {
  if (!ID_PATTERN.test(id)) return false;
  return index.ids.has(id) || kindOf(id) in VIRTUAL_PARENTS;
}

function slug(text: string): string {
  return text.trim().replace(/[^A-Za-z0-9._/@:-]+/g, '-').slice(0, 160);
}

/** The job name after a `wake-*` token in a dedupe key (`awrise:wake-failed:<job>:<ts>`). */
function wakeJob(dedupeKey: string): string {
  const parts = dedupeKey.split(':');
  const at = parts.findIndex((p) => p.startsWith('wake-'));
  return at >= 0 && at + 1 < parts.length ? parts[at + 1] : '';
}

function prefixRule(card: DeskCard): string | null {
  const keys = [card.dedupeKey ?? '', card.recipe ?? ''].filter(Boolean);
  for (const key of keys) {
    if (key.startsWith('escalation:')) {
      const agent = card.agent || key.slice('escalation:'.length).split(':')[0];
      if (agent) return `agent:${slug(agent)}`;
    }
    if (key.startsWith('expedition-gate:')) return 'agent:atlas';
    if (key.startsWith('awconnect-pair:')) return 'galaxy:mesh';
    if (key.startsWith('pr-review')) return REPO_ID;
  }
  const wakeKey = (card.dedupeKey ?? '').split(':').some((p) => p.startsWith('wake-'));
  if (wakeKey || (card.recipe ?? '').startsWith('wake-')) {
    const job = wakeJob(card.dedupeKey ?? '');
    if (job) return `routine:${slug(job)}`;
  }
  return null;
}

/**
 * Which node a card concerns. First hit wins:
 * explicit subject → credential → key prefix → known agent → service named in the text →
 * session → repo by cwd → host → platform.
 */
export function subjectOf(card: DeskCard, index: SubjectIndex): Subject {
  if (card.subject && resolves(card.subject, index)) return { id: card.subject, how: 'explicit' };

  if (String(card.kind).toLowerCase() === 'credential' && card.secretName) {
    const id = `secret:${slug(card.secretName)}`;
    if (resolves(id, index)) return { id, how: 'heuristic:credential' };
  }

  const prefixed = prefixRule(card);
  if (prefixed && resolves(prefixed, index)) return { id: prefixed, how: 'heuristic:prefix' };

  if (card.agent) {
    const id = index.agents.get(card.agent.toLowerCase());
    if (id) return { id, how: 'heuristic:agent' };
  }

  const text = `${card.title ?? ''}\n${card.summary ?? ''}`;
  for (const svc of index.services) {
    if (svc.re.test(text)) return { id: svc.id, how: 'heuristic:service' };
  }

  if (card.sessionId) {
    const id = `session:${slug(card.sessionId)}`;
    if (resolves(id, index)) return { id, how: 'heuristic:session' };
  }

  if (card.cwd) {
    const base = card.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    if (base === 'AitherOS-Fresh' || base === 'AitherOS') return { id: REPO_ID, how: 'heuristic:cwd' };
  }

  if (card.host) {
    const fleet = index.fleetHosts.has(card.host.toLowerCase());
    const id = fleet ? 'galaxy:fleet' : 'galaxy:mesh';
    if (index.ids.has(id)) return { id, how: 'heuristic:host' };
  }

  return { id: 'platform', how: 'heuristic:platform' };
}

function askOf(card: DeskCard, how: string, rank: number | undefined): BeadAsk {
  const credential = String(card.kind).toLowerCase() === 'credential';
  const ask: BeadAsk = {
    cardId: card.id,
    title: card.title,
    urgency: card.urgency || 'normal',
    credential,
    options: (card.options ?? []).map((o) => ({
      key: o.key,
      label: o.label || o.key,
      recommended: Boolean(o.recommended),
    })),
    how,
  };
  if (credential && card.secretName) ask.secretName = card.secretName;
  if (rank !== undefined) ask.rank = rank;
  return ask;
}

function virtualMoon(id: string, data: UniverseData, ids: Set<string>): UniverseNode {
  const parents = VIRTUAL_PARENTS[kindOf(id)] ?? [];
  const parent = parents.find((p) => ids.has(p)) ?? (ids.has('platform') ? 'platform' : null);
  return {
    id,
    title: id.slice(id.indexOf(':') + 1),
    level: 'moon',
    parent,
    cluster: parent ?? 'platform',
    status: 'open',
    createdAt: data.generated_at,
    health: { state: 'unknown', reason: 'known only from an open card', source: 'cards' },
    virtual: true,
  };
}

export interface AttachOptions {
  /** Hosts that mean the fleet PC, for the host rule. */
  fleetHosts?: string[];
}

/**
 * A copy of `data` with `node.asks` filled from `cards`. `order` is the host's ranked
 * card order (ids); it becomes each ask's `rank` and the order asks sit on a node.
 * Subjects with no node get a virtual moon under the right parent. `data` is not mutated.
 */
export function attachCards(
  data: UniverseData,
  cards: DeskCard[],
  order: readonly string[] = [],
  options: AttachOptions = {},
): UniverseData {
  const index = subjectIndex(data, options.fleetHosts);
  const rankOf = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rankOf.has(id)) rankOf.set(id, i);
  });
  const ranked = [...cards].sort((a, b) =>
    (rankOf.get(a.id) ?? Infinity) - (rankOf.get(b.id) ?? Infinity) || 0);

  const byId = new Map<string, UniverseNode>();
  const nodes: UniverseNode[] = data.nodes.map((n) => {
    const copy: UniverseNode = { ...n, asks: [] };
    byId.set(copy.id, copy);
    return copy;
  });
  const ids = new Set(index.ids);
  for (const card of ranked) {
    if (!card || !card.id) continue;
    const subject = subjectOf(card, index);
    let node = byId.get(subject.id);
    if (!node && subject.id !== 'platform') {
      node = virtualMoon(subject.id, data, ids);
      nodes.push(node);
      byId.set(node.id, node);
      ids.add(node.id);
    }
    if (!node) node = byId.get(indexUniverse(data).root?.id ?? '');
    if (!node) continue;
    node.asks = [...(node.asks ?? []), askOf(card, subject.how, rankOf.get(card.id))];
  }
  for (const node of nodes) {
    if (!node.asks?.length) delete node.asks;
  }
  return { ...data, nodes };
}
