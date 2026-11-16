"use strict";

/**
 * Bridge for assist.html (assist-window.cjs). The page can ask main to run a verb, route a
 * selection, accept / undo / copy a result, and run a listed utility by ID. It never sees a
 * window handle, a key chord, a path or an Electron API; main acts on the window it
 * captured when the pop-up opened.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherAssist", {
  state: () => ipcRenderer.invoke("assist:state"),
  run: (req) => ipcRenderer.invoke("assist:run", {
    verb: String((req && req.verb) || "write"), prompt: String((req && req.prompt) || ""),
    arg: String((req && req.arg) || ""), retryOf: req && req.retryOf ? String(req.retryOf) : "",
  }),
  route: (req) => ipcRenderer.invoke("assist:route", {
    verb: String((req && req.verb) || ""), agent: String((req && req.agent) || ""), name: String((req && req.name) || ""),
  }),
  refine: () => ipcRenderer.invoke("assist:refine"),
  accept: (text) => ipcRenderer.invoke("assist:accept", { text: text == null ? undefined : String(text) }),
  undo: () => ipcRenderer.invoke("assist:undo"),
  copy: (text) => ipcRenderer.invoke("assist:copy", { text: String(text || "") }),
  util: (id, arg) => ipcRenderer.invoke("assist:util", { id: String(id || ""), arg: arg == null ? undefined : String(arg) }),
  file: (action, arg) => ipcRenderer.invoke("assist:file", { action: String(action || ""), arg: arg == null ? "" : String(arg) }),
  close: () => ipcRenderer.invoke("assist:close"),
  onState: (fn) => {
    const listener = (_event, state) => { try { fn(state); } catch { /* page bug stays in the page */ } };
    ipcRenderer.on("assist:state", listener);
    return () => ipcRenderer.removeListener("assist:state", listener);
  },
});
