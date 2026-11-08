"use strict";

/**
 * Bridge for the ink overlays (ink.html), owned by ink-window.cjs.
 *
 * The renderer draws; the main process is the source of truth for the mark list
 * (so a display re-created by a resolution change gets its drawings back). Only
 * shapes cross this bridge -- no paths, tokens or app settings.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherInk", {
  init: () => ipcRenderer.invoke("ink:init"),
  add: (item) => ipcRenderer.invoke("ink:add", item),
  erase: (point, radius) => ipcRenderer.invoke("ink:erase", {
    x: Number(point && point.x), y: Number(point && point.y), radius: Number(radius),
  }),
  prune: (ids) => ipcRenderer.invoke("ink:prune", Array.isArray(ids) ? ids : []),
  undo: () => ipcRenderer.invoke("ink:undo"),
  redo: () => ipcRenderer.invoke("ink:redo"),
  clear: () => ipcRenderer.invoke("ink:clear"),
  exit: () => ipcRenderer.invoke("ink:exit"),
  save: () => ipcRenderer.invoke("ink:save"),
  setTool: (tool) => ipcRenderer.invoke("ink:set-tool", String(tool || "")),
  setColor: (color) => ipcRenderer.invoke("ink:set-color", String(color || "")),
  setWidth: (width) => ipcRenderer.invoke("ink:set-width", Number(width)),
  setFade: (fadeMs) => ipcRenderer.invoke("ink:set-fade", Number(fadeMs)),
  /** Click-through drawing: true / false, or null to toggle. */
  passThrough: (on) => ipcRenderer.invoke("ink:pass-through", on == null ? null : Boolean(on)),
  /** While click-through: "the pointer is over my toolbar" so it can be clicked. */
  hoverChrome: (over) => ipcRenderer.invoke("ink:hover-chrome", Boolean(over)),
  toBoard: () => ipcRenderer.invoke("ink:to-board"),
  snip: () => ipcRenderer.invoke("ink:snip"),
  onState: (fn) => {
    const listener = (_event, state) => { try { fn(state); } catch { /* a page bug stays in the page */ } };
    ipcRenderer.on("ink:state", listener);
    return () => ipcRenderer.removeListener("ink:state", listener);
  },
  onChrome: (fn) => {
    const listener = (_event, visible) => { try { fn(Boolean(visible)); } catch { /* page bug */ } };
    ipcRenderer.on("ink:chrome", listener);
    return () => ipcRenderer.removeListener("ink:chrome", listener);
  },
  /** "I have painted the chrome change" -- lets a save grab wait for the repaint. */
  chromeDone: () => ipcRenderer.send("ink:chrome-done"),
});
