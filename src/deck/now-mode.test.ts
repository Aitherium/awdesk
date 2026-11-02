import { describe, expect, it } from 'vitest';
import type { DeckDecision } from './deck-types';
import { nextActionLine } from './inbox-view';
import {
  NOW_IDLE,
  nowCounter,
  nowCurrent,
  nowKeyIntent,
  nowModeParam,
  nowOptions,
  nowQueue,
  nowReducer,
  nowWhy,
  type NowState,
} from './now-mode';

function card(overrides: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id: 'd-1', title: 'T', summary: '', urgency: 'normal', createdAt: 1_800_000_000,
    options: [
      { key: 'yes', label: 'Approve', recommended: true },
      { key: 'no', label: 'Deny', recommended: false },
      { key: 'ask', label: 'Ask why', recommended: false },
    ],
    defaultKey: 'yes', tab: '', cwd: '', agent: '', ...overrides,
  };
}

const deck = (n: number) => Array.from({ length: n }, (_, i) => card({ id: `d-${i}`, title: `Task ${i}` }));

describe('now mode ordering', () => {
  it('the card on stage is exactly nextActionLine of what is left — no second ranking', () => {
    const cards = [card({ id: 'd-z', title: 'Zed' }), card({ id: 'd-a', title: 'Alpha' })];
    const state = nowReducer(NOW_IDLE, { type: 'enter', cards });
    expect(nowCurrent(cards, state)?.id).toBe(nextActionLine(cards, cards.length)?.id);
    expect(nowCurrent(cards, state)?.id).toBe('d-z');
    const after = nowReducer(state, { type: 'handled', id: 'd-z' });
    expect(nowCurrent(cards, after)?.id).toBe(nextActionLine(nowQueue(cards, after), 1)?.id);
    expect(nowCurrent(cards, after)?.id).toBe('d-a');
  });

  it('a handled card leaves the stage before main confirms it', () => {
    const cards = deck(3);
    let state = nowReducer(NOW_IDLE, { type: 'enter', cards });
    state = nowReducer(state, { type: 'handled', id: 'd-0' });
    expect(nowQueue(cards, state).map((c) => c.id)).toEqual(['d-1', 'd-2']);
  });

  it('nothing left = no current card', () => {
    const state = nowReducer(NOW_IDLE, { type: 'enter', cards: [] });
    expect(nowCurrent([], state)).toBeNull();
  });
});

describe('now mode counter', () => {
  it('reads "3 of 12" after two answers', () => {
    const cards = deck(12);
    let state = nowReducer(NOW_IDLE, { type: 'enter', cards });
    state = nowReducer(state, { type: 'handled', id: 'd-0' });
    state = nowReducer(state, { type: 'handled', id: 'd-1' });
    // main's push drops the two answered cards; the counter must not jump back
    const live = cards.slice(2);
    state = nowReducer(state, { type: 'sync', cards: live });
    expect(nowCounter(live, state).label).toBe('3 of 12');
  });

  it('a card arriving mid-run grows the total, never shrinks it', () => {
    const cards = deck(2);
    let state = nowReducer(NOW_IDLE, { type: 'enter', cards });
    const more = [...cards, card({ id: 'd-new' })];
    state = nowReducer(state, { type: 'sync', cards: more });
    expect(nowCounter(more, state).total).toBe(3);
    state = nowReducer(state, { type: 'sync', cards: [] });
    expect(state.total).toBe(3);
  });

  it('done says how many were handled', () => {
    const cards = deck(2);
    let state = nowReducer(NOW_IDLE, { type: 'enter', cards });
    state = nowReducer(state, { type: 'handled', id: 'd-0' });
    state = nowReducer(state, { type: 'handled', id: 'd-1' });
    expect(nowCounter(cards, state)).toMatchObject({ done: true, label: '2 of 2 done' });
    expect(nowCounter([], nowReducer(NOW_IDLE, { type: 'enter', cards: [] })).label).toBe('nothing waiting');
  });

  it('handled twice counts once; idle ignores handled/sync; exit resets', () => {
    let state: NowState = nowReducer(NOW_IDLE, { type: 'enter', cards: deck(3) });
    state = nowReducer(state, { type: 'handled', id: 'd-0' });
    expect(nowReducer(state, { type: 'handled', id: 'd-0' })).toBe(state);
    expect(nowReducer(NOW_IDLE, { type: 'handled', id: 'd-0' })).toBe(NOW_IDLE);
    expect(nowReducer(NOW_IDLE, { type: 'sync', cards: deck(3) })).toBe(NOW_IDLE);
    expect(nowReducer(state, { type: 'exit' })).toEqual(NOW_IDLE);
  });
});

