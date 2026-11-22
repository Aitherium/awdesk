"use strict";

/**
 * browser-page-errors.cjs -- a page that crashed or did not load says so.
 *
 * Two cases left a tab blank with no word of why:
 *   - the page's renderer died (out of memory, a GPU fault): the toolbar now shows
 *     "This page crashed." with Reload.
 *   - a link the owner followed did not load (no network, the site is down, a refused
 *     connection). Only an address typed in the bar got the dark "This page didn't
 *     open" page (aither-address.cjs errorPageUrl); a followed link got Chromium's
 *     empty error document. Every main-frame failure now gets the same page.
 *
 * Pure: no electron.
 */

/** net::ERR_ABORTED: a navigation another one replaced, a download, a 204. Not an error. */
const ERR_ABORTED = -3;

/**
 * The notice for a renderer that is gone, or null when it ended on purpose.
 * @param {{reason?: string}} [details] Electron's render-process-gone details
 */
function crashNotice(details) {
  const reason = String((details && details.reason) || "");
  if (reason === "clean-exit") return null;
  return {
    kind: "crashed",
    text: reason === "oom" ? "This page ran out of memory." : "This page crashed.",
    actions: [{ id: "crash-reload", label: "Reload" }, { id: "dismiss", label: "Not now" }],
  };
}

/**
 * Should a failed load show the error page? Only a web page's own top frame, and
 * never an aborted navigation.
 * @param {{code: number, desc?: string, url: string, isMainFrame: boolean}} failure did-fail-load's arguments
 * @returns {{url: string, reason: string} | null}
 */
function failedLoad({ code, desc = "", url, isMainFrame } = {}) {
  if (!isMainFrame || !Number.isInteger(code) || code === ERR_ABORTED || code >= 0) return null;
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  return { url: String(url), reason: `${String(desc || "the page did not load").slice(0, 120)} (${code})` };
}

module.exports = { ERR_ABORTED, crashNotice, failedLoad };
