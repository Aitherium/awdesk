import { describe, expect, it } from 'vitest';

import {
  atlasViewFromAnswer,
  normalizeAtlasBoard,
  timestampSeconds,
  webUrl,
} from './atlas-view';

/**
 * The Atlas board's real row shape (lib/automation/issue_board.py rows_for):
 *   {number:int, title, stage, detail, since:epoch_s, age_s:float seconds,
 *    pr: URL|"", thread: id, thread_url: URL|""}
 * counts = {stage: n} for EVERY stage (zeros included); updated_at is epoch
 * SECONDS (a float), not ISO. These pin that shape plus the degradation rules
 * for a board the platform will evolve.
 */

const NOW = Date.parse('2026-11-09T12:00:00Z');
const NOW_S = NOW / 1000;

const BOARD = {
  counts: { triage: 2, progress: 1, done: 0 },
  rows: [
    {
      number: 15130,
      title: 'Browser links keep focus',
      stage: 'progress',
      detail: 'PR open, waiting on review',
      since: NOW_S - 3 * 86400,
      age_s: 3 * 86400 + 600,
      pr: 'https://github.com/Aitherium/AitherOS/pull/15130',
      thread: 15130,
      thread_url: 'https://discord.com/channels/1/2/15130',
    },
    {
      number: 15146,
      title: 'Voice keepalive',
      stage: 'triage',
      detail: '',
      since: NOW_S - 2 * 3600,
      age_s: 2 * 3600,
      pr: '',
      thread: 15146,
      thread_url: '',
    },
  ],
  metrics: { open: 3 },
  text: '3 open · 1 in progress',
  message_id: 'msg-1',
  updated_at: NOW_S - 300,
};

describe('normalizeAtlasBoard', () => {
  it('carries counts (zeros included), rows, links and the board age', () => {
    const view = normalizeAtlasBoard(BOARD, NOW);
    expect(view.ok).toBe(true);
    expect(view.counts).toEqual([
      { stage: 'triage', count: 2 },
      { stage: 'progress', count: 1 },
      { stage: 'done', count: 0 },
    ]);
    expect(view.rows).toHaveLength(2);
    const [first, second] = view.rows;
    expect(first.number).toBe('#15130');
    expect(first.title).toBe('Browser links keep focus');
    expect(first.detail).toBe('PR open, waiting on review');
    expect(first.stage).toBe('progress');
    // age_s is authoritative: 3d 10m rounds down to the same day label.
    expect(first.age).toBe('3d');
    expect(first.ageTitle).toBe('3d at this stage');
    expect(first.prUrl).toBe('https://github.com/Aitherium/AitherOS/pull/15130');
    expect(first.prLabel).toBe('#15130');
    // thread is only the id; thread_url is the link.
    expect(first.threadUrl).toBe('https://discord.com/channels/1/2/15130');
    expect(second.age).toBe('2h');
    expect(second.ageTitle).toBe('2h at this stage');
    expect(second.prUrl).toBe('');
    expect(second.threadUrl).toBe('');
    // updated_at is epoch seconds: 5 minutes ago.
    expect(view.updated).toBe('5m');
    expect(view.text).toBe('3 open · 1 in progress');
    expect(view.messageId).toBe('msg-1');
  });

  it('accepts the {ok:true, board} envelope main serves', () => {
    const view = normalizeAtlasBoard({ ok: true, board: BOARD }, NOW);
    expect(view.rows).toHaveLength(2);
    expect(view.counts[0].stage).toBe('triage');
  });

  it('accepts an array of counts and derives counts when absent', () => {
    const arrayed = normalizeAtlasBoard(
      { counts: [{ stage: 'triage', count: 4 }], rows: [] },
      NOW,
    );
    expect(arrayed.counts).toEqual([{ stage: 'triage', count: 4 }]);

    const derived = normalizeAtlasBoard({ rows: BOARD.rows }, NOW);
    expect(derived.counts).toEqual([
      { stage: 'progress', count: 1 },
      { stage: 'triage', count: 1 },
    ]);
  });

  it('falls back to since (epoch seconds) when age_s is absent', () => {
    const view = normalizeAtlasBoard(
      { rows: [{ number: 1, stage: 'triage', since: NOW_S - 7200 }] },
      NOW,
    );
    expect(view.rows[0].age).toBe('2h');
    expect(view.rows[0].ageTitle).toBe('2h ago in this stage');
  });

  it('reads age_s 0 as just now and ignores a null age_s', () => {
    const zero = normalizeAtlasBoard({ rows: [{ number: 1, stage: 'done', age_s: 0 }] }, NOW);
    expect(zero.rows[0].age).toBe('just now');
    const nulled = normalizeAtlasBoard(
      { rows: [{ number: 2, stage: 'done', age_s: null, ageSeconds: null }] },
      NOW,
    );
    expect(nulled.rows[0].age).toBe('');
  });

  it('an empty or unknown board is an empty view, not a throw', () => {
    for (const raw of [null, undefined, {}, { rows: 'nope' }, { rows: [null, 7] }]) {
      const view = normalizeAtlasBoard(raw, NOW);
      expect(view.ok).toBe(true);
      expect(view.rows).toEqual([]);
      expect(view.counts).toEqual([]);
      expect(view.updated).toBe('');
    }
  });
});

describe('atlasViewFromAnswer', () => {
  it('turns an error answer into the unavailable state', () => {
    const view = atlasViewFromAnswer({ ok: false, error: 'atlas_board: unknown tool' }, NOW);
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error).toMatch(/unknown tool/);
  });

  it('keeps a reason when the answer carries none', () => {
    const view = atlasViewFromAnswer({ ok: false }, NOW);
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error).toBe('Atlas is unavailable.');
  });

  it('normalizes a success answer', () => {
    const view = atlasViewFromAnswer({ ok: true, board: BOARD }, NOW);
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.rows).toHaveLength(2);
  });

  it('survives a bridge that answers nothing', () => {
    expect(atlasViewFromAnswer(null, NOW).ok).toBe(false);
    expect(atlasViewFromAnswer('boom', NOW).ok).toBe(false);
  });
});

describe('timestamps and links', () => {
  it('reads epoch seconds (incl. floats), epoch milliseconds and ISO strings', () => {
    expect(timestampSeconds(NOW_S - 0.75)).toBe(NOW_S - 1);
    expect(timestampSeconds('2026-11-09T12:00:00Z')).toBe(NOW_S);
    expect(timestampSeconds(NOW)).toBe(NOW_S);
    expect(timestampSeconds('nope')).toBeNull();
    expect(timestampSeconds(-5)).toBeNull();
  });

  it('only http(s) links render', () => {
    expect(webUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(webUrl({ html_url: 'https://example.com/y' })).toBe('https://example.com/y');
    expect(webUrl('javascript:alert(1)')).toBe('');
    expect(webUrl(15130)).toBe('');
    expect(webUrl(undefined)).toBe('');
  });
});
