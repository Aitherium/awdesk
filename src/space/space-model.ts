/**
 * The Space pane's model, pure: main's universe (desk:space-get) + main's deck feed
 * -> what the pane draws.
 *
 *   data       the universe with each open card attached to the object it concerns
 *              (bead-space attachCards: explicit subject first, then the heuristics);
 *   nextAsks   every ask, best first -- main's rank order (decision-cards rankCards,
 *              which both the local scan and the gateway read apply), then urgency;
 *   badge      '' when the universe is live, 'stale' for the last good copy, 'local view'
 *              when only the desk's own skeleton is drawn.
 *
 * Cards are copied field by field into the DeskCard shape, so nothing a card carries
 * beyond what the pane draws (a receipt, a description) reaches the model -- and a
 * credential VALUE is never on the deck feed in the first place.
 *
 * Nothing here moves the camera. A new ask only glows; flying is a deep link or a click.
 */
import { allAsks, attachCards, indexUniverse } from '../vendor/bead-space/universe';
import { auditSummaryOf, lensOf, verdictOf } from '../vendor/bead-space/space/panel-text';
import type { AuditSummary, AuditVerdict, LensSummary, LensTier } from '../vendor/bead-space/space/panel-text';
import type { DeskCard, UniverseData } from '../vendor/bead-space/types';
import type { DeckDecision, DeckState } from '../deck/deck-types';

/** `genesis`: Veil was unreachable, so main read the same universe straight from Genesis. */
export type SpaceSource = 'remote' | 'genesis' | 'last-good' | 'local';

/** What desk:space-get answers (electron/space-client.cjs get()). */
export interface SpaceGetResult {
  ok: boolean;
  universe?: UniverseData;
  stale?: boolean;
  source?: SpaceSource;
  error?: string;
  savedAt?: string;
}

export interface NextAsk {
  nodeId: string;
  cardId: string;
  title: string;
  urgency: string;
}

export interface SpaceModel {
  /** null until the first universe arrives. */
  data: UniverseData | null;
  nextAsks: NextAsk[];
  /** '' | 'stale' | 'local view'. */
  badge: string;
  error: string;
}

/** One deck card as bead-space's DeskCard: the listed fields and nothing else. */
export function deskCardOf(card: DeckDecision): DeskCard {
  const out: DeskCard = {
    id: String(card.id),
    title: String(card.title ?? ''),
    summary: String(card.summary ?? ''),
    kind: String(card.kind ?? 'decision'),
    urgency: String(card.urgency ?? 'normal'),
    options: (card.options ?? []).map((o) => ({
      key: String(o.key),
      label: String(o.label ?? o.key),
      recommended: Boolean(o.recommended),
    })),
    blocking: Boolean(card.blocking),
  };
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const optional: Array<[keyof DeskCard, unknown]> = [
    ['subject', card.subject],
    ['secretName', card.secretName],
    ['recipe', card.recipe],
    ['dedupeKey', card.dedupeKey],
    ['agent', card.agent],
    ['sessionId', card.sessionId],
    ['cwd', card.cwd],
    ['host', card.host],
  ];
  for (const [key, value] of optional) {
    const v = text(value);
    if (v !== undefined) (out as unknown as Record<string, string>)[key] = v;
  }
  return out;
}

export function badgeOf(result: SpaceGetResult | null): string {
  if (!result || !result.ok) return '';
  if (result.source === 'local') return 'local view';
  // Live, just not through api.aitherium.com: say so, never "stale".
  if (result.source === 'genesis') return 'direct';
  if (result.source === 'last-good' || result.stale) return 'stale';
  return '';
}

export function buildSpaceModel(result: SpaceGetResult | null, deck: Pick<DeckState, 'decisions'>): SpaceModel {
  const universe = result && result.ok && result.universe && Array.isArray(result.universe.nodes)
    ? result.universe : null;
  if (!universe) {
    return { data: null, nextAsks: [], badge: '', error: result && !result.ok ? String(result.error ?? 'no answer') : '' };
  }
  const decisions = Array.isArray(deck.decisions) ? deck.decisions.filter((c) => c && c.id) : [];
  // Main sends the cards already ranked (rankCards); that order IS the rank.
  const order = decisions.map((c) => c.id);
  const data = attachCards(universe, decisions.map(deskCardOf), order);
  const nextAsks = allAsks(data).map(({ node, ask }) => ({
    nodeId: node.id,
    cardId: ask.cardId,
    title: ask.title,
    urgency: ask.urgency,
  }));
  return { data, nextAsks, badge: badgeOf(result), error: result?.error ? String(result.error) : '' };
}

export interface DeskLens {
  summary: LensSummary;
  /** Planet ids to draw dim: svc outside the tier, and containers holding ONLY such svc. */
  dim: Set<string>;
}

/**
 * The profile lens for the desk's one-level-at-a-time planets. A service outside the
 * tier is dim; a galaxy/solar planet is dim only when every service under it is (a
 * container with one kept service stays lit, so the eye finds it). Status is untouched.
 */
export function deskLensOf(data: UniverseData | null, tier: LensTier): DeskLens | null {
  const summary = lensOf(data, tier);
  if (!data || !summary) return null;
  const { children } = indexUniverse(data);
  const dim = new Set(summary.dimIds);
  const memo = new Map<string, { svc: number; dimmed: number }>();
  const count = (id: string, seen: Set<string>): { svc: number; dimmed: number } => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (seen.has(id)) return { svc: 0, dimmed: 0 };
    seen.add(id);
    const own = id.startsWith('svc:') ? { svc: 1, dimmed: summary.dimIds.has(id) ? 1 : 0 } : { svc: 0, dimmed: 0 };
    for (const kid of children.get(id) ?? []) {
      const c = count(kid.id, seen);
      own.svc += c.svc;
      own.dimmed += c.dimmed;
    }
    memo.set(id, own);
    return own;
  };
  for (const node of data.nodes) {
    if (node.id.startsWith('svc:')) continue;
    const c = count(node.id, new Set());
    if (c.svc > 0 && c.dimmed === c.svc) dim.add(node.id);
  }
  return { summary, dim };
}

