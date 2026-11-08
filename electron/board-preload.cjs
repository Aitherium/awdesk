"use strict";

/**
 * board-preload.cjs -- the only bridge between board.html and main.
 * No node, no remote: five calls, each returning the handler's verdict.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherBoard", {
  init: () => ipcRenderer.invoke("board:init"),
  save: (patch) => ipcRenderer.invoke("board:save", patch),
  putAway: () => ipcRenderer.invoke("board:put-away"),
  close: () => ipcRenderer.invoke("board:close"),
  paste: () => ipcRenderer.invoke("board:paste"),
  exportPng: (dataUrl) => ipcRenderer.invoke("board:export", dataUrl),
  /** An image main hands this board (the GIF picker's Shift+click). */
  onAddImage: (fn) => {
    const listener = (_event, img) => { try { fn(img); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("board:add-image", listener);
    return () => ipcRenderer.removeListener("board:add-image", listener);
  },
});
