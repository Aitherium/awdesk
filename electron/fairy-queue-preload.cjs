"use strict";

/**
 * Bridge for the fairy's waiting list (fairy-queue.html). Three verbs, no more:
 * list the queue for the current filters, open one card on the desk's answer
 * path, close. The page never gets Node, the store directory or a write verb --
 * answering a card stays the Inbox's job (fairy-queue-window.cjs).
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherQueue", {
  list: (filters) => ipcRenderer
    .invoke("desk:fairy-queue-list", filters && typeof filters === "object" ? filters : {})
    .catch(() => ({ entries: [], sources: [], totalEntries: 0, totalCards: 0, shownEntries: 0, shownCards: 0, hiddenEntries: 0 })),
  open: (id) => ipcRenderer.invoke("desk:fairy-queue-open", String(id || "")).catch(() => ({ ok: false })),
  close: () => ipcRenderer.invoke("desk:fairy-queue-close").catch(() => ({ ok: false })),
  onRefresh: (fn) => {
    if (typeof fn !== "function") return;
    ipcRenderer.on("desk:fairy-queue-refresh", () => fn());
  },
});