export interface DeskAudit {
  summary: AuditSummary | null;
  /** Every planet's verdict: its own, or the WORST under it (a group with one breaking
   *  service reads breaking, so the eye finds it from the top). */
  verdict: Map<string, AuditVerdict>;
  /** Every planet's RAM: its own reading, or the sum of the RUNNING readings under it. */
  ramMb: Map<string, number>;
  /** The fleet moved since the audit measured it: the desk's own running count (and when
   *  the desk took it) differs from the audit's. null when they agree or either is missing. */
  drift: { running: number; at: string } | null;
}

/**
 * The desk's live running count vs the audit's. Pure. The verdict rings are the audit's
 * word at its measure time; a fleet that woke or slept since must say so, never let the
 * old count read as now (2026-10-16: "61 running" while podman ran 78).
 */
export function auditDriftOf(data: UniverseData | null, summary: AuditSummary | null): DeskAudit['drift'] {
  if (!data || !summary || summary.running === null) return null;
  const meta = data.nodes.find((n) => n.id === 'galaxy:fleet')?.meta;
  const live = meta?.desk_running;
  if (typeof live !== 'number' || !Number.isFinite(live) || live === summary.running) return null;
  const at = typeof meta?.desk_running_at === 'string' ? meta.desk_running_at : '';
  return { running: live, at };
}

/**
 * Which verdict a GROUP wears, most attention-worthy first. Not AUDIT_VERDICTS' order:
 * there `parked` outranks `business`/`core`, so every group holding one parked unit read
 * "parked" (grey) over its running core services -- measured live 2026-10-16, Security
 * (secrets, security-core running) and 13 more fleet groups ringed grey. Parked asks
 * nothing of the owner; a group reads parked only when nothing under it runs.
 */
const ROLLUP_ORDER: readonly AuditVerdict[] = [
  'breaking', 'crashed', 'dead', 'waste', 'trim-candidate', 'business', 'core', 'parked',
];

/**
 * The audit lens over the desk's one-level-at-a-time planets. Pure. Status is untouched:
 * the lens only rings and labels what the audit (fleet_audit.py, via universe.py) said.
 */
export function deskAuditOf(data: UniverseData | null): DeskAudit | null {
  if (!data) return null;
  const { byId, children } = indexUniverse(data);
  const rank = new Map(ROLLUP_ORDER.map((v, i) => [v as string, i]));
  const verdict = new Map<string, AuditVerdict>();
  const ramMb = new Map<string, number>();
  const memo = new Map<string, { v: AuditVerdict | null; ram: number }>();
  const visit = (id: string, seen: Set<string>): { v: AuditVerdict | null; ram: number } => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (seen.has(id)) return { v: null, ram: 0 };
    seen.add(id);
    const node = byId.get(id);
    let v = verdictOf(node);
    const own = node?.meta?.mem_mb;
    const running = node?.meta?.run_state === 'running' || (node?.meta?.run_state == null && verdictOf(node) != null);
    let ram = typeof own === 'number' && Number.isFinite(own) && running ? own : 0;
    for (const kid of children.get(id) ?? []) {
      const c = visit(kid.id, seen);
      ram += c.ram;
      if (c.v && (!v || (rank.get(c.v) ?? 99) < (rank.get(v) ?? 99))) v = c.v;
    }
    const out = { v, ram };
    memo.set(id, out);
    return out;
  };
  for (const node of data.nodes) {
    const r = visit(node.id, new Set());
    if (r.v) verdict.set(node.id, r.v);
    if (r.ram > 0) ramMb.set(node.id, Math.round(r.ram * 10) / 10);
  }
  const summary = auditSummaryOf(data);
  return { summary, verdict, ramMb, drift: auditDriftOf(data, summary) };
}

/** The node an open card sits on, or null. */
export function nodeOfCard(data: UniverseData | null, cardId: string): string | null {
  if (!data) return null;
  for (const node of data.nodes) {
    if ((node.asks ?? []).some((a) => a.cardId === cardId)) return node.id;
  }
  return null;
}

export interface DeepLink {
  at: string | null;
  focusNext: boolean;
  card: string | null;
}

const ID_RE = /^(platform|[a-z]+:[A-Za-z0-9._/@:-]{1,160})$/;
const CARD_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** ?at=<id> | focus=next | card=<id>, each validated; anything else is ignored. */
export function deepLinkOf(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const at = params.get('at');
  const card = params.get('card');
  return {
    at: at && ID_RE.test(at) ? at : null,
    focusNext: params.get('focus') === 'next',
    card: card && CARD_RE.test(card) ? card : null,
  };
}

/** Where a deep link flies, once the data can answer it; null = not yet (or nowhere). */
export function deepLinkTarget(link: DeepLink, model: SpaceModel): string | null {
  const data = model.data;
  if (!data) return null;
  if (link.card) return nodeOfCard(data, link.card);
  if (link.at) return data.nodes.some((n) => n.id === link.at) ? link.at : null;
  if (link.focusNext) return model.nextAsks[0]?.nodeId ?? null;
  return null;
}
