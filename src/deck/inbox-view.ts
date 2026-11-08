/**
 * The Inbox's triage view — pure functions that turn the deck feed into the
 * four questions the owner reads top to bottom (redesign 2026-10-28, owner
 * screenshots: "1 of 122", ~60 green wake cards, raw exception text):
 *
 *   1. Needs you  — decisions grouped by kind, stale ones folded away;
 *   2. Broken     — only the failing wakes; the healthy ones are ONE line;
 *   3. Agents     — the relay, requests/alerts pinned above findings/acks;
 *   4. System     — only what is degraded, said as a human state.
 *
 * No React here: every rule the view applies has a vitest arm.
 */
import {
  primaryChoice,
  reasonLabel,
  transportNote,
  type DeckDecision,
  type RelayRow,
  type WakeInvestigateResult,
  type WakeRow,
  type WakesFeed,
} from './deck-types';

/** How many rows a group shows before "N more" takes over. PRESENTATION only:
 *  the rest stay behind the fold, reachable, never dropped. */
export const VISIBLE_CAP = 5;

/**
 * The first `cap` items plus how many were withheld. One rule for every list on
 * the desk, so "5 visible, N more" is the same shape in Needs you, FYI and the
 * terminal strip — and a caller can never silently lose a row by slicing.
 */
export function capList<T>(items: T[], cap = VISIBLE_CAP): { shown: T[]; more: number } {
  const list = items || [];
  const limit = Number.isFinite(cap) && cap >= 0 ? cap : VISIBLE_CAP;
  return list.length <= limit
    ? { shown: list.slice(), more: 0 }
    : { shown: list.slice(0, limit), more: list.length - limit };
}

/** "Claude Code needs you: AitherOS-Fresh -- " -- the session-status wrapper. */
const SESSION_STATUS_TITLE = /^\s*[\w .+()-]{1,40}? needs you:\s*/i;
const SESSION_PROJECT = /^\S{1,80}\s+(?:--|—|–)(?:\s+|$)/;

/**
 * A session-status card: a terminal session saying "I am waiting on you" (the
 * cc-waiting hook; title "Claude Code needs you: <project> -- <ask>", answer
 * "I am looking now"). Answering it unblocks nothing by itself -- the owner
 * still has to go to that terminal -- so it never outranks a card whose answer
 * IS the unblock.
 */
export function isSessionStatus(card: DeckDecision): boolean {
  if (String(card.dedupeKey || '').startsWith('cc-waiting:')) return true;
  return SESSION_STATUS_TITLE.test(String(card.title || ''));
}

/**
 * The ask in plain words, the session wrapper and the verb taken off:
 * "Claude Code needs you: AitherOS-Fresh -- Good faith extension terms" reads
 * "Good faith extension terms — a session needs your answer". The action is
 * the BUTTON's job (owner screenshot 2026-11-01: "I am looking now: Claude Code
 * needs you: …" on the Next line was unreadable).
 */
export function plainAsk(card: DeckDecision): string {
  const title = String(card.title || '').replace(/\s+/g, ' ').trim();
  if (!isSessionStatus(card)) return title || 'Answer this card';
  const ask = title.replace(SESSION_STATUS_TITLE, '').replace(SESSION_PROJECT, '').trim();
  return `${ask || 'A session is waiting'} — a session needs your answer`;
}

/**
 * What goes FIRST: credentials (a typed value unblocks a stopped session), then
 * the decisions whose answer is the unblock, then session-status pings. Stable:
 * inside a tier main's rank order is kept. Every surface that leads with "the
 * next one" (the Next line, Now mode) reads this ONE order.
 */
export function nextOrder(cards: DeckDecision[]): DeckDecision[] {
  const tier = (c: DeckDecision) => (c.kind === 'credential' ? 0 : isSessionStatus(c) ? 2 : 1);
  return (cards || [])
    .map((card, at) => ({ card, at, tier: tier(card) }))
    .sort((a, b) => a.tier - b.tier || a.at - b.at)
    .map((x) => x.card);
}

