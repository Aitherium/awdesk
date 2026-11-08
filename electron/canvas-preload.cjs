"use strict";

/**
 * Bridge for the Canvas page (canvas.html), injected by browser-internal-preload.cjs
 * for aither://canvas and by console-preload.cjs inside the console. Main answers
 * every channel only when the sender IS the canvas page (browser-canvas.cjs).
 *
 * The page draws boards and widgets itself; it never holds a live page. It reports
 * where each app card's body is (`views`) and main lays the real page over it.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherCanvas", {
  /** {ok, boards: {active, boards:[...]}, widgets: [{id,label,hint,view,size,refreshMs}]} */
  state: () => ipcRenderer.invoke("desk:canvas-state"),
  /** One edit (canvas-model.applyOp): {op:"card.move", id, x, y} ... */
  op: (op) => ipcRenderer.invoke("desk:canvas-op", op && typeof op === "object" ? op : {}),
  /** A widget's read-out: {ok, view, value|rows, sub, tone} or {ok:false, error}. */
  widget: (id) => ipcRenderer.invoke("desk:canvas-widget", String(id ?? "")),
  /** Where the board viewport and every app card body are, in this page's CSS px. */
  views: (payload) => ipcRenderer.invoke("desk:canvas-views", payload && typeof payload === "object" ? payload : {}),
  /** Open an app card's address in a tab of its own. */
  open: (id) => ipcRenderer.invoke("desk:canvas-open", String(id ?? "")),
  onBoards: (listener) => {
    const handler = (_event, boards) => listener(boards);
    ipcRenderer.on("desk:canvas-boards", handler);
    return () => ipcRenderer.off("desk:canvas-boards", handler);
  },
});
