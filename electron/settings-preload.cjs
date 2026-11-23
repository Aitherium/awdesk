"use strict";

// Preload for the Settings pane (settings.html) -- the ONE shared settings
// page (owner, 2026-09-22: "there still isnt just a shared settings page").
// device enumeration itself uses navigator.mediaDevices directly (a Web API,
// not Node), so nothing is exposed for it here; this bridge covers only the
// main-process state (cast.json's input/hotkeys) that a sandboxed page cannot
// reach on its own.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settingsBridge", {
  get: () => ipcRenderer.invoke("desk:settings-get"),
  setInput: (patch) => ipcRenderer.invoke("desk:settings-set-input", patch),
  setOverlay: (patch) => ipcRenderer.invoke("desk:settings-set-overlay", patch),
  // Visual neurons (neurons-model.cjs): a per-viewer switch in orb.json, off by default.
  setNeurons: (on) => ipcRenderer.invoke("desk:settings-set-neurons", on === true),
  // Companion display (display-mode.cjs): avatar / fairy / both / swarm, saved in
  // avatar-dock.json with the dock wish (owner 2026-11-20).
  setDisplay: (mode) => ipcRenderer.invoke("desk:settings-set-display", String(mode || "")),
  // Where a dropped fairy stands and how long it stays (fairy-drop.cjs, owner 2026-11-23).
  setFairy: (patch) => ipcRenderer.invoke("desk:settings-set-fairy", patch),
  // The native empty-desktop right-click ring (owner 2026-11-23).
  setDesktopRing: (on) => ipcRenderer.invoke("desk:settings-set-desktop-ring", on === true),
  probeAccel: (accel, excludeId) => ipcRenderer.invoke("desk:settings-probe-accel", accel, excludeId),
  setHotkey: (id, accel) => ipcRenderer.invoke("desk:settings-set-hotkey", id, accel),
  clearHotkey: (id) => ipcRenderer.invoke("desk:settings-set-hotkey", id, ""),
  linkStatus: () => ipcRenderer.invoke("desk:link-status"),
  connections: () => ipcRenderer.invoke("desk:connections"),
  runConnection: (id) => ipcRenderer.invoke("desk:connections-run", String(id || "")),
  linkStart: () => ipcRenderer.invoke("desk:link-start"),
  linkPoll: (deviceCode) => ipcRenderer.invoke("desk:link-poll", deviceCode),
  bricksList: () => ipcRenderer.invoke("desk:bricks-list"),
  bricksAct: (verb, name) => ipcRenderer.invoke("desk:bricks-act", verb, name),
});
