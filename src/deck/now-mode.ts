/**
 * NOW mode — one card at a time (ADHD gap 3, owner 2026-11-01).
 *
 * The Inbox shows every open decision at once, grouped. That is the right view
 * for triage and the wrong one for DOING: a list of 12 is twelve things to hold
 * in mind. Now mode puts ONE card on the whole window — its title, one line of
 * why, the recommended answer as the big button — and when it is answered the
 * next one slides in, with "3 of 12" so the end is always in sight.
 *
 * ORDER is not decided here. The card on stage is always `nextActionLine(...)`
 * of what is left — the same "Next" the Inbox header shows — so Now mode can
 * never disagree with the Inbox about where to start. This module only tracks
 * which cards the owner already handled in this run (answered or "later"), so a
 * card leaves the stage the moment it is handled even before main's next
 * deck-state push confirms it.
 *
 * Pure functions + a reducer, no React: every rule has a vitest arm.
 */
import { otherChoices, primaryChoice, type DeckDecision } from './deck-types';
import { nextActionLine } from './inbox-view';

/** How many non-recommended options get a number key (1-4). */
export const NOW_OPTION_KEYS = 4;

export interface NowState {
  active: boolean;
  /** Ids handled in THIS run, in the order they were handled. */
  handled: string[];
  /** The largest queue size seen this run, so "N of M" never shrinks under the owner. */
  total: number;
}

export const NOW_IDLE: NowState = Object.freeze({ active: false, handled: [], total: 0 }) as NowState;

export type NowEvent =
  | { type: 'enter'; cards: DeckDecision[] }
  | { type: 'handled'; id: string }
  | { type: 'sync'; cards: DeckDecision[] }
  | { type: 'exit' };

/** What is left to do, in the Inbox's own order (handled ones removed). */
export function nowQueue(cards: DeckDecision[], state: NowState): DeckDecision[] {
  const handled = new Set(state.handled);
  return (cards || []).filter((c) => c && !handled.has(c.id));
}

/** The card on stage: whatever nextActionLine picks from what is left. */
export function nowCurrent(cards: DeckDecision[], state: NowState): DeckDecision | null {
  const queue = nowQueue(cards, state);
  const next = nextActionLine(queue, queue.length);
  return next ? queue.find((c) => c.id === next.id) ?? null : null;
}

/**
 * "3 of 12": position = handled + 1, total = the most this run has known about.
 * A card arriving mid-run grows the total; one answered elsewhere never makes
 * the counter jump backwards. `done` is true once nothing is left.
 */
export function nowCounter(cards: DeckDecision[], state: NowState): { position: number; total: number; done: boolean; label: string } {
  const left = nowQueue(cards, state).length;
  const total = Math.max(state.total, state.handled.length + left);
  if (left === 0) {
    return { position: state.handled.length, total, done: true, label: total > 0 ? `${state.handled.length} of ${total} done` : 'nothing waiting' };
  }
  const position = Math.min(total, state.handled.length + 1);
  return { position, total, done: false, label: `${position} of ${total}` };
}

export function nowReducer(state: NowState, event: NowEvent): NowState {
  switch (event.type) {
    case 'enter':
      return { active: true, handled: [], total: (event.cards || []).length };
    case 'exit':
      return NOW_IDLE;
    case 'handled':
      if (!state.active || !event.id || state.handled.includes(event.id)) return state;
      return { ...state, handled: [...state.handled, event.id] };
    case 'sync': {
      if (!state.active) return state;
      const grown = Math.max(state.total, state.handled.length + nowQueue(event.cards, state).length);
      return grown === state.total ? state : { ...state, total: grown };
    }
    default:
      return state;
  }
}

/** What a key press means on the Now stage. */
export type NowIntent =
  | { type: 'answer'; id: string; choice: string }
  | { type: 'later'; id: string }
  | { type: 'exit' }
  | null;

/** The options shown small under the big button, each with its number key. */
export function nowOptions(card: DeckDecision): Array<{ key: string; label: string; hotkey: string | null }> {
  return otherChoices(card).map((o, i) => ({ ...o, hotkey: i < NOW_OPTION_KEYS ? String(i + 1) : null }));
}

/**
 * Enter = the recommended answer, 1-4 = the other options in the order shown,
 * L = later, Esc = exit. A credential card has no answer a key could give (the
 * value is typed into its field), so Enter and 1-4 do nothing there.
 * Modifier chords are never ours (Ctrl+L, Alt+1 belong to the window).
 */
export function nowKeyIntent(
  key: string,
  card: DeckDecision | null,
  mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {},
): NowIntent {
  if (mods.ctrl || mods.meta || mods.alt) return null;
  if (key === 'Escape') return { type: 'exit' };
  if (!card) return null;
  if (key === 'l' || key === 'L') return { type: 'later', id: card.id };
  if (card.kind === 'credential') return null;
  if (key === 'Enter') {
    const primary = primaryChoice(card);
    return primary ? { type: 'answer', id: card.id, choice: primary.key } : null;
  }
  if (/^[1-9]$/.test(key)) {
    const option = nowOptions(card).find((o) => o.hotkey === key);
    return option ? { type: 'answer', id: card.id, choice: option.key } : null;
  }
  return null;
}

/** The one line of WHY under the title: the summary's first line, trimmed. */
export function nowWhy(card: DeckDecision, max = 160): string {
  const first = String(card.summary || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** `?mode=now` on the Inbox URL opens straight into Now mode (tray / palette door). */
export function nowModeParam(search: string): boolean {
  try {
    return new URLSearchParams(search).get('mode') === 'now';
  } catch {
    return false;
  }
}
