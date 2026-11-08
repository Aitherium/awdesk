/**
 * The renderer half of the Inbox session panel: the SessionContext contract main
 * serves on `window.deskBridge.deck.session(cardId)`, a 30 s per-card cache, the
 * three session verbs (focus / resume / reply) and the http(s)-only URL opener.
 *
 * Every entry point is feature-detected: an older main has no `deck.session`,
 * and then the Inbox keeps the plain card (summary + "Something else...").
 * Nothing here throws into the UI -- a failed call becomes `{ ok: false, ... }`
 * with a sentence the panel can print.
 */

import { createContext } from 'react';

import { isWebUrl } from './session-text';

export interface SessionTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ms */
  at: number;
}

export interface SessionContext {
  ok: true;
  sessionId: string;
  /** The session's own title ("Desktop canvas layout"); "" if unknown. */
  name: string;
  /** null = the session process is not running (ended). */
  live: null | { status: string; pid: number; since: number };
  /** ms, last journal write. */
  updatedAt: number;
  firstAsk: string;
  lastAsk: string;
  /** The session's final message, markdown. */
  lastSaid: string;
  /** Last <=8 turns, oldest first. */
  turns: SessionTurn[];
  /** <=10 edited paths, most recent first. */
  files: string[];
  /** "owner/name" for bare #NNNN PR links; "" if unknown. */
  repo: string;
  /** Absolute transcript path, display only. */
  transcript: string;
}

export interface SessionError {
  ok: false;
  error: string;
}

export type SessionResult = SessionContext | SessionError;

export type SessionAction = 'focus' | 'resume' | 'reply';

export interface SessionActResult {
  ok: boolean;
  via?: 'tab' | 'resumed' | 'mailbox' | 'mailbox+tab';
  note: string;
}

interface SessionBridge {
  session?: (cardId: string) => Promise<unknown>;
  sessionAct?: (cardId: string, action: SessionAction, text?: string) => Promise<unknown>;
  openUrl?: (url: string) => Promise<unknown>;
  openFile?: (cardId: string, file: string) => Promise<unknown>;
}

function bridge(): SessionBridge | null {
  if (typeof window === 'undefined') return null;
  const desk = (window as unknown as { deskBridge?: { deck?: SessionBridge } }).deskBridge;
  return desk?.deck ?? null;
}

/** This main can read a card's session (the panel renders only then). */
export function hasSessionBridge(): boolean {
  return typeof bridge()?.session === 'function';
}

/** This main can open a URL in Aither Browser (links render as buttons only then). */
export function canOpenUrl(): boolean {
  return typeof bridge()?.openUrl === 'function';
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Main's answer as a SessionResult, defensively: a field an older or newer main
 * shapes differently degrades to empty instead of crashing the row.
 */
export function normalizeSessionResult(raw: unknown): SessionResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'The desk sent no session.' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) {
    return { ok: false, error: text(value.error, 400) || 'The desk could not read this session.' };
  }
  const liveRaw = value.live as Record<string, unknown> | null | undefined;
  const live = liveRaw && typeof liveRaw === 'object'
    ? { status: text(liveRaw.status, 40), pid: num(liveRaw.pid), since: num(liveRaw.since) }
    : null;
  const turns = Array.isArray(value.turns)
    ? (value.turns as Array<Record<string, unknown>>)
        .filter((turn) => turn && typeof turn === 'object' && typeof turn.text === 'string')
        .slice(-8)
        .map((turn): SessionTurn => ({
          role: turn.role === 'user' ? 'user' : 'assistant',
          text: text(turn.text, 1500),
          at: num(turn.at),
        }))
    : [];
  const files = Array.isArray(value.files)
    ? (value.files as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0).slice(0, 10)
    : [];
  return {
    ok: true,
    sessionId: text(value.sessionId, 200),
    name: text(value.name, 300),
    live,
    updatedAt: num(value.updatedAt),
    firstAsk: text(value.firstAsk, 1200),
    lastAsk: text(value.lastAsk, 1200),
    lastSaid: text(value.lastSaid, 6000),
    turns,
    files,
    repo: text(value.repo, 200),
    transcript: text(value.transcript, 1000),
  };
}

