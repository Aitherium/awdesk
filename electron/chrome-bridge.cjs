"use strict";

/**
 * chrome-bridge.cjs -- agents driving the owner's OWN Chrome, through awconnect,
 * one approved tab at a time (owner, 2026-10-03: "Yes, but ask each time").
 *
 * An MV3 extension cannot listen on a port, so the desk holds a QUEUE: an agent's
 * chrome_* MCP tool enqueues a request and waits; awconnect long-polls
 * POST /chrome/next (its pinned origin only; POST because Chrome sends no Origin on an extension GET), runs the request in the tab, and
 * posts POST /chrome/result. The desk never decides whether a tab may be driven:
 * awconnect does, because it is the side that can ASK the owner (a notification
 * per tab: Allow / Deny) and the side the owner's real sessions live in. Every
 * action on a tab the owner has not approved comes back REFUSED from awconnect.
 *
 * No awconnect polling = every call answers, loudly, that the extension is not
 * connected, after a short wait; a request never hangs an agent.
 */

const ACTIONS = Object.freeze(["tabs", "request_tab", "read", "snapshot", "click", "type", "select", "check"]);
/** The owner's Allow / Deny can take a while; everything else should be quick. */
const TIMEOUTS_MS = Object.freeze({ request_tab: 55_000, default: 25_000 }); // under an MCP client's 60 s
/** awconnect is "connected" if it polled this recently. */
const CONNECTED_WINDOW_MS = 40_000;
const MAX_QUEUE = 20;

function createChromeBridge({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let nextId = 1;
  const queue = []; // requests awconnect has not picked up yet
  const pending = new Map(); // id -> {resolve, timer}
  const waiters = []; // long-polls waiting for a request
  let lastPollAt = 0;

  function connected() {
    return lastPollAt > 0 && now() - lastPollAt < CONNECTED_WINDOW_MS;
  }

  function settle(id, result) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimer(entry.timer);
    const at = queue.findIndex((r) => r.id === id);
    if (at >= 0) queue.splice(at, 1);
    entry.resolve(result);
    return true;
  }

  /** An agent's call. Resolves with awconnect's answer or a refusal; never rejects. */
  function call(action, args = {}) {
    if (!ACTIONS.includes(action)) return Promise.resolve({ ok: false, error: `unknown chrome action ${action}` });
    if (queue.length >= MAX_QUEUE) return Promise.resolve({ ok: false, error: "too many Chrome requests waiting" });
    const id = nextId++;
    const request = { id, action, args: args && typeof args === "object" ? args : {} };
    return new Promise((resolve) => {
      const wait = TIMEOUTS_MS[action] || TIMEOUTS_MS.default;
      const timer = setTimer(() => settle(id, {
        ok: false,
        error: connected()
          ? `awconnect did not answer within ${Math.round(wait / 1000)} s`
          : "awconnect is not connected to this desk (install or update awconnect in Chrome, and keep Chrome open)",
      }), wait);
      pending.set(id, { resolve, timer });
      const waiter = waiters.shift();
      if (waiter) waiter(request);
      else queue.push(request);
    });
  }

  /** awconnect's long-poll: the next request, or null after `waitMs`. */
  function next(waitMs = 20_000) {
    lastPollAt = now();
    const ready = queue.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        const at = waiters.indexOf(take);
        if (at >= 0) waiters.splice(at, 1);
        resolve(null);
      }, waitMs);
      function take(request) {
        clearTimer(timer);
        resolve(request);
      }
      waiters.push(take);
    });
  }

  /** awconnect's answer to request `id`. */
  function result(id, value) {
    lastPollAt = now();
    const shaped = value && typeof value === "object" ? value : { ok: false, error: "awconnect sent no result" };
    return settle(Number(id), shaped);
  }

  function status() {
    return { connected: connected(), waiting: queue.length, inFlight: pending.size, lastPollAt };
  }

  return { call, next, result, status };
}

module.exports = { ACTIONS, CONNECTED_WINDOW_MS, TIMEOUTS_MS, createChromeBridge };
