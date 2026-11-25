"use strict";

/**
 * sessions-client.cjs — the Sessions pane's backend: the awdk harness daemon's
 * unified session directory (loopback :8362), read-only.
 *
 * WHY (2026-09-12, owner: "a proper interactive awsh/aithershell"): the daemon
 * already merges daemon-owned sessions with DISCOVERED interactive Claude Code
 * tabs (pid + start-time, so no cooperation is needed from the tab), and every
 * row carries the daemon's own verdict on what may be done to it (`actions` +
 * `why_not`, from adk.harnesses.session_verbs.row_actions). Slice 1 of COCKPIT-DESIGN.md is
 * read-only — "stop tab-cycling to check on things" — and this pane IS that
 * view: list + live tail, saying what it cannot do instead of pretending.
 *
 * Auth: Bearer from AITHER_HARNESS_TOKEN or ~/.aither/harness_token (the same
 * resolution order harness-client.ts documents). The token never leaves the
 * main process — the pane's frame only ever sees session rows and file tails.
 *
 * Failure is a RENDERED STATE: daemon down / no token -> { ok:false, note }
 * with the reason — never a thrown error, and never a fabricated empty list.
 * "Could not look" and "nothing is running" must not read the same.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DAEMON = process.env.AITHER_HARNESS_URL || "http://127.0.0.1:8362";

function harnessToken() {
  if (process.env.AITHER_HARNESS_TOKEN) return process.env.AITHER_HARNESS_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), ".aither", "harness_token"), "utf8").trim();
  } catch {
    return "";
  }
}

const FOCUS_ROOT = process.env.AITHER_FOCUS_DIR || path.join(os.homedir(), ".aither", "focus");

// ── Antigravity (owner 2026-11-25: "fairies don't even send me decisions anymore!
// they aren't integrated into antigravity!"). The Antigravity plugin
// (~/.gemini/config/plugins/aitheros) runs awdk's antigravity_hooks.py on every
// lifecycle event; that adapter writes ONE presence file per live conversation in
// ~/.aither/antigravity_sessions/<conversationId>.json. The harness daemon does not
// discover that directory (measured 2026-11-25: :8362/sessions/unified listed 11
// Claude sessions and zero Antigravity), so the desk reads it here and merges it into
// the same unified list: those conversations become fairies like any other session.
const ANTIGRAVITY_DIR = process.env.AITHER_ANTIGRAVITY_SESSIONS
  || path.join(os.homedir(), ".aither", "antigravity_sessions");
/** A conversation that wrote no lifecycle event for this long is not "live": the hook
 *  writes "ready"/"idle" and never deletes the file, so age is the only honest test. */
const ANTIGRAVITY_LIVE_MS = 90 * 60 * 1000;

/** Antigravity conversations as session rows. Never throws; a missing directory is
 *  "not integrated here", not an error. */
function readAntigravitySessions({ dir = ANTIGRAVITY_DIR, now = Date.now(), liveMs = ANTIGRAVITY_LIVE_MS } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (!raw || typeof raw !== "object") continue;
      const id = String(raw.sessionId || raw.id || "").trim();
      if (!id) continue;
      const updatedTs = Number(raw.updatedTs) || 0;
      const updatedMs = updatedTs > 0 ? updatedTs * 1000 : Date.parse(String(raw.updatedAt || ""));
      if (!Number.isFinite(updatedMs) || now - updatedMs > liveMs) continue;
      rows.push({
        ...raw,
        id,
        harness: "antigravity",
        harness_label: raw.harnessLabel || "Antigravity",
        status: String(raw.status || "ready"),
      });
    } catch { /* a half-written file is skipped; the next event rewrites it */ }
  }
  return rows;
}

/** The goal / next step a Claude Code session left behind (written by the
 *  session-focus.py Stop hook as <FOCUS_ROOT>/<project>/<session_id>.json).
 *  A row that says WHAT it was doing is what makes resume pick the right one.
 *  Missing or unreadable -> null, never a thrown error. */
function focusFor(sessionId, root = FOCUS_ROOT) {
  const sid = String(sessionId || "");
  if (!sid || /[\\/]|\.\./.test(sid)) return null;
  let projects;
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const proj of projects) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(root, proj, `${sid}.json`), "utf8"));
      if (rec && typeof rec === "object") {
        return { goal: rec.first_ask || "", latest: rec.last_ask || "", next: rec.next || "", ended: rec.report || "" };
      }
    } catch {
      // not in this project dir, or unreadable: keep looking
    }
  }
  return null;
}

function withFocus(sessions, root = FOCUS_ROOT) {
  return sessions.map((s) => {
    const focus = focusFor(s.harness_session_id || s.session_id || s.id, root);
    return focus ? { ...s, focus } : s;
  });
}

/** The verbs the daemon decides per row (adk.harnesses.session_verbs.VERBS). */
const VERBS = ["message", "interrupt", "focus", "input"];
const NO_VERDICT = "the daemon did not say what this session allows (older adk -- update it)";

/**
 * Lift the daemon's per-row verdict (`row.actions` = {verb: bool, why_not:
 * {verb: reason}}) to `actions` + `why_not`, and DROP `steer_capability`.
 * The daemon's row_actions() is the one rule set for what a row can do; the
 * pane used to map steer_capability to its own "steerable / steer @ turn /
 * watch only" label, a third rule set that disagreed with the other two.
 * A row with no verdict gets every verb off with a reason -- never a guess.
 */
