"use strict";

/**
 * Bridge for quick-menu.html (quick-menu.cjs). The page lists command ids and
 * asks main to run one; it never sees a path, a token or an Electron API.
 *
 * `release()` is the HOLD half of Alt+Space: the page is the only place that can
 * see the key coming UP, and main decides the slice from the real cursor.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherQuick", {
  items: () => ipcRenderer.invoke("quick:items"),
  run: (id) => ipcRenderer.invoke("quick:run", String(id || "")),
  release: () => ipcRenderer.invoke("quick:release"),
  hide: () => ipcRenderer.invoke("quick:hide"),
  onRefresh: (fn) => {
    const listener = () => { try { fn(); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("quick:refresh", listener);
    return () => ipcRenderer.removeListener("quick:refresh", listener);
  },
});
