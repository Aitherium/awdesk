import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DeckDecision } from '../deck/deck-types';
import { clearSessionCache } from '../deck/session-context';
import { DecisionRow, NeedsYouSection } from './Deck';

/**
 * The Inbox wiring around the session panel, rendered without a DOM: list rows
 * (session title + status pill), the "from ended sessions" chip on Blocked on
 * you, and which body an expanded card gets (session panel vs facts / More /
 * consequences / Something else).
 */

const NOW = Date.parse('2026-11-08T12:00:00Z');

function card(overrides: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id: 'd-0001',
    title: 'Claude Code needs you: AitherOS-Fresh — Desktop canvas layout',
    summary: 'Needs: a look. You asked: <teammate-message>{"x":1}</teammate-message>',
    kind: 'blocked',
    urgency: 'normal',
    createdAt: NOW / 1000 - 600,
    options: [
      { key: 'look', label: 'I am looking now', recommended: true },
      { key: 'later', label: 'Later', recommended: false },
    ],
    defaultKey: 'look',
    tab: '',
    cwd: 'C:\\AitherOS-Fresh',
    agent: 'claude-code',
    ...overrides,
  };
}

function setBridge(withSession: boolean): void {
  (globalThis as unknown as { window: unknown }).window = {
    deskBridge: {
      deck: withSession
        ? { session: vi.fn().mockResolvedValue({ ok: false, error: 'x' }), sessionAct: vi.fn(), openUrl: vi.fn() }
        : {},
    },
  };
}

beforeEach(() => {
  clearSessionCache();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

function section(cards: DeckDecision[]): string {
  return renderToStaticMarkup(
    <NeedsYouSection
      cards={cards}
      fyi={[]}
      openCount={cards.length}
      nowMs={NOW}
      onAnswer={() => {}}
      onPopout={() => {}}
      onPopupAll={() => {}}
    />,
  );
}

describe('Needs you rows', () => {
  it('titles a session card by its session and swaps the source label for a status pill', () => {
    setBridge(true);
    const html = section([
      card({ id: 'd-0001', sessionId: 's1', session: { live: true, status: 'idle', name: '' } }),
      card({ id: 'd-0002', sessionId: 's2', session: { live: true, status: 'busy', name: 'Fix the taskbar' } }),
      card({ id: 'd-0003', sessionId: 's3', session: { live: false, status: '', name: '' } }),
    ]);
    expect(html).toContain('<span class="deck-ny-title">Desktop canvas layout</span>');
    expect(html).toContain('<span class="deck-ny-title">Fix the taskbar</span>');
    expect(html).not.toContain('<span class="deck-ny-title">Claude Code needs you');
    expect(html).toMatch(/deck-session-pill-live[^>]*>live</);
    expect(html).toMatch(/deck-session-pill-working[^>]*>working</);
    expect(html).toMatch(/deck-session-pill-ended[^>]*>ended</);
    expect(html).not.toContain('class="deck-ny-source"');
  });

  it('offers to close the Blocked cards whose session ended, counting only those', () => {
    setBridge(true);
    const html = section([
      card({ id: 'd-0001', sessionId: 's1', session: { live: false, status: '', name: '' } }),
      card({ id: 'd-0002', sessionId: 's2', session: { live: false, status: '', name: '' } }),
      card({ id: 'd-0003', sessionId: 's3', session: { live: true, status: 'idle', name: '' } }),
    ]);
    expect(html).toContain('2 from ended sessions — close them');
  });

  it('no chip when every session is live; older mains (no session field) keep the source label', () => {
    setBridge(false);
    const html = section([card({ id: 'd-0001', sessionId: 's1' })]);
    expect(html).not.toContain('from ended session');
    expect(html).toContain('<span class="deck-ny-source">claude-code</span>');
    // the title is still stripped: it is the same session card
    expect(html).toContain('<span class="deck-ny-title">Desktop canvas layout</span>');
  });
});

describe('DecisionRow', () => {
  it('a session card gets the session panel first, the raw blob folded, and no "Something else…"', () => {
    setBridge(true);
    const html = renderToStaticMarkup(
      <DecisionRow card={card({ sessionId: 's1', session: { live: true, status: 'idle', name: 'Desktop canvas layout' } })} nowMs={NOW} onAnswer={() => {}} />,
    );
    const panelAt = html.indexOf('aria-label="Session"');
    const optionAt = html.indexOf('1. I am looking now');
    expect(panelAt).toBeGreaterThan(-1);
    expect(optionAt).toBeGreaterThan(panelAt);
    expect(html).toContain('<summary>Raw card text</summary>');
    expect(html).toContain('&lt;teammate-message&gt;');
    expect(html).not.toContain('<teammate-message');
    expect(html).not.toContain('Something else…');
    expect(html).toContain('placeholder="Tell this session what to do…"');
    expect(html).not.toContain('class="deck-card-summary');
  });

  it('a session card on an OLD main (no deck.session) renders the plain card', () => {
    setBridge(false);
    const html = renderToStaticMarkup(
      <DecisionRow card={card({ sessionId: 's1' })} nowMs={NOW} onAnswer={() => {}} />,
    );
    expect(html).not.toContain('aria-label="Session"');
    expect(html).toContain('class="deck-card-summary"');
    expect(html).toContain('Something else…');
  });

  it('a non-session card shows facts, a folded More, and what each option does', () => {
    setBridge(true);
    const html = renderToStaticMarkup(
      <DecisionRow
        card={card({
          kind: 'decision',
          facts: ['3 failures since Nov 6', 'last: exit 1'],
          detail: 'The job **awrise-sync** has failed.\n\n- step one',
          options: [
            { key: 'disable', label: 'Disable this wake', recommended: true, consequence: 'Runs awrise disable --name sync' },
            { key: 'keep', label: 'Keep it', recommended: false },
          ],
          defaultKey: 'disable',
        })}
        nowMs={NOW}
        onAnswer={() => {}}
      />,
    );
    expect(html).toContain('<li>3 failures since Nov 6</li>');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('<strong>awrise-sync</strong>');
    expect(html).toMatch(/1\. Disable this wake<\/span><span class="deck-card-consequence-text">Runs awrise disable --name sync/);
    expect(html).toContain('Something else…');
    expect(html).not.toContain('aria-label="Session"');
  });

  it('a credential card never gets the session panel, even with a sessionId', () => {
    setBridge(true);
    const html = renderToStaticMarkup(
      <DecisionRow card={card({ kind: 'credential', sessionId: 's1', secretName: 'API_TOKEN' })} nowMs={NOW} onAnswer={() => {}} />,
    );
    expect(html).not.toContain('aria-label="Session"');
    expect(html).toContain('Store in vault');
  });
});
