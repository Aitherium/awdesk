"use strict";

/**
 * Bridge for the Disk Explorer window (disk-explorer.html).
 *
 * Every verb answers {ok, data} or {ok:false, status, error[, signedOut]}.
 * There is no approve/apply/delete verb: a proposal becomes a decision card that
 * a human answers in the Inbox or Veil.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("diskExplorer", {
  host: () => ipcRenderer.invoke("desk:disk-host"),
  nodes: () => ipcRenderer.invoke("desk:disk-nodes"),
  search: (opts) => ipcRenderer.invoke("desk:disk-search", opts || {}),
  dupes: (opts) => ipcRenderer.invoke("desk:disk-dupes", opts || {}),
  tree: (opts) => ipcRenderer.invoke("desk:disk-tree", opts || {}),
  proposals: (opts) => ipcRenderer.invoke("desk:disk-proposals", opts || {}),
  raiseCard: (proposalId) => ipcRenderer.invoke("desk:disk-raise-card", Number(proposalId)),
  share: (node, path, seal) => ipcRenderer.invoke("desk:disk-share",
    { node: String(node || ""), path: String(path || ""), seal: seal === true }),
  shares: () => ipcRenderer.invoke("desk:disk-shares"),
  signIn: () => ipcRenderer.send("desk:disk-sign-in"),
  openWeb: () => ipcRenderer.send("desk:disk-open-inbox"),
});
