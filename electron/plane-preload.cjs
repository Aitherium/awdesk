"use strict";

/**
 * Bridge for the plane pages (plane-<id>.html), injected by console-preload.cjs
 * inside the console and used directly by the detached window (plane-window.cjs).
 *
 * Read-only: one snapshot verb per plane. Every call answers {ok, data|error}.
 * The Pulse page also carries a cloud-spend card (spend-window.cjs owns those two
 * channels): `spend` answers {ok, data} | {ok:false, reason, notDeployed}, and
 * `openSpend` raises the Spend page (aither://spend). The Strata page's node browser
 * reads `filesNodes()` and `filesTree(node, dir)` -- each answers {ok, data|error}.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherPlane", {
  planes: () => ipcRenderer.invoke("desk:plane-list"),
  snapshot: (planeId) => ipcRenderer.invoke("desk:plane-snapshot", String(planeId || "")),
  spend: (hours) => ipcRenderer.invoke("desk:spend-report", Number(hours) || 24, { fresh: false }),
  openSpend: () => ipcRenderer.invoke("desk:spend-open"),
  // The Strata page's node browser (plane-window.cjs -> node-browser-client.cjs).
  filesNodes: () => ipcRenderer.invoke("desk:plane-files-nodes"),
  filesTree: (node, dir) => ipcRenderer.invoke("desk:plane-files-tree", String(node || ""), String(dir || "")),
});
