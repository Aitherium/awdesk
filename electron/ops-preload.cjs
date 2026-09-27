"use strict";

/**
 * Bridge for the Ops pane (ops.html), injected by console-preload.cjs inside the
 * console and used directly by the detached window (ops-window.cjs).
 *
 * Every verb answers {ok, data|error}. Runs always go out with via:"awdesk"
 * (ops-client.cjs adds it); approval of a guarded run is not a verb here.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherOps", {
  catalog: () => ipcRenderer.invoke("desk:ops-catalog"),
  state: (noun) => ipcRenderer.invoke("desk:ops-state", String(noun || "backups")),
  plan: (op, delegateTo) => ipcRenderer.invoke("desk:ops-plan", String(op || ""),
    { delegateTo: String(delegateTo || "") }),
  run: (op, delegateTo) => ipcRenderer.invoke("desk:ops-run", String(op || ""),
    { delegateTo: String(delegateTo || "") }),
  recent: (noun, limit) => ipcRenderer.invoke("desk:ops-status",
    { noun: String(noun || "backups"), limit: Number(limit) || 20 }),
  status: (runId) => ipcRenderer.invoke("desk:ops-status", String(runId || "")),
  cancel: (runId) => ipcRenderer.invoke("desk:ops-cancel", String(runId || "")),
  watch: (runId) => ipcRenderer.invoke("desk:ops-watch", String(runId || "")),
  onRunUpdate: (listener) => {
    const handler = (_event, payload) => listener(payload || {});
    ipcRenderer.on("desk:ops-run-update", handler);
    return () => ipcRenderer.off("desk:ops-run-update", handler);
  },
});
