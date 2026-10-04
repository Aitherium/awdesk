"use strict";

/**
 * Bridge for the Stage pane (stage.html), injected by console-preload.cjs
 * because the pane is an iframe under nodeIntegrationInSubFrames.
 *
 * Every verb here is something that was previously reachable ONLY by hitting a
 * 3D body with the mouse (or a tray submenu, for the voice switches).
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherStage", {
  /** Who is on the stage: {bodies: [{ slotId, name, agent, resident, voiceMuted }],
   *  allVoicesMuted, safety}. */
  bodies: () => ipcRenderer.invoke("desk:stage-bodies"),
  /** Apply a named arrangement (row / arc / pair / focus / reset). */
  arrange: (name, options) => ipcRenderer.invoke(
    "desk:stage-arrange", String(name || ""), options || {},
  ),
  /** Frame one body, or everyone when slotId is null. */
  focus: (slotId) => ipcRenderer.invoke("desk:stage-focus", slotId || null),
  /** Send one body away (the resident stays; main refuses that). */
  remove: (slotId) => ipcRenderer.invoke("desk:stage-remove", String(slotId || "")),
  /** Run one of the avatar-window commands (stage-window.cjs STAGE_RUNNABLE). */
  run: (id) => ipcRenderer.invoke("desk:stage-run", String(id || "")),
  /** Set ONE body's voice off (true) or on (false). Resolves {ok, slotId, voiceMuted}. */
  setVoice: (slotId, muted) => ipcRenderer.invoke(
    "desk:stage-voice", String(slotId || ""), muted === true,
  ),
  /** Set every voice off (true) or on (false). Resolves {ok, allVoicesMuted}. */
  setAllVoices: (muted) => ipcRenderer.invoke("desk:stage-all-voices", muted === true),
});
