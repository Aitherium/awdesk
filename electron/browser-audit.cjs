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

function createAudit({ dir, file = AUDIT_FILE, maxBytes = MAX_BYTES, keep = KEEP, now = Date.now } = {}) {
  const target = path.join(String(dir), file);

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

  /** Append one row. Returns the row written, or null when the disk refused it. */
  function record(entry) {
    const row = shape(entry, now());
    const line = `${JSON.stringify(row)}\n`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let size = 0;
      try { size = fs.statSync(target).size; } catch { size = 0; }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(target, line, { mode: 0o600 });
      return row;
    } catch {
      return null;
    }
  }

  /** The rows of the current file (not the rotated ones), oldest first. */
  function read() {
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

  return { file: target, read, record, upload };
}

module.exports = { AUDIT_FILE, KEEP, MAX_BYTES, TAB_KINDS, createAudit, shape };
