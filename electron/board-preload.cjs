"use strict";

/**
 * board-preload.cjs -- the only bridge between board.html and main.
 * No node, no remote: each call returns the handler's verdict.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherBoard", {
  init: () => ipcRenderer.invoke("board:init"),
  save: (patch) => ipcRenderer.invoke("board:save", patch),
  putAway: () => ipcRenderer.invoke("board:put-away"),
  close: () => ipcRenderer.invoke("board:close"),
  paste: () => ipcRenderer.invoke("board:paste"),
  exportPng: (dataUrl) => ipcRenderer.invoke("board:export", dataUrl),
  // The board's pinned cards: the same cards aither://canvas shows (pin-cards.js).
  pins: () => ipcRenderer.invoke("board:pins"),
  pinOp: (op) => ipcRenderer.invoke("board:pin-op", op && typeof op === "object" ? op : {}),
  pinViews: (data) => ipcRenderer.invoke("board:pin-views", data && typeof data === "object" ? data : {}),
  pinWidget: (id) => ipcRenderer.invoke("board:pin-widget", String(id ?? "")),
  pinOpen: (id) => ipcRenderer.invoke("board:pin-open", String(id ?? "")),
  /** The board changed elsewhere (the canvas, a pin from a tab): redraw its cards. */
  onChanged: (listener) => {
    const handler = (_event, board) => listener(board);
    ipcRenderer.on("board:changed", handler);
    return () => ipcRenderer.off("board:changed", handler);
  },
  /** An image main hands this board (the GIF picker's Shift+click). */
  onAddImage: (fn) => {
    const listener = (_event, img) => { try { fn(img); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("board:add-image", listener);
    return () => ipcRenderer.removeListener("board:add-image", listener);
  },
});
