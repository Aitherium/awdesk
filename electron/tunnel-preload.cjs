"use strict";

/**
 * Bridge for the Public URL panel (tunnel.html). Channels are TUNNEL_CHANNELS in
 * tunnel-window.cjs (a sandboxed preload cannot require it, so they are spelled
 * here; tunnel-client.test.cjs asserts the two lists match).
 *
 * Every verb answers {ok, data} or {ok:false, reason[, denied]}. The fleet-
 * internal override travels only as a literal boolean.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tunnel", {
  list: () => ipcRenderer.invoke("desk:tunnel-list"),
  check: (port, allowInternal) => ipcRenderer.invoke("desk:tunnel-check",
    { port: String(port ?? ""), allowInternal: allowInternal === true }),
  start: (port, allowInternal) => ipcRenderer.invoke("desk:tunnel-start",
    { port: String(port ?? ""), allowInternal: allowInternal === true }),
  stop: (port) => ipcRenderer.invoke("desk:tunnel-stop", { port: String(port ?? "") }),
  copy: (url) => ipcRenderer.invoke("desk:tunnel-copy", String(url || "")),
  open: (url) => ipcRenderer.invoke("desk:tunnel-open", String(url || "")),
});
