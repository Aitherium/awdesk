"use strict";

/**
 * terminal-client.cjs -- the awsh layer: terminal tabs over the awsh harness daemon.
 *
 * Owner, 2026-10-04: "AND WHERE IS THE AWSH LAYER?? THERE SHOULD BASICALLY BE LIKE...
 * TERMINAL TABS/SESSIONS". The daemon (adk harness, 127.0.0.1:8362) already runs
 * real pty sessions -- a shell (`terminal`), Claude Code, Aither, Codex, Gemini,
 * OpenCode, Aider -- with raw ANSI output as `text.delta` events and a resumable SSE
 * stream. This module is the desk's client for exactly those verbs; the page
 * (terminal.html, xterm.js) renders them. Nothing here runs a process itself.
 *
 * The bearer (~/.aither/harness_token) stays in main: the page gets only this API's
 * results over IPC (terminal-window.cjs), never the token.
 *
 * fetch is injected, so every verb and the SSE parser are asserted under node --test.
 */

const { DAEMON, harnessToken } = require("./sessions-client.cjs");

/** The harnesses a tab may start, in the order the "+" menu lists them. */
const HARNESS_ORDER = Object.freeze(["terminal", "claude", "aither", "codex", "gemini", "opencode", "aider"]);
const HARNESS_LABELS = Object.freeze({
  terminal: "Shell", claude: "Claude Code", aither: "Aither", codex: "Codex",
  gemini: "Gemini", opencode: "OpenCode", aider: "Aider", node: "Node shell",
});
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_INPUT = 64 * 1024;
/**
 * A node shell's target, `[user@]host[:port]` -- the daemon's own rule (awdk
 * adk/harnesses/pty_session.py `_NODE_TARGET`), repeated here so the desk never
 * forwards a target the daemon would refuse. Nothing that starts with `-` passes:
 * the target lands on ssh's command line.
 */
const NODE_TARGET = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}(?::[0-9]{1,5})?$/;

function validId(id) {
  return SESSION_ID.test(String(id || ""));
}

function validNodeTarget(target) {
  if (typeof target !== "string" || !NODE_TARGET.test(target)) return false;
  // The daemon also refuses a port outside 1-65535; refuse it here so it never leaves.
  const port = /:([0-9]+)$/.exec(target);
  return !port || (Number(port[1]) >= 1 && Number(port[1]) <= 65535);
}

/** What the "+ New" menu needs from a daemon /nodes row; null for one it cannot open. */
function nodeRow(n) {
  if (!n || !validNodeTarget(n.target)) return null;
  return {
    name: String(n.name || n.target).slice(0, 80),
    target: n.target,
    host: String(n.host || ""),
    user: String(n.user || ""),
    port: String(n.port || ""),
    os: String(n.os || ""),
    online: n.online === true ? true : n.online === false ? false : null,
    source: String(n.source || ""),
  };
}

/**
 * Parse an SSE byte stream incrementally. Feed it text; it returns the complete
 * events seen so far ({event, data}) and keeps the unfinished tail.
 */
function createSseParser() {
  let buffer = "";
  return function feed(chunk) {
    buffer += String(chunk || "").replace(/\r\n/g, "\n");
    const out = [];
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue; // a keepalive comment
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) out.push({ event, data: data.join("\n") });
    }
    return out;
  };
}

/** What a tab strip needs from a daemon session row. */
function tabRow(s) {
  return {
    id: String(s.id || ""),
    harness: String(s.harness || ""),
    label: String(s.title || HARNESS_LABELS[s.harness] || s.harness_label || s.harness || "session"),
    state: String(s.state || ""),
    cwd: String(s.cwd || ""),
    exitCode: s.exit_code == null ? null : Number(s.exit_code),
    createdAt: Number(s.created_at) || 0,
  };
}

/**
 * A /sessions/unified row the dock may offer to RESUME: a Claude Code tab the daemon
 * discovered (origin "discovered"), not one it runs. null for anything else.
 */
