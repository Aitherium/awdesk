"use strict";

/**
 * Bridge for aither://terminal (terminal.html), injected by browser-internal-preload.cjs
 * (the `<stem>-preload.cjs` convention) and console-preload.cjs. Main checks that every
 * call comes from the terminal page (terminal-window.cjs); the daemon's bearer never
 * crosses this bridge.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherTerminal", {
  harnesses: () => ipcRenderer.invoke("desk:terminal-harnesses"),
  list: () => ipcRenderer.invoke("desk:terminal-list"),
  create: (opts) => ipcRenderer.invoke("desk:terminal-create", {
    harness: String((opts && opts.harness) || "terminal"),
    cwd: String((opts && opts.cwd) || ""),
    title: String((opts && opts.title) || ""),
    rows: Number(opts && opts.rows) || 30,
    cols: Number(opts && opts.cols) || 100,
  }),
  input: (id, text) => ipcRenderer.invoke("desk:terminal-input", String(id), String(text ?? "")),
  resize: (id, rows, cols) => ipcRenderer.invoke("desk:terminal-resize", String(id), Number(rows), Number(cols)),
  interrupt: (id) => ipcRenderer.invoke("desk:terminal-interrupt", String(id)),
  close: (id) => ipcRenderer.invoke("desk:terminal-close", String(id)),
  attach: (id, since) => ipcRenderer.invoke("desk:terminal-attach", String(id), Number(since) || 0),
  detach: (id) => ipcRenderer.invoke("desk:terminal-detach", String(id)),
  external: () => ipcRenderer.invoke("desk:terminal-external"),
  resume: (id, cwd) => ipcRenderer.invoke("desk:terminal-resume", String(id), String(cwd || "")),
  /** The browser's bottom dock: "open" | "close" | "toggle" | "state" | "popout" (arg = session id). */
  dock: (action, arg) => ipcRenderer.invoke("desk:terminal-dock", String(action), arg == null ? null : String(arg)),
  onDockState: (listener) => {
    const handler = (_event, s) => listener({ open: Boolean(s && s.open) });
    ipcRenderer.on("desk:terminal-dock-state", handler);
    return () => ipcRenderer.off("desk:terminal-dock-state", handler);
  },
  onEvent: (listener) => {
    const handler = (_event, id, payload) => listener(String(id), payload);
    ipcRenderer.on("desk:terminal-event", handler);
    return () => ipcRenderer.off("desk:terminal-event", handler);
  },
});
