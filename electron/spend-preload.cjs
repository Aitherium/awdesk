"use strict";

/**
 * Bridge for the Spend pane (spend.html), injected by console-preload.cjs inside
 * the console, by browser-internal-preload.cjs for aither://spend, and used
 * directly by the detached window (spend-window.cjs).
 *
 * Read-only over the platform: `report` answers {ok:true, data, stale?, savedAt?} or
 * {ok:false, reason, notDeployed}. The only write is the owner's LOCAL budget
 * (userData/spend-budget.json), never anything on the platform.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSpend", {
  report: (hours, fresh) => ipcRenderer.invoke("desk:spend-report", Number(hours) || 24, { fresh: Boolean(fresh) }),
  budget: () => ipcRenderer.invoke("desk:spend-budget-get"),
  setBudget: (daily, monthly) => ipcRenderer.invoke("desk:spend-budget-set", {
    daily_usd: Number(daily) || 0, monthly_usd: Number(monthly) || 0,
  }),
});
