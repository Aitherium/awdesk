"use strict";

/**
 * tab-discard -- which hidden Aither Browser tabs give their renderer back.
 *
 * Every tab used to keep a live renderer for as long as it existed, on screen or not, so
 * the browser's weight grew with every tab ever opened. A DISCARDED tab keeps its place,
 * label and address on the strip; its renderer is closed and the page reloads when the
 * tab is shown again (browser-window.cjs restoreDiscarded).
 *
 * Never discarded: the tab on screen, a pinned tab (Inbox, AitherOS Online, Workspace),
 * a popped-out tab, a tab playing sound, an agent's tab (it may be mid-task) and an
 * Aither page (aither://, its pane state lives in the renderer).
 *
 * Pure: tab facts in, ids out.
 */

const IDLE_MS = 10 * 60 * 1000; // hidden this long: discarded
const KEEP_LIVE = 3; // at most this many hidden tabs keep a renderer
const MIN_HIDDEN_MS = 60 * 1000; // never one seen in the last minute (no thrash)
const PRESSURE_MIN_HIDDEN_MS = 30 * 1000;
const DISCARDABLE_KINDS = new Set(["web", "hosted", "extension"]);

/**
 * @param {Array<{id, by, kind, pinned, active, popped, audible, discarded, shownAt}>} tabs
 * @param {{now: number, idleMs?: number, keepLive?: number, pressure?: boolean}} opts
 * @returns {number[]} ids to discard, oldest first
 */
function pickDiscards(tabs, { now, idleMs = IDLE_MS, keepLive = KEEP_LIVE, pressure = false } = {}) {
  if (!Array.isArray(tabs)) return [];
  const live = tabs
    .filter((t) => t && !t.active && !t.popped && !t.pinned && !t.audible && !t.discarded
      && t.by === "you" && DISCARDABLE_KINDS.has(t.kind || "web"))
    .map((t) => ({ id: t.id, hiddenFor: now - (Number(t.shownAt) || 0) }))
    .sort((a, b) => b.hiddenFor - a.hiddenFor); // oldest first
  const out = [];
  if (pressure) {
    for (const t of live) if (t.hiddenFor >= PRESSURE_MIN_HIDDEN_MS) out.push(t.id);
    return out;
  }
  let remaining = live.length;
  for (const t of live) {
    const idle = t.hiddenFor >= idleMs;
    const over = remaining > keepLive && t.hiddenFor >= MIN_HIDDEN_MS;
    if (idle || over) {
      out.push(t.id);
      remaining -= 1;
    }
  }
  return out;
}

module.exports = { DISCARDABLE_KINDS, IDLE_MS, KEEP_LIVE, MIN_HIDDEN_MS, pickDiscards };
