import { describe, expect, it } from 'vitest';

import {
  atlasViewFromAnswer,
  normalizeAtlasBoard,
  timestampSeconds,
  webUrl,
} from './atlas-view';

/**
 * The Atlas board is a gateway snapshot whose fields are not guaranteed: these
 * pin the degradation rules (missing counts, missing rows, a PR that is a bare
 * number, an epoch-seconds vs ISO timestamp) so the section never crashes on a
 * board the platform will evolve.
 */

const NOW = Date.parse('2026-11-09T12:00:00Z');

const BOARD = {
  counts: { triage: 2, progress: 1 },
  rows: [
    {
      number: 15130,
      stage: 'progress',
      title: 'Browser links keep focus',
      updated_at: '2026-11-06T12:00:00Z',
      pr: 'https://github.com/Aitherium/AitherOS/pull/15130',
      thread: 'https://github.com/Aitherium/AitherOS/issues/15130',
    },
    {
      number: 15146,
      stage: 'triage',
      opened_at: NOW / 1000 - 2 * 3600,
      pr: 15146,
    },
  ],
  metrics: { open: 3 },
  text: '3 open · 1 in progress',
  message_id: 'msg-1',
  updated_at: '2026-11-09T11:55:00Z',
};

describe('normalizeAtlasBoard', () => {
  it('carries counts, rows, links and the board age', () => {
    const view = normalizeAtlasBoard(BOARD, NOW);
    expect(view.ok).toBe(true);
    expect(view.counts).toEqual([
      { stage: 'triage', count: 2 },
      { stage: 'progress', count: 1 },
    ]);
    expect(view.rows).toHaveLength(2);
    const [first, second] = view.rows;
    expect(first.number).toBe('#15130');
    expect(first.stage).toBe('progress');
    expect(first.age).toBe('3d');
    expect(first.ageTitle).toBe('updated 3d ago');
    expect(first.prUrl).toBe('https://github.com/Aitherium/AitherOS/pull/15130');
    expect(first.prLabel).toBe('#15130');
    expect(first.threadUrl).toBe('https://github.com/Aitherium/AitherOS/issues/15130');
    // a bare PR number is not a link -- never a guessed repo
    expect(second.prUrl).toBe('');
    expect(second.threadUrl).toBe('');
    expect(second.age).toBe('2h');
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
  it('reads epoch seconds, epoch milliseconds and ISO strings', () => {
    expect(timestampSeconds('2026-11-09T12:00:00Z')).toBe(NOW / 1000);
    expect(timestampSeconds(NOW / 1000)).toBe(NOW / 1000);
    expect(timestampSeconds(NOW)).toBe(NOW / 1000);
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
