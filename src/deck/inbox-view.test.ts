import { describe, expect, it } from 'vitest';
import type { DeckDecision, RelayRow, WakeRow } from './deck-types';
import {
  awarenessLine,
  capList,
  decisionGroup,
  decisionSource,
  groupDecisions,
  healthySummary,
  isBrokenWake,
  moveCursor,
  nextActionLine,
  orderRelay,
  relayNick,
  splitWakes,
  successorId,
  wakeErrorLine,
  VISIBLE_CAP,
} from './inbox-view';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86400;

function card(overrides: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id: 'd-1', title: 'T', summary: '', urgency: 'normal', createdAt: NOW / 1000 - 60,
    options: [{ key: 'a', label: 'Option A', recommended: false }, { key: 'b', label: 'Option B', recommended: false }],
    defaultKey: '', tab: '', cwd: '', agent: '', ...overrides,
  };
}

function wake(overrides: Partial<WakeRow> = {}): WakeRow {
  return {
    name: 'w', enabled: true, every: '1h', intervalS: 3600, run: 'x', at: null, lastState: 'success',
    lastReason: 'exit_0', lastStartedAt: null, lastFinishedAt: null, lastWakeId: null, consecutiveFailures: 0,
    running: false, runningSince: null, nextDueAt: null, cardId: '', error: '', ...overrides,
  };
}

function relay(overrides: Partial<RelayRow> = {}): RelayRow {
  return { channel: '#agents', author: 'a', text: 't', at: 1, id: null, threadId: null, replyCount: 0, agent: true, ...overrides };
}

describe('decisionGroup', () => {
  it('credential and blocked come from the kind', () => {
    expect(decisionGroup(card({ kind: 'credential' }))).toBe('credential');
    expect(decisionGroup(card({ kind: 'blocked' }))).toBe('blocked');
    expect(decisionGroup(card({ blocking: true }))).toBe('blocked');
  });
  it('a yes/no pair is an approval; anything else is a choice', () => {
    const yn = [{ key: 'y', label: 'Approve', recommended: true }, { key: 'n', label: 'Deny', recommended: false }];
    expect(decisionGroup(card({ options: yn }))).toBe('approve');
    expect(decisionGroup(card({ kind: 'approval' }))).toBe('approve');
    expect(decisionGroup(card())).toBe('choose');
    const three = [...yn, { key: 'm', label: 'Maybe', recommended: false }];
    expect(decisionGroup(card({ options: three }))).toBe('choose');
  });
});

describe('groupDecisions', () => {
  it('folds cards older than 7 days apart and keeps group order', () => {
    const cards = [
      card({ id: 'd-old', createdAt: NOW / 1000 - 8 * DAY }),
      card({ id: 'd-choose' }),
      card({ id: 'd-cred', kind: 'credential' }),
    ];
    const { groups, stale } = groupDecisions(cards, NOW);
    expect(stale.map((c) => c.id)).toEqual(['d-old']);
    expect(groups.map((g) => g.key)).toEqual(['credential', 'choose']);
    expect(groups[1].cards.map((c) => c.id)).toEqual(['d-choose']);
  });
  it('never folds a credential or blocked card, however old', () => {
    const old = NOW / 1000 - 30 * DAY;
    const { groups, stale } = groupDecisions([card({ id: 'c', kind: 'credential', createdAt: old }), card({ id: 'b', kind: 'blocked', createdAt: old })], NOW);
    expect(stale).toEqual([]);
    expect(groups.map((g) => g.key)).toEqual(['credential', 'blocked']);
  });
  it('drops empty groups', () => {
    expect(groupDecisions([], NOW).groups).toEqual([]);
  });
});

describe('decisionSource', () => {
  it('names the agent, else the tab, else the last cwd segment', () => {
    expect(decisionSource(card({ agent: 'lyra' }))).toBe('lyra');
    expect(decisionSource(card({ tab: 'tab 3' }))).toBe('tab 3');
    expect(decisionSource(card({ cwd: 'C:\\AitherOS-Fresh\\awdk' }))).toBe('awdk');
  });
});