/**
 * THE next action -- the plain ask of the top card (nextOrder), how much sits
 * behind it, and the choice its button answers. Every surface that shows a list
 * leads with this, so the owner never has to scan to find where to start. The
 * line never carries the verb: the button says it. A credential has no button
 * answer (its value is typed), so `choice` is null there.
 */
export function nextActionLine(
  cards: DeckDecision[],
  openCount: number,
): { id: string; line: string; after: string; choice: { key: string; label: string } | null } | null {
  const first = nextOrder(cards)[0];
  if (!first) return null;
  const line = plainAsk(first);
  const open = Number.isFinite(openCount) ? openCount : cards.length;
  const remaining = Math.max(0, open - 1);
  return {
    id: first.id,
    line: line.length > 120 ? `${line.slice(0, 119)}…` : line,
    after: remaining > 0 ? `${remaining} after this one` : 'nothing after this one',
    choice: first.kind === 'credential' ? null : primaryChoice(first),
  };
}

export type DecisionGroupKey = 'credential' | 'blocked' | 'approve' | 'choose';

export const DECISION_GROUP_LABELS: Record<DecisionGroupKey, string> = {
  credential: 'Credentials',
  blocked: 'Blocked on you',
  approve: 'Approve',
  choose: 'Choose',
};

const GROUP_ORDER: DecisionGroupKey[] = ['credential', 'blocked', 'approve', 'choose'];

/** A card older than this folds into "Older than 7 days" — still open, never hidden. */
export const STALE_DECISION_DAYS = 7;

const APPROVE_KINDS = new Set(['approve', 'approval', 'destructive', 'confirm', 'permission']);
const YES_WORDS = /^(approve|approved|yes|ok|allow|go|proceed|merge|ship|accept|confirm)\b/i;
const NO_WORDS = /^(deny|denied|no|reject|cancel|block|hold|not now|later|skip|decline|stop)\b/i;

/**
 * Which group a card belongs in. The kind wins when it says so; otherwise a
 * card whose options are a yes/no pair is an approval, and anything else is a
 * choice between options.
 */
export function decisionGroup(card: DeckDecision): DecisionGroupKey {
  const kind = String(card.kind || '').trim().toLowerCase();
  if (kind === 'credential') return 'credential';
  if (kind === 'blocked' || card.blocking === true) return 'blocked';
  if (APPROVE_KINDS.has(kind)) return 'approve';
  const labels = card.options.map((o) => `${o.label || o.key}`.trim());
  if (labels.length >= 1 && labels.length <= 2 && labels.some((l) => YES_WORDS.test(l))
      && (labels.length === 1 || labels.some((l) => NO_WORDS.test(l)))) {
    return 'approve';
  }
  return 'choose';
}

export function isStaleDecision(card: DeckDecision, nowMs: number, days = STALE_DECISION_DAYS): boolean {
  return Number.isFinite(card.createdAt) && nowMs / 1000 - card.createdAt > days * 86400;
}

export interface DecisionGroup {
  key: DecisionGroupKey;
  label: string;
  cards: DeckDecision[];
}

/**
 * The "Older than 7 days" fold: approve/choose cards old enough to stop leading,
 * in the order they arrived. Credential and blocked cards NEVER age out -- a
 * session stopped on the owner is still stopped on day 30, and folding it away
 * is the exact "the card was there and I could not find it" report this view
 * exists to kill. One rule, used by groupDecisions and by the launcher.
 */
export function staleGroup(cards: DeckDecision[], nowMs: number, days = STALE_DECISION_DAYS): DeckDecision[] {
  return (cards || []).filter((card) => {
    const key = decisionGroup(card);
    return key !== 'credential' && key !== 'blocked' && isStaleDecision(card, nowMs, days);
  });
}

/**
 * Fresh cards in their groups (fixed order, main's rank order kept inside a
 * group), and the stale approve/choose ones apart. Empty groups are dropped.
 */
