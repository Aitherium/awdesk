import { describe, expect, it } from 'vitest';

import type { DeckDecision } from './deck-types';
import {
  agoLabel,
  baseName,
  endedSessionIds,
  isLongText,
  linkTokens,
  parseBlocks,
  parseInline,
  replyEffectLine,
  sessionPill,
  sessionRowTitle,
  sessionStatusLine,
  splitTableRow,
  stripSessionTitle,
} from './session-text';
import { normalizeSessionResult } from './session-context';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const DAY_MS = 86_400_000;

describe('linkTokens', () => {
  it('turns a d-xxxx card id into a card token, leaving the words around it', () => {
    expect(linkTokens('see d-1a2b for the rest')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'card', text: 'd-1a2b', id: 'd-1a2b' },
      { kind: 'text', text: ' for the rest' },
    ]);
  });

  it('does not take a d-id out of the middle of a word or a longer token', () => {
    for (const text of ['odd-abcd', 'd-abcde', 'd-ABCD', 'x_d-abcd', 'd-ab-cd']) {
      expect(linkTokens(text).some((t) => t.kind === 'card'), text).toBe(false);
    }
  });

  it('links owner/repo#123 to that repo\'s pull request', () => {
    const tokens = linkTokens('merged Aitherium/awdesk#42 today');
    expect(tokens[1]).toEqual({
      kind: 'url',
      text: 'Aitherium/awdesk#42',
      url: 'https://github.com/Aitherium/awdesk/pull/42',
    });
  });

  it('links a bare #NNNN only when the session has a repo', () => {
    expect(linkTokens('PR #15146 is open', 'Aitherium/AitherOS')[1]).toEqual({
      kind: 'url',
      text: '#15146',
      url: 'https://github.com/Aitherium/AitherOS/pull/15146',
    });
    expect(linkTokens('PR #15146 is open')).toEqual([{ kind: 'text', text: 'PR #15146 is open' }]);
    expect(linkTokens('PR #15146 is open', 'not a repo')).toEqual([{ kind: 'text', text: 'PR #15146 is open' }]);
  });

  it('leaves short numbers, mid-word hashes and HTML entities alone', () => {
    for (const text of ['item #12', 'abc#12345', '&#12345;', 'src/a/b#12345', '#1234567']) {
      expect(linkTokens(text, 'o/r').every((t) => t.kind === 'text'), text).toBe(true);
    }
  });

  it('links URLs and keeps sentence punctuation outside them', () => {
    expect(linkTokens('read https://aitherium.com/blog/x. then')).toEqual([
      { kind: 'text', text: 'read ' },
      { kind: 'url', text: 'https://aitherium.com/blog/x', url: 'https://aitherium.com/blog/x' },
      { kind: 'text', text: '. then' },
    ]);
    expect(linkTokens('(see https://en.wikipedia.org/wiki/Foo_(bar))')[1]).toEqual({
      kind: 'url',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });

  it('keeps a URL whole when it contains a #number or a d-id', () => {
    const url = 'https://github.com/Aitherium/AitherOS/pull/15146#issuecomment-1';
    expect(linkTokens(url, 'Aitherium/AitherOS')).toEqual([{ kind: 'url', text: url, url }]);
    expect(linkTokens('http://x.test/d-abcd')).toEqual([
      { kind: 'url', text: 'http://x.test/d-abcd', url: 'http://x.test/d-abcd' },
    ]);
  });

  it('never makes a link out of a non-http scheme', () => {
    const tokens = linkTokens('javascript:alert(1) file:///etc/passwd');
    expect(tokens).toEqual([{ kind: 'text', text: 'javascript:alert(1) file:///etc/passwd' }]);
  });

  it('keeps <script> as plain text', () => {
    const text = '<script>alert("x")</script> d-ab12';
    const tokens = linkTokens(text);
    expect(tokens[0]).toEqual({ kind: 'text', text: '<script>alert("x")</script> ' });
    expect(tokens.map((t) => t.text).join('')).toBe(text);
  });

  it('is lossless: the tokens put back together are the input', () => {
    const text = 'a d-1a2b b o/r#1 c #12345 d https://x.test/y). e';
    expect(linkTokens(text, 'o/r').map((t) => t.text).join('')).toBe(text);
  });
});

describe('parseInline', () => {
  it('splits code, bold and markdown links; code wins over bold', () => {
    expect(parseInline('run `a **b**` then **ship** [PR](https://x.test/1)')).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'a **b**' },
      { type: 'text', text: ' then ' },
      { type: 'bold', text: 'ship' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'PR', url: 'https://x.test/1' },
    ]);
  });

  it('does not treat a non-http markdown link as a link', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ type: 'text', text: '[x](javascript:alert(1))' }]);
  });
});

