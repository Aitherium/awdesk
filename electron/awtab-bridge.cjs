"use strict";

/**
 * awtab-bridge.cjs — the desk end of AitherTab: what the browser extension pushes.
 *
 * The extension (C:\AitherOS-Fresh\AitherOS\apps\awtab) posts ONE snapshot of the
 * owner's real tabs on every tab/group/window change (debounced). This module turns
 * that into the groups the desk mirrors, keeps the last snapshot per browser, and
 * queues the few commands the desk has for the extension (refresh, forget).
 *
 * Deliberately NOT the awconnect trust path: a tab-mirroring extension must never
 * inherit the shared trusted-extension list (that one unlocks /chrome/*, /commands/run,
 * /desktop/*, /speak, /assist/*). bridge-server gates this route separately, by
 * AWDESK_AWTAB_EXTENSION_IDS and/or a per-install token.
 *
 * PURE-ish: no electron, no fs. `apply(groups, {browser})` is injected, so
 * `node --test electron/awtab-bridge.test.cjs` pins it with no window.
 */

const awtab = require("./awtab.cjs");

/** A snapshot bigger than this is a bug, not a browse: refuse instead of mirroring junk. */
const MAX_SNAPSHOT_BYTES = 512 * 1024;

function createAwtabBridge({ apply = () => ({}), enabled = () => true, now = Date.now } = {}) {
  /** browser -> {at, groups} — the last snapshot each browser sent. */
  const last = new Map();
  /** browser -> [verb] waiting for that browser's next push (commands ride the reply). */
  const queued = new Map();

  function queue(verb, browser = "") {
    const b = String(browser || "");
    if (!b) {
      for (const key of last.keys()) queued.set(key, [...(queued.get(key) || []), verb]);
      return { ok: true, queued: [...last.keys()] };
    }
    queued.set(b, [...(queued.get(b) || []), verb]);
    return { ok: true, queued: [b] };
  }

  /**
   * One snapshot in. `enabled(browser)` is the owner's per-browser switch: a disabled
   * browser is ACKed (so the extension stops retrying) and mirrors nothing.
   */
  function push(raw) {
    const snapshot = awtab.normalizeSnapshot(raw);
    if (!snapshot) return { ok: false, error: "not an AitherTab snapshot" };
    if (!enabled(snapshot.browser)) {
      last.delete(snapshot.browser);
      apply([], { browser: snapshot.browser });
      return { ok: true, skipped: true, groups: 0, commands: take(snapshot.browser) };
    }
    const groups = awtab.planGroups(snapshot);
    last.set(snapshot.browser, { at: now(), groups });
    let applied;
    try {
      applied = apply(groups, { browser: snapshot.browser }) || {};
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    return { ok: true, groups: groups.length, applied, commands: take(snapshot.browser) };
  }

  function take(browser) {
    const verbs = queued.get(browser) || [];
    queued.delete(browser);
    return verbs;
  }

  /** Every mirrored group across browsers, in the order the browsers last spoke. */
  function groups() {
    return [...last.values()].flatMap((row) => row.groups);
  }

  /** Counts only: this is what a status surface may show without leaking URLs. */
  function status() {
    return {
      ok: true,
      browsers: [...last.entries()].map(([browser, row]) => ({
        browser, at: row.at, groups: row.groups.length,
        tabs: row.groups.reduce((n, g) => n + g.tabs.length, 0),
      })),
      total: groups().length,
    };
  }

  function forget(key) {
    const want = String(key || "");
    if (!want) return { ok: false, error: "no group key" };
    for (const [browser, row] of last) {
      const kept = row.groups.filter((g) => g.key !== want);
      if (kept.length !== row.groups.length) {
        last.set(browser, { ...row, groups: kept });
        apply(kept, { browser, forget: want });
        return { ok: true, forgotten: want };
      }
    }
    return { ok: true, forgotten: "" };
  }

  /** Stop mirroring one browser (its stage set is cleared; a later push rebuilds it). */
  function drop(browser) {
    const b = String(browser || "");
    if (!last.has(b)) return { ok: true, dropped: "" };
    last.delete(b);
    apply(groups(), { browser: b, dropped: true });
    return { ok: true, dropped: b };
  }

  return { push, groups, status, queue, forget, drop, take, MAX_SNAPSHOT_BYTES, last };
}

module.exports = { createAwtabBridge, MAX_SNAPSHOT_BYTES };