export function groupDecisions(cards: DeckDecision[], nowMs: number, days = STALE_DECISION_DAYS): {
  groups: DecisionGroup[];
  stale: DeckDecision[];
} {
  const buckets = new Map<DecisionGroupKey, DeckDecision[]>(GROUP_ORDER.map((k) => [k, []]));
  const staleIds = new Set(staleGroup(cards, nowMs, days).map((card) => card.id));
  const stale: DeckDecision[] = [];
  for (const card of cards) {
    if (staleIds.has(card.id)) stale.push(card);
    else buckets.get(decisionGroup(card))!.push(card);
  }
  const groups = GROUP_ORDER
    .map((key) => ({ key, label: DECISION_GROUP_LABELS[key], cards: buckets.get(key)! }))
    .filter((g) => g.cards.length > 0);
  return { groups, stale };
}

/**
 * The option a number key selects: 1-based, clamped to the card's own list.
 * Out of range is null, never "the last one" -- pressing 9 on a two-option card
 * must do nothing, not answer.
 */
export function optionByIndex<T extends { key: string }>(options: T[], index: number): T | null {
  const list = Array.isArray(options) ? options : [];
  const n = Math.trunc(Number(index));
  if (!Number.isFinite(n) || n < 1 || n > list.length) return null;
  return list[n - 1] || null;
}

/**
 * A typed answer for the focused card: the option whose KEY or LABEL the owner
 * typed ("ack", "Not now"), or the single option whose label starts with it.
 * Ambiguous text answers nothing -- typing "n" on Ack/Not-now must not guess
 * which one the owner meant.
 */
export function answerByQuery<T extends { key: string; label?: string }>(options: T[], query: string): T | null {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return null;
  const list = Array.isArray(options) ? options : [];
  const key = list.find((o) => String(o.key || '').toLowerCase() === text);
  if (key) return key;
  const label = list.find((o) => String(o.label || '').toLowerCase() === text);
  if (label) return label;
  // A one-letter prefix is how you FIND a card, not how you answer it: "n" in
  // an option search box must never silently pick "Not now".
  if (text.length < 2) return null;
  const prefixed = list.filter((o) => String(o.label || '').toLowerCase().startsWith(text));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * Rows matching what the owner typed, in the order they arrived (the store's
 * rank order -- filtering never re-ranks). Every token must match somewhere, so
 * "cred gmail" narrows instead of widening. An empty query is every row.
 */
export function filterRows(cards: DeckDecision[], query: string): DeckDecision[] {
  const list = cards || [];
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return list.slice();
  return list.filter((card) => {
    const hay = [card.title, card.summary, card.kind, decisionSource(card)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return tokens.every((token) => hay.includes(token));
  });
}

/** Where a card came from, for its one-line row: the agent or tab, else the host. */
export function decisionSource(card: DeckDecision): string {
  return card.agent || card.tab || card.host || (card.cwd ? card.cwd.split(/[\\/]/).filter(Boolean).pop() || '' : '');
}

/**
 * j/k/enter over the visible list: the next id after `current` by `step`,
 * clamped to the ends. An unknown current starts at the top.
 */
export function moveCursor(ids: string[], current: string | null, step: number): string | null {
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, at + step))];
}

/**
 * After a card leaves the list (answered), the card now sitting in its old
 * slot — so answering one opens the next without a click.
 */
export function successorId(previous: string[], next: string[], gone: string): string | null {
  const at = previous.indexOf(gone);
  if (at < 0 || next.length === 0) return null;
  const after = previous.slice(at + 1).find((id) => next.includes(id));
  if (after) return after;
  const before = previous.slice(0, at).reverse().find((id) => next.includes(id));
  return before ?? null;
}

const TIMEOUT_STATE = /time[ds]?[ _-]?out|timeout/i;

