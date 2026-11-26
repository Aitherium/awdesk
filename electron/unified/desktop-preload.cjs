"use strict";

/**
 * desktop-preload.cjs -- Minimal, safe host-protocol preload injected into
 * the https://aithr.net Living Desktop WebContentsView (desktop morph mode).
 *
 * Exposes `window.aitherUnifiedHost` + `window.aitherDeskVerbs` (v1 compatible)
 * with strict human-gesture gating and zero setIgnoreMouseEvents click-through loops.
 */

const { contextBridge, ipcRenderer } = require("electron");

function humanGesture() {
  const activation = typeof navigator !== "undefined" ? navigator.userActivation : null;
  return Boolean(activation && activation.isActive);
}

try {
  contextBridge.exposeInMainWorld(
    "aitherUnifiedHost",
    Object.freeze({
      version: 1,
      morph: (mode) => {
        if (!humanGesture()) return Promise.resolve({ ok: false, error: "needs user gesture" });
        return ipcRenderer.invoke("unified:desktop-host-action", { action: "morph", mode });
      },
      openTab: (url) => {
        if (!humanGesture()) return Promise.resolve({ ok: false, error: "needs user gesture" });
        return ipcRenderer.invoke("unified:desktop-host-action", { action: "open-tab", url });
      },
      status: () => ipcRenderer.invoke("unified:desktop-host-action", { action: "status" }),
    }),
  );

  contextBridge.exposeInMainWorld(
    "aitherDeskVerbs",
    Object.freeze({
      version: 1,
      openBrowser: (url) => {
        if (!humanGesture()) return Promise.resolve({ ok: false, error: "needs user gesture" });
        return ipcRenderer.invoke("unified:desktop-host-action", { action: "open-tab", url });
      },
      shrinkToAvatar: () => {
        if (!humanGesture()) return Promise.resolve({ ok: false, error: "needs user gesture" });
        return ipcRenderer.invoke("unified:desktop-host-action", { action: "morph", mode: "avatar" });
      },
      openWorkbench: () => {
        if (!humanGesture()) return Promise.resolve({ ok: false, error: "needs user gesture" });
        return ipcRenderer.invoke("unified:desktop-host-action", { action: "morph", mode: "workbench" });
      },
    }),
  );
} catch {
  /* contextIsolation disabled fallback */
}
