"use strict";

/**
 * browser-audit.cjs -- the browser's local audit spool for workspace-policy decisions.
 *
 * One JSON object per line, append-only, in userData:
 *   { ts, tenant, origin, action, verdict, tab }
 * and nothing else: `origin` is cut down to scheme://host[:port], so a path, a query, a
 * page title, page text, a file name or a credential can never be written. Unknown
 * fields are dropped, not stored.
 *
 * Writing is off the caller's path: record() only queues the row; the queue is written
 * in one append a moment later (flush). read() and flush() write what is waiting first,
 * so nothing a caller recorded is missing from what it reads back.
 *
 * It cannot be flooded: the same (tenant, origin, action, verdict, tab) is written at
 * most `burst` times per `windowMs`; the rest are counted (stats().dropped), and the
 * queue has a ceiling. So one noisy source cannot rotate the real rows out.
 *
 * Size-capped: when the file would pass `maxBytes` it is renamed to .1 (older ones move
 * to .2 ... .keep, the oldest is dropped) and a new file starts.
 *
 * upload() is the seam for sending the spool to the workspace. It is NOT implemented:
 * it sends nothing and says how many rows wait. (docs/WORKSPACE-POLICY.md "Not yet".)
 *
 * Pure: node:fs only.
 */

const fs = require("node:fs");
const path = require("node:path");

const AUDIT_FILE = "browser-audit.jsonl";
const MAX_BYTES = 1024 * 1024;
const KEEP = 3;
const BURST = 20;
const WINDOW_MS = 10_000;
const FLUSH_MS = 250;
const MAX_QUEUE = 2000;
const VERDICTS = Object.freeze(["allow", "deny"]);
const TAB_KINDS = Object.freeze(["owner", "work", "agent", "private", "door"]);
const WORD = /^[a-z][a-z0-9-]{0,31}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function originOnly(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

/** The row as it is written: six known fields, each cut to its own shape. */
function shape(entry = {}, now = Date.now()) {
  return {
    ts: new Date(now).toISOString(),
    tenant: TENANT.test(String(entry.tenant || "")) ? String(entry.tenant) : "",
    origin: originOnly(entry.origin),
    action: WORD.test(String(entry.action || "")) ? String(entry.action) : "unknown",
    verdict: VERDICTS.includes(entry.verdict) ? entry.verdict : "deny",
    tab: TAB_KINDS.includes(entry.tab) ? entry.tab : "owner",
  };
}

function createAudit({ dir, file = AUDIT_FILE, maxBytes = MAX_BYTES, keep = KEEP, now = Date.now, burst = BURST, windowMs = WINDOW_MS,
  flushMs = FLUSH_MS, maxQueue = MAX_QUEUE } = {}) {
  const target = path.join(String(dir), file);
  let queue = [];
  let timer = null;
  let dropped = 0;
  let written = 0;
  const recent = new Map(); // key -> { since, count }

  function rotate() {
    for (let i = keep; i >= 1; i -= 1) {
      const from = i === 1 ? target : `${target}.${i - 1}`;
      const to = `${target}.${i}`;
      try {
        if (i === keep) fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
      } catch { /* nothing at that place */ }
    }
  }

  /** May this row be written, or has its like been written `burst` times in this window already? */
  function admitted(row, at) {
    const key = `${row.tenant}|${row.origin}|${row.action}|${row.verdict}|${row.tab}`;
    let slot = recent.get(key);
    if (!slot || at - slot.since >= windowMs) {
      if (recent.size > 500) for (const [k, v] of recent) if (at - v.since >= windowMs) recent.delete(k);
      slot = { since: at, count: 0 };
      recent.set(key, slot);
    }
    slot.count += 1;
    return slot.count <= burst;
  }

  /** Write what is waiting. Returns how many rows went to disk. */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return 0;
    const lines = queue;
    queue = [];
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let size = 0;
      try { size = fs.statSync(target).size; } catch { size = 0; }
      let chunk = "";
      const put = () => { if (chunk) { fs.appendFileSync(target, chunk, { mode: 0o600 }); size += Buffer.byteLength(chunk); chunk = ""; } };
      for (const line of lines) {
        if (size + Buffer.byteLength(chunk) > 0 && size + Buffer.byteLength(chunk) + Buffer.byteLength(line) > maxBytes) {
          put();
          rotate();
          size = 0;
        }
        chunk += line;
      }
      put();
      written += lines.length;
      return lines.length;
    } catch {
      dropped += lines.length;
      return 0;
    }
  }

  /** Queue one row. Returns the row, or null when it was not taken (too many of its like, or the queue is full). */
  function record(entry) {
    const at = now();
    const row = shape(entry, at);
    if (!admitted(row, at) || queue.length >= maxQueue) { dropped += 1; return null; }
    queue.push(`${JSON.stringify(row)}\n`);
    if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, flushMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    return row;
  }

  /** The rows of the current file (not the rotated ones), oldest first. Waiting rows are written first. */
  function read() {
    flush();
    let raw;
    try { raw = fs.readFileSync(target, "utf8"); } catch { return []; }
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { /* a torn last line */ }
    }
    return rows;
  }

  /** NOT IMPLEMENTED: nothing leaves this computer. */
  async function upload() {
    return { ok: true, uploaded: 0, pending: read().length, implemented: false };
  }

  return { file: target, flush, read, record, upload, stats: () => ({ dropped, written, waiting: queue.length }) };
}

module.exports = { AUDIT_FILE, BURST, KEEP, MAX_BYTES, TAB_KINDS, WINDOW_MS, createAudit, shape };
