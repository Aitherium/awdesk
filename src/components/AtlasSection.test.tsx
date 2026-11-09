import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { atlasViewFromAnswer } from '../deck/atlas-view';
import { AtlasBoardView } from './AtlasSection';

/**
 * The Atlas section, rendered without a DOM (the same react-dom/server path
 * the other Deck section tests take): stage counts, a row with a PR and a
 * thread link, the board's own timestamp, the digest verb, and the clean
 * unavailable state an undeployed gateway tool produces.
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
  ],
  text: '3 open · 1 in progress',
  message_id: 'msg-1',
  updated_at: '2026-11-09T11:55:00Z',
};

function render(overrides: Partial<Parameters<typeof AtlasBoardView>[0]> = {}): string {
  return renderToStaticMarkup(
    <AtlasBoardView
      view={atlasViewFromAnswer({ ok: true, board: BOARD }, NOW)}
      busy={false}
      digestBusy={false}
      digestNote=""
      onRefresh={vi.fn()}
      onDigest={vi.fn()}
      onOpen={vi.fn()}
      {...overrides}
    />,
  );
}

describe('AtlasBoardView', () => {
  it('renders the section, stage counts and the board total', () => {
    const html = render();
    expect(html).toContain('aria-label="Atlas"');
    expect(html).toContain('<strong>2</strong> triage');
    expect(html).toContain('<strong>1</strong> progress');
    expect(html).toContain('deck-section-count">3<');
  });

  it('renders each row with its number, stage, age and both links', () => {
    const html = render();
    expect(html).toContain('#15130');
    expect(html).toContain('Browser links keep focus');
    expect(html).toContain('progress');
    expect(html).toContain('>3d<');
    expect(html).toContain('href="https://github.com/Aitherium/AitherOS/pull/15130"');
    expect(html).toContain('PR #15130');
    expect(html).toContain('href="https://github.com/Aitherium/AitherOS/issues/15130"');
    expect(html).toContain('thread');
  });

  it('shows the board timestamp, the folded digest text and the digest button', () => {
    const html = render();
    expect(html).toContain('Board updated 5m ago');
    expect(html).toContain('Last digest');
    expect(html).toContain('Send digest now');
  });

  it('says sending while a digest is in flight, then renders feedback', () => {
    const busy = render({ digestBusy: true, digestNote: 'sending…' });
    expect(busy).toContain('Sending…');
    expect(busy).not.toContain('Send digest now');
    const done = render({ digestNote: 'digest sent (msg-2)' });
    expect(done).toContain('digest sent (msg-2)');
  });

  it('renders the undeployed-tool error as a clean unavailable state', () => {
    const html = render({
      view: atlasViewFromAnswer({ ok: false, error: 'atlas_board: unknown tool' }, NOW),
    });
    expect(html).toContain('Atlas unavailable');
    expect(html).toContain('atlas_board: unknown tool');
    expect(html).not.toContain('Send digest now');
  });

  it('renders an empty board without inventing rows', () => {
    const html = render({ view: atlasViewFromAnswer({ ok: true, board: {} }, NOW) });
    expect(html).toContain('No stage counts on the board.');
    expect(html).toContain('No Atlas work on the board.');
    expect(html).toContain('Board has no timestamp');
  });

  it('renders the loading state before the first answer', () => {
    expect(render({ view: null })).toContain('Reading the board…');
  });
});
