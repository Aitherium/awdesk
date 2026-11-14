"use strict";

/**
 * browser-popups.cjs -- what window.open() from a page becomes.
 *
 * Until now every window.open was DENIED and its address reopened as an unrelated tab.
 * The new tab had no window.opener, so "Sign in with Google", PayPal and every other
 * popup flow that reports back with opener.postMessage (or that the opener closes when
 * it is done) never finished.
 *
 * A popup from a WEB tab is now ADOPTED: Electron hands main the popup's own page
 * (setWindowOpenHandler -> {action: "allow", createWindow}, measured on Electron 39.8.10:
 * options.webContents is the popup, and `new WebContentsView({webContents})` shows it),
 * and the browser makes it a TAB beside its opener. It keeps window.opener, the opener
 * keeps its handle, and window.close() from the popup closes that tab.
 *
 * The rules, all in popupVerdict():
 *   - the popup belongs to whoever owns the opener. An agent page's popup is the
 *     agent's tab, in the agent's session; an InPrivate tab's popup is InPrivate. A
 *     popup can never move a page to another owner or another session: it is created
 *     in the opener's session by Chromium, with the opener's sandbox and no preload.
 *   - an agent's tab that rides the OWNER's session (the owner allowed that one site,
 *     "Let the agent use my sign-in") is never adopted from: an adopted popup stays in
 *     its opener's session whatever it loads, so it would carry the owner's cookies to
 *     any site the page names. Its popup opens the old way, where the session is
 *     picked again for the popup's own address.
 *   - only http(s) addresses, or about:blank (a page that opens an empty popup and
 *     then navigates it, the usual sign-in shape). javascript:, file:, data: and
 *     aither: are refused; the popup's later navigations go through the tab's guard.
 *   - only a WEB tab's popup is adopted. A console page, a hosted page (the signed-in
 *     Online tab carries a desk preload) and an extension page keep the old behaviour:
 *     the address opens as a separate tab with no opener, so their preload and session
 *     never reach a page they open.
 *   - the owner's popup to an Aitherium page (app.aitherium.com) also keeps the old
 *     behaviour: that page opens in its own signed-in tab, never in the web session.
 *   - at most POPUP_BURST popups per ROOT opener in POPUP_WINDOW_MS, counted over the
 *     whole chain (a popup's own popups) and over both ways of opening (rootOf). A page that opens
 *     windows in a loop is refused after that.
 *
 * Pure: no electron.
 */

const POPUP_BURST = 6;
const POPUP_WINDOW_MS = 10_000;
const WEB = new Set(["http:", "https:"]);

function schemeOf(url) {
  try { return new URL(String(url || "")).protocol; } catch { return ""; }
}

/** An address a popup may start on: a web page, or the empty page a script then navigates. */
function popupUrlOk(url) {
  const text = String(url == null ? "" : url);
  return text === "" || text === "about:blank" || WEB.has(schemeOf(text));
}

/**
 * @param {object} req
 * @param {{by: string, kind?: string, private?: boolean, ownerSession?: boolean}|null} req.opener the tab that
 *   called window.open; ownerSession = an AGENT tab riding the owner's session
 * @param {string} req.url the popup's first address
 * @param {string} [req.disposition] Electron's disposition ("new-window", "foreground-tab", "background-tab"...)
 * @param {number} [req.recent] popups this opener made inside the window (createPopupLedger.count)
 * @param {(url: string) => boolean} [req.isInternalUrl] true for an aither:// page address
 * @param {(url: string) => boolean} [req.isHostedSite] true for an Aitherium page that opens signed in
 * @returns {{action: "adopt"|"tab"|"deny", by?: string, activate?: boolean, private?: boolean, reason?: string}}
 *   adopt = a tab that keeps its opener; tab = the old way (a separate tab, no opener)
 */
function popupVerdict({ opener, url, disposition = "", recent = 0, isInternalUrl = () => false, isHostedSite = () => false } = {}) {
  if (!opener || (opener.by !== "you" && opener.by !== "agent")) return { action: "deny", reason: "no opener tab" };
  // The burst limit covers every way a page opens a tab, the old no-opener way too.
  if (recent >= POPUP_BURST) return { action: "deny", reason: "too many popups from this page" };
  const kind = opener.kind || "web";
  const activate = disposition !== "background-tab";
  if (kind !== "web") {
    // Console, hosted and extension pages: never adopted (their preload and session stay theirs).
    if (WEB.has(schemeOf(url))) return { action: "tab", by: opener.by, activate: true };
    if (kind === "internal" && isInternalUrl(url)) return { action: "tab", by: "you", activate: true };
    return { action: "deny", reason: "not a page this tab may open" };
  }
  if (!popupUrlOk(url)) return { action: "deny", reason: "only web pages open as popups" };
  // An agent tab on the owner's session: the popup's session is picked for its own address.
  if (opener.by === "agent" && opener.ownerSession) {
    return WEB.has(schemeOf(url)) ? { action: "tab", by: "agent", activate: true } : { action: "deny", reason: "not a page this tab may open" };
  }
  // The owner's link to an Aitherium page opens the way it always did: its own signed-in
  // tab (or its aither:// page), which a web page's session must not be handed.
  if (opener.by === "you" && isHostedSite(url)) return { action: "tab", by: "you", activate: true };
  return { action: "adopt", by: opener.by, activate, private: Boolean(opener.private) };
}

/**
 * The tab a burst is counted against: the ROOT of the chain of pages that opened each
 * other. Every tab a page opens carries its opener's root (`popupRoot`), so a popup that
 * opens popups spends the same allowance instead of getting a fresh one each time.
 * @param {{popupRoot?: number|null}|null} opener the tab that called window.open
 * @param {number} openerId its id
 */
function rootOf(opener, openerId) {
  return opener && opener.popupRoot != null ? opener.popupRoot : openerId;
}

/** How many popups each ROOT opener's chain made lately (the burst limit). */
function createPopupLedger({ now = () => Date.now(), windowMs = POPUP_WINDOW_MS } = {}) {
  const byOpener = new Map(); // opener tab id -> [timestamps]
  const live = (id) => {
    const cut = now() - windowMs;
    const list = (byOpener.get(id) || []).filter((t) => t > cut);
    if (list.length) byOpener.set(id, list);
    else byOpener.delete(id);
    return list;
  };
  return {
    count: (id) => live(id).length,
    note(id) {
      const list = live(id);
      list.push(now());
      byOpener.set(id, list);
      return list.length;
    },
    forget: (id) => byOpener.delete(id),
  };
}

module.exports = { POPUP_BURST, POPUP_WINDOW_MS, createPopupLedger, popupUrlOk, popupVerdict, rootOf };
