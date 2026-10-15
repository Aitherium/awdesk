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
import { allAsks, attachCards } from '../vendor/bead-space/universe';
import type { DeskCard, UniverseData } from '../vendor/bead-space/types';
import type { DeckDecision, DeckState } from '../deck/deck-types';

export type SpaceSource = 'remote' | 'last-good' | 'local';

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
