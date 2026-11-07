"use strict";

/**
 * Bridge for the Audio flyout (audio.html) and its OSD (audio-osd.html), both
 * owned by audio-control.cjs. Pages name a flow and a number; every Core Audio
 * call happens in the main process. Nothing here sees a path or a token.
 */

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, fn) {
  const listener = (_event, value) => { try { fn(value); } catch { /* page bug stays in the page */ } };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aitherAudio", {
  state: () => ipcRenderer.invoke("audio:state"),
  list: () => ipcRenderer.invoke("audio:list"),
  setVolume: (flow, percent) => ipcRenderer.invoke("audio:set-volume", { flow: String(flow || "render"), percent: Number(percent) }),
  setMuted: (flow, muted) => ipcRenderer.invoke("audio:set-muted", { flow: String(flow || "render"), muted: Boolean(muted) }),
  setDefault: (flow, deviceId) => ipcRenderer.invoke("audio:set-default", { flow: String(flow || "render"), deviceId: String(deviceId || "") }),
  close: () => ipcRenderer.invoke("audio:close"),
  osdInfo: () => ipcRenderer.invoke("audio:osd-info"),
  onState: (fn) => subscribe("audio:state-changed", fn),
  onOsd: (fn) => subscribe("audio:osd-update", fn),
});
