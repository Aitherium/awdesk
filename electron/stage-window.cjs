"use strict";

/**
 * stage-window.cjs — the Stage pane: every body on the stage, listed, with the
 * arrangements beside them. Plan 40 slice G, the surface half.
 *
 * WHY A PANE AND NOT JUST A MENU (owner, 2026-09-18: "i cant control the actual
 * avatar stage / window / box size anymore", then "the whole UI/UX is starting to
 * just become a stacked mess"): everything about the stage was a GESTURE on a
 * body — drag to move, right-drag to turn, wheel to scale, right-click for the
 * menu. If the body is hidden, tiny, behind another window or simply not where
 * you expect, the stage becomes unmanageable and there is no second path. This
 * pane is that second path: it names each body, says where it stands, and
 * arranges them without the owner having to hit a 3D object with the mouse.
 *
 * The handlers live HERE rather than in console-window.cjs for the same reason
 * Sessions' do: the pane has a standalone twin, and console-window's wireIpc
 * only runs when the console is open.
 *
 * It owns NO state. Bodies come from main (the live slots), arrangements go to
 * the renderer through main's one sender, and the geometry is the renderer's
 * (src/stage/arrangements.ts) — main never holds a second copy of the bounds.
 */

const path = require("node:path");

// Same lazy-require rule as the other window modules: loadable under
// `node --test` without Electron.
function electron() {
  return require("electron");
}

let stageWindow = null;
let wired = false;
/** Injected by main.cjs: { bodies(), arrange(name, opts), focus(slotId), remove(slotId),
 *  run(id), safety(), allVoicesMuted(), setVoiceMuted(slotId, on), setAllVoicesMuted(on) }. */
let stageImpl = {};

/** Registry commands the Stage page may run: the avatar window's size and layout. */
const STAGE_RUNNABLE = Object.freeze([
  "avatar.toggle", "window.size.small", "window.size.medium", "window.size.large",
  "window.size.xlarge", "window.size.bigger", "window.size.smaller", "window.outline",
  "layout.reset-all",
]);

/** Body names are stored lowercased (cast-config normaliseAuthor); compare the same way. */
function voiceKey(agent) {
  return String(agent == null ? "" : agent).trim().toLowerCase().slice(0, 80);
}

/**
 * Stamp `voiceMuted` on every body. `agentFor(slotId)` names the agent a body
 * speaks for (main's agentForSlot -- the SAME lookup the right-click mute keys
 * on, so the pane and the menu can never disagree about whose voice a row is),
 * and `mutedAgents` is voice.mutedAgents read ONCE for the whole list.
 */
function withVoiceState(bodies, { agentFor, mutedAgents } = {}) {
  const muted = new Set((Array.isArray(mutedAgents) ? mutedAgents : []).map(voiceKey).filter(Boolean));
  return (Array.isArray(bodies) ? bodies : []).map((body) => {
    const agent = voiceKey((typeof agentFor === "function" && agentFor(body.slotId)) || body.agent);
    return { ...body, voiceMuted: Boolean(agent) && muted.has(agent) };
  });
}

/** A strict boolean from the renderer, or null: a toggle with no stated target is refused. */
function asState(value) {
  return value === true || value === false ? value : null;
}

/**
 * Every desk:stage-* verb as a plain function over `getImpl()` -- the seam that
 * lets stage-window.test.cjs drive them without Electron (same shape as
 * cast-window.cjs's castHandlers).
 */
function stageHandlers(getImpl) {
  const impl = () => getImpl() || {};
  const call = (name, fn) => {
    try {
      return { ok: true, ...(fn() || {}) };
    } catch (error) {
      // A pane that goes blank because one verb threw is worse than a pane that
      // says which verb failed -- the same rule the console's rail follows.
      return { ok: false, error: `${name}: ${String((error && error.message) || error)}` };
    }
  };
  return {
    "desk:stage-bodies": () => call("bodies", () => ({
      bodies: (impl().bodies && impl().bodies()) || [],
      // The master voice switch rides with the list so the pane's "All voices"
      // button and the rows are painted from one answer.
      allVoicesMuted: Boolean(impl().allVoicesMuted && impl().allVoicesMuted()),
      // Plan 40 slice F: the safety setting is enforced at every door that shows a
      // body, so the pane that lists bodies is where its state belongs. Read-only
      // on purpose -- the desk does not own the flip, it obeys it.
      safety: (impl().safety && impl().safety()) || null,
    })),
    "desk:stage-arrange": (_event, name, options) => call("arrange", () => {
      impl().arrange?.(String(name || ""), options || {});
    }),
    "desk:stage-focus": (_event, slotId) => call("focus", () => {
      impl().focus?.(slotId ? String(slotId) : null);
    }),
    "desk:stage-remove": (_event, slotId) => call("remove", () => {
      impl().remove?.(String(slotId || ""));
    }),
    // The avatar WINDOW's controls live on this page now (owner, 2026-10-03: too many
    // separate menus for one stage). Only these registry ids may run from here.
    "desk:stage-run": (_event, id) => call("run", () => {
      const name = String(id || "");
      if (!STAGE_RUNNABLE.includes(name)) throw new Error(`${name} cannot run from the stage page`);
      impl().run?.(name);
    }),
    // ONE body's voice, set to a stated state (not flipped: a double click must not
    // undo itself). Was reachable only from that body's right-click menu.
    "desk:stage-voice": (_event, slotId, muted) => call("voice", () => {
      const slot = String(slotId || "");
      const state = asState(muted);
      if (!slot) throw new Error("no body named");
      if (state === null) throw new Error("muted must be true or false");
      if (!impl().setVoiceMuted) throw new Error("voice control is not wired");
      return { slotId: slot, voiceMuted: Boolean(impl().setVoiceMuted(slot, state)) };
    }),
    // Every voice at once. Captions keep showing the words either way.
    "desk:stage-all-voices": (_event, muted) => call("all voices", () => {
      const state = asState(muted);
      if (state === null) throw new Error("muted must be true or false");
      if (!impl().setAllVoicesMuted) throw new Error("voice control is not wired");
      return { allVoicesMuted: Boolean(impl().setAllVoicesMuted(state)) };
    }),
  };
}

function ensureStageIpc(impl) {
  if (impl) stageImpl = impl;
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(stageHandlers(() => stageImpl))) {
    ipcMain.handle(channel, handler);
  }
}

function createStageWindow() {
  ensureStageIpc();
  const { BrowserWindow } = electron();
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.show();
    stageWindow.focus();
    return stageWindow;
  }
  stageWindow = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title: "Aither Stage",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "stage-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The same fence every other desk window carries.
  stageWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  stageWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  stageWindow.once("ready-to-show", () => {
    stageWindow.show();
    stageWindow.focus();
  });
  stageWindow.on("closed", () => {
    stageWindow = null;
  });
  void stageWindow.loadFile(path.join(__dirname, "stage.html"));
  return stageWindow;
}

function closeStageWindow() {
  if (stageWindow && !stageWindow.isDestroyed()) stageWindow.close();
}

function isStageWindowOpen() {
  return Boolean(stageWindow && !stageWindow.isDestroyed());
}

module.exports = {
  ensureStageIpc,
  createStageWindow,
  closeStageWindow,
  isStageWindowOpen,
  stageHandlers,
  withVoiceState,
  STAGE_RUNNABLE,
};
