"use strict";

/**
 * ask-answered.cjs -- a card for a Claude Code QUESTION closes once that question was
 * answered anywhere (in the terminal, by another surface, or refused).
 *
 * Measured 2026-11-17 (card d-yjmc, "Go live: openaw.org"): the session asked at
 * 12:35:56, the owner answered in the terminal at 12:39:17, and the card was still up
 * 26 s later when he clicked it. A dialog answer fires no UserPromptSubmit, so awask's
 * "--resolve" never ran; nothing else looked. The session's own journal says it: a
 * tool_result for an AskUserQuestion tool_use, written after the card was raised.
 *
 * Rules, each one a way this could close a live question:
 *   - only a claude-code card that names a session and offers a session-ask key
 *     (`tui:type`, `tui:<n>`, `ans:type`, `ans:<n>`): awask's question cards and no other;
 *   - only a result for a tool_use the journal itself names AskUserQuestion;
 *   - only a result stamped AFTER the card was raised (an earlier question's answer is
 *     not this one's: a new question is always asked after the last one's result);
 *   - an unreadable journal closes nothing.
 *
 * PURE except for the injected reader/cancel. No electron. node --test.
 */

const fs = require("node:fs");

const ASK_KEY_RE = /^(tui|ans):(type|[1-9])$/;
const NOTE = "the question was answered in the session (closed by Desk)";
const TAIL_BYTES = 768 * 1024;

function agentOf(card) {
  return String((card && (card.agent || (card.source && card.source.agent))) || "");
}

/** A card awask raised for a Claude Code AskUserQuestion. */
function isAskCard(card) {
  if (!card || typeof card !== "object" || agentOf(card) !== "claude-code") return false;
  if (!card.sessionId) return false;
  const options = Array.isArray(card.options) ? card.options : [];
  return options.some((o) => o && ASK_KEY_RE.test(String(o.key || "")));
}

/** The journal records (parsed) that can matter: AskUserQuestion uses and tool results. */
function parseRecords(raw) {
  const out = [];
  for (const line of String(raw || "").split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    if (!s.includes("AskUserQuestion") && !s.includes("\"tool_result\"")) continue;
    try { out.push(JSON.parse(s)); } catch { /* a torn line at the window edge */ }
  }
  return out;
}

/** ms of the newest AskUserQuestion result in `records`, or 0. */
function lastAskAnswerAt(records) {
  const askIds = new Set();
  let last = 0;
  for (const rec of Array.isArray(records) ? records : []) {
    const content = rec && rec.message && Array.isArray(rec.message.content) ? rec.message.content : [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && b.name === "AskUserQuestion" && b.id) askIds.add(String(b.id));
      if (b.type === "tool_result" && askIds.has(String(b.tool_use_id || ""))) {
        const t = Date.parse(rec.timestamp);
        if (Number.isFinite(t) && t > last) last = t;
      }
    }
  }
  return last;
}

/** Was the question this card carries answered after the card was raised? */
function answeredSince(card, records) {
  const created = (Number(card && card.createdAt) || 0) * 1000;
  if (!created) return false;
  return lastAskAnswerAt(records) > created;
}

function readTail(file, fsImpl = fs, bytes = TAIL_BYTES) {
  let fd = null;
  try {
    const size = fsImpl.statSync(file).size;
    const start = Math.max(0, size - bytes);
    fd = fsImpl.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    const n = fsImpl.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
  }
}

/**
 * Close every open ask card whose question was answered. deps:
 *   transcript(card) -> path | "" ; read(path) -> text ; cancel(id, note) -> truthy
 * Returns {closed:[ids], failed:[ids]}. Never throws.
 */
function sweep(cards, { transcript, read = (p) => readTail(p), cancel } = {}) {
  const closed = [];
  const failed = [];
  const cache = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!isAskCard(card)) continue;
    let records = cache.get(card.sessionId);
    if (!records) {
      let file;
      try { file = String(transcript(card) || ""); } catch { file = ""; }
      records = file ? parseRecords(read(file)) : [];
      cache.set(card.sessionId, records);
    }
    if (!answeredSince(card, records)) continue;
    let ok;
    try { ok = Boolean(cancel(card.id, NOTE)); } catch { ok = false; }
    (ok ? closed : failed).push(card.id);
  }
  return { closed, failed };
}

module.exports = { ASK_KEY_RE, NOTE, isAskCard, parseRecords, lastAskAnswerAt, answeredSince, readTail, sweep };
