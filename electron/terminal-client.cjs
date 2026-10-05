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
  gemini: "Gemini", opencode: "OpenCode", aider: "Aider",
});
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_INPUT = 64 * 1024;

function validId(id) {
  return SESSION_ID.test(String(id || ""));
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
    async create({ harness = "terminal", cwd = "", title = "", rows = 30, cols = 100 } = {}) {
      if (!HARNESS_ORDER.includes(harness)) return { ok: false, error: `not a terminal harness: ${harness}` };
      const r = await call("POST", "/sessions", { harness, cwd: String(cwd || ""), title: String(title || "") },
        { timeoutMs: 30000 });
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

module.exports = { HARNESS_LABELS, HARNESS_ORDER, createSseParser, createTerminalClient, tabRow, validId };