describe('parseBlocks', () => {
  it('splits paragraphs, headings, bullets and numbered lists', () => {
    const blocks = parseBlocks('## Done\nFirst line\nsecond line\n\n- one\n- two\n  continued\n\n1. a\n2) b');
    expect(blocks).toEqual([
      { type: 'h', text: 'Done' },
      { type: 'p', text: 'First line\nsecond line' },
      { type: 'list', ordered: false, items: ['one', 'two continued'] },
      { type: 'list', ordered: true, items: ['a', 'b'] },
    ]);
  });

  it('renders a pipe table with a header row and pads short rows', () => {
    const blocks = parseBlocks('Status:\n| PR | State |\n|---|:---:|\n| #1 | merged |\n| #2 |\nafter');
    expect(blocks).toEqual([
      { type: 'p', text: 'Status:' },
      { type: 'table', header: ['PR', 'State'], rows: [['#1', 'merged'], ['#2', '']] },
      { type: 'p', text: 'after' },
    ]);
  });

  it('needs the separator row: pipes in prose are not a table', () => {
    expect(parseBlocks('a | b\nc | d')).toEqual([{ type: 'p', text: 'a | b\nc | d' }]);
  });

  it('keeps fenced code verbatim and drops horizontal rules', () => {
    expect(parseBlocks('```ts\nconst a = 1;\n- not a list\n```\n---\nend')).toEqual([
      { type: 'pre', text: 'const a = 1;\n- not a list' },
      { type: 'p', text: 'end' },
    ]);
  });

  it('does not read #12345 at a line start as a heading', () => {
    expect(parseBlocks('#15146 merged')).toEqual([{ type: 'p', text: '#15146 merged' }]);
  });

  it('splits a row on unescaped pipes only', () => {
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('never loses text: CRLF and stray markup survive as paragraphs', () => {
    expect(parseBlocks('<b>hi</b>\r\nthere')).toEqual([{ type: 'p', text: '<b>hi</b>\nthere' }]);
  });
});

describe('isLongText', () => {
  it('is long past N lines or N lines worth of characters', () => {
    expect(isLongText('a\nb', 2)).toBe(false);
    expect(isLongText('a\nb\nc', 2)).toBe(true);
    expect(isLongText('x'.repeat(300), 2)).toBe(true);
  });
});

describe('session titles', () => {
  it('strips "Claude Code needs you: <project> — " down to the session title', () => {
    expect(stripSessionTitle('Claude Code needs you: AitherOS-Fresh — Desktop canvas layout')).toBe('Desktop canvas layout');
    expect(stripSessionTitle('Claude Code needs you: AitherOS-Fresh -- Desktop canvas layout')).toBe('Desktop canvas layout');
    expect(stripSessionTitle('Claude Code needs you: AitherOS-Fresh - Fix the build')).toBe('Fix the build');
  });

  it('keeps every word when there is no project segment', () => {
    expect(stripSessionTitle('Claude Code needs you: Desktop canvas layout')).toBe('Desktop canvas layout');
  });

  it('leaves a title without the prefix untouched', () => {
    expect(stripSessionTitle('Approve the merge — #15146')).toBe('Approve the merge — #15146');
  });

  it('never returns an empty title', () => {
    expect(stripSessionTitle('Claude Code needs you: ')).toBe('Claude Code needs you: ');
  });

  it('prefers the session name main sent', () => {
    const card = { title: 'Claude Code needs you: X — Y', session: { live: true, status: 'idle', name: 'Real name' } };
    expect(sessionRowTitle(card)).toBe('Real name');
    expect(sessionRowTitle({ ...card, session: { ...card.session, name: '  ' } })).toBe('Y');
    expect(sessionRowTitle({ title: card.title })).toBe('Y');
  });
});

describe('session state lines', () => {
  it('pill: live / working / ended / none', () => {
    expect(sessionPill({ live: true, status: 'idle', name: '' })).toBe('live');
    expect(sessionPill({ live: true, status: 'busy', name: '' })).toBe('working');
    expect(sessionPill({ live: false, status: '', name: '' })).toBe('ended');
    expect(sessionPill(undefined)).toBeNull();
  });

  it('status line names the state and, when ended, how long ago', () => {
    expect(sessionStatusLine({ status: 'idle' }, 0, NOW)).toBe('Live · waiting for you');
    expect(sessionStatusLine({ status: 'busy' }, 0, NOW)).toBe('Live · working');
    expect(sessionStatusLine(null, NOW - 6 * DAY_MS - 1000, NOW)).toBe('Ended · last active 6 d ago');
    expect(sessionStatusLine(null, 0, NOW)).toBe('Ended');
  });

  it('ago labels', () => {
    expect(agoLabel(NOW - 5_000, NOW)).toBe('just now');
    expect(agoLabel(NOW - 12 * 60_000, NOW)).toBe('12 min ago');
    expect(agoLabel(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(agoLabel(0, NOW)).toBe('');
  });

  it('reply effect says what Send will do', () => {
    expect(replyEffectLine(true)).toMatch(/^Queued: it reads this at its next prompt/);
    expect(replyEffectLine(false)).toBe('Resumes it in a new terminal tab with your message.');
    expect(replyEffectLine(null)).toMatch(/Queued if the session is live/);
  });

  it('ended ids are only the cards main marked live === false', () => {
    const cards: Array<Pick<DeckDecision, 'id' | 'session'>> = [
      { id: 'd-0001', session: { live: false, status: '', name: '' } },
      { id: 'd-0002', session: { live: true, status: 'idle', name: '' } },
      { id: 'd-0003' },
    ];
    expect(endedSessionIds(cards)).toEqual(['d-0001']);
  });

  it('baseName handles both separators', () => {
    expect(baseName('D:\\desk\\src\\components\\Deck.tsx')).toBe('Deck.tsx');
    expect(baseName('/app/lib/x.py')).toBe('x.py');
  });
});

describe('normalizeSessionResult', () => {
  it('passes an error through with its sentence', () => {
    expect(normalizeSessionResult({ ok: false, error: 'no transcript' })).toEqual({ ok: false, error: 'no transcript' });
    expect(normalizeSessionResult(null)).toEqual({ ok: false, error: 'The desk sent no session.' });
  });

  it('degrades malformed fields to empty instead of throwing', () => {
    const result = normalizeSessionResult({ ok: true, live: 'yes', turns: [{ role: 'x', text: 'hi', at: 1 }, 5], files: [1, 'a.ts'] });
    expect(result).toMatchObject({ ok: true, live: null, name: '', files: ['a.ts'], turns: [{ role: 'assistant', text: 'hi', at: 1 }] });
  });
});
