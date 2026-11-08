/**
 * Pure text helpers for the Inbox session panel (owner, 2026-11-08: "not enough
 * info, no easy way to interact or dive deeper or engage with those sessions").
 *
 * Everything here turns untrusted card / transcript text into a small TOKEN or
 * BLOCK tree that the renderer maps onto React nodes. Nothing produces HTML:
 * a `<script>` in a session's last message stays a run of text, because the
 * only output of these functions is strings in typed records.
 *
 * Kept free of React and of the bridge so vitest exercises exactly this logic.
 */

import type { DeckDecision } from './deck-types';

// ── Links ────────────────────────────────────────────────────────────────

/** One run of linkified text. A PR reference becomes a `url` token. */
export type LinkToken =
  | { kind: 'text'; text: string }
  | { kind: 'card'; text: string; id: string }
  | { kind: 'url'; text: string; url: string };

/**
 * The four link shapes, leftmost-first and in this precedence at one position:
 *   1. an http(s) URL (so a URL that CONTAINS "#1234" or "d-abcd" stays whole)
 *   2. owner/repo#123  -> that repo's pull request
 *   3. d-xxxx          -> a decision card id (focuses it in the Inbox)
 *   4. bare #12345     -> a PR in the session's own repo, when it has one
 * The look-behinds keep a mid-word or mid-path match out ("abc#1234",
 * "src/a/b#12", "&#12345;", "odd-abcd").
 */
