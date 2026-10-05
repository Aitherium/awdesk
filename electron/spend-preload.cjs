"use strict";

/**
 * Bridge for the Spend pane (spend.html), injected by console-preload.cjs inside
 * the console, by browser-internal-preload.cjs for aither://spend, and used
 * directly by the detached window (spend-window.cjs).
 *
 * Read-only: one verb. It answers {ok:true, data} or {ok:false, reason, notDeployed}.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSpend", {
  report: (hours, fresh) => ipcRenderer.invoke("desk:spend-report", Number(hours) || 24, { fresh: Boolean(fresh) }),
});
