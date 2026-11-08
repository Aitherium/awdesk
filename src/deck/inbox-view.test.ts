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
  isSessionStatus,
  moveCursor,
  nextActionLine,
  nextOrder,
  plainAsk,
  orderRelay,
  relayNick,
  splitWakes,
  successorId,
  wakeCausePill,
  wakeErrorLine,
  wakeHeldPill,
  wakeInvestigateMessage,
  wakeWhyLine,
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

describe('wake why / cause / held', () => {
  it('the why line keeps the host:port and path that say what broke', () => {
    const w = wake({ lastReason: 'exit_2', lastWhy: 'publish_moe_tiers: no llama-server on spark.local:8118 (or ssh failed)' });
    expect(wakeWhyLine(w)).toBe('publish_moe_tiers: no llama-server on spark.local:8118 (or ssh failed)');
    expect(wakeWhyLine(wake({ lastReason: 'exit_1', lastWhy: '' }))).toBe('exited 1');
    expect(wakeWhyLine(wake({ lastWhy: 'x'.repeat(300) })).length).toBe(160);
  });
  it('the cause pill names the bucket and the streak', () => {
    expect(wakeCausePill(wake({ lastCause: 'code-bug', whyStreak: 5 }))).toBe('code-bug ×5');
    expect(wakeCausePill(wake({ lastCause: 'timeout', whyStreak: 1 }))).toBe('timeout');
    expect(wakeCausePill(wake({}))).toBe('');
  });
  it('the held pill shows only while the hold is in the future', () => {
    const future = new Date(NOW + 30 * 60_000).toISOString();
    const past = new Date(NOW - 60_000).toISOString();
    expect(wakeHeldPill(wake({ heldUntil: future, heldOn: 'no llama-server' }), NOW)).toMatch(/^held until \d\d:\d\d — no llama-server$/);
    expect(wakeHeldPill(wake({ heldUntil: past, heldOn: 'x' }), NOW)).toBe('');
    expect(wakeHeldPill(wake({ heldUntil: 'garbage' }), NOW)).toBe('');
  });
  it('the investigate note says the session or the error', () => {
    expect(wakeInvestigateMessage({ ok: true, session: 's-1' })).toBe('investigating — agent session s-1');
    expect(wakeInvestigateMessage({ ok: false, error: 'daemon unreachable' })).toBe('investigate failed: daemon unreachable');
    expect(wakeInvestigateMessage(null)).toBe('investigate: no answer from the desk');
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
  it('the line is the plain ask; the verb rides on the button only', () => {
    const next = nextActionLine([
      card({ title: 'Solana receive address', options: [{ key: 'y', label: 'Approve', recommended: true }] }),
    ], 1);
    expect(next?.line).toBe('Solana receive address');
    expect(next?.choice).toEqual({ key: 'y', label: 'Approve' });
  });
  it('a session-status card reads as the ask, not "I am looking now: Claude Code needs you: ..."', () => {
    const status = card({
      id: 'd-cc', kind: 'blocked', dedupeKey: 'cc-waiting:abc:1',
      title: 'Claude Code needs you: AitherOS-Fresh -- Good faith extension terms',
      options: [{ key: 'ack', label: 'I am looking now', recommended: true }, { key: 'later', label: 'Not now', recommended: false }],
      defaultKey: 'ack',
    });
    const next = nextActionLine([status], 1);
    expect(next?.line).toBe('Good faith extension terms — a session needs your answer');
    expect(next?.line).not.toMatch(/I am looking now|Claude Code needs you/);
    expect(next?.choice?.label).toBe('I am looking now');
    expect(plainAsk(card({ title: 'Claude Code needs you: X --  ' }))).toBe('A session is waiting — a session needs your answer');
  });
  it('credentials first, then decisions that unblock work, session-status pings last (stable inside a tier)', () => {
    const status = (id: string) => card({ id, kind: 'blocked', title: `Claude Code needs you: P -- ask ${id}` });
    const cards = [
      status('d-s1'),
      card({ id: 'd-dec1', title: 'Pick a region' }),
      status('d-s2'),
      card({ id: 'd-cred', kind: 'credential', title: 'Secret needed: STRIPE_KEY' }),
      card({ id: 'd-dec2', title: 'Approve the merge' }),
    ];
    expect(nextOrder(cards).map((c) => c.id)).toEqual(['d-cred', 'd-dec1', 'd-dec2', 'd-s1', 'd-s2']);
    const next = nextActionLine(cards, 5);
    expect(next?.id).toBe('d-cred');
    expect(next?.choice).toBeNull();
    expect(nextActionLine(cards.filter((c) => c.id !== 'd-cred'), 4)?.id).toBe('d-dec1');
    expect(nextActionLine([status('d-s1'), status('d-s2')], 2)?.id).toBe('d-s1');
  });
  it('a session-status card is recognised by its dedupe key or its title, nothing else', () => {
    expect(isSessionStatus(card({ dedupeKey: 'cc-waiting:x:y', title: 'anything' }))).toBe(true);
    expect(isSessionStatus(card({ title: 'Claude Code needs you: P -- x' }))).toBe(true);
    expect(isSessionStatus(card({ kind: 'blocked', title: 'Blocked: deploy needs the Cloudflare token' }))).toBe(false);
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

import { staleGroup, optionByIndex, answerByQuery, filterRows } from './inbox-view';

describe('staleGroup — the fold, and what never falls into it', () => {
  it('folds approve/choose cards older than the window', () => {
    const old = card({ id: 'd-old', createdAt: NOW / 1000 - 8 * DAY });
    expect(staleGroup([old], NOW).map((c) => c.id)).toEqual(['d-old']);
  });

  it('never folds a credential or blocked card, however old', () => {
    const cred = card({ id: 'd-cred', kind: 'credential', createdAt: NOW / 1000 - 90 * DAY });
    const blocked = card({ id: 'd-blk', kind: 'blocked', createdAt: NOW / 1000 - 90 * DAY });
    expect(staleGroup([cred, blocked], NOW)).toEqual([]);
  });

  it('groupDecisions agrees with staleGroup term for term', () => {
    const rows = [
      card({ id: 'd-fresh' }),
      card({ id: 'd-old', createdAt: NOW / 1000 - 8 * DAY }),
      card({ id: 'd-cred', kind: 'credential', createdAt: NOW / 1000 - 8 * DAY }),
    ];
    const { stale } = groupDecisions(rows, NOW);
    expect(stale.map((c) => c.id)).toEqual(staleGroup(rows, NOW).map((c) => c.id));
  });
});

describe('optionByIndex — the number keys', () => {
  const options = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
  it('is 1-based', () => {
    expect(optionByIndex(options, 1)?.key).toBe('a');
    expect(optionByIndex(options, 2)?.key).toBe('b');
  });
  it('does nothing out of range instead of answering the last option', () => {
    expect(optionByIndex(options, 3)).toBeNull();
    expect(optionByIndex(options, 0)).toBeNull();
    expect(optionByIndex(options, -1)).toBeNull();
    expect(optionByIndex([], 1)).toBeNull();
  });
});

describe('answerByQuery — typed answers', () => {
  const options = [
    { key: 'ack', label: 'I am looking now' },
    { key: 'not_now', label: 'Not now' },
  ];
  it('matches an exact key or label, case-insensitively', () => {
    expect(answerByQuery(options, 'ack')?.key).toBe('ack');
    expect(answerByQuery(options, 'not now')?.key).toBe('not_now');
  });
  it('matches a unique prefix but refuses an ambiguous one', () => {
    expect(answerByQuery(options, 'i am')?.key).toBe('ack');
    expect(answerByQuery(options, 'n')).toBeNull();
  });
  it('empty text is not an answer', () => {
    expect(answerByQuery(options, '   ')).toBeNull();
  });
});

describe('filterRows — typing narrows the list, never re-ranks it', () => {
  const rows = [
    card({ id: 'd-cred', title: 'Gmail credential', kind: 'credential', summary: 'type the app password' }),
    card({ id: 'd-pr', title: 'Merge PR 42', agent: 'claude-code' }),
    card({ id: 'd-fyi', title: 'Nightly digest' }),
  ];
  it('returns every row in order for an empty query', () => {
    expect(filterRows(rows, '').map((c) => c.id)).toEqual(['d-cred', 'd-pr', 'd-fyi']);
  });
  it('matches title, summary, kind and source', () => {
    expect(filterRows(rows, 'gmail').map((c) => c.id)).toEqual(['d-cred']);
    expect(filterRows(rows, 'password').map((c) => c.id)).toEqual(['d-cred']);
    expect(filterRows(rows, 'claude').map((c) => c.id)).toEqual(['d-pr']);
  });
  it('requires every token to match', () => {
    expect(filterRows(rows, 'merge 42').map((c) => c.id)).toEqual(['d-pr']);
    expect(filterRows(rows, 'merge gmail')).toEqual([]);
  });
});