const LINK_RE =
  /(https?:\/\/[^\s<>"'`]+)|(?<![\w./-])([A-Za-z0-9][\w.-]*\/[\w.-]+)#(\d{1,7})(?!\w)|(?<![\w-])(d-[a-z0-9]{4})(?![\w-])|(?<![\w/&#])#(\d{4,6})(?!\w)/g;

/** Trailing punctuation a sentence puts after a URL is not part of it. A closing
 *  bracket is kept only when the URL opened one ("...wiki/Foo_(bar)"). */
function splitUrlTail(raw: string): { url: string; tail: string } {
  let url = raw;
  let tail = '';
  for (;;) {
    const last = url.slice(-1);
    if (/[.,;:!?*'"]/.test(last)) {
      // fallthrough: always trailing
    } else if (last === ')' || last === ']' || last === '}' || last === '>') {
      const open = { ')': '(', ']': '[', '}': '{', '>': '<' }[last] as string;
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes <= opens) break;
    } else {
      break;
    }
    tail = last + tail;
    url = url.slice(0, -1);
  }
  return { url, tail };
}

/** Merge adjacent text runs so the renderer emits as few nodes as possible. */
function pushText(out: LinkToken[], text: string): void {
  if (!text) return;
  const prev = out[out.length - 1];
  if (prev && prev.kind === 'text') prev.text += text;
  else out.push({ kind: 'text', text });
}

/**
 * Split `text` into plain runs and links. `repo` ("owner/name") is the session's
 * own repository: without it a bare "#12345" stays plain text, because guessing
 * the repo would send the owner to somebody else's pull request.
 */
export function linkTokens(text: string, repo = ''): LinkToken[] {
  const source = String(text ?? '');
  const out: LinkToken[] = [];
  const homeRepo = /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
  let at = 0;
  LINK_RE.lastIndex = 0;
  for (let match = LINK_RE.exec(source); match; match = LINK_RE.exec(source)) {
    const [whole, url, slug, slugNumber, cardId, bareNumber] = match;
    pushText(out, source.slice(at, match.index));
    at = match.index + whole.length;
    if (url) {
      const split = splitUrlTail(url);
      if (split.url.length > 'https://'.length) out.push({ kind: 'url', text: split.url, url: split.url });
      else pushText(out, split.url);
      pushText(out, split.tail);
    } else if (slug) {
      out.push({ kind: 'url', text: whole, url: `https://github.com/${slug}/pull/${slugNumber}` });
    } else if (cardId) {
      out.push({ kind: 'card', text: whole, id: cardId });
    } else if (bareNumber && homeRepo) {
      out.push({ kind: 'url', text: whole, url: `https://github.com/${homeRepo}/pull/${bareNumber}` });
    } else {
      pushText(out, whole);
    }
  }
  pushText(out, source.slice(at));
  return out;
}

/** Only these schemes are ever handed to the browser. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(String(url ?? ''));
}

// ── Light markdown ───────────────────────────────────────────────────────

/** An inline run: plain, `code`, **bold**, or a [label](https://...) link. */
export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'link'; text: string; url: string };

const INLINE_RE = /`([^`\n]+)`|\*\*(?=\S)([^*\n]*?\S)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Code wins over bold (a `**` inside backticks is literal), left to right. */
export function parseInline(text: string): InlineNode[] {
  const source = String(text ?? '');
  const out: InlineNode[] = [];
  let at = 0;
  INLINE_RE.lastIndex = 0;
  for (let match = INLINE_RE.exec(source); match; match = INLINE_RE.exec(source)) {
    if (match.index > at) out.push({ type: 'text', text: source.slice(at, match.index) });
    at = match.index + match[0].length;
    if (match[1] !== undefined) out.push({ type: 'code', text: match[1] });
    else if (match[2] !== undefined) out.push({ type: 'bold', text: match[2] });
    else out.push({ type: 'link', text: match[3], url: match[4] });
  }
  if (at < source.length) out.push({ type: 'text', text: source.slice(at) });
  return out;
}

/** A block of light markdown. Paragraph text keeps its own line breaks. */
export type MdBlock =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'pre'; text: string };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*(?:([-*•+])|(\d{1,3})[.)])\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** "| a | b |" -> ["a", "b"]. An escaped pipe (\|) stays in its cell. */
export function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  if (head === undefined || sep === undefined) return false;
  // Both rows carry a pipe and the second is a GFM separator ("|---|:--:|"):
  // a lone "---" under a line is a rule / setext heading, never a table.
  if (!head.includes('|') || !sep.includes('|') || !sep.includes('-')) return false;
  return TABLE_SEP.test(sep);
}

/**
 * Split markdown into blocks: paragraphs, headings (shown bold), bullet / number
 * lists, GFM pipe tables (header row + separator row required) and fenced code.
 * Horizontal rules are dropped. Anything it does not recognise is a paragraph,
 * so no text is ever lost.
 */
export function parseBlocks(text: string): MdBlock[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join('\n') });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const fence = line.trim().slice(0, 3);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'pre', text: body.join('\n') });
      i += 1; // the closing fence (or past the end)
      continue;
    }
    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      flush();
      const header = splitTableRow(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitTableRow(lines[i]);
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, Math.max(header.length, 1)));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      i += 1;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ type: 'h', text: heading[1] });
      i += 1;
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      flush();
      const ordered = Boolean(item[2]);
      const items: string[] = [item[3]];
      i += 1;
      while (i < lines.length && lines[i].trim()) {
        const next = lines[i].match(ITEM);
        if (next) items.push(next[3]);
        else if (/^\s+\S/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    para.push(line.replace(/^\s*>\s?/, ''));
    i += 1;
  }
  flush();
  return blocks;
}

/** Long enough that it should start folded: more lines than `lines`, or about
 *  that many lines' worth of characters at the Inbox's measure. */
export function isLongText(text: string, lines: number): boolean {
  const source = String(text ?? '');
  return source.split('\n').length > lines || source.length > lines * 110;
}

// ── Session cards ────────────────────────────────────────────────────────

/** "Claude Code needs you: " (any harness name before "needs you:"). */
const NEEDS_YOU_PREFIX = /^\s*[^:\n]{1,40}?\bneeds you:\s*/i;

/**
 * The row title a session card should wear: "Claude Code needs you:
 * AitherOS-Fresh — Desktop canvas layout" -> "Desktop canvas layout". The
 * project segment is dropped only when a separator follows it, so a title with
 * no project ("... needs you: Desktop canvas layout") keeps every word.
 */
export function stripSessionTitle(title: string): string {
  const raw = String(title ?? '');
  if (!NEEDS_YOU_PREFIX.test(raw)) return raw;
  const rest = raw.replace(NEEDS_YOU_PREFIX, '');
  const project = rest.match(/^\S+\s+(?:—|–|--|-|·)\s+(.+)$/);
  const stripped = (project ? project[1] : rest).trim();
  return stripped || raw;
}

/** The session's own name when main knows it, else the stripped card title. */
export function sessionRowTitle(card: Pick<DeckDecision, 'title' | 'session'>): string {
  const name = card.session?.name?.trim();
  return name || stripSessionTitle(card.title);
}

export type SessionPillLabel = 'live' | 'working' | 'ended';

/** The list row's status pill: live (waiting at its prompt), working, ended. */
export function sessionPill(session: DeckDecision['session']): SessionPillLabel | null {
  if (!session) return null;
  if (!session.live) return 'ended';
  return session.status === 'busy' ? 'working' : 'live';
}

/** "just now" / "12 min ago" / "3 h ago" / "6 d ago" for a ms timestamp. */
export function agoLabel(atMs: number, nowMs: number): string {
  if (!Number.isFinite(atMs) || atMs <= 0) return '';
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The panel's status sentence. `live` null = the session is not running. */
export function sessionStatusLine(
  live: { status: string } | null,
  updatedAt: number,
  nowMs: number,
): string {
  if (live) {
    if (live.status === 'idle') return 'Live · waiting for you';
    if (live.status === 'busy') return 'Live · working';
    return live.status ? `Live · ${live.status}` : 'Live';
  }
  const ago = agoLabel(updatedAt, nowMs);
  return ago ? `Ended · last active ${ago}` : 'Ended';
}

/** What Send will actually do, said before it is pressed. null = not known yet. */
export function replyEffectLine(live: boolean | null): string {
  if (live === true) return 'Queued: it reads this at its next prompt. Go to it to see it act.';
  if (live === false) return 'Resumes it in a new terminal tab with your message.';
  return 'Queued if the session is live, or it resumes in a new terminal tab if it ended.';
}

/** Ids of the cards whose asking session has ended (main said live === false). */
export function endedSessionIds(cards: Array<Pick<DeckDecision, 'id' | 'session'>>): string[] {
  return cards.filter((card) => card.session?.live === false).map((card) => card.id);
}

/** "D:\\desk\\src\\a.ts" / "/x/y.ts" -> "a.ts" / "y.ts". */
export function baseName(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? String(path ?? '');
}