describe('now mode keyboard', () => {
  const c = card({ id: 'd-k' });

  it('Enter = the recommended answer', () => {
    expect(nowKeyIntent('Enter', c)).toEqual({ type: 'answer', id: 'd-k', choice: 'yes' });
  });

  it('1-4 = the other options in the order shown; out of range = nothing', () => {
    expect(nowOptions(c).map((o) => [o.hotkey, o.key])).toEqual([['1', 'no'], ['2', 'ask']]);
    expect(nowKeyIntent('1', c)).toEqual({ type: 'answer', id: 'd-k', choice: 'no' });
    expect(nowKeyIntent('2', c)).toEqual({ type: 'answer', id: 'd-k', choice: 'ask' });
    expect(nowKeyIntent('3', c)).toBeNull();
  });

  it('only four options get a number', () => {
    const many = card({
      options: ['p', 'a', 'b', 'c', 'd', 'e'].map((k, i) => ({ key: k, label: k.toUpperCase(), recommended: i === 0 })),
      defaultKey: 'p',
    });
    expect(nowOptions(many).map((o) => o.hotkey)).toEqual(['1', '2', '3', '4', null]);
    expect(nowKeyIntent('5', many)).toBeNull();
  });

  it('L = later, Esc = exit (even with nothing on stage)', () => {
    expect(nowKeyIntent('l', c)).toEqual({ type: 'later', id: 'd-k' });
    expect(nowKeyIntent('L', c)).toEqual({ type: 'later', id: 'd-k' });
    expect(nowKeyIntent('Escape', null)).toEqual({ type: 'exit' });
    expect(nowKeyIntent('Enter', null)).toBeNull();
  });

  it('modifier chords belong to the window', () => {
    expect(nowKeyIntent('l', c, { ctrl: true })).toBeNull();
    expect(nowKeyIntent('1', c, { alt: true })).toBeNull();
    expect(nowKeyIntent('Escape', c, { meta: true })).toBeNull();
  });

  it('a credential card cannot be answered by a key, only deferred', () => {
    const cred = card({ id: 'd-c', kind: 'credential' });
    expect(nowKeyIntent('Enter', cred)).toBeNull();
    expect(nowKeyIntent('1', cred)).toBeNull();
    expect(nowKeyIntent('l', cred)).toEqual({ type: 'later', id: 'd-c' });
  });

  it('a card with no options has no Enter answer', () => {
    expect(nowKeyIntent('Enter', card({ options: [], defaultKey: '' }))).toBeNull();
  });
});

describe('now mode text + door', () => {
  it('why is the first non-empty summary line, capped', () => {
    expect(nowWhy(card({ summary: '\n  First line \nsecond' }))).toBe('First line');
    expect(nowWhy(card({ summary: 'x'.repeat(200) })).length).toBe(160);
    expect(nowWhy(card({ summary: '' }))).toBe('');
  });

  it('?mode=now opens straight into Now mode', () => {
    expect(nowModeParam('?mode=now')).toBe(true);
    expect(nowModeParam('?card=d-1&mode=now')).toBe(true);
    expect(nowModeParam('?mode=later')).toBe(false);
    expect(nowModeParam('')).toBe(false);
  });
});

describe('now mode follows the Next order', () => {
  it('a credential leads, session-status pings come last', () => {
    const cards = [
      card({ id: 'd-s', kind: 'blocked', title: 'Claude Code needs you: P -- look' }),
      card({ id: 'd-d', title: 'Pick one' }),
      card({ id: 'd-c', kind: 'credential', title: 'Secret needed' }),
    ];
    let state = nowReducer(NOW_IDLE, { type: 'enter', cards });
    expect(nowCurrent(cards, state)?.id).toBe('d-c');
    state = nowReducer(state, { type: 'handled', id: 'd-c' });
    expect(nowCurrent(cards, state)?.id).toBe('d-d');
    state = nowReducer(state, { type: 'handled', id: 'd-d' });
    expect(nowCurrent(cards, state)?.id).toBe('d-s');
    expect(nowCounter(cards, state).label).toBe('3 of 3');
  });
});
