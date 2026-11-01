"use strict";

/**
 * Bridge for the System window (system-monitor.html).
 *
 * Every verb answers {ok, ...} or {ok:false, reason[, refused]}. `end` carries
 * confirm:true only after the window's own second click; main re-reads the
 * process and refuses protected ones (csrss, lsass, vmmemWSL, ...) regardless.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherSystem", {
  snapshot: () => ipcRenderer.invoke("desk:sys-snapshot"),
  network: () => ipcRenderer.invoke("desk:sys-network"),
  probes: () => ipcRenderer.invoke("desk:sys-probes"),
  startup: () => ipcRenderer.invoke("desk:sys-startup"),
  end: (pid, name, tree) => ipcRenderer.invoke("desk:sys-end",
    { pid: Number(pid), name: String(name || ""), tree: tree === true, confirm: true }),
  priority: (pid, name, level) => ipcRenderer.invoke("desk:sys-priority",
    { pid: Number(pid), name: String(name || ""), level: String(level || "") }),
  reveal: (pid) => ipcRenderer.invoke("desk:sys-reveal", Number(pid)),
  ask: (pid) => ipcRenderer.invoke("desk:sys-ask", Number(pid)),
});
