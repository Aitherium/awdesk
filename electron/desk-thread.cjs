"use strict";

/**
 * desk-thread.cjs -- the ONE conversation thread on the desk (aither-host/1 os-thread).
 *
 * awconnect's Cloud chat, AitherOS Online (Veil os-thread.ts) and the desk's connect
 * panel share one server session (Genesis ConversationStore). This module is the desk's
 * copy of its id: AitherOS Online pages say os-thread through the desk preload, the
 * awconnect overlay over web tabs through browser-overlay.cjs (thread-get / thread-set),
 * and the connect panel's local-brain answers are appended to it so they are not lost to
 * every other surface (PUT /api/conversation/history -> Genesis /conversation/append).
 *
 * The bearer is the Online session's platform bearer (browser-window onlineToken) and is
 * used here, in main, only -- never handed to the connect panel's renderer.
 */

const THREAD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const API_BASE = "https://api.aitherium.com";
const MAX_CHARS = 32000;

/**
 * @param {object} deps
 * @param {() => Promise<string|null>} deps.token   the Online session's bearer
 * @param {Function} [deps.fetchImpl]
 * @param {() => string} [deps.mint]                a new thread id
 */
function createDeskThread({ token, fetchImpl = globalThis.fetch, mint = defaultMint, apiBase = API_BASE } = {}) {
  let current = null;
  const listeners = new Set();

  function get() { return current; }

  /** Move the desk to `threadId`; listeners hear it unless it came from them (`from`). */
  function set(threadId, from = "") {
    const id = String(threadId || "");
    if (!THREAD_ID.test(id)) return false;
    if (current === id) return true;
    current = id;
    for (const fn of listeners) { try { fn(id, from); } catch { /* one listener */ } }
    return true;
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function authHeaders() {
    let bearer;
    try { bearer = await token(); } catch { bearer = null; }
    return bearer ? { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" } : null;
  }

  /** The thread, resolving it once: the person's newest server session, else a new id. */
  async function resolve() {
    if (current) return current;
    const headers = await authHeaders();
    if (headers) {
      try {
        const r = await fetchImpl(`${apiBase}/api/conversation/sessions?limit=1`, { headers, signal: AbortSignal.timeout(5000) });
        const body = r && r.ok ? await r.json() : null;
        const sid = body && Array.isArray(body.sessions) && body.sessions[0] && body.sessions[0].session_id;
        if (!current && typeof sid === "string" && THREAD_ID.test(sid)) set(sid, "server");
      } catch { /* offline: a new thread */ }
    }
    if (!current) set(mint(), "new");
    return current;
  }

  /**
   * Append a question and the desk's own answer to the shared thread. Signed out = not
   * kept (null). Never throws; returns the server ids, or null.
   */
  async function persistTurn(question, reply, { source = "desk" } = {}) {
    const q = String(question || "").trim();
    const a = String(reply || "").trim();
    if (!q || !a) return null;
    const headers = await authHeaders();
    if (!headers) return null;
    const threadId = await resolve();
    try {
      const r = await fetchImpl(`${apiBase}/api/conversation/history`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ session_id: threadId, messages: [
          { role: "user", content: q.slice(0, MAX_CHARS), source },
          { role: "assistant", content: a.slice(0, MAX_CHARS), agent_id: "desk", source },
        ] }),
        signal: AbortSignal.timeout(8000),
      });
      const body = await r.json().catch(() => null);
      return r.ok && body && body.ok && Array.isArray(body.ids) ? body.ids.map(String) : null;
    } catch {
      return null;
    }
  }

  return { get, set, onChange, resolve, persistTurn };
}

function defaultMint() {
  const { randomUUID } = require("node:crypto");
  return `desk-${randomUUID()}`;
}

module.exports = { THREAD_ID, API_BASE, createDeskThread };