/** A wake that needs a look: a failing streak or a timed-out last run (running ones are not broken). */
export function isBrokenWake(wake: WakeRow): boolean {
  if (wake.running) return false;
  if (wake.consecutiveFailures > 0) return true;
  return TIMEOUT_STATE.test(wake.lastState || '') || TIMEOUT_STATE.test(wake.lastReason || '');
}

/** Broken wakes, worst streak first; everything else in name order. */
export function splitWakes(wakes: WakeRow[]): { broken: WakeRow[]; healthy: WakeRow[] } {
  const broken = wakes.filter(isBrokenWake)
    .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.name.localeCompare(b.name));
  const healthy = wakes.filter((w) => !isBrokenWake(w)).sort((a, b) => a.name.localeCompare(b.name));
  return { broken, healthy };
}

/** "57 routines OK · 2 running · 3 disabled" — the line the healthy table folds into. */
export function healthySummary(healthy: WakeRow[]): string {
  const running = healthy.filter((w) => w.running).length;
  const disabled = healthy.filter((w) => !w.running && !w.enabled).length;
  const ok = healthy.length - running - disabled;
  const parts = [`${ok} routine${ok === 1 ? '' : 's'} OK`];
  if (running) parts.push(`${running} running`);
  if (disabled) parts.push(`${disabled} disabled`);
  return parts.join(' · ');
}

