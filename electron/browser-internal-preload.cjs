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

const { ipcRenderer, webUtils } = require("electron");
const internal = require("./browser-internal.cjs");

const loc = globalThis.location;
const href = String((loc && loc.href) || "");

/** Is this document a SPLIT PANE (browser-window.cjs openSplit adds split=1)? */
function isSplitPane(address) {
  return /(?:[?&])split=1(?:&|$)/.test(String(address || ""));
}

/**
 * A folder or file dropped on the split PANE opens in Files in that pane (dock-in slice
 * 2). Only the pane wires this: a normal tab keeps the page's own drop behaviour, and a
 * web page has no preload at all. Paths are resolved HERE with webUtils -- page script
 * never names a path.
 */
function wireSplitDrop() {
  const doc = globalThis.document;
  if (!doc || typeof doc.addEventListener !== "function") return;
  const hasFiles = (dt) => Boolean(dt) && Array.from(dt.types || []).includes("Files");
  doc.addEventListener("dragover", (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  doc.addEventListener("drop", (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const paths = [];
    for (const f of Array.from(e.dataTransfer.files || [])) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) paths.push(p);
      } catch { /* a non-file drop */ }
    }
    if (paths.length) void ipcRenderer.invoke("desk:browser-drop", { paths, where: "split" });
  });
}

if (loc && loc.protocol === internal.PROTOCOL) {
  const preload = internal.preloadForUrl(href);
  if (preload) require(`./${preload}`);
  if (isSplitPane(href)) wireSplitDrop();

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
