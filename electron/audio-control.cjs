"use strict";

/**
 * audio-control.cjs -- the Desk's speaker + microphone surface, on top of
 * system-audio.cjs (Windows Core Audio through one resident PowerShell).
 *
 *   volumeUp() / volumeDown()   +5 / -5 % on the default speakers, then an OSD
 *   toggleSpeakerMute() / toggleMicMute()   the Windows mute flag, then an OSD
 *   openSettings()              the Audio flyout (audio.html): device pickers,
 *                               two sliders + mutes, a live mic level meter
 *
 * owner 2026-11-02: "hot keys and better way to control audio / system speaker
 * and mic settings in awdesk ... like a floating orb with a chat bubble". The
 * OSD is that bubble: bottom-centre, 1.2 s, no focus, never in the taskbar.
 *
 * main.cjs only routes command ids here; every window and every IPC channel is
 * owned by this file (the snip-window.cjs / recorder-window.cjs shape). Nothing
 * here leaves the owner's volume, mute or default device changed on its own:
 * the flyout and the OSD only ever report what a person asked for.
 */

const path = require("node:path");
const systemAudio = require("./system-audio.cjs");

function electron() {
  return require("electron");
}

const OSD_WIDTH = 300;
const OSD_HEIGHT = 68;
const OSD_MS = 1200;
/** How stale a cached speaker/mic state may be before the poll refreshes it. */
const STATE_POLL_MS = 30_000;

let wired = false;
let deps = { onChange: null };
let lastState = null; // normalized {ok, render, capture}
let settingsWin = null;
let osdWin = null;
let osdTimer = null;
let osdInfo = null;
let pollTimer = null;

/**
 * main.cjs injects `onChange(state)`: called after every successful read/write
 * so the tray's Audio rows re-render their "Mute / Unmute" wording.
 */
function configureAudio(next = {}) {
  deps = { ...deps, ...next };
  startStatePoll();
}

function startStatePoll() {
  if (pollTimer || process.platform !== "win32") return;
  pollTimer = setInterval(() => { void refreshState({ announce: false }); }, STATE_POLL_MS);
  // Never hold the process open (tests, a quit that skips teardown).
  if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
}

/** The last state this process saw -- SYNCHRONOUS, for commandContext()'s labels. */
function cachedState() {
  return lastState;
}

function speakerMuted() {
  return Boolean(lastState && lastState.render && lastState.render.muted);
}

function micMuted() {
  return Boolean(lastState && lastState.capture && lastState.capture.muted);
}

/** A mute flip made from the Windows flyout/media key changes the tray wording. */
function muteFlagsChanged(previous, next) {
  if (!previous || !previous.ok) return true;
  const muted = (state, flow) => Boolean(state[flow] && state[flow].muted);
  return muted(previous, "render") !== muted(next, "render")
    || muted(previous, "capture") !== muted(next, "capture");
}

async function refreshState({ announce = false } = {}) {
  const previous = lastState;
  const state = await systemAudio.getState();
  if (state.ok) {
    lastState = state;
    // The 30 s poll used to stay silent, so a Windows-side mute left the tray
    // rows claiming the opposite until the next Desk change (main.cjs:5295).
    if ((announce || muteFlagsChanged(previous, state)) && deps.onChange) deps.onChange(state);
    broadcastState();
  }
  return state;
}

function broadcastState() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send("audio:state-changed", lastState);
  }
}

/** A completed change: cache it, toast it, tell the tray, tell a live flyout. */
function afterChange(state, flow) {
  if (!state || !state.ok) {
    showOsd(systemAudio.osdModel({ flow, error: state && state.error }));
    return state;
  }
  lastState = state;
  showOsd(systemAudio.osdModel({ flow, endpoint: state[systemAudio.flowFor(flow)] }));
  if (deps.onChange) deps.onChange(state);
  broadcastState();
  return state;
}

async function volumeUp() {
  return afterChange(await systemAudio.adjustVolume("render", systemAudio.VOLUME_STEP), "render");
}

async function volumeDown() {
  return afterChange(await systemAudio.adjustVolume("render", -systemAudio.VOLUME_STEP), "render");
}

async function toggleSpeakerMute() {
  return afterChange(await systemAudio.toggleMute("render"), "render");
}

async function toggleMicMute() {
  return afterChange(await systemAudio.toggleMute("capture"), "capture");
}

/** Bottom-centre of the primary display's work area -- the Windows volume flyout spot. */
function osdBounds(workArea) {
  const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    x: Math.round(area.x + (area.width - OSD_WIDTH) / 2),
    y: Math.round(area.y + area.height - OSD_HEIGHT - 72),
    width: OSD_WIDTH,
    height: OSD_HEIGHT,
  };
}

/**
 * The OSD has no clickable control, so its whole rectangle is transparent to the
 * mouse: focusable:false stops activation but NOT hit-testing, and without this
 * the 300x68 card swallows clicks for OSD_MS over the active window.
 */
function makeOsdClickThrough(win) {
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* older Electron */ }
}

