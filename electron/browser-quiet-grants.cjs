"use strict";

/**
 * browser-quiet-grants.cjs -- two things every browser lets a page do without asking.
 *
 * browser-permissions.cjs asks the owner about five permissions and denies the rest.
 * Two of "the rest" are not privacy questions and Edge never asks about them, yet their
 * denial broke everyday pages:
 *
 *   fullscreen                 a video's full-screen button (element.requestFullscreen())
 *   clipboard-sanitized-write  a "Copy" button (navigator.clipboard.writeText())
 *
 * Both are now allowed for the OWNER's own web tab, with no prompt. The rules:
 *   - an agent's tab is denied both, also when it rides the owner's session, and so is
 *     any tab while an agent drives it: an agent's page must not cover the screen or
 *     put text on the owner's clipboard.
 *   - console pages, hosted pages and extension pages are not judged here (denied).
 *   - clipboard write: the top frame only, and only right after the owner clicked or
 *     typed in that page. Chromium asks the embedder even when there was no click, so
 *     main checks the page's own user-activation flag (GESTURE_SCRIPT, run in the
 *     isolated world where the page cannot fake it) before it answers.
 *   - full screen: an embedded player's frame may ask too (Chromium already needs the
 *     embedding page's allow="fullscreen" and a click). The window's own Escape exits.
 *   - reading the clipboard is NOT here; it stays a prompt (browser-permissions.cjs).
 *
 * Pure: no electron.
 */

const QUIET = Object.freeze({
  fullscreen: Object.freeze({ frames: true, gesture: false }),
  "clipboard-sanitized-write": Object.freeze({ frames: false, gesture: true }),
});

/** Run in the isolated world of the asking page: did the owner just click or type here? */
const GESTURE_SCRIPT = "Boolean(navigator.userActivation && navigator.userActivation.isActive)";

/**
 * @param {object} req
 * @param {string} req.permission Electron's permission name
 * @param {object} [req.details]  Electron's details (isMainFrame)
 * @param {{by?: string, kind?: string}|null} req.tab the tab the request came from
 * @param {boolean} [req.agentDriving] an agent holds this tab right now
 * @returns {null | {allow: boolean, gesture: boolean}} null = not one of the two (the caller decides)
 */
function decide({ permission, details = {}, tab, agentDriving = false } = {}) {
  const rule = Object.prototype.hasOwnProperty.call(QUIET, String(permission || "")) ? QUIET[permission] : null;
  if (!rule) return null;
  const deny = { allow: false, gesture: false };
  if (!tab || tab.by !== "you" || (tab.kind || "web") !== "web") return deny;
  if (agentDriving) return deny;
  if (!rule.frames && details && details.isMainFrame === false) return deny;
  return { allow: true, gesture: rule.gesture };
}

module.exports = { GESTURE_SCRIPT, QUIET, decide };