/** How long a fetched session stays fresh for one card. */
export const SESSION_CACHE_MS = 30_000;

const cache = new Map<string, { at: number; value: SessionContext }>();
const inflight = new Map<string, Promise<SessionResult>>();

/** The cached session for a card, when it is younger than SESSION_CACHE_MS.
 *  Only successful reads are cached: an error is re-asked on the next open. */
export function peekSessionContext(cardId: string, nowMs: number = Date.now()): SessionContext | null {
  const hit = cache.get(cardId);
  if (!hit) return null;
  if (nowMs - hit.at > SESSION_CACHE_MS) {
    cache.delete(cardId);
    return null;
  }
  return hit.value;
}

/** Fetch (or reuse) a card's session. One request per card at a time. */
export function loadSessionContext(cardId: string, nowMs: number = Date.now()): Promise<SessionResult> {
  const cached = peekSessionContext(cardId, nowMs);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(cardId);
  if (pending) return pending;
  const deck = bridge();
  if (typeof deck?.session !== 'function') {
    return Promise.resolve({ ok: false, error: 'This Aither build cannot read sessions yet.' });
  }
  const request = Promise.resolve()
    .then(() => deck.session!(cardId))
    .then((raw) => normalizeSessionResult(raw))
    .catch((error: unknown): SessionResult => ({
      ok: false,
      error: `The desk did not answer${error instanceof Error && error.message ? `: ${error.message}` : '.'}`,
    }))
    .then((result) => {
      if (result.ok) cache.set(cardId, { at: nowMs, value: result });
      inflight.delete(cardId);
      return result;
    });
  inflight.set(cardId, request);
  return request;
}

/** Drop a card's cached session (after a reply/resume changed it). */
export function forgetSessionContext(cardId: string): void {
  cache.delete(cardId);
}

/** Test seam: forget every cached session. */
export function clearSessionCache(): void {
  cache.clear();
  inflight.clear();
}

/** focus / resume / reply, always answered with a sentence. */
export async function runSessionAct(cardId: string, action: SessionAction, body?: string): Promise<SessionActResult> {
  const deck = bridge();
  if (typeof deck?.sessionAct !== 'function') {
    return { ok: false, note: 'This Aither build cannot reach sessions yet.' };
  }
  try {
    const raw = (await deck.sessionAct(cardId, action, body)) as Partial<SessionActResult> | null;
    if (!raw || typeof raw !== 'object') return { ok: false, note: 'The desk sent no answer.' };
    return {
      ok: raw.ok === true,
      via: raw.via,
      note: text(raw.note, 400) || (raw.ok ? 'Done.' : 'Refused.'),
    };
  } catch {
    return { ok: false, note: 'The desk did not answer.' };
  }
}

/** This main can reveal a session's edited file in Explorer. */
export function canOpenFile(): boolean {
  return typeof bridge()?.openFile === 'function';
}

/** Reveal one of the card's session files. Main re-checks it is in the session's list. */
export async function openSessionFile(cardId: string, file: string): Promise<boolean> {
  const deck = bridge();
  if (typeof deck?.openFile !== 'function') return false;
  try {
    const result = (await deck.openFile(cardId, file)) as { ok?: boolean } | null;
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

/** Open an http(s) URL in Aither Browser. Anything else is refused here. */
export async function openDeskUrl(url: string): Promise<boolean> {
  const deck = bridge();
  if (!isWebUrl(url) || typeof deck?.openUrl !== 'function') return false;
  try {
    const result = (await deck.openUrl(url)) as { ok?: boolean } | null;
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

/** What a link in card text can do here. `repo` turns a bare #NNNN into a PR. */
export interface DeckLinkHandlers {
  /** Focus a card in the Inbox. Absent = render d-ids as plain ids. */
  focusCard?: (id: string) => void;
  /** Is this card in the Inbox right now? An id that is not stays plain text. */
  hasCard?: (id: string) => boolean;
  /** Open a URL. Absent (older main) = URLs render as plain text. */
  openUrl?: (url: string) => void;
  repo: string;
}

export const DeckLinks = createContext<DeckLinkHandlers>({ repo: '' });
