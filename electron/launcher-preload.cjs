"use strict";

/**
 * Bridge for launcher.html (launcher-window.cjs). The page sees text and command
 * ids only: results carry no target (a path, a URL, clipboard text), and running a
 * row asks main to resolve the remembered item. No Electron API is exposed.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherLauncher", {
  search: (text) => ipcRenderer.invoke("launcher:search", String(text == null ? "" : text)),
  run: (key, query) => ipcRenderer.invoke("launcher:run", String(key || ""), String(query || "")),
  command: (line, confirm) => ipcRenderer.invoke("launcher:command", String(line || ""), confirm === true),
  ask: (text) => ipcRenderer.invoke("launcher:ask", String(text || "")),
  spirit: (text) => ipcRenderer.invoke("launcher:spirit", String(text || "")),
  act: (key, verb, text) => ipcRenderer.invoke("launcher:act", String(key || ""), String(verb || "open"), String(text || "")),
  hide: () => ipcRenderer.invoke("launcher:hide"),
  release: () => ipcRenderer.invoke("launcher:release"),
  onResults: (fn) => {
    const listener = (_event, payload) => { try { fn(payload); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("launcher:results", listener);
    return () => ipcRenderer.removeListener("launcher:results", listener);
  },
  onFocus: (fn) => {
    const listener = () => { try { fn(); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("launcher:focus", listener);
    return () => ipcRenderer.removeListener("launcher:focus", listener);
  },
});
