"use strict";

/**
 * desk-inbox.cjs -- "Message everyone -> My devices" reaches the desk.
 *
 * Owner (2026-10-18): "what if I want to send messages to the whole house or all devices in
 * my mesh?" Hearth's broadcast route (lib/hearth/broadcast_router.py) queues a "My devices"
 * message for the sender's OWN desk; this loop long-polls that queue through Veil
 * (POST https://api.aitherium.com/api/push/broadcast/desk) with the desk's ONE identity --
 * the Online session's platform bearer (browser-window onlineToken, as desk-thread.cjs) --
 * and shows each message as a desktop notification, speaking it when the sender asked.
 *
 * The queue is keyed by the bearer's own account on the server, so the desk can only ever
 * read messages its signed-in person sent to themselves. Signed out = the loop idles. The
 * first answer only sets the cursor, so a desk that starts up never replays a day of
 * messages; the server keeps them 24 h for a desk that was off, and the receipt said so.
 */

const API_BASE = "https://api.aitherium.com";
const ROUTE = "/api/push/broadcast/desk";
const WAIT_S = 20;
const IDLE_MS = 30_000;
const ERROR_MS = 15_000;

/**
 * @param {object} deps
 * @param {() => Promise<string|null>|string|null} deps.token   the Online session's bearer
 * @param {(title: string, body: string, urgent: boolean) => void} deps.notify
 * @param {(text: string) => unknown} [deps.speak]
 * @param {Function} [deps.fetchImpl]
 * @param {(fn: Function, ms: number) => unknown} [deps.schedule]
 */
function createDeskInbox({ token, notify, speak = null, fetchImpl = globalThis.fetch,
  apiBase = API_BASE, schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let cursor = null; // null = never answered: the first answer sets it and shows nothing
  let running = false;
  let stopped = false;
  const shown = new Set();

  async function bearer() {
    try { return (await token()) || null; } catch { return null; }
  }

  /** One poll. Returns the delay (ms) before the next one. Never throws. */
  async function tick() {
    const b = await bearer();
    if (!b) return IDLE_MS;
    const first = cursor === null;
    let res;
    try {
      res = await fetchImpl(`${apiBase}${ROUTE}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ since: first ? 0 : cursor, wait_s: first ? 0 : WAIT_S }),
        signal: AbortSignal.timeout((WAIT_S + 15) * 1000),
      });
    } catch {
      return ERROR_MS;
    }
    if (!res || !res.ok) return res && (res.status === 401 || res.status === 403) ? IDLE_MS : ERROR_MS;
    let data;
    try { data = await res.json(); } catch { return ERROR_MS; }
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (first) {
      cursor = Number(data && data.now) || Date.now() / 1000;
      return 0;
    }
    for (const item of items) {
      if (!item || typeof item !== "object" || shown.has(item.id)) continue;
      shown.add(item.id);
      const title = String(item.title || "Message").slice(0, 80);
      const body = String(item.body || "").slice(0, 240);
      try { notify(title, body, !!item.urgent); } catch { /* no notification surface */ }
      if (item.speak && speak && body) {
        try { void Promise.resolve(speak(body)).catch(() => {}); } catch { /* voice is optional */ }
      }
    }
    if (shown.size > 500) shown.clear();
    cursor = Math.max(cursor, Number(data && data.cursor) || cursor);
    return 0;
  }

  function loop() {
    if (stopped) { running = false; return; }
    void tick().then((delay) => schedule(loop, delay || 250));
  }

  return {
    start() { if (!running) { running = true; stopped = false; loop(); } },
    stop() { stopped = true; },
    tick,
    cursor: () => cursor,
  };
}

module.exports = { createDeskInbox, ROUTE };