function externalRow(s) {
  if (!s || s.origin !== "discovered" || s.harness !== "claude" || !validId(s.id)) return null;
  return {
    id: String(s.id),
    label: String(s.name || s.title || s.id).slice(0, 120),
    cwd: String(s.cwd || ""),
    status: String(s.status || ""),
    lastActivityAt: Number(s.last_activity_at) || 0,
  };
}

function createTerminalClient({ fetchImpl = globalThis.fetch, base = DAEMON, token = harnessToken } = {}) {
  const headers = (json = false) => {
    const h = { authorization: `Bearer ${typeof token === "function" ? token() : token}` };
    if (json) h["content-type"] = "application/json";
    return h;
  };

  async function call(method, pathname, body, { timeoutMs = 15000 } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${pathname}`, {
        method,
        headers: headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, error: `the awsh daemon did not answer (${(error && error.message) || error})` };
    }
    let data = null;
    try { data = await res.json(); } catch { /* an empty body */ }
    if (!res.ok) {
      const detail = data && data.detail;
      return { ok: false, status: res.status,
        error: typeof detail === "string" ? detail : `the awsh daemon answered ${res.status}` };
    }
    return { ok: true, data };
  }

  return {
    /** Harnesses this machine has, in menu order, with labels. */
    async harnesses() {
      const r = await call("GET", "/health", undefined, { timeoutMs: 5000 });
      if (!r.ok) return r;
      const installed = new Set((r.data && r.data.harnesses_installed) || []);
      return { ok: true, harnesses: HARNESS_ORDER.filter((id) => installed.has(id))
        .map((id) => ({ id, label: HARNESS_LABELS[id] })) };
    },
    /** Every session the daemon manages (the ones a tab can attach to). */
    async list() {
      const r = await call("GET", "/sessions");
      if (!r.ok) return r;
      const rows = Array.isArray(r.data) ? r.data : (r.data && r.data.sessions) || [];
      return { ok: true, sessions: rows.map(tabRow).filter((s) => validId(s.id)) };
    },
    /**
     * Claude Code tabs the daemon DISCOVERED running elsewhere (Windows Terminal, an IDE).
     * Their pty is not the daemon's, so they cannot be typed into or mirrored; what a
     * terminal tab CAN do is resume one (`claude --resume <id>` under the daemon).
     */
    async external() {
      const r = await call("GET", "/sessions/unified", undefined, { timeoutMs: 8000 });
      if (!r.ok) return r;
      const rows = (r.data && Array.isArray(r.data.sessions)) ? r.data.sessions : [];
      return { ok: true, sessions: rows.map(externalRow).filter(Boolean) };
    },
    /**
     * `GET /sessions/unified`, split by ORIGIN (contract v1): the daemon's own sessions
     * ("daemon" -- attach directly) and the interactive Claude Code tabs it discovered
     * ("discovered" -- Windows Terminal owns their pty, so they can only be RESUMED).
     * The "+" picker lists exactly this.
     */
    async unified() {
      const r = await call("GET", "/sessions/unified", undefined, { timeoutMs: 8000 });
      if (!r.ok) return r;
      const rows = (r.data && Array.isArray(r.data.sessions)) ? r.data.sessions : [];
      const sessions = [];
      const external = [];
      for (const s of rows) {
        if (!s || !validId(s.id)) continue;
        const origin = String(s.origin || "daemon");
        if (origin === "discovered") {
          const row = externalRow(s);
          if (row) external.push(row);
          continue;
        }
        sessions.push({
          id: String(s.id),
          harness: String(s.harness || ""),
          label: String(s.name || s.title || HARNESS_LABELS[s.harness] || s.harness || "session").slice(0, 120),
          state: String(s.status || s.state || ""),
          cwd: String(s.cwd || ""),
          exitCode: s.exit_code == null ? null : Number(s.exit_code),
          // The /sessions/unified wire row (contract v1, adk daemon `_unified_row`)
          // carries last_activity_at and NEVER created_at: keying this on created_at
          // left every daemon row at 0 and the picker in directory order.
          lastActivityAt: Number(s.last_activity_at) || 0,
        });
      }
      return { ok: true, sessions, external };
    },
    /** Reopen a Claude Code session by its own id, as a daemon pty tab (claude-tty). */
    async resume(id, { cwd = "", rows = 30, cols = 100 } = {}) {
      if (!validId(id)) return { ok: false, error: "bad session id" };
      const r = await call("POST", "/sessions", { harness: "claude-tty", resume_session_id: id,
        cwd: String(cwd || ""), title: "" }, { timeoutMs: 60000 });
      if (!r.ok) return r;
      const session = tabRow(r.data || {});
      if (validId(session.id)) await call("POST", `/sessions/${session.id}/resize`, { rows, cols }).catch(() => {});
      return { ok: true, session };
    },
    /**
     * Machines a node shell can open (the daemon's GET /nodes: your ssh_config aliases
     * plus the tailnet peers online now). An older daemon without the route answers 404:
     * that is "no nodes section", not an error the menu should shout.
     */
    async nodes() {
      const r = await call("GET", "/nodes", undefined, { timeoutMs: 8000 });
      if (!r.ok) return r.status === 404 ? { ok: true, nodes: [] } : r;
      const rows = (r.data && Array.isArray(r.data.nodes)) ? r.data.nodes : [];
      return { ok: true, nodes: rows.map(nodeRow).filter(Boolean) };
    },
    async create({ harness = "terminal", cwd = "", title = "", rows = 30, cols = 100, target = "" } = {}) {
      const node = harness === "node";
      if (!node && !HARNESS_ORDER.includes(harness)) return { ok: false, error: `not a terminal harness: ${harness}` };
      if (node && !validNodeTarget(target)) return { ok: false, error: `not a node target: ${String(target).slice(0, 80)}` };
      const body = { harness, cwd: String(cwd || ""), title: String(title || "") };
      if (node) body.target = target;
      const r = await call("POST", "/sessions", body, { timeoutMs: 30000 });
      if (!r.ok) return r;
      const session = tabRow(r.data || {});
      if (validId(session.id)) await call("POST", `/sessions/${session.id}/resize`, { rows, cols }).catch(() => {});
      return { ok: true, session };
    },
    async input(id, text) {
      if (!validId(id)) return { ok: false, error: "bad session id" };
      const data = String(text == null ? "" : text);
      if (data.length > MAX_INPUT) return { ok: false, error: "input too large" };
      return call("POST", `/sessions/${id}/input`, { text: data, submit: false });
    },
    async resize(id, rows, cols) {
      if (!validId(id)) return { ok: false, error: "bad session id" };
      const r = Math.max(2, Math.min(500, Math.floor(Number(rows) || 0)));
      const c = Math.max(2, Math.min(1000, Math.floor(Number(cols) || 0)));
      return call("POST", `/sessions/${id}/resize`, { rows: r, cols: c });
    },
    async interrupt(id) {
      if (!validId(id)) return { ok: false, error: "bad session id" };
      return call("POST", `/sessions/${id}/interrupt`, {});
    },
    async close(id) {
      if (!validId(id)) return { ok: false, error: "bad session id" };
      return call("DELETE", `/sessions/${id}`);
    },
    /**
     * Follow a session's events from `since`. Calls onEvent(event) per daemon event
     * and resolves when the stream ends (exit, abort, or a dead daemon).
     */
    async stream(id, since, onEvent, signal) {
      if (!validId(id)) return { ok: false, error: "bad session id" };
      let res;
      try {
        res = await fetchImpl(`${base}/sessions/${id}/stream?since=${Math.max(0, Number(since) || 0)}`,
          { headers: headers(), signal });
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
      if (!res.ok || !res.body) return { ok: false, status: res.status, error: `stream answered ${res.status}` };
      const feed = createSseParser();
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          for (const frame of feed(decoder.decode(chunk, { stream: true }))) {
            let event;
            try { event = JSON.parse(frame.data); } catch { continue; }
            onEvent(event);
          }
        }
      } catch (error) {
        if (!(signal && signal.aborted)) return { ok: false, error: String((error && error.message) || error) };
      }
      return { ok: true };
    },
  };
}

module.exports = {
  HARNESS_LABELS, HARNESS_ORDER, createSseParser, createTerminalClient, externalRow, nodeRow, tabRow,
  validId, validNodeTarget,
};
