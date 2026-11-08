"use strict";

/**
 * gif-picker-preload.cjs -- the GIF picker's bridge (gif-picker-window.cjs).
 * Only result IDS cross it: main resolves an id to a URL itself, so the page can
 * never make the desk fetch, pin or drag an arbitrary address.
 */

const { contextBridge, ipcRenderer } = require("electron");

const id = (v) => String(v == null ? "" : v).slice(0, 100);

contextBridge.exposeInMainWorld("aitherGif", {
  init: () => ipcRenderer.invoke("gif:init"),
  search: (q) => ipcRenderer.invoke("gif:search", String(q == null ? "" : q).slice(0, 100)),
  pin: (resultId) => ipcRenderer.invoke("gif:pin", id(resultId)),
  toBoard: (resultId) => ipcRenderer.invoke("gif:to-board", id(resultId)),
  prefetch: (resultId) => ipcRenderer.invoke("gif:prefetch", id(resultId)),
  drag: (resultId) => ipcRenderer.send("gif:drag", id(resultId)),
  close: () => ipcRenderer.invoke("gif:close"),
  onQuery: (fn) => {
    const listener = (_event, q) => { try { fn(String(q || "")); } catch { /* page bug */ } };
    ipcRenderer.on("gif:query", listener);
    return () => ipcRenderer.removeListener("gif:query", listener);
  },
});