const TRACEBACK = /Traceback \(most recent call last\)[\s\S]*?(?:\n[ \t]*\n|$)/i;
const URL_TEXT = /https?:\/\/\S+/gi;
const WIN_PATH = /\b[A-Za-z]:\\[^\s"'<>|]+/g;
const POSIX_PATH = /(?:\/[\w.@+-]+){2,}/g;
const TRAILING = /[\s.,;:—–-]+$/;

/**
 * ONE readable clause out of machine noise. The row is 28 px wide and the owner
 * reads it at a glance: a URL, a stack path or a traceback block is something to
 * open, not something to parse. Never silently empty — an empty result falls
 * back to a phrase the caller can show.
 */
function oneClause(text: string): string {
  let out = String(text || '');
  out = out.replace(TRACEBACK, ' ');
  out = out.replace(URL_TEXT, ' ');
  out = out.replace(WIN_PATH, ' ');
  out = out.replace(POSIX_PATH, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  // The first sentence or dash boundary ends the clause.
  const cut = out.search(/\.\s| — /);
  if (cut >= 0) out = out.slice(0, cut);
  out = out.replace(TRAILING, '').trim();
  return out.length > 80 ? `${out.slice(0, 79)}…` : out;
}

/**
 * The last error of a broken wake as one actionable clause (the full text stays
 * in the row's title). The REASON leads: "exited 1" tells the owner what broke,
 * while "failure" only restates that something did.
 */
export function wakeErrorLine(wake: WakeRow): string {
  const reason = wake.lastReason ? reasonLabel(wake.lastReason) : '';
  const state = wake.lastState && !reason.toLowerCase().includes(wake.lastState.toLowerCase()) ? wake.lastState : '';
  const line = oneClause([reason, state].filter(Boolean).join(' — ') || wake.error || '');
  return line || 'no reason recorded';
}

function clipLine(text: string, max: number): string {
  const out = text.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** The line under a broken wake: awrise's own WHY (the error line it read off
 *  the run's output) when the daemon carries one, else the old reason line. */
export function wakeWhyLine(wake: WakeRow): string {
  // NOT oneClause: the why IS the error line, and its host:port, URL or path
  // ("no llama-server on spark.local:8118", "POST /decisions: HTTP 400") is the
  // part that says what broke. Whitespace collapsed, length capped, nothing cut.
  const why = clipLine(String(wake.lastWhy || ''), 160);
  return why || wakeErrorLine(wake);
}

/** The cause pill: '' when awrise has not classified this streak. */
export function wakeCausePill(wake: WakeRow): string {
  const cause = String(wake.lastCause || '').trim();
  if (!cause) return '';
  const streak = Number(wake.whyStreak) || 0;
  return streak > 1 ? `${cause} ×${streak}` : cause;
}

/** "held until 14:05 — no llama-server on spark.local:8118" while the hold is
 *  in the future; '' once it has lapsed (the next wake retries). */
export function wakeHeldPill(wake: WakeRow, nowMs: number): string {
  if (!wake.heldUntil) return '';
  const until = Date.parse(wake.heldUntil);
  if (!Number.isFinite(until) || until <= nowMs) return '';
  const d = new Date(until);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const on = clipLine(String(wake.heldOn || ''), 80);
  return on ? `held until ${hhmm} — ${on}` : `held until ${hhmm}`;
}

/** The note an Investigate click leaves on the row. */
export function wakeInvestigateMessage(result: WakeInvestigateResult | boolean | null | undefined): string {
  if (result === null || result === undefined || typeof result === 'boolean') {
    return result === true ? 'investigating' : 'investigate: no answer from the desk';
  }
  if (result.ok && result.session) return `investigating — agent session ${result.session}`;
  return `investigate failed: ${result.error || 'refused'}`;
}

/** Is the scheduler's own clock the broken thing? Then it leads the Broken list. */
export function clockIsBroken(feed: WakesFeed): boolean {
  return feed.source === 'daemon' && feed.installed === true && !feed.error && feed.clockStale;
}

const PINNED_KINDS = new Set(['request', 'alert']);

/** Requests and alerts first, then everything else; newest first inside each. */
export function orderRelay(rows: RelayRow[]): { pinned: RelayRow[]; rest: RelayRow[] } {
  const newest = [...rows].sort((a, b) => b.at - a.at);
  const pinned = newest.filter((r) => PINNED_KINDS.has(String(r.kind || '').toLowerCase()));
  const rest = newest.filter((r) => !PINNED_KINDS.has(String(r.kind || '').toLowerCase()));
  return { pinned, rest };
}

/** The nick without the session suffix ("david+3f2a" -> "david"), and the suffix. */
export function relayNick(author: string): { nick: string; session: string } {
  const text = String(author || 'unknown');
  const at = text.indexOf('+');
  return at > 0 ? { nick: text.slice(0, at), session: text.slice(at + 1) } : { nick: text, session: '' };
}

export interface AwarenessLine {
  /** "Voice", "Vision", ... */
  name: string;
  ok: boolean;
  /** The headline, in words ("Voice service not answering"). Never raw exception text. */
  state: string;
  /** The raw detail, for a tooltip/expand. */
  detail: string;
}

/**
 * One awareness source as a human state. `raw` is what the snapshot said
 * ("unreachable — Server disconnected without sending a response"); the
 * headline names the thing and its state, the raw text becomes the detail.
 */
export function awarenessLine(name: string, raw: string, noun = `${name} service`): AwarenessLine {
  const text = String(raw || '').trim();
  if (!text || text === 'up' || /^up\b/i.test(text)) return { name, ok: true, state: `${noun} OK`, detail: text };
  const verb = text.match(/^(unreachable|down|unavailable)\b\s*[—-]?\s*/i);
  const rest = verb ? text.slice(verb[0].length) : text;
  const detail = transportNote(rest) || rest;
  if (verb) {
    const v = verb[1].toLowerCase();
    if (v === 'unreachable') return { name, ok: false, state: `${noun} not answering`, detail };
    if (v === 'down') return { name, ok: false, state: `${noun} reporting an error`, detail };
    if (/windows|platform/i.test(rest)) return { name, ok: false, state: `${noun} not available on this machine`, detail };
    return { name, ok: false, state: `${noun} unavailable`, detail };
  }
  if (/not answering|no answer in time|not signed in|error|fail|refused|disconnect/i.test(text)) {
    return { name, ok: false, state: `${noun} not answering`, detail };
  }
  // Anything else is a status line the source chose to report (a window title, a profile).
  return { name, ok: true, state: `${noun}: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`, detail: text };
}
