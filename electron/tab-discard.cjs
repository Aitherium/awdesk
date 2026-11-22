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
 * Since 2026-11-13 (the first limits -- 10 minutes hidden, 3 kept live, the rest after a
 * minute -- reloaded pages the owner had only just left, and lost what they were doing):
 *   - a hidden tab is kept for about two hours, and twelve hidden tabs stay live;
 *   - three more kinds of tab are never discarded, also under memory pressure:
 *       notifies   the owner allowed this site to show notifications (mail, chat, a
 *                  calendar): a discarded page can no longer tell them anything;
 *       capturing  the page was given the camera or the microphone (a call in progress);
 *       unsaved    the page holds something the owner typed and has not sent. That one
 *                  cannot be known from main, so it is asked of the page itself, once,
 *                  right before the discard (UNSAVED_SCRIPT, in the isolated world).
 *
 * Pure: tab facts in, ids out.
 */

const IDLE_MS = 2 * 60 * 60 * 1000; // hidden this long: discarded
const KEEP_LIVE = 12; // at most this many hidden tabs keep a renderer
const MIN_HIDDEN_MS = 10 * 60 * 1000; // over the limit: still never one seen in the last ten minutes
const PRESSURE_MIN_HIDDEN_MS = 30 * 1000;
const DISCARDABLE_KINDS = new Set(["web", "hosted", "extension"]);

/**
 * Run in the page's isolated world right before a discard: true when the page holds
 * text the owner typed and has not sent. A text field or a text area whose value differs
 * from the one the page loaded with, or an editor (contenteditable) that has the focus
 * and has text in it. Passwords and hidden fields do not count.
 */
const UNSAVED_SCRIPT = `(() => {
  try {
    const typed = new Set(["text", "email", "url", "tel", "number", ""]);
    for (const el of document.querySelectorAll("textarea, input")) {
      if (el.disabled || el.readOnly) continue;
      if (el.tagName === "INPUT" && !typed.has(String(el.getAttribute("type") || "").toLowerCase())) continue;
      const value = String(el.value || "");
      if (value.trim() && value !== String(el.defaultValue || "")) return true;
    }
    const at = document.activeElement;
    if (at && at.isContentEditable && String(at.textContent || "").trim()) return true;
    return false;
  } catch {
    return false;
  }
})()`;

/** Why this tab is exempt beyond the classic rules, or null. */
function keepReason(t) {
  if (!t) return null;
  if (t.capturing) return "capturing";
  if (t.notifies) return "notifies";
  if (t.unsaved) return "unsaved";
  return null;
}

/**
 * @param {Array<{id, by, kind, pinned, active, popped, audible, discarded, shownAt,
 *   notifies?: boolean, capturing?: boolean, unsaved?: boolean}>} tabs
 * @param {{now: number, idleMs?: number, keepLive?: number, pressure?: boolean}} opts
 * @returns {number[]} ids to discard, oldest first
 */
function pickDiscards(tabs, { now, idleMs = IDLE_MS, keepLive = KEEP_LIVE, pressure = false } = {}) {
  if (!Array.isArray(tabs)) return [];
  const live = tabs
    .filter((t) => t && !t.active && !t.popped && !t.pinned && !t.audible && !t.discarded
      && t.by === "you" && DISCARDABLE_KINDS.has(t.kind || "web") && !keepReason(t))
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

/**
 * The last check before each discard: ask every picked tab's page whether it holds
 * unsaved input, and discard only the ones that do not. A page that cannot answer (it
 * crashed, it is gone) counts as having nothing to lose.
 *
 * @param {number[]} ids pickDiscards' answer
 * @param {(id: number) => Promise<unknown>} hasUnsaved resolves true when the page holds unsaved input
 * @param {(id: number) => void} discard
 * @returns {Promise<{discarded: number[], kept: number[]}>}
 */
async function discardUnlessUnsaved(ids, hasUnsaved, discard) {
  const discarded = [];
  const kept = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    let unsaved;
    try { unsaved = (await hasUnsaved(id)) === true; } catch { unsaved = false; }
    if (unsaved) { kept.push(id); continue; }
    discard(id);
    discarded.push(id);
  }
  return { discarded, kept };
}

module.exports = {
  DISCARDABLE_KINDS, IDLE_MS, KEEP_LIVE, MIN_HIDDEN_MS, PRESSURE_MIN_HIDDEN_MS, UNSAVED_SCRIPT,
  discardUnlessUnsaved, keepReason, pickDiscards,
};
