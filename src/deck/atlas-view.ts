/**
 * The renderer half of the Atlas section: the board a `GET /atlas/issues/board`
 * snapshot carries, normalized so a missing field degrades instead of crashing
 * the Inbox.
 *
 * Main serves `window.deskBridge.atlas.board()` -> `{ok:true, board}` or
 * `{ok:false, error}` (electron/atlas-client.cjs). The board is
 * `{counts, rows, metrics, text, message_id, updated_at}`; a row is
 * `{number, stage, pr, thread, ...}`. Nothing here assumes a field exists:
 * an unknown/tool-not-deployed answer yields an empty view with the reason.
 */

import { formatAge } from './deck-types';

export interface AtlasStageCount {
  stage: string;
  count: number;
}

export interface AtlasRowView {
  key: string;
  /** "#15130", or "" when the row carries no number. */
  number: string;
  title: string;
  stage: string;
  /** "3d" from the row's newest timestamp; "" when the row has none. */
  age: string;
  /** The full sentence behind the age ("opened 3d ago"). */
  ageTitle: string;
  prUrl: string;
  prLabel: string;
  threadUrl: string;
  threadLabel: string;
}

export interface AtlasBoardView {
  ok: true;
  counts: AtlasStageCount[];
  rows: AtlasRowView[];
  /** "updated 5m ago" / "" when the board has no timestamp. */
  updated: string;
  /** The board's own timestamp as a sentence for a tooltip ("2026-11-09 …"). */
  updatedTitle: string;
  /** Server-provided digest text (the section folds it away). */
  text: string;
  messageId: string;
}

export interface AtlasErrorView {
  ok: false;
  error: string;
}

export type AtlasView = AtlasBoardView | AtlasErrorView;

export const EMPTY_BOARD: AtlasBoardView = {
  ok: true,
  counts: [],
  rows: [],
  updated: '',
  updatedTitle: '',
  text: '',
  messageId: '',
};

/** An http(s) URL from a string, or from `{url|href|html_url}`; anything else
 *  is "" (the row renders plain text rather than a dead link). */
export function webUrl(value: unknown): string {
  let raw = '';
  if (typeof value === 'string') raw = value.trim();
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['url', 'href', 'html_url', 'link']) {
      if (typeof obj[key] === 'string' && obj[key]) {
        raw = (obj[key] as string).trim();
        break;
      }
    }
  }
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/** A PR/thread link for a column that may be a raw number, a "…#NNN" string
 *  or an object: `{url, label}`. `base` turns a bare number into the row's
 *  link only when the row already gave one — never a guessed repo. */
function linkOf(value: unknown): { url: string; label: string } {
  const url = webUrl(value);
  if (!url) return { url: '', label: '' };
  const tail = url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? '';
  return { url, label: /^\d+$/.test(tail) ? `#${tail}` : 'open' };
}

/** Epoch seconds from a number (s or ms) or an ISO string; null when absent. */
export function timestampSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) return Math.floor(asDate / 1000);
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    }
  }
  return null;
}

/** The row's own age, preferring the newest timestamp it carries. */
function rowAge(row: Record<string, unknown>, nowMs: number): { age: string; title: string } {
  for (const field of ['updated_at', 'opened_at', 'created_at', 'updatedAt', 'openedAt', 'createdAt']) {
    const at = timestampSeconds(row[field]);
    if (at == null) continue;
    const name = field.replace(/_(at|At)$/, '').replace(/_/g, ' ');
    const label = formatAge(at, nowMs);
    return { age: label, title: `${name} ${label === 'just now' ? label : `${label} ago`}` };
  }
  return { age: '', title: '' };
}

function textOf(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Counts may arrive as `{stage: n}`, `[{stage, count}]` or `[{stage, value}]`. */
function stageCounts(raw: unknown, rows: AtlasRowView[]): AtlasStageCount[] {
  const out: AtlasStageCount[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const stage = textOf(obj.stage ?? obj.name ?? obj.key, 60);
      const count = Number(obj.count ?? obj.total ?? obj.value);
      if (stage && Number.isFinite(count)) out.push({ stage, count });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [stage, value] of Object.entries(raw as Record<string, unknown>)) {
      const count = Number(value);
      if (stage && Number.isFinite(count)) out.push({ stage, count });
    }
  }
  if (out.length > 0) return out;
  // No counts on the board: count the rows themselves, server order preserved.
  for (const row of rows) {
    if (!row.stage) continue;
    const hit = out.find((entry) => entry.stage === row.stage);
    if (hit) hit.count += 1;
    else out.push({ stage: row.stage, count: 1 });
  }
  return out;
}

function normalizeRow(raw: unknown, index: number, nowMs: number): AtlasRowView | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const number = row.number ?? row.issue ?? row.id;
  const numberLabel = /^\d+$/.test(String(number ?? '')) ? `#${number}` : textOf(number, 40);
  const pr = linkOf(row.pr ?? row.pull_request ?? row.pullRequest);
  const thread = linkOf(row.thread ?? row.thread_url ?? row.threadUrl ?? row.issue_url);
  const { age, title } = rowAge(row, nowMs);
  return {
    key: `${String(number ?? index)}-${index}`,
    number: numberLabel,
    title: textOf(row.title ?? row.name ?? row.summary, 200),
    stage: textOf(row.stage ?? row.status ?? row.state, 60),
    age,
    ageTitle: title,
    prUrl: pr.url,
    prLabel: pr.label,
    threadUrl: thread.url,
    threadLabel: thread.label,
  };
}

/** A board snapshot (or the `{ok:true, board}` envelope) as a view. */
export function normalizeAtlasBoard(raw: unknown, nowMs: number = Date.now()): AtlasBoardView {
  const envelope = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const board = (envelope.ok === true && envelope.board && typeof envelope.board === 'object'
    ? envelope.board
    : envelope) as Record<string, unknown>;
  const rowsRaw = Array.isArray(board.rows) ? board.rows : [];
  const rows = rowsRaw
    .map((row, index) => normalizeRow(row, index, nowMs))
    .filter((row): row is AtlasRowView => row !== null);
  const updatedAt = timestampSeconds(board.updated_at ?? board.updatedAt);
  const updated = updatedAt == null ? '' : formatAge(updatedAt, nowMs);
  const updatedTitle = updatedAt == null ? '' : new Date(updatedAt * 1000).toISOString();
  return {
    ok: true,
    counts: stageCounts(board.counts ?? board.stages, rows),
    rows,
    updated,
    updatedTitle,
    text: textOf(board.text, 4000),
    messageId: textOf(board.message_id ?? board.messageId, 120),
  };
}

/** Main's answer (`{ok, board|error}`) as a view; never throws. */
export function atlasViewFromAnswer(raw: unknown, nowMs: number = Date.now()): AtlasView {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'The desk sent no Atlas board.' };
  }
  const answer = raw as Record<string, unknown>;
  if (answer.ok === false) {
    return { ok: false, error: textOf(answer.error ?? answer.reason, 400) || 'Atlas is unavailable.' };
  }
  return normalizeAtlasBoard(raw, nowMs);
}