function withActions(row) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose (rest omits it)
  const { steer_capability: _dropped, actions: raw, ...rest } = row || {};
  const given = raw && typeof raw === "object" ? raw : null;
  const whyIn = given && given.why_not && typeof given.why_not === "object" ? given.why_not : {};
  const actions = {};
  const whyNot = {};
  for (const verb of VERBS) {
    actions[verb] = given ? given[verb] === true : false;
    if (!actions[verb]) whyNot[verb] = given ? String(whyIn[verb] || "not offered for this session") : NO_VERDICT;
  }
  return { ...rest, actions, why_not: whyNot };
}

async function listSessions({ fetchImpl = globalThis.fetch, timeoutMs = 6000, antigravityDir = ANTIGRAVITY_DIR, now = Date.now() } = {}) {
  const antigravity = readAntigravitySessions({ dir: antigravityDir, now });
  const merged = (sessions) => {
    const ids = new Set(sessions.map((s) => String((s && (s.id || s.session_id)) || "")));
    return [...sessions, ...antigravity.filter((s) => !ids.has(s.id))];
  };
  const noteFor = (sessions, base) => {
    const extra = antigravity.length ? ` + ${antigravity.length} Antigravity` : "";
    return `${sessions.length} session(s)${extra}${base ? ` — ${base}` : ""}`;
  };
  const token = harnessToken();
  if (!token) {
    if (antigravity.length) {
      const sessions = merged([]);
      return { ok: true, sessions, note: noteFor(sessions, "no harness token: Antigravity only") };
    }
    return { ok: false, sessions: [], note: "no harness token (~/.aither/harness_token) — daemon never ran here?" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${DAEMON}/sessions/unified`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, sessions: [], note: `daemon refused the token (${res.status}) — restart it: adk harness serve` };
    }
    if (!res.ok) return { ok: false, sessions: [], note: `daemon answered ${res.status}` };
    const body = await res.json();
    const sessions = merged(withFocus(Array.isArray(body.sessions) ? body.sessions : [])).map(withActions);
    return { ok: true, sessions, note: noteFor(sessions, "") };
  } catch (error) {
    const why = error && error.name === "AbortError"
      ? `daemon did not answer within ${Math.round(timeoutMs / 1000)}s`
      : "daemon unreachable (start it: adk harness serve)";
    // A down daemon must not hide a fairy that is working right now: the Antigravity
    // conversations come from the disk, not from the daemon.
    if (antigravity.length) {
      const sessions = merged([]);
      return { ok: true, sessions, note: noteFor(sessions, why) };
    }
    return { ok: false, sessions: [], note: why };
  } finally {
    clearTimeout(timer);
  }
}

/** The last `maxLines` lines of a transcript, capped by BYTES so a huge JSONL
 *  cannot stall the pane, and read from the END — a tail is all this view
 *  shows, and reading a 200 MB file to print its last page is how a live view
 *  becomes the slowest pane in the window. */
function tailTranscript(transcriptPath, { maxLines = 60, maxBytes = 512 * 1024 } = {}) {
  const p = String(transcriptPath || "");
  if (!p) return { ok: false, lines: [], note: "session has no transcript_path" };
  let fd = null;
  try {
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - maxBytes);
    fd = fs.openSync(p, "r");
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    // A byte-window can open mid-multibyte or mid-line; drop the partial first line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n").filter((l) => l.trim());
    return {
      ok: true,
      lines: lines.slice(-maxLines),
      truncated: start > 0 || lines.length > maxLines,
      note: "",
    };
  } catch (error) {
    return { ok: false, lines: [], note: `cannot read transcript: ${(error && error.message) || error}` };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

const STATUS_ORDER = { working: 0, "waiting-input": 1, idle: 2 };

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * A short, prompt-sized brief of the owner's live sessions for the Command
 * agent (owner, 2026-09-22: "have context of all of my active sessions and
 * work"). Working sessions first. "Could not look" is said as such -- never an
 * empty list, which would read as "nothing is running".
 */
function sessionsBrief(result, { max = 15 } = {}) {
  if (!result || !result.ok) {
    return `The owner's active sessions: unknown right now (${(result && result.note) || "no answer"}).`;
  }
  const rows = [...result.sessions].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3),
  );
  if (!rows.length) return "The owner has no active agent sessions right now.";
  const lines = rows.slice(0, max).map((s) => {
    const summary = s.last_activity_summary ? ` -- ${clip(s.last_activity_summary, 90)}` : "";
    return `- [${s.status || "?"}] ${s.harness || "?"} ${String(s.id || "").slice(0, 12)}: ${clip(s.title, 70)}${summary}`;
  });
  const more = rows.length > max ? `\n(+${rows.length - max} more)` : "";
  return (
    `The owner's active agent sessions right now (${rows.length}), from the harness daemon:\n` +
    `${lines.join("\n")}${more}\n` +
    "When the owner asks about ongoing work, answer from these; to message or steer one, " +
    "use the awsh MCP tools (awsh_send / awsh_say) with its id."
  );
}

module.exports = { listSessions, readAntigravitySessions, ANTIGRAVITY_LIVE_MS, tailTranscript, harnessToken, sessionsBrief, focusFor, withFocus, withActions, VERBS, DAEMON };
