import { describe, expect, it } from 'vitest';
import {
  cardWhere,
  clockLabel,
  clockTone,
  formatAge,
  isoAgeLabel,
  normalizeWakes,
  primaryChoice,
  secondaryChoice,
  staleLabel,
  wakeActionMessage,
  wakeAgeLabel,
  wakeBadge,
  EMPTY_DECK_STATE,
  type DeckDecision,
  type WakeRow,
  type WakesFeed,
} from './deck-types';

function card(overrides: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id: 'd-1',
    title: 'Waiting on you',
    summary: '…',
    urgency: 'low',
    createdAt: 0,
    options: [],
    defaultKey: '',
    tab: '',
    cwd: '',
    agent: '',
    ...overrides,
  };
}

describe('cardWhere', () => {
  it('names the tab first, then cwd, then agent', () => {
    expect(cardWhere(card({ tab: 'pipeline', cwd: 'C:\\x', agent: 'bot' }))).toBe('pipeline');
    expect(cardWhere(card({ cwd: 'C:\\x', agent: 'bot' }))).toBe('C:\\x');
    expect(cardWhere(card({ agent: 'bot' }))).toBe('bot');
    expect(cardWhere(card())).toBe('');
  });
});

describe('formatAge', () => {
  const now = 10_000_000;
  it('renders human wall-clock age, not a date', () => {
    expect(formatAge(now, now * 1000)).toBe('just now');
    expect(formatAge(now - 4 * 60, now * 1000)).toBe('4m');
    expect(formatAge(now - 2 * 3600, now * 1000)).toBe('2h');
    expect(formatAge(now - 3 * 86400, now * 1000)).toBe('3d');
  });
  it('never goes negative on a clock-skewed createdAt', () => {
    expect(formatAge(now + 500, now * 1000)).toBe('just now');
  });
});

