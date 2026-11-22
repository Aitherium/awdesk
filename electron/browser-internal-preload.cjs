"use strict";

/**
 * Preload for an aither:// tab of the Aither Browser (browser-internal.cjs).
 *
 * An internal tab is built with THIS preload and nothing else; web tabs get no
 * preload at all. It hands the page exactly ONE pane's bridge -- the preload the
 * Aither Console already gives that pane (command-preload, settings-preload, the
 * renderer's preload for ?deck=1 ...) -- required, never re-implemented, so a page
 * in a tab behaves exactly like the same pane in the console.
 *
 * It does nothing at all unless the document is on an aither: origin. An internal
 * tab cannot navigate to the web (browser-internal navigationVerdict sends a link
 * to a new web tab), and this check is the second wall if that ever slips.
 *
 * Not sandboxed for the same reason the console is not: a sandboxed preload's
 * require() resolves `electron` and nothing else. contextIsolation stays on and
 * nodeIntegration stays off, so page script reaches Node through nothing but the
 * pane's own exposed bridge.
 */

const { ipcRenderer } = require("electron");
const internal = require("./browser-internal.cjs");

const loc = globalThis.location;
const href = String((loc && loc.href) || "");

if (loc && loc.protocol === internal.PROTOCOL) {
  const preload = internal.preloadForUrl(href);
  if (preload) require(`./${preload}`);

  // The owner's theme, per document -- what console-preload.cjs paints into each pane.
  const doc = globalThis.document;
  let last = null;
  const paint = () => {
    const root = doc && doc.documentElement;
    if (!root || !last) return;
    if (last.theme && last.theme !== "dark-glass") root.dataset.theme = last.theme;
    else delete root.dataset.theme;
    if (Number.isFinite(last.uiScale)) root.style.setProperty("--ui-scale", String(last.uiScale));
  };
  ipcRenderer.invoke("desk:appearance-get").then((a) => { last = a; paint(); }).catch(() => {});
  ipcRenderer.on("desk:appearance-changed", (_event, a) => { last = a; paint(); });
  if (doc && doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", paint);
  else paint();
}