function showOsd(info) {
  let BrowserWindow, screen;
  try {
    ({ BrowserWindow, screen } = electron());
  } catch { return null; }
  osdInfo = info;
  const bounds = osdBounds(screen.getPrimaryDisplay().workArea);
  if (osdTimer) clearTimeout(osdTimer);
  if (!osdWin || osdWin.isDestroyed()) {
    osdWin = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, movable: false,
      skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, "audio-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    osdWin.setAlwaysOnTop(true, "screen-saver");
    makeOsdClickThrough(osdWin);
    try { osdWin.setContentProtection(true); } catch { /* older OS: the OSD may appear in a recording */ }
    osdWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    osdWin.webContents.on("will-navigate", (event) => event.preventDefault());
    osdWin.once("ready-to-show", () => {
      if (osdWin && !osdWin.isDestroyed()) { makeOsdClickThrough(osdWin); osdWin.showInactive(); }
    });
    osdWin.on("closed", () => { osdWin = null; });
    void osdWin.loadFile(path.join(__dirname, "audio-osd.html"));
  } else {
    osdWin.setBounds(bounds);
    makeOsdClickThrough(osdWin);
    osdWin.webContents.send("audio:osd-update", publicOsd());
    osdWin.showInactive();
  }
  osdTimer = setTimeout(() => {
    osdTimer = null;
    if (osdWin && !osdWin.isDestroyed()) osdWin.hide();
  }, OSD_MS);
  return osdInfo;
}

function publicOsd() {
  return osdInfo || { kind: "speaker", title: "Speakers", value: "—", percent: 0, muted: false, note: "", icon: "volume" };
}

/** The Audio flyout. One instance; a second call focuses (and re-reads) it. */
function openSettings() {
  let BrowserWindow, screen;
  try {
    ({ BrowserWindow, screen } = electron());
  } catch { return null; }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    void refreshState();
    return settingsWin;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = 460;
  const height = 600;
  settingsWin = new BrowserWindow({
    x: Math.round(area.x + area.width - width - 24),
    y: Math.round(area.y + (area.height - height) / 2),
    width, height,
    frame: false, resizable: false, minimizable: false, maximizable: false,
    skipTaskbar: false, show: false, backgroundColor: "#0b0b10",
    title: "Audio",
    webPreferences: {
      preload: path.join(__dirname, "audio-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWin.webContents.on("will-navigate", (event) => event.preventDefault());
  settingsWin.once("ready-to-show", () => { if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); } });
  settingsWin.on("closed", () => { settingsWin = null; });
  void settingsWin.loadFile(path.join(__dirname, "audio.html"));
  return settingsWin;
}

function closeWindowOf(event) {
  try {
    const { BrowserWindow } = electron();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  } catch { /* already gone */ }
}

/**
 * Only the two windows this module owns may drive machine-wide audio. The
 * handlers change the Windows default device and master volume, so a bare
 * `ipcMain.handle` from any renderer is not enough (recorder-window.cjs's shape).
 */
function fromAudioWindow(event) {
  const sender = event && event.sender;
  if (!sender) return false;
  for (const win of [settingsWin, osdWin]) {
    try {
      if (win && !win.isDestroyed() && win.webContents === sender) return true;
    } catch { /* window closing */ }
  }
  return false;
}

function guarded(fn) {
  return (event, ...args) => {
    if (!fromAudioWindow(event)) return { ok: false, reason: "not the audio window" };
    return fn(event, ...args);
  };
}

function handlers() {
  return {
    "audio:state": () => refreshState(),
    "audio:list": () => systemAudio.listDevices(),
    "audio:set-volume": async (_event, payload) => {
      const flow = systemAudio.flowFor(payload && payload.flow);
      return afterChange(await systemAudio.setVolume(flow, payload && payload.percent), flow);
    },
    "audio:set-muted": async (_event, payload) => {
      const flow = systemAudio.flowFor(payload && payload.flow);
      return afterChange(await systemAudio.setMuted(flow, Boolean(payload && payload.muted)), flow);
    },
    "audio:set-default": async (_event, payload) => {
      const flow = systemAudio.flowFor(payload && payload.flow);
      return afterChange(await systemAudio.setDefaultDevice(flow, payload && payload.deviceId), flow);
    },
    "audio:close": (event) => { closeWindowOf(event); return { ok: true }; },
    "audio:osd-info": () => publicOsd(),
  };
}

function ensureAudioIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, fn] of Object.entries(handlers())) ipcMain.handle(channel, guarded(fn));
}

/** main calls this once after boot: a warm helper keeps the first hotkey instant. */
function warm() {
  return systemAudio.warm();
}

function teardown() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (osdTimer) { clearTimeout(osdTimer); osdTimer = null; }
  for (const win of [settingsWin, osdWin]) {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }
  settingsWin = null;
  osdWin = null;
  systemAudio.stopHelper();
}

module.exports = {
  configureAudio, ensureAudioIpc, warm, teardown,
  volumeUp, volumeDown, toggleSpeakerMute, toggleMicMute, openSettings, refreshState,
  cachedState, speakerMuted, micMuted, showOsd, osdBounds, publicOsd, handlers,
  OSD_WIDTH, OSD_HEIGHT, OSD_MS, STATE_POLL_MS,
  // test seam
  __setStateForTest(next = {}) {
    if ("state" in next) lastState = next.state;
    if ("osdInfo" in next) osdInfo = next.osdInfo;
    return { lastState, osdInfo };
  },
};