describe('primaryChoice / secondaryChoice', () => {
  const ackLater = card({
    options: [
      { key: 'ack', label: 'I am looking now', recommended: true },
      { key: 'later', label: 'Not now', recommended: false },
    ],
    defaultKey: 'ack',
  });

  it('prefers the raiser’s default key for the primary button', () => {
    expect(primaryChoice(ackLater)).toEqual({ key: 'ack', label: 'I am looking now' });
  });

  it('falls back to recommended, then first, and null on no options', () => {
    const noDefault = card({
      options: [
        { key: 'a', label: 'A', recommended: false },
        { key: 'b', label: 'B', recommended: true },
      ],
    });
    expect(primaryChoice(noDefault)).toEqual({ key: 'b', label: 'B' });

    const nothingRecommended = card({
      options: [{ key: 'a', label: 'A', recommended: false }],
    });
    expect(primaryChoice(nothingRecommended)).toEqual({ key: 'a', label: 'A' });
    expect(primaryChoice(card())).toBeNull();
  });

  it('secondary is the defer path: first non-recommended option', () => {
    expect(secondaryChoice(ackLater)).toEqual({ key: 'later', label: 'Not now' });
    // all-recommended or single-option cards have no defer button
    expect(secondaryChoice(card({
      options: [
        { key: 'a', label: 'A', recommended: true },
        { key: 'b', label: 'B', recommended: true },
      ],
    }))).toBeNull();
    expect(secondaryChoice(card({
      options: [{ key: 'a', label: 'A', recommended: true }],
    }))).toBeNull();
    expect(secondaryChoice(card())).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Wakes (awrise scheduled jobs)
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-18T08:00:00Z');

function wake(overrides: Partial<WakeRow> = {}): WakeRow {
  return {
    name: 'nightly-sync',
    enabled: true,
    every: '1h',
    intervalS: 3600,
    run: 'python sync.py',
    at: null,
    lastState: 'success',
    lastReason: '',
    lastStartedAt: null,
    lastFinishedAt: null,
    lastWakeId: null,
    consecutiveFailures: 0,
    running: false,
    runningSince: null,
    nextDueAt: null,
    cardId: '',
    error: '',
    ...overrides,
  };
}

function feed(overrides: Partial<WakesFeed> = {}): WakesFeed {
  return { ...EMPTY_DECK_STATE.wakes, source: 'daemon', installed: true, ...overrides };
}

describe('wakeBadge', () => {
  it('lets RUNNING beat FAILING — a job executing now is not broken', () => {
    expect(wakeBadge(wake({ running: true, consecutiveFailures: 5 }))).toBe('running');
  });

  it('names failing, disabled and ok', () => {
    expect(wakeBadge(wake({ consecutiveFailures: 1 }))).toBe('failing');
    expect(wakeBadge(wake({ enabled: false }))).toBe('disabled');
    expect(wakeBadge(wake())).toBe('ok');
    // A disabled job that failed before it was disabled still reads failing —
    // the streak is the thing that needs an answer.
    expect(wakeBadge(wake({ enabled: false, consecutiveFailures: 2 }))).toBe('failing');
  });
});

describe('wakeAgeLabel', () => {
  it('prefers how long it has been running', () => {
    expect(wakeAgeLabel(wake({ running: true, runningSince: '2026-09-18T07:58:00Z' }), NOW)).toBe('running 2m');
  });

  it('falls back to the last finish, then the last start, then never', () => {
    expect(wakeAgeLabel(wake({ lastFinishedAt: '2026-09-18T06:00:00Z' }), NOW)).toBe('ran 2h ago');
    expect(wakeAgeLabel(wake({ lastStartedAt: '2026-09-17T08:00:00Z' }), NOW)).toBe('started 1d ago');
    expect(wakeAgeLabel(wake(), NOW)).toBe('never run');
  });
});

describe('isoAgeLabel', () => {
  it('says never for null and unknown for garbage — never a fabricated age', () => {
    expect(isoAgeLabel(null, NOW)).toBe('never');
    expect(isoAgeLabel('not-a-date', NOW)).toBe('unknown');
    expect(isoAgeLabel('2026-09-18T07:00:00Z', NOW)).toBe('1h');
  });
});

describe('clockLabel', () => {
  it('says the clock is silent, with the last tick, when it is stale', () => {
    expect(clockLabel(feed({ clockStale: true, lastTickAt: '2026-09-18T07:00:00Z' }), NOW)).toBe(
      'clock silent since 2026-09-18T07:00:00Z',
    );
  });

  it('says NEVER TICKED when a stale clock has no tick at all', () => {
    expect(clockLabel(feed({ clockStale: true, lastTickAt: null }), NOW)).toBe('clock silent — never ticked');
  });

  it('reports a healthy clock with its age', () => {
    expect(clockLabel(feed({ clockStale: false, lastTickAt: '2026-09-18T07:59:00Z' }), NOW)).toBe(
      'clock ok — last tick 1m ago',
    );
  });

  it('says awrise is not installed rather than accusing the clock', () => {
    expect(clockLabel(feed({ installed: false, clockStale: false }), NOW)).toBe('awrise not installed');
  });

  // The defect these arms pin: a fetch that learned NOTHING about the scheduler
  // used to render "clock ok", because clockStale defaults to false. Absence of
  // a stale flag is not evidence of a live clock.
  it('never says ok when the clock has never ticked', () => {
    expect(clockLabel(feed({ clockStale: false, lastTickAt: null }), NOW)).toBe('clock never ticked');
  });

  it('says liveness is unknown when the read errored (live repro: no /wakes window)', () => {
    const f = feed({
      installed: null,
      clockStale: false,
      lastTickAt: null,
      error: 'daemon has no /wakes window (restart the harness daemon)',
    });
    expect(clockLabel(f, NOW)).toBe('clock liveness unknown');
  });

  it('says liveness is unknown when installed is still unknown', () => {
    expect(clockLabel(feed({ installed: null, clockStale: false, lastTickAt: null }), NOW)).toBe(
      'clock liveness unknown',
    );
  });

  it('never calls a CACHED snapshot ok — clockStale there is frozen, not measured', () => {
    const f = feed({ source: 'stale', clockStale: false, lastTickAt: '2026-09-18T05:00:00Z' });
    expect(clockLabel(f, NOW)).toBe('clock liveness unknown — last known tick 3h ago');
  });

  it('keeps the stale wording for a cached snapshot that DID report a silent clock', () => {
    const f = feed({ source: 'stale', clockStale: true, lastTickAt: '2026-09-18T05:00:00Z' });
    expect(clockLabel(f, NOW)).toBe('clock liveness unknown — last known tick 3h ago');
  });
});

describe('clockTone', () => {
  it('is ok only for a live daemon read with a tick', () => {
    expect(clockTone(feed({ clockStale: false, lastTickAt: '2026-09-18T07:59:00Z' }))).toBe('ok');
  });

  it('is stale when a live read reports a silent clock', () => {
    expect(clockTone(feed({ clockStale: true, lastTickAt: '2026-09-18T07:00:00Z' }))).toBe('stale');
    expect(clockTone(feed({ clockStale: true, lastTickAt: null }))).toBe('stale');
  });

  it('is unknown for an errored read, a cached snapshot, and a never-ticked clock', () => {
    expect(clockTone(feed({ error: 'boom', installed: null }))).toBe('unknown');
    expect(clockTone(feed({ source: 'stale', clockStale: false, lastTickAt: '2026-09-18T05:00:00Z' }))).toBe(
      'unknown',
    );
    expect(clockTone(feed({ clockStale: false, lastTickAt: null }))).toBe('unknown');
  });

  it('is unknown, not ok, when awrise is not installed', () => {
    expect(clockTone(feed({ installed: false }))).toBe('unknown');
  });
});

describe('staleLabel', () => {
  it('is empty while the feed is live', () => {
    expect(staleLabel(feed(), NOW)).toBe('');
  });

  it('ages the snapshot it is showing', () => {
    const f = feed({ source: 'stale', staleSince: NOW - 3_600_000, wakes: [wake()] });
    expect(staleLabel(f, NOW)).toBe('daemon down — showing snapshot from 1h ago');
  });

  it('says nothing cached rather than showing an empty list as truth', () => {
    const f = feed({ source: 'stale', staleSince: NOW - 1000, wakes: [] });
    expect(staleLabel(f, NOW)).toBe('daemon down — nothing cached');
  });
});

describe('normalizeWakes', () => {
  it('translates the snake_case snapshot fields main sends', () => {
    const out = normalizeWakes({
      source: 'daemon',
      installed: true,
      schema: 1,
      migration: 'v1 file',
      wakes: [wake({ name: 'job1' })],
      count: 1,
      failing: 1,
      disabled: 0,
      running: 0,
      last_tick_at: '2026-09-18T07:41:00Z',
      clock_stale: true,
      stale_since: null,
      error: null,
    });
    expect(out.lastTickAt).toBe('2026-09-18T07:41:00Z');
    expect(out.clockStale).toBe(true);
    expect(out.schema).toBe(1);
    expect(out.wakes).toHaveLength(1);
  });

  it('falls back to the empty feed for junk, and never invents installed:true', () => {
    expect(normalizeWakes(null)).toEqual(EMPTY_DECK_STATE.wakes);
    expect(normalizeWakes(undefined).installed).toBeNull();
    expect(normalizeWakes({ source: 'nonsense' }).source).toBe('none');
    expect(normalizeWakes({ wakes: 'not-an-array' }).wakes).toEqual([]);
  });

  it('carries staleness through so the chip can flip', () => {
    const out = normalizeWakes({ source: 'stale', stale_since: 1234, wakes: [], error: 'daemon unreachable' });
    expect(out.source).toBe('stale');
    expect(out.staleSince).toBe(1234);
    expect(out.error).toBe('daemon unreachable');
  });
});


describe('wakeActionMessage', () => {
  it('never reports a 202 as plain success — the wake is still running', () => {
    expect(wakeActionMessage('run', { ok: true, started: true, pid: 4242 })).toBe(
      'started (pid 4242) — outcome in the list',
    );
  });

  it('carries the daemon reason on a refusal, with the exit code when there is one', () => {
    expect(wakeActionMessage('run', { ok: false, detail: 'already running' })).toBe(
      'run failed: already running',
    );
    expect(wakeActionMessage('run', { ok: false, detail: 'awrise run exited 3', exitCode: 3 })).toBe(
      'run failed: awrise run exited 3 (exit 3)',
    );
    expect(wakeActionMessage('disable', { ok: false, detail: 'awrise not installed' })).toBe(
      'disable failed: awrise not installed',
    );
  });

  it('says something for every shape — a silent button looks broken', () => {
    expect(wakeActionMessage('disable', { ok: true, detail: 'nightly-sync: disabled' })).toBe(
      'disable: nightly-sync: disabled',
    );
    expect(wakeActionMessage('enable', true)).toBe('enable: ok');
    expect(wakeActionMessage('enable', false)).toBe('enable: refused');
    expect(wakeActionMessage('enable', null)).toBe('enable: no answer from the desk');
  });
});
