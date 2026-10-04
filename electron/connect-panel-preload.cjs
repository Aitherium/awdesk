"use strict";

// Preload for the Aither Browser's CONNECT PANEL (connect-panel.html): awconnect's
// side panel inside the desk's browser. This object is the whole contract the
// panel speaks; main checks the sender of every call (browser-window.cjs fromPanel).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherAssist", {
  state: () => ipcRenderer.invoke("desk:browser-state"),
  /** Chat about the page on screen: the question, plus {selection, history:[{q,a}]}. */
  ask: (question, extra) => ipcRenderer.invoke("desk:browser-ask", String(question ?? ""), extra || {}),
  /** What the owner has selected on the page on screen. */
  selection: () => ipcRenderer.invoke("desk:browser-selection"),
  /** Hand a task on this page to an agent (it works in its own tab). */
  task: (instruction) => ipcRenderer.invoke("desk:browser-task", String(instruction ?? "")),
  /** The page on screen, in the owner's own browser (their signed-in Chrome). */
  openExternal: () => ipcRenderer.invoke("desk:browser-open-external"),
  /** The Agents tab: AGENTS_VIEW v1 (agents-panel.cjs) -- live sessions, open cards, the room. */
  agents: () => ipcRenderer.invoke("desk:browser-agents"),
  /** Answer an open card with one of ITS option keys (main re-checks both, then the Inbox's path). */
  answerCard: (id, choice) => ipcRenderer.invoke("desk:browser-agents-answer", String(id ?? ""), String(choice ?? "")),
  clearDownloads: () => ipcRenderer.send("desk:browser-downloads-clear"),
  showDownload: (id) => ipcRenderer.send("desk:browser-download-show", Number(id)),
  onState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:browser-state", handler);
    return () => ipcRenderer.off("desk:browser-state", handler);
  },
});
