"use strict";

/**
 * Bridge for the Aither Browser's library pages (library-*.html): aither://history,
 * aither://bookmarks, aither://downloads, aither://permissions, aither://clear-data.
 * One bridge for the five; main answers each channel only to the page that owns it
 * (browser-library-pages.cjs), so the history page cannot read bookmarks through it.
 */
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel, ...args) => ipcRenderer.invoke(`desk:library-${channel}`, ...args);

contextBridge.exposeInMainWorld("aitherLibrary", {
  /** Open a web address in a tab; show another library page. */
  open: (url) => call("open", String(url ?? "")),
  goto: (page) => call("goto", String(page ?? "")),
  history: {
    list: (query) => call("history-list", query || {}),
    remove: (url) => call("history-remove", String(url ?? "")),
    removeRange: (span) => call("history-remove-range", span || {}),
    clear: () => call("history-clear"),
  },
  bookmarks: {
    list: () => call("bookmarks-list"),
    add: (row) => call("bookmarks-add", row || {}),
    update: (url, patch) => call("bookmarks-update", String(url ?? ""), patch || {}),
    remove: (url) => call("bookmarks-remove", String(url ?? "")),
    addFolder: (name) => call("bookmarks-folder-add", String(name ?? "")),
    renameFolder: (from, to) => call("bookmarks-folder-rename", String(from ?? ""), String(to ?? "")),
    removeFolder: (name, keep) => call("bookmarks-folder-remove", String(name ?? ""), Boolean(keep)),
    exportHtml: () => call("bookmarks-export"),
    importHtml: () => call("bookmarks-import"),
    setBar: (on) => call("bookmarks-bar", Boolean(on)),
  },
  downloads: {
    list: () => call("downloads-list"),
    open: (id) => call("downloads-open", Number(id)),
    show: (id) => call("downloads-show", Number(id)),
    retry: (id) => call("downloads-retry", Number(id)),
    remove: (id) => call("downloads-remove", Number(id)),
    clear: () => call("downloads-clear"),
  },
  permissions: {
    list: () => call("permissions-list"),
    remove: (origin, kind) => call("permissions-remove", String(origin ?? ""), kind == null ? "" : String(kind)),
    clear: () => call("permissions-clear"),
  },
  clearData: {
    summary: () => call("clear-summary"),
    run: (input) => call("clear-run", input || {}),
  },
  /** Main says the data behind this page moved (a visit, a download's progress). */
  onChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("desk:library-changed", handler);
    return () => ipcRenderer.off("desk:library-changed", handler);
  },
});
