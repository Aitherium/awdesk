import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DeckDecision } from '../deck/deck-types';
import {
  DeckLinks,
  clearSessionCache,
  loadSessionContext,
  peekSessionContext,
  type SessionContext,
} from '../deck/session-context';
import { LinkedText, Markdown, SessionPanel } from './SessionPanel';

/**
 * Render tests without a DOM: react-dom/server renders the panel from the 30 s
 * session cache, which the test primes through the REAL loader against a mocked
 * `window.deskBridge.deck` -- the same path the row takes when it opens.
 */

const NOW = Date.parse('2026-11-08T12:00:00Z');
const DAY_MS = 86_400_000;

function card(overrides: Partial<DeckDecision> = {}): DeckDecision {
  return {
    id: 'd-live',
    title: 'Claude Code needs you: AitherOS-Fresh — Desktop canvas layout',
    summary: 'Needs: a look. You asked: ... Claude last said: ...',
    urgency: 'normal',
    createdAt: NOW / 1000 - 600,
    options: [{ key: 'look', label: 'I am looking now', recommended: true }],
    defaultKey: 'look',
    tab: '',
    cwd: 'C:\\AitherOS-Fresh',
    agent: 'claude-code',
    sessionId: 'sess-1234567890',
    ...overrides,
  };
}

function context(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    ok: true,
    sessionId: 'sess-1234567890',
    name: 'Desktop canvas layout',
    live: { status: 'idle', pid: 4242, since: NOW - 3_600_000 },
    updatedAt: NOW - 60_000,
    firstAsk: 'Lay out the desktop canvas so panes snap to a grid.',
    lastAsk: 'Also fix the taskbar overlap.',
    lastSaid: 'Done. **Two** changes:\n\n- grid snap\n- taskbar inset\n\n| PR | State |\n|---|---|\n| #15146 | merged |',
    turns: [
      { role: 'user', text: 'Lay out the desktop canvas', at: NOW - 3_000_000 },
      { role: 'assistant', text: 'Working on it, see d-ab12', at: NOW - 2_000_000 },
    ],
    files: ['D:\\desk\\src\\components\\Deck.tsx', '/app/lib/x.py'],
    repo: 'Aitherium/AitherOS',
    transcript: 'C:\\Users\\me\\.claude\\projects\\x\\sess-1234567890.jsonl',
    ...overrides,
  };
}

const sessionMock = vi.fn();