describe('cursor', () => {
  it('moves and clamps', () => {
    expect(moveCursor(['a', 'b', 'c'], null, 1)).toBe('a');
    expect(moveCursor(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(moveCursor(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(moveCursor(['a', 'b', 'c'], 'a', -1)).toBe('a');
    expect(moveCursor([], 'a', 1)).toBeNull();
  });
  it('the successor of an answered card is the one in its slot', () => {
    expect(successorId(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
    expect(successorId(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
    expect(successorId(['a'], [], 'a')).toBeNull();
  });
});

describe('wakes', () => {
  it('broken = failing streak or a timed-out last run, never a running one', () => {
    expect(isBrokenWake(wake({ consecutiveFailures: 3 }))).toBe(true);
    expect(isBrokenWake(wake({ lastState: 'timeout' }))).toBe(true);
    expect(isBrokenWake(wake({ lastReason: 'timed_out_after_300s' }))).toBe(true);
    expect(isBrokenWake(wake({ consecutiveFailures: 3, running: true }))).toBe(false);
    expect(isBrokenWake(wake())).toBe(false);
  });
  it('sorts the worst streak first and summarises the rest in one line', () => {
    const { broken, healthy } = splitWakes([
      wake({ name: 'b', consecutiveFailures: 2 }),
      wake({ name: 'a', consecutiveFailures: 131 }),
      wake({ name: 'ok1' }),
      wake({ name: 'off', enabled: false }),
      wake({ name: 'run', running: true }),
    ]);
    expect(broken.map((w) => w.name)).toEqual(['a', 'b']);
    expect(healthySummary(healthy)).toBe('1 routine OK · 1 running · 1 disabled');
  });
  it('the error line is one actionable clause, capped', () => {
    expect(wakeErrorLine(wake({ lastState: 'failure', lastReason: 'exit_1' }))).toBe('exited 1');
    expect(wakeErrorLine(wake({ lastState: '', lastReason: 'x'.repeat(200) })).length).toBe(80);
  });
  it('strips a traceback, a url and a path — one clause, no machine noise', () => {
    const raw = 'Traceback (most recent call last):\n  File "/app/x.py", line 3, in <module>\n    raise SystemExit(1)\n\nERROR: could not reach https://aitherium.com/health then /usr/lib/python3.12/x.py died';
    const line = wakeErrorLine(wake({ lastState: '', lastReason: '', error: raw }));
    expect(line).not.toContain('http');
    expect(line).not.toContain('Traceback');
    expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe('capList', () => {
  it('shows five and counts the rest', () => {
    const { shown, more } = capList([1, 2, 3, 4, 5, 6, 7]);
    expect(shown.length).toBe(VISIBLE_CAP);
    expect(shown).toEqual([1, 2, 3, 4, 5]);
    expect(more).toBe(2);
  });
  it('returns everything under the cap, as a copy', () => {
    const items = [1, 2, 3];
    const { shown, more } = capList(items);
    expect(shown).toEqual([1, 2, 3]);
    expect(more).toBe(0);
    expect(shown).not.toBe(items);
  });
  it('honours an explicit cap', () => {
    expect(capList([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], more: 2 });
  });
});

describe('nextActionLine', () => {
  it('leads with the top card and counts what is behind it', () => {
    const cards = Array.from({ length: 30 }, (_, i) => card({ id: `d-${i}`, title: `Task ${i}` }));
    const next = nextActionLine(cards, 30);
    expect(next?.id).toBe('d-0');
    expect(next?.after).toBe('29 after this one');
  });
  it('keeps a title that already starts with the action', () => {
    const next = nextActionLine([
      card({ title: 'Approve the Solana receive address', options: [{ key: 'y', label: 'Approve', recommended: true }] }),
    ], 1);
    expect(next?.line).toBe('Approve the Solana receive address');
  });
  it('prefixes the action when the title does not carry it', () => {
    const next = nextActionLine([
      card({ title: 'Solana receive address', options: [{ key: 'y', label: 'Approve', recommended: true }] }),
    ], 1);
    expect(next?.line).toBe('Approve: Solana receive address');
  });
  it('says nothing follows the last card, and is null with no cards', () => {
    expect(nextActionLine([card()], 1)?.after).toBe('nothing after this one');
    expect(nextActionLine([], 0)).toBeNull();
  });
});

describe('relay', () => {
  it('pins requests and alerts above findings, newest first', () => {
    const { pinned, rest } = orderRelay([
      relay({ id: 'f-old', kind: 'finding', at: 1 }),
      relay({ id: 'r', kind: 'REQUEST', at: 2 }),
      relay({ id: 'f-new', kind: 'finding', at: 5 }),
      relay({ id: 'a', kind: 'alert', at: 3 }),
    ]);
    expect(pinned.map((r) => r.id)).toEqual(['a', 'r']);
    expect(rest.map((r) => r.id)).toEqual(['f-new', 'f-old']);
  });
  it('splits the session suffix off the nick', () => {
    expect(relayNick('david+3f2a')).toEqual({ nick: 'david', session: '3f2a' });
    expect(relayNick('lyra')).toEqual({ nick: 'lyra', session: '' });
  });
});

describe('awarenessLine', () => {
  it('never puts raw exception text in the headline', () => {
    const line = awarenessLine('Voice', 'unreachable — Server disconnected without sending a response');
    expect(line).toMatchObject({ ok: false, state: 'Voice service not answering' });
    expect(line.detail).toContain('Server disconnected');
  });
  it('a platform limit reads as not available here', () => {
    const line = awarenessLine('Desktop', 'unavailable — Desktop context tools require Windows platform', 'Desktop context');
    expect(line).toMatchObject({ ok: false, state: 'Desktop context not available on this machine' });
  });
  it('healthy sources are ok', () => {
    expect(awarenessLine('Voice', 'up').ok).toBe(true);
    expect(awarenessLine('Workspace', 'default · 2 terminal session(s)', 'Workspace').ok).toBe(true);
  });
});