beforeEach(() => {
  clearSessionCache();
  sessionMock.mockReset();
  (globalThis as unknown as { window: unknown }).window = {
    deskBridge: { deck: { session: sessionMock, sessionAct: vi.fn(), openUrl: vi.fn() } },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  clearSessionCache();
});

async function renderPanel(target: DeckDecision, answer: unknown): Promise<string> {
  sessionMock.mockResolvedValueOnce(answer);
  await loadSessionContext(target.id);
  return renderToStaticMarkup(<SessionPanel card={target} nowMs={NOW} />);
}

describe('SessionPanel', () => {
  it('a LIVE session: status, Go to it, what it said, and the queued-reply effect', async () => {
    const html = await renderPanel(card(), context());
    expect(sessionMock).toHaveBeenCalledWith('d-live');
    expect(html).toContain('Live · waiting for you');
    expect(html).toContain('Desktop canvas layout');
    expect(html).toContain('Go to it');
    expect(html).not.toContain('Resume');
    expect(html).toContain('Lay out the desktop canvas so panes snap to a grid.');
    expect(html).toContain('Also fix the taskbar overlap.');
    // light markdown: bold, bullets and a real table
    expect(html).toContain('<strong>Two</strong>');
    expect(html).toContain('<li>grid snap</li>');
    expect(html).toMatch(/<table class="deck-md-table">[\s\S]*<th>PR<\/th>/);
    // the reply box is always there, with the honest effect line
    expect(html).toContain('placeholder="Tell this session what to do…"');
    expect(html).toContain('Queued: it reads this at its next prompt. Go to it to see it act.');
    // files as chips (basename shown, full path in the title)
    expect(html).toContain('title="D:\\desk\\src\\components\\Deck.tsx"');
    expect(html).toContain('>Deck.tsx<');
    expect(html).toContain('Last 2 turns');
  });

  it('a busy live session reads "working"', async () => {
    const html = await renderPanel(card(), context({ live: { status: 'busy', pid: 1, since: NOW } }));
    expect(html).toContain('Live · working');
    expect(html).toContain('Go to it');
  });

  it('an ENDED session: last active, Resume, and the resume effect', async () => {
    const ended = card({ id: 'd-gone', session: { live: false, status: '', name: 'Old work' } });
    const html = await renderPanel(ended, context({ live: null, updatedAt: NOW - 6 * DAY_MS - 5_000 }));
    expect(html).toContain('Ended · last active 6 d ago');
    expect(html).toContain('Resume');
    expect(html).not.toContain('Go to it');
    expect(html).toContain('Resumes it in a new terminal tab with your message.');
  });

  it('a failed read is not cached; the panel falls back to the card\'s own session state', async () => {
    const target = card({ id: 'd-err1', session: { live: false, status: '', name: 'Old work' } });
    sessionMock.mockResolvedValueOnce({ ok: false, error: 'transcript not found' });
    const result = await loadSessionContext(target.id);
    expect(result).toEqual({ ok: false, error: 'transcript not found' });
    // errors are not cached: the next open asks again
    expect(peekSessionContext(target.id)).toBeNull();
    const html = renderToStaticMarkup(<SessionPanel card={target} nowMs={NOW} />);
    expect(html).toContain('Ended');
    expect(html).toContain('Resume');
    expect(html).toContain('Resumes it in a new terminal tab with your message.');
  });

  it('caches a session for 30 s per card', async () => {
    sessionMock.mockResolvedValue(context());
    await loadSessionContext('d-live', NOW);
    await loadSessionContext('d-live', NOW + 10_000);
    expect(sessionMock).toHaveBeenCalledTimes(1);
    expect(peekSessionContext('d-live', NOW + 29_000)).not.toBeNull();
    expect(peekSessionContext('d-live', NOW + 31_000)).toBeNull();
  });

  it('turns transcript HTML into text, never markup', async () => {
    const html = await renderPanel(card(), context({ lastSaid: '<script>alert(1)</script> **bold** <img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<strong>bold</strong>');
  });
});

describe('LinkedText', () => {
  const links = {
    repo: 'Aitherium/AitherOS',
    focusCard: () => {},
    hasCard: (id: string) => id === 'd-ab12',
    openUrl: () => {},
  };

  it('renders d-ids that are waiting as buttons, others as plain ids', () => {
    const html = renderToStaticMarkup(
      <DeckLinks.Provider value={links}>
        <LinkedText text="see d-ab12 and d-zz99" />
      </DeckLinks.Provider>,
    );
    expect(html).toMatch(/<button[^>]*title="Show card d-ab12 in the Inbox"[^>]*>d-ab12<\/button>/);
    expect(html).toMatch(/<span class="deck-inline-id"[^>]*>d-zz99<\/span>/);
  });

  it('renders PRs and URLs as buttons only when the desk can open them', () => {
    const withOpen = renderToStaticMarkup(
      <DeckLinks.Provider value={links}>
        <LinkedText text="PR #15146 and https://aitherium.com" />
      </DeckLinks.Provider>,
    );
    expect(withOpen).toContain('title="Open https://github.com/Aitherium/AitherOS/pull/15146 in Aither Browser"');
    expect(withOpen).toContain('title="Open https://aitherium.com in Aither Browser"');
    const without = renderToStaticMarkup(<LinkedText text="https://aitherium.com" />);
    expect(without).not.toContain('<button');
    expect(without).toContain('https://aitherium.com');
  });

  it('a session repo set by the panel reaches bare #NNNN inside Markdown', () => {
    const html = renderToStaticMarkup(
      <DeckLinks.Provider value={links}>
        <Markdown text={'| PR |\n|---|\n| #15146 |'} />
      </DeckLinks.Provider>,
    );
    expect(html).toContain('pull/15146');
  });

  it('keeps <script> as text', () => {
    const html = renderToStaticMarkup(<LinkedText text="<script>alert(1)</script>" />);
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
