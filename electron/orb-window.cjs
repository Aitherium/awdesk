"use strict";

/**
 * orb-window — the floating ask orb, grown into the SPIRIT (orb-core.cjs).
 *
 * Owner, 2026-11-02, in order: "integrate the system like with awdesk / and the
 * spirit guide in DarkMatter where you can click and ask it what it sees and it
 * just responds like a floating orb with a chat bubble on your desktop" ·
 * "integrate with the awdesk avatar/persona too" · "make the spirit
 * attachable/detachable basically" · "awdesk avatars ... can send the spirit orb
 * to do stuff around the desktop, go look at files, for context" · "and you can
 * watch it go" · "I want to be able to right click and search, or ask a question
 * or send something to it, or be like 'go find this file and give me the path'
 * and then it literally retrieves it and holds it ... or just read it and talk to
 * me about the file in text or voice" · "and things like web searches too!"
 *
 * Three windows, one idea:
 *   orb     — a 72 px glowing orb, always on top, draggable, click-through
 *             everywhere except the orb itself.
 *   bubble  — a small dark card beside the orb: one answer at a time (the
 *             pacing is orb-core.cjs), the quick actions, holds, pick lists,
 *             the trip log and the follow-up input.
 *   veil    — a transparent, click-through overlay that draws the flight trail
 *             and the tether while the spirit is moving or attached. It never
 *             takes a click.
 *
 * Everything the spirit DECIDES is in spirit-core.cjs (pure, node --test); every
 * transport is in spirit-ops.cjs (universal search, awfind, file-ask) and the
 * Windows window oracle is spirit-probe.cjs (one resident PowerShell). This file
 * owns only windows, animation and the one-trip-at-a-time runner.
 *
 * Capture is the desk's existing one (snip-window.nativeFrame). The orb, bubble
 * and veil are HIDDEN while a capture is in flight so the answer is never a
 * picture of the assistant.
 *
 * State is per-viewer convenience only: orb.json in userData, written atomically.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const orbCore = require("./orb-core.cjs");
const orbVision = require("./orb-vision.cjs");
const spiritCore = require("./spirit-core.cjs");
const spiritOps = require("./spirit-ops.cjs");
const spiritProbe = require("./spirit-probe.cjs");
const spriteCore = require("./sprite-core.cjs");
const awCli = require("./aw-cli.cjs");
const selectionReader = require("./selection-reader.cjs");
const fairyAttention = require("./fairy-attention.cjs");

const ORB_SIZE = Object.freeze({ width: 72, height: 72 });
const BUBBLE_SIZE = Object.freeze({ width: 392, height: 480 });
/** The whisper: the card the fairy carries, beside it. Small on purpose. */
const NUDGE_SIZE = Object.freeze({ width: 420, height: 188 });
/** The whisper grows to its content (full button labels), within these bounds. */
const NUDGE_MIN_H = 140;
const NUDGE_MAX_H = 560;
const ATTENTION_TICK_MS = 15_000;
const NUDGE_STEP_MS = 250;
const TICK_MS = 250;
const DRAG_STEP_MS = 16;
const CLICK_SLOP_PX = 4;
const REGION_WAIT_MS = 120000;
const ORB_POLL_MS = 500;
const CAPTURE_TTL_MS = 10 * 60 * 1000;
// Spirit: the tether follows an attached target at 4 Hz (one rect read), the
// flight redraws at ~60 Hz, and the trail keeps a short history.
const FOLLOW_MS = 250;
/** The orbit around an avatar is drawn at ~30 fps; the body's rect is re-read at FOLLOW_MS. */
const ORBIT_MS = 33;
/** How often a free spirit looks for an avatar to orbit (unless the owner set it free). */
const ORBIT_SEEK_MS = 2000;
let orbitTimer = null;
let seekTimer = null;
const FLIGHT_STEP_MS = 16;
const TRAIL_MAX = 26;
const TRAIL_GAP_MS = 26;
const CAPTURE_HIDE_MS = 90;
const TRIP_TIMEOUT_MS = 150000;

let wired = false;
let orbWindow = null;
let bubbleWindow = null;
let veilWindow = null;
let nudgeWindow = null;
let state = orbCore.sanitizeState(null);
let queue = orbCore.createQueue();
let tickTimer = null;
let dragTimer = null;
let dragging = null;
let drafting = false;
let inflight = false;
let lastImage = null;
let quitting = false;

// ── spirit state ────────────────────────────────────────────────────────────
let attach = null; // {kind:"avatar"|"window"|"desk", slotId|hwnd|windowId, title, bounds, tint}
let followTimer = null;
let followMisses = 0;
let flight = null; // {path, from, to, startedAt, duration, resolve, cancelled}
let flightTimer = null;
let trail = [];
let lastTrailAt = 0;
// The last veil payload actually sent. A 60 Hz flight used to re-send identical
// frames and the renderer reallocated its canvas for every one of them.
let lastVeilKey = "";
let home = null; // {x,y} free resting point (orb CENTRE) captured when attaching
let tint = spiritCore.tintFor("slot0");
let hold = null;
let results = null; // {mode:"find"|"web"|"folder", rows, more, total, query}
let tripQueue = spiritCore.createTripQueue();
let tripLog = spiritCore.createTripLog();
let tripBusy = false;
let bubbleMode = null; // "find" | "web" | "card" | null
/** The card the bubble is chatting about (bubbleMode "card"): {id, title, context}. */
let cardChat = null;
/** The body whose avatar-menu row opened the bubble: it speaks the answer the
 *  owner types there (an avatar-menu row cannot carry a text prompt). */
let pendingSlot = null;
let regionWait = false;
/** A bubble the owner closed stays closed until something NEW arrives. */
let suppressed = false;
let ops = null;
let probe = null;
let pendingRuns = new Map(); // trip id -> {resolve, timer}

/** Test seams: a fake capture (snip-window) and a fake vision ladder. */
let captureImpl = null;
let askVisionImpl = null;
/** Injected by main: who speaks, what the avatars are, and the one runCommand. */
let speakImpl = null;
let avatarTargetsImpl = null;
let runCommandImpl = null;
let openUrlImpl = null;
let universalImpl = null;
let searchClientImpl = null;

// ── the owner's AitherSprite (sprite-core.cjs) ──────────────────────────────
/** The sprite view the fairy wears, or null = the plain fairy (offline / signed out). */
let sprite = null;
/** The last thing the vision ladder said about a snip/screen: `sprite.teach`'s third source. */
let lastCaption = "";
let spriteTimer = null;
let spriteKick = null;
let spriteClientImpl = null;
let spriteTokenImpl = null;
let awRunImpl = null;
let clipboardImpl = null;
let selectionImpl = null;
/** The sprite service throttles teach to one per 2 s; a retry waits this long. */
let teachRetryDelayMs = 2500;
const SPRITE_POLL_MS = 5 * 60 * 1000;

function electron() {
  return require("electron");
}

function capture() {
  return captureImpl || require("./snip-window.cjs");
}

function askVision(imagePath, prompt, opts) {
  return (askVisionImpl || orbVision.askVision)(imagePath, prompt, opts);
}

function alive(win) {
  return Boolean(win && !win.isDestroyed());
}

// ── persisted state ─────────────────────────────────────────────────────────

function stateFile() {
  if (process.env.DESK_ORB_FILE) return String(process.env.DESK_ORB_FILE);
  const { app } = electron();
  return path.join(app.getPath("userData"), "orb.json");
}

function loadState() {
  try {
    state = orbCore.sanitizeState(JSON.parse(fs.readFileSync(stateFile(), "utf8")));
  } catch {
    state = orbCore.sanitizeState(null); // unreadable state -> defaults, never a crash
  }
  return state;
}

function saveState() {
  try {
    const file = stateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch { /* per-viewer convenience: losing it costs a remembered spot only */ }
}

// ── geometry ────────────────────────────────────────────────────────────────

function orbCenter() {
  if (alive(orbWindow)) {
    const [x, y] = orbWindow.getPosition();
    return { x: x + ORB_SIZE.width / 2, y: y + ORB_SIZE.height / 2 };
  }
  const { screen } = electron();
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width / 2, y: area.y + area.height / 2 };
}

function displayForOrb() {
  const { screen } = electron();
  try {
    return screen.getDisplayNearestPoint(orbCenter());
  } catch {
    return screen.getPrimaryDisplay();
  }
}

/**
 * The work area a SAVED position belongs to. The orb's spot is the one piece of
 * state this feature exists to keep, so a point on the second monitor must be
 * judged against THAT monitor: clamping it to the primary first moved every
 * remembered secondary spot onto the primary at launch.
 */
function restoreWorkArea() {
  const { screen } = electron();
  if (state.x != null && state.y != null) {
    try {
      const display = screen.getDisplayNearestPoint({ x: state.x, y: state.y });
      if (display && display.workArea) return display.workArea;
    } catch { /* fall through to the primary */ }
  }
  try { return screen.getPrimaryDisplay().workArea; } catch { return { x: 0, y: 0, width: 1920, height: 1080 }; }
}

function placeOrb() {
  if (!alive(orbWindow)) return;
  const area = restoreWorkArea();
  const pos = state.x != null && state.y != null
    ? orbCore.clampToWorkArea({ x: state.x, y: state.y }, ORB_SIZE, area)
    : orbCore.defaultOrbPosition(area, ORB_SIZE);
  orbWindow.setBounds({ ...pos, ...ORB_SIZE });
}

function placeBubble() {
  if (!alive(bubbleWindow) || !alive(orbWindow)) return;
  const [x, y] = orbWindow.getPosition();
  const area = displayForOrb().workArea;
  const pos = orbCore.bubblePosition(
    { x, y, width: ORB_SIZE.width, height: ORB_SIZE.height },
    BUBBLE_SIZE,
    area,
    10,
  );
  bubbleWindow.setBounds({ ...pos, ...BUBBLE_SIZE });
}

/**
 * Move the orb, PINNING its size on every call.
 *
 * `setPosition()` alone is not a move on Windows: at this display's fractional
 * scale factor Electron re-rounds the window's width/height on each call, so the
 * size creeps up by 1-2 px per move. The hover timer calls this at ORBIT_MS
 * (33 ms), the drift compounds (area, then the layered GPU surface, grows with
 * it) and the transparent always-on-top orb reaches desktop size: measured
 * 2026-11-07 a 72 px orb at 28466x27338 with the GPU process at 9.2 GB private /
 * 16.9 GB working set, twice driving the host's commit charge past 92%.
 * setBounds() that repeats width/height cannot drift.
 */
function moveOrb(x, y) {
  if (!alive(orbWindow)) return;
  // Every move lands on a real screen (owner 2026-11-07: the fairy flew off-screen
  // following a window parked off the desktop, and clicking it sent it back there).
  // This is the one choke point flights, orbits and follows all go through.
  let pos = { x: Number(x), y: Number(y) };
  try {
    const { screen } = electron();
    const centre = { x: Math.round(pos.x + ORB_SIZE.width / 2), y: Math.round(pos.y + ORB_SIZE.height / 2) };
    const area = screen.getDisplayNearestPoint(centre).workArea;
    pos = orbCore.clampToWorkArea(pos, ORB_SIZE, area);
  } catch { /* no screen module (tests): keep the requested spot */ }
  orbWindow.setBounds({
    x: Math.round(Number(pos.x)),
    y: Math.round(Number(pos.y)),
    width: ORB_SIZE.width,
    height: ORB_SIZE.height,
  });
}

function setOrbCenter(point) {
  moveOrb(
    Number(point && point.x) - ORB_SIZE.width / 2,
    Number(point && point.y) - ORB_SIZE.height / 2,
  );
}

function orbVisible() {
  return Boolean(state.visible && alive(orbWindow) && orbWindow.isVisible());
}

// ── the windows ─────────────────────────────────────────────────────────────

function send(channel, payload) {
  for (const win of [orbWindow, bubbleWindow]) {
    try {
      if (alive(win)) win.webContents.send(channel, payload);
    } catch { /* a page mid-load misses one update; the next tick resends */ }
  }
}

function ensureOrb() {
  if (alive(orbWindow)) return orbWindow;
  const { BrowserWindow, screen } = electron();
  let area = { x: 0, y: 0, width: 1920, height: 1080 };
  try { area = screen.getPrimaryDisplay().workArea; } catch { /* keep the default */ }
  const pos = state.x != null && state.y != null
    ? orbCore.clampToWorkArea({ x: state.x, y: state.y }, ORB_SIZE, restoreWorkArea())
    : orbCore.defaultOrbPosition(area, ORB_SIZE);
  orbWindow = new BrowserWindow({
    ...pos, ...ORB_SIZE,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, focusable: true, title: "Aither spirit",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "orb-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      // The nudge chime (WebAudio) plays without a click: the fairy is never clicked first.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  orbWindow.setAlwaysOnTop(true, "screen-saver");
  try { orbWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* Windows: no-op */ }
  orbWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  orbWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  // Click-through EXCEPT the orb disc itself: the page reports pointer
  // enter/leave of the disc and main flips hit testing. The transparent
  // corners of the 72 px box therefore pass clicks to the desktop below.
  orbWindow.setIgnoreMouseEvents(true, { forward: true });
  orbWindow.on("closed", () => { orbWindow = null; });
  orbWindow.on("blur", () => { if (dragging) void endDrag(); });
  void orbWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "orb" } });
  return orbWindow;
}

function ensureBubble() {
  if (alive(bubbleWindow)) return bubbleWindow;
  const { BrowserWindow } = electron();
  bubbleWindow = new BrowserWindow({
    ...BUBBLE_SIZE,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: true, title: "Ask Aither",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "orb-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  bubbleWindow.setAlwaysOnTop(true, "screen-saver");
  try { bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* no-op */ }
  bubbleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bubbleWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  bubbleWindow.on("closed", () => { bubbleWindow = null; });
  bubbleWindow.on("blur", () => { drafting = false; syncBubble(); });
  void bubbleWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "bubble" } });
  return bubbleWindow;
}

/** The trail/tether overlay. Transparent, click-through, never focused. */
function ensureVeil() {
  if (alive(veilWindow)) return veilWindow;
  const { BrowserWindow } = electron();
  veilWindow = new BrowserWindow({
    x: 0, y: 0, width: 160, height: 160,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, focusable: false, title: "Aither spirit trail",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "orb-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  veilWindow.setAlwaysOnTop(true, "screen-saver");
  veilWindow.setIgnoreMouseEvents(true);
  lastVeilKey = "";
  veilWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  veilWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  veilWindow.on("closed", () => { veilWindow = null; });
  void veilWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "veil" } });
  return veilWindow;
}

/** The rect a set of screen points needs, with room for a glow and a line. */
function veilRect(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(Number(p.x)));
  if (!pts.length) return { x: 0, y: 0, width: 160, height: 160 };
  const xs = pts.map((p) => Number(p.x));
  const ys = pts.map((p) => Number(p.y));
  const pad = 70;
  const x = Math.round(Math.min(...xs) - pad);
  const y = Math.round(Math.min(...ys) - pad);
  return {
    x,
    y,
    width: Math.max(160, Math.round(Math.max(...xs) + pad - x)),
    height: Math.max(160, Math.round(Math.max(...ys) + pad - y)),
  };
}

/** The union of every display's bounds: the largest rect the veil may cover. */
function displayUnion() {
  try {
    const displays = electron().screen.getAllDisplays();
    if (!Array.isArray(displays) || !displays.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const display of displays) {
      const b = display && display.bounds;
      if (!b) continue;
      left = Math.min(left, b.x);
      top = Math.min(top, b.y);
      right = Math.max(right, b.x + b.width);
      bottom = Math.max(bottom, b.y + b.height);
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

/** Keep a rect on the virtual desktop: a window larger than the screens buys nothing. */
function clampRect(rect, area) {
  if (!area) return rect;
  const x = Math.round(Math.max(area.x, Math.min(rect.x, area.x + area.width - 1)));
  const y = Math.round(Math.max(area.y, Math.min(rect.y, area.y + area.height - 1)));
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  return {
    x,
    y,
    width: Math.max(1, Math.round(right - x)),
    height: Math.max(1, Math.round(bottom - y)),
  };
}

/**
 * Where the veil belongs for these points: its CURRENT extent, clamped to the screens.
 *
 * It must SHRINK as the trail moves on. The old code grew the window to the union of
 * where it had ever been and never shrank it; a flying spirit therefore left behind a
 * transparent always-on-top window spanning the whole desktop, re-laid-out at 60 Hz.
 * Measured 2026-11-07: the window reached 25568x24656 and the GPU process climbed to
 * 9.2 GB private / 16.9 GB working set under software present, twice hard-rebooting the
 * host's commit charge. So: current points only, never bounded by the past.
 */
function veilPlacement(points, area) {
  return clampRect(veilRect(points), area);
}

function coverVeil(points) {
  const win = ensureVeil();
  const want = veilPlacement(points, displayUnion());
  const bounds = win.getBounds();
  if (want.x !== bounds.x || want.y !== bounds.y
    || want.width !== bounds.width || want.height !== bounds.height) {
    win.setBounds(want);
  }
  if (!win.isVisible()) win.showInactive();
  return want;
}

function veilPayload() {
  if (!alive(veilWindow)) return null;
  const b = veilWindow.getBounds();
  const local = (p) => ({ x: Math.round(Number(p.x) - b.x), y: Math.round(Number(p.y) - b.y) });
  const tether = attach
    ? (() => {
      const anchor = spiritCore.anchorFor(attach);
      return anchor ? [local(anchor), local(orbCenter())] : null;
    })()
    : null;
  return {
    width: b.width,
    height: b.height,
    tint: tint.css,
    trail: trail.map(local),
    tether,
  };
}

/** A cheap content key: identical frames are never re-sent to the renderer. */
function veilKey(payload) {
  if (!payload) return "";
  const points = (list) => (Array.isArray(list) ? list.map((p) => `${p.x},${p.y}`).join(";") : "");
  return `${payload.width}x${payload.height}|${payload.tint}|${points(payload.trail)}|${points(payload.tether)}`;
}

function drawVeil() {
  if (!alive(veilWindow)) return;
  const points = trail.slice();
  if (alive(orbWindow)) points.push(orbCenter());
  if (attach) {
    const anchor = spiritCore.anchorFor(attach);
    if (anchor) points.push(anchor);
  }
  if (!points.length) return;
  coverVeil(points);
  const payload = veilPayload();
  const key = veilKey(payload);
  if (key === lastVeilKey) return;
  lastVeilKey = key;
  try {
    veilWindow.webContents.send("orb:veil", payload);
  } catch {
    lastVeilKey = ""; // page mid-load: the next tick sends again
  }
}

function showVeil() {
  const win = ensureVeil();
  if (!win.isVisible()) win.showInactive();
}

function hideVeil() {
  trail = [];
  lastVeilKey = "";
  if (alive(veilWindow)) veilWindow.hide();
}

// ── visibility ──────────────────────────────────────────────────────────────

function showOrb() {
  const win = ensureOrb();
  const was = state.visible;
  state.visible = true;
  suppressed = false;
  if (!was) saveState();
  if (!win.isVisible()) win.showInactive();
  if (attach) showVeil();
  return { ok: true, visible: true };
}

function hideOrb() {
  suppressed = true;
  pendingSlot = null;
  if (nudging) endNudge("hidden");
  if (alive(bubbleWindow)) bubbleWindow.hide();
  if (alive(orbWindow)) orbWindow.hide();
  hideVeil();
  const was = state.visible;
  state.visible = false;
  if (was) saveState();
  return { ok: true, visible: false };
}

function toggleOrb() {
  return state.visible && alive(orbWindow) && orbWindow.isVisible()
    ? hideOrb()
    : showOrb();
}

/** The bubble is up while it has something to say, an ask or a trip is running,
 *  the owner is typing in it, or it is holding/showing something. Nothing else
 *  keeps it open — and a bubble the owner closed stays closed. */
function bubbleWanted() {
  if (suppressed || !state.visible) return false;
  return Boolean(queue.cur) || queue.items.length > 0 || inflight || drafting
    || regionWait || Boolean(hold) || Boolean(results) || tripBusy;
}

function syncBubble() {
  if (!alive(bubbleWindow)) return;
  const wanted = bubbleWanted();
  if (wanted && !bubbleWindow.isVisible()) {
    placeBubble();
    bubbleWindow.showInactive();
    send("orb:line", queue.cur);
  } else if (!wanted && bubbleWindow.isVisible()) {
    bubbleWindow.hide();
    drafting = false;
  }
}

function openBubble({ focus = false } = {}) {
  showOrb();
  const win = ensureBubble();
  placeBubble();
  if (!win.isVisible()) win.showInactive();
  send("orb:line", queue.cur);
  if (focus) {
    win.focus();
    try { win.webContents.send("orb:focus"); } catch { /* page loading: focuses on load */ }
  }
}

function closeBubble() {
  suppressed = true;
  bubbleMode = null;
  cardChat = null;
  pendingSlot = null;
  drafting = false;
  if (alive(bubbleWindow)) bubbleWindow.hide();
  return { ok: true };
}

// ── the queue pump ──────────────────────────────────────────────────────────

function pump() {
  const before = queue.cur;
  const out = orbCore.tick(queue, Date.now());
  if (out.hide) send("orb:line", null);
  if (out.show) {
    if (!suppressed && state.visible) {
      if (!(alive(bubbleWindow) && bubbleWindow.isVisible())) {
        openBubble({ focus: false });
      } else {
        placeBubble();
      }
      send("orb:line", out.show);
    }
  } else if (!queue.cur && before) {
    send("orb:line", null);
  }
  send("orb:badge", orbCore.unreadCount(queue) + attention.count);
  syncBubble();
  send("orb:queue", orbCore.queueSummary(queue));
  send("orb:busy", inflight || tripBusy);
  sendTrips();
  // An idle orb costs nothing: stop the pump until the next ask or line.
  if (!queue.cur && queue.items.length === 0 && !inflight && !tripBusy && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function ensurePump() {
  if (tickTimer) return;
  tickTimer = setInterval(pump, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
}

function kick() {
  ensurePump();
  pump();
}

function pushStatus(text, ttlMs, holdMs) {
  orbCore.push(queue, { kind: "status", text, ttlMs, holdMs }, Date.now());
  kick();
}

function dropStatuses() {
  queue.items = queue.items.filter((x) => x.kind !== "status");
  if (queue.cur && queue.cur.kind === "status") {
    queue.cur = null;
    queue.lastHideAt = Date.now();
  }
  kick();
}

/** A new answer is exactly the "something NEW" that reopens a closed bubble. */
function answer(line, meta) {
  suppressed = false;
  orbCore.push(queue, { kind: "answer", text: line, meta }, Date.now());
  kick();
}

function fail(error, meta) {
  suppressed = false;
  orbCore.push(queue, { kind: "error", text: error, meta }, Date.now());
  kick();
}

function busyLine() {
  const line = "One ask at a time — the first answer is still coming.";
  fail(line, { code: "busy" });
  return { ok: false, error: line };
}

// ── capture ─────────────────────────────────────────────────────────────────

function pruneCaptures(keep) {
  let dir;
  try {
    dir = os.tmpdir();
    const cutoff = Date.now() - CAPTURE_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("aither-orb-") || !name.endsWith(".png")) continue;
      const file = path.join(dir, name);
      if (file === keep) continue;
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* another process already cleaned it */ }
    }
  } catch { /* tmp is unreadable: the capture itself still works */ }
}

/** Hide the spirit while a screenshot is taken: the question is about the
 *  desktop, never about the assistant's own card. Returns the visibility to
 *  restore. */
function hideForCapture() {
  const wins = [orbWindow, bubbleWindow, veilWindow].filter(alive);
  const shown = wins.filter((w) => w.isVisible());
  for (const win of shown) {
    try { win.hide(); } catch { /* already gone */ }
  }
  return shown;
}

function restoreAfterCapture(shown) {
  for (const win of shown) {
    if (!alive(win)) continue;
    try { win.showInactive(); } catch { /* a window being destroyed */ }
  }
}

/** A rect of the screen (physical pixels) as a PNG for the vision ladder. */
async function captureRect(rect) {
  const bounds = spiritCore.normBounds(rect);
  if (!bounds) return null;
  let image;
  try {
    image = await capture().nativeFrame({ id: `spirit-${process.pid}`, bounds });
  } catch {
    image = null;
  }
  if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) return null;
  const out = path.join(os.tmpdir(), `aither-orb-${process.pid}-${Date.now()}.png`);
  let png;
  try { png = image.toPNG(); } catch { png = null; }
  // An undecodable nativeImage yields a zero-byte PNG; that is a failed capture,
  // not an image the vision ladder should be asked about.
  if (!png || !png.length) return null;
  try {
    fs.writeFileSync(out, png);
  } catch {
    return null;
  }
  pruneCaptures(out);
  return out;
}

/** Keep the last screenshot only while a follow-up can still use it, then
 *  delete it: a full display of the owner's desk must not sit in %TEMP%. */
function scheduleCaptureCleanup(file) {
  if (!file) return;
  const timer = setTimeout(() => {
    try {
      if (!lastImage || lastImage.path !== file) fs.unlinkSync(file);
    } catch { /* already gone */ }
  }, orbCore.FOLLOWUP_MS + 5000);
  if (timer.unref) timer.unref();
}

/** What "what do you see" means: the attached target's rect, else the display. */
function contextRect() {
  if (attach && attach.bounds && attach.kind !== "avatar") {
    const b = spiritCore.normBounds(attach.bounds);
    if (b) return b;
  }
  return displayForOrb().bounds;
}

async function captureQuietRect(rect) {
  const shown = hideForCapture();
  try {
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_HIDE_MS));
    return await captureRect(rect);
  } finally {
    restoreAfterCapture(shown);
  }
}

async function captureScreen() {
  return captureQuietRect(contextRect());
}

/** Wait for the snip overlay to save a NEW capture (the module exposes only
 *  the last saved path, so the orb watches for it to change). */
function waitForNewScreenshot(before, timeoutMs = REGION_WAIT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let latest;
      try { latest = capture().lastScreenshot(); } catch { latest = null; }
      if (latest && latest !== before) {
        clearInterval(timer);
        resolve(latest);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, ORB_POLL_MS);
    if (timer.unref) timer.unref();
  });
}

// ── asking ──────────────────────────────────────────────────────────────────

function pickContext() {
  if (!lastImage) return null;
  if (Date.now() - lastImage.at > orbCore.FOLLOWUP_MS) return null;
  try {
    if (!fs.existsSync(lastImage.path)) return null;
  } catch {
    return null;
  }
  return lastImage;
}

/** The one vision call. The INFLIGHT guard belongs to the caller (claimAsk),
 *  so it is set before the capture awaits, not after it. */
async function runAsk(imagePath, prompt, question, { label = null } = {}) {
  pushStatus(label || "Reading your screen", 300000);
  try {
    const result = await askVision(imagePath, prompt, { timeoutMs: orbVision.DIRECT_TIMEOUT_MS });
    dropStatuses();
    if (result && result.ok) {
      lastImage = { path: imagePath, question: question || "", at: Date.now() };
      scheduleCaptureCleanup(imagePath);
      lastCaption = String(result.text || "").slice(0, spriteCore.CONTENT_MAX);
      answer(result.text, { via: result.via, model: result.model || null, provider: result.provider || null });
      return { ok: true, via: result.via, text: result.text };
    }
    const card = result && result.title
      ? { code: result.code, title: result.title, remedy: result.remedy, attempts: result.attempts }
      : { code: "unknown" };
    // Every door's own error, in the log and in the verdict -- the headline alone
    // ("timed out after 90 s") named the LAST door and hid why the first failed.
    const attempts = (result && result.attempts) || [];
    console.warn(`[spirit] vision failed: ${JSON.stringify(attempts).slice(0, 600)}`);
    fail((result && result.text) || (result && result.error) || "vision failed", card);
    if (imagePath !== (lastImage && lastImage.path)) scheduleCaptureCleanup(imagePath);
    return { ok: false, error: (result && result.error) || "vision failed", attempts };
  } catch (err) {
    dropStatuses();
    fail(orbCore.failureCard(String((err && err.message) || err)).text, { code: "unknown" });
    if (imagePath !== (lastImage && lastImage.path)) scheduleCaptureCleanup(imagePath);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function claimAsk() {
  if (inflight) return false;
  inflight = true;
  ensurePump();
  return true;
}

function releaseAsk() {
  inflight = false;
  regionWait = false;
  kick();
}

async function askScreen({ slotId = null } = {}) {
  openBubble({ focus: false });
  if (!claimAsk()) return busyLine();
  try {
    const shot = await captureScreen();
    if (!shot) {
      fail(
        "I could not capture the screen under the orb.\n\nCheck Settings > Privacy > Screen recording (and that the display under the orb is switched on), then ask again.",
        { code: "capture" },
      );
      return { ok: false, error: "screen capture failed" };
    }
    const r = await runAsk(shot, orbCore.buildPrompt("screen", ""), "What's on my screen?");
    if (r.ok) speakAnswer(r.text, slotId, { onlyIfAttached: true });
    return r;
  } finally {
    releaseAsk();
  }
}

async function askRegion({ slotId = null } = {}) {
  openBubble({ focus: false });
  if (!claimAsk()) return busyLine();
  regionWait = true;
  try {
    let before;
    try { before = capture().lastScreenshot(); } catch { before = null; }
    const shown = hideForCapture();
    let started;
    try {
      started = await capture().startSnip({ mode: "region" });
    } catch (err) {
      started = { ok: false, reason: String((err && err.message) || err) };
    } finally {
      restoreAfterCapture(shown);
    }
    if (!started || started.ok !== true) {
      fail(
        `${(started && started.reason) || "the snip overlay did not open"}\n\nTry Snip a region from the tray (PrintScreen) — if that works, the orb's only missing part is the overlay already being open.`,
        { code: "capture" },
      );
      return { ok: false, error: (started && started.reason) || "snip did not open" };
    }
    pushStatus("Select the part to explain (this saves a snapshot to Aither Screenshots)", REGION_WAIT_MS, REGION_WAIT_MS);
    const shot = await waitForNewScreenshot(before, REGION_WAIT_MS);
    if (!shot) {
      dropStatuses();
      return { ok: false, error: "no region was selected" };
    }
    regionWait = false;
    const r = await runAsk(shot, orbCore.buildPrompt("region", ""), "Explain this region");
    if (r.ok) speakAnswer(r.text, slotId, { onlyIfAttached: true });
    return r;
  } finally {
    releaseAsk();
  }
}

async function askText(text, { slotId = null } = {}) {
  const said = String(text || "").trim();
  if (!said) return { ok: false, error: "type a question first" };
  openBubble({ focus: false });
  if (!claimAsk()) return busyLine();
  try {
    // Chatting about a card (the whisper's Chat, or Alt+Space -> "Ask the fairy
    // about"): the card is the context, ahead of a held file or a past screen.
    if (bubbleMode === "card" && cardChat) {
      const question = fairyAttention.chatQuestion(cardChat.context, said);
      const shot = await captureScreen();
      if (!shot) {
        fail("I could not capture the screen to answer that.\n\nCheck Settings > Privacy > Screen recording, then ask again.", { code: "capture" });
        return { ok: false, error: "screen capture failed" };
      }
      const r = await runAsk(shot, orbCore.buildPrompt("text", question), said, { label: "Thinking about the card" });
      if (r.ok) speakAnswer(r.text, slotId, { onlyIfAttached: true });
      return r;
    }
    // A held file or link is the context for the next question: the owner asked
    // for "follow-up questions keep the file as context".
    if (hold && hold.kind === "file") {
      const r = await ops.readFile(hold.path, said);
      if (r.ok) {
        answer(r.answer, { via: "file", held: hold.path });
        speakAnswer(r.answer, slotId, { onlyIfAttached: true });
        return r;
      }
      fail(r.line || r.reason || "the file could not be read", { code: r.refused ? "secret" : "file" });
      return r;
    }
    if (hold && hold.kind === "web") {
      const r = await ops.readWeb(hold.url, said);
      if (r.ok) {
        answer(r.answer, { via: "web", held: hold.url });
        speakAnswer(r.answer, slotId, { onlyIfAttached: true });
        return r;
      }
      fail(r.line || r.reason || "that page could not be read", { code: "web" });
      return r;
    }
    const context = pickContext();
    if (context) {
      const prompt = orbCore.buildPrompt("text", said, { isFollowUp: true, lastQuestion: context.question });
      const r = await runAsk(context.path, prompt, said);
      if (r.ok) speakAnswer(r.text, slotId, { onlyIfAttached: true });
      return r;
    }
    const shot = await captureScreen();
    if (!shot) {
      fail(
        "I could not capture the screen to answer that.\n\nCheck Settings > Privacy > Screen recording, then ask again.",
        { code: "capture" },
      );
      return { ok: false, error: "screen capture failed" };
    }
    const r = await runAsk(shot, orbCore.buildPrompt("text", said), said);
    if (r.ok) speakAnswer(r.text, slotId, { onlyIfAttached: true });
    return r;
  } finally {
    releaseAsk();
  }
}

// ── voice: the avatar speaks when the spirit is attached to one ─────────────

function speakAnswer(text, slotId, { onlyIfAttached = false } = {}) {
  const body = String(text == null ? "" : text).trim();
  if (!body) return { ok: false, reason: "nothing to say" };
  const slot = slotId || (attach && attach.kind === "avatar" ? attach.slotId : null);
  if (!slot && onlyIfAttached) return { ok: false, reason: "not attached to a body" };
  if (!speakImpl) return { ok: false, reason: "no voice is wired" };
  try {
    const verdict = speakImpl(body, { slotId: slot || "slot0", origin: "desk:spirit" });
    if (verdict && typeof verdict.catch === "function") verdict.catch(() => { /* the caption still says it */ });
    return { ok: true, slotId: slot || "slot0" };
  } catch {
    return { ok: false, reason: "the voice service refused" };
  }
}

// ── flight and the trail ────────────────────────────────────────────────────

/**
 * Fly the orb along an eased arc to `point` (a CENTRE). Resolves
 * {ok, cancelled}. A flight is always visible: the veil draws the path.
 */
function flyTo(point, { durationMs = null } = {}) {
  if (!alive(orbWindow)) return Promise.resolve({ ok: false, error: "no orb" });
  const from = orbCenter();
  const to = { x: Number(point && point.x) || from.x, y: Number(point && point.y) || from.y };
  const path = spiritCore.flightPath(from, to);
  const duration = Math.max(200, Number(durationMs) || spiritCore.flightDurationMs(from, to));
  return new Promise((resolve) => {
    if (flight) {
      try { flight.resolve({ ok: true, cancelled: true }); } catch { /* already settled */ }
    }
    flight = { path, from, to, startedAt: Date.now(), duration, resolve, cancelled: false };
    trail = [from];
    lastTrailAt = Date.now();
    coverVeil([from, to]);
    showVeil();
    drawVeil();
    if (flightTimer) clearInterval(flightTimer);
    flightTimer = setInterval(stepFlight, FLIGHT_STEP_MS);
    if (flightTimer.unref) flightTimer.unref();
  });
}

function stepFlight() {
  if (!flight) return;
  const now = Date.now();
  const t = Math.min(1, (now - flight.startedAt) / flight.duration);
  const point = spiritCore.pointAt(flight.path, spiritCore.easeInOut(t));
  setOrbCenter(point);
  if (now - lastTrailAt >= TRAIL_GAP_MS) {
    trail.push(point);
    while (trail.length > TRAIL_MAX) trail.shift();
    lastTrailAt = now;
  }
  drawVeil();
  if (t >= 1) finishFlight();
}

function finishFlight() {
  if (!flight) return { ok: true };
  const done = flight;
  flight = null;
  if (flightTimer) {
    clearInterval(flightTimer);
    flightTimer = null;
  }
  if (done.cancelled) {
    // A cancelled flight stops where it IS — never teleports to the target it
    // was heading for, which would read as a jump followed by a trip home.
    const t = Math.min(1, (Date.now() - done.startedAt) / done.duration);
    setOrbCenter(spiritCore.pointAt(done.path, spiritCore.easeInOut(t)));
  } else {
    setOrbCenter(done.to);
  }
  drawVeil();
  if (!attach && !tripBusy) hideVeil();
  try { done.resolve({ ok: true, cancelled: done.cancelled }); } catch { /* settled */ }
  return { ok: true, cancelled: done.cancelled };
}

/** Cancel the running trip: the flight turns around, the queue keeps its rest. */
function cancelTrip() {
  const trip = tripQueue.cur;
  const wasFlying = Boolean(flight);
  if (flight) {
    flight.cancelled = true;
    finishFlight();
  }
  if (!trip) return { ok: wasFlying, reason: wasFlying ? "flight cancelled" : "no trip is running" };
  spiritCore.cancel(tripQueue, trip.id);
  const pending = pendingRuns.get(trip.id);
  if (pending) {
    pendingRuns.delete(trip.id);
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: "cancelled", trip });
  }
  spiritCore.logTrip(tripLog, { label: `cancelled ${spiritCore.quote(trip.target, 32)}`, ok: false });
  sendTrips();
  pushStatus("Trip cancelled", 6000, 6000);
  void flyHome(520);
  return { ok: true, cancel: true, trip };
}

async function flyHome(durationMs = null) {
  if (!alive(orbWindow)) return { ok: false };
  const area = restoreWorkArea();
  const pos = state.x != null && state.y != null
    ? orbCore.clampToWorkArea({ x: state.x, y: state.y }, ORB_SIZE, area)
    : orbCore.defaultOrbPosition(area, ORB_SIZE);
  const target = { x: pos.x + ORB_SIZE.width / 2, y: pos.y + ORB_SIZE.height / 2 };
  const r = await flyTo(target, { durationMs });
  if (!attach) hideVeil();
  return r;
}

function lookoutPoint() {
  const area = displayForOrb().workArea;
  return { x: area.x + area.width * 0.62, y: area.y + area.height * 0.22 };
}

async function sendHome() {
  detach({ silent: true });
  const area = displayForOrb().workArea;
  const pos = orbCore.defaultOrbPosition(area, ORB_SIZE);
  await flyTo({ x: pos.x + ORB_SIZE.width / 2, y: pos.y + ORB_SIZE.height / 2 });
  state.x = pos.x;
  state.y = pos.y;
  saveState();
  hideVeil();
  return { ok: true };
}

// ── attach ──────────────────────────────────────────────────────────────────

async function attachableTargets() {
  if (!avatarTargetsImpl) return [];
  try {
    const list = await avatarTargetsImpl();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Every visible desk BrowserWindow (board, recorder, editor) as a target. */
function electronWindowTargets() {
  const { BrowserWindow } = electron();
  const own = new Set([orbWindow, bubbleWindow, veilWindow].filter(Boolean));
  let wins;
  try { wins = BrowserWindow.getAllWindows(); } catch { wins = []; }
  return wins
    .filter((w) => alive(w) && !own.has(w) && w.isVisible())
    .map((w) => ({
      kind: "desk",
      windowId: w.id,
      title: (() => { try { return w.getTitle() || "a desk window"; } catch { return "a desk window"; } })(),
      bounds: w.getBounds(),
    }));
}

async function probeTargetAt(point) {
  if (!probe) probe = spiritProbe.createWindowProbe();
  try {
    return await probe.pointAt(point.x, point.y, { excludePid: process.pid });
  } catch {
    return null;
  }
}

/** What a drop landed on: an external window if one is under the point (its
 *  rect is what the owner sees), else an avatar, else a desk window. */
async function resolveDropTarget(point) {
  const external = await probeTargetAt(point);
  if (external) return external;
  const candidates = [...(await attachableTargets()), ...electronWindowTargets()];
  return spiritCore.pickAttachTarget(point, candidates);
}

function stopFollow() {
  if (followTimer) {
    clearInterval(followTimer);
    followTimer = null;
  }
  followMisses = 0;
}

function startFollow() {
  stopFollow();
  followTimer = setInterval(() => { void refreshAttach(); }, FOLLOW_MS);
  if (followTimer.unref) followTimer.unref();
}

async function refreshAttach() {
  // Never yank the orb back to a shoulder while it is flying or working: the
  // tether catches up when the trip is done.
  if (!attach || flight || tripBusy || nudging) return;
  let bounds = attach.bounds;
  if (attach.kind === "window" && attach.hwnd) {
    if (!probe) probe = spiritProbe.createWindowProbe();
    const now = await probe.rectOf(attach.hwnd, { excludePid: process.pid });
    if (!now) {
      followMisses += 1;
      if (followMisses >= 3) detach({ reason: "that window went away" });
      return;
    }
    followMisses = 0;
    bounds = now.bounds;
    attach.title = now.title || attach.title;
  } else if (attach.kind === "desk" && attach.windowId) {
    const { BrowserWindow } = electron();
    const win = BrowserWindow.fromId(attach.windowId);
    if (!alive(win)) {
      detach({ reason: "that window closed" });
      return;
    }
    bounds = win.getBounds();
  } else if (attach.kind === "avatar" && attach.slotId) {
    const targets = await attachableTargets();
    const now = targets.find((t) => t.slotId === attach.slotId);
    if (!now) {
      followMisses += 1;
      if (followMisses >= 4) detach({ reason: "that body went away" });
      return;
    }
    followMisses = 0;
    bounds = now.bounds;
    if (now.title) attach.title = now.title;
  }
  attach.bounds = spiritCore.normBounds(bounds) || attach.bounds;
  if (attach.kind === "avatar") return; // the orbit timer moves it around the body
  const dock = spiritCore.dockPosition(attach, ORB_SIZE);
  setOrbCenter({ x: dock.x + ORB_SIZE.width / 2, y: dock.y + ORB_SIZE.height / 2 });
  drawVeil();
}

function stopOrbit() {
  if (orbitTimer) { clearInterval(orbitTimer); orbitTimer = null; }
}

function startOrbit() {
  stopOrbit();
  let lastFront = 0;
  orbitTimer = setInterval(() => {
    if (!attach || attach.kind !== "avatar" || flight || tripBusy || dragging || nudging) return;
    const p = spiritCore.orbitPoint(attach.bounds, Date.now());
    if (!p) return;
    setOrbCenter(p);
    if (p.front !== lastFront) { lastFront = p.front; send("orb:depth", { front: p.front }); }
  }, ORBIT_MS);
  if (orbitTimer.unref) orbitTimer.unref();
}

/** A free spirit (not set free by the owner) finds an avatar and starts orbiting it. */
async function seekAvatar() {
  if (attach || flight || tripBusy || dragging || nudging || state.freeRoam || !orbVisible()) return;
  const body = (await attachableTargets()).find((t) => t && t.kind === "avatar");
  if (body) await attachTo(body, { quiet: true });
}

/** Free and idle: hover around the remembered spot (state.x/y is the window's top-left). */
let hoverTimer = null;
function startHover() {
  if (hoverTimer) return;
  hoverTimer = setInterval(() => {
    if (attach || flight || tripBusy || dragging || nudging || !orbVisible()) return;
    if (state.x == null || state.y == null) return;
    const d = spiritCore.hoverOffset(Date.now());
    setOrbCenter({ x: state.x + ORB_SIZE.width / 2 + d.x, y: state.y + ORB_SIZE.height / 2 + d.y });
  }, ORBIT_MS);
  if (hoverTimer.unref) hoverTimer.unref();
}

function startSeek() {
  if (seekTimer) clearInterval(seekTimer);
  seekTimer = setInterval(() => { void seekAvatar(); }, ORBIT_SEEK_MS);
  if (seekTimer.unref) seekTimer.unref();
}

async function attachTo(target, { quiet = false } = {}) {
  if (!target || !spiritCore.normBounds(target.bounds)) {
    fail("That is not something I can attach to.");
    return { ok: false, error: "no usable bounds" };
  }
  if (dragging) {
    dragging = null;
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  }
  if (flight) {
    flight.cancelled = true;
    finishFlight();
  }
  if (!attach && !home) home = orbCenter();
  const next = { ...target, bounds: spiritCore.normBounds(target.bounds) };
  next.tint = next.kind === "avatar"
    ? spiritCore.tintFor(next.slotId, next.tint || next.color || next.colour)
    : restTint();
  attach = next;
  tint = next.tint;
  stopFollow();
  sendTint();
  let targetPoint;
  if (attach.kind === "avatar") {
    targetPoint = spiritCore.orbitPoint(attach.bounds, Date.now() + 560);
  } else {
    const dock = spiritCore.dockPosition(attach, ORB_SIZE);
    targetPoint = { x: dock.x + ORB_SIZE.width / 2, y: dock.y + ORB_SIZE.height / 2 };
  }
  showVeil();
  await flyTo(targetPoint, { durationMs: 560 });
  startFollow();
  if (attach && attach.kind === "avatar") startOrbit();
  sendAttach();
  if (!quiet) pushStatus(spiritCore.attachLabel(attach), 6000, 6000);
  return { ok: true, attach: publicAttach() };
}

function publicAttach() {
  return attach
    ? { kind: attach.kind, slotId: attach.slotId || null, title: attach.title || null, tint: tint.css }
    : null;
}

function detach({ silent = false, reason = null } = {}) {
  if (!attach) return { ok: true, attached: false };
  stopFollow();
  stopOrbit();
  const was = attach;
  attach = null;
  tint = restTint();
  sendTint();
  if (reason) pushStatus(reason, 6000, 6000);
  if (!silent) {
    const back = home || orbCenter();
    void flyTo(back, { durationMs: 480 }).then(() => { if (!attach) hideVeil(); });
  }
  sendAttach();
  return { ok: true, attached: false, was: { kind: was.kind, title: was.title } };
}

async function toggleAttach() {
  if (attach) {
    state.freeRoam = true; // the owner set it free: no automatic re-orbit
    saveState();
    return detach();
  }
  state.freeRoam = false;
  saveState();
  const point = orbCenter();
  const external = await probeTargetAt(point);
  if (external) return attachTo(external);
  const candidates = [...(await attachableTargets()), ...electronWindowTargets()];
  const local = spiritCore.pickAttachTarget(point, candidates);
  if (local) return attachTo(local);
  fail("Nothing to attach to here — drop the spirit on a window, a board or an avatar.");
  return { ok: false, error: "nothing to attach to" };
}

// ── the sprite: the fairy wears the owner's AitherSprite ────────────────────

/** Where the fairy rests when nothing tints it: the sprite's mood, else the plain white. */
function restTint() {
  return sprite && sprite.tint ? sprite.tint : spiritCore.tintFor("slot0");
}

function publicSprite() {
  return sprite
    ? { name: sprite.name, stage: sprite.stage, mood: sprite.mood, line: sprite.line, tooltip: sprite.tooltip, tint: sprite.tint }
    : null;
}

function spriteClient() {
  if (spriteClientImpl) return spriteClientImpl;
  spriteClientImpl = spriteCore.createSpriteClient({ token: spriteTokenImpl });
  return spriteClientImpl;
}

/**
 * Re-read the sprite and re-dress the fairy. Silent: any failure (signed out,
 * refused, no sprite, offline) is the plain fairy, never a bubble. Returns the
 * client's verdict for `sprite.status`.
 */
async function refreshSprite() {
  let verdict;
  try {
    verdict = await spriteClient().status();
  } catch {
    verdict = { ok: false, reason: "offline", view: null };
  }
  sprite = verdict && verdict.ok ? verdict.view : null;
  if (!attach) {
    tint = restTint();
    sendTint();
  }
  send("orb:sprite", publicSprite());
  return verdict;
}

function startSpritePoll() {
  if (spriteTimer) return;
  spriteTimer = setInterval(() => { void refreshSprite(); }, SPRITE_POLL_MS);
  spriteTimer.unref?.();
}

/** The desk's own pids: their windows are never read as "the selection". */
function deskPids() {
  try { return electron().app.getAppMetrics().map((m) => m.pid); } catch { return [process.pid]; }
}

/** Highlighted text in the app under the desk, via UI Automation (no keys, no clipboard). */
async function readSelection() {
  if (selectionImpl) return String((await selectionImpl()) || "");
  try { return await selectionReader.readSelection({ excludePids: deskPids() }); } catch { return ""; }
}

function readClipboard() {
  if (clipboardImpl) return String(clipboardImpl() || "");
  try { return String(electron().clipboard.readText() || ""); } catch { return ""; }
}

async function spriteStatus() {
  const verdict = await refreshSprite();
  const line = spriteCore.statusLine(verdict && verdict.ok ? verdict.view : null, verdict);
  if (verdict && verdict.ok) answer(line, { via: "sprite" });
  else fail(line, { code: `sprite-${(verdict && verdict.reason) || "offline"}` });
  return { ok: Boolean(verdict && verdict.ok), line, sprite: publicSprite() };
}

/** Teach the typed arg, else the highlighted selection, else the clipboard, else the last snip's caption. */
async function spriteTeach(arg) {
  const typed = arg == null ? "" : String(arg).trim();
  const selection = typed ? "" : await readSelection();
  const payload = spriteCore.teachPayload({ arg: typed, selection, clipboard: typed || selection.trim() ? "" : readClipboard(), lastCaption });
  // Nothing given, nothing copied, no snip read: the bubble field is the typed door.
  if (!payload) return openMode("sprite-teach");
  const refused = spriteCore.looksSecret(payload.content)
    || (payload.kind === "link" && spiritCore.secretPathReason(payload.content));
  if (refused) {
    const line = "That looks like a credential; it was not taught.";
    fail(line, { code: "sprite-secret" });
    return { ok: false, error: line };
  }
  pushStatus(`Teaching ${sprite ? sprite.name : "your sprite"}`, 20000);
  let r;
  let woke = false;
  try {
    r = await spriteClient().teach(payload);
    // A dormant sprite refuses every care action (409). Teaching is the food:
    // wake it once and teach what was asked for, rather than reporting the
    // network as down while the creature is merely asleep. The wake costs a
    // round trip and the service throttles teach to one per 2 s, so wait for
    // that window before the retry -- otherwise the retry earns a 429.
    if (r && !r.ok && r.reason === "dormant") {
      const revived = await spriteClient().revive();
      if (revived && revived.ok) {
        woke = true;
        await new Promise((ok) => setTimeout(ok, teachRetryDelayMs));
        r = await spriteClient().teach(payload);
      }
    } else if (r && !r.ok && r.reason === "throttled") {
      await new Promise((ok) => setTimeout(ok, teachRetryDelayMs));
      r = await spriteClient().teach(payload);
    }
  } catch {
    r = { ok: false, reason: "offline" };
  }
  dropStatuses();
  if (!r.ok) {
    const line = r.reason === "dormant"
      ? `${sprite ? sprite.name : "Your sprite"} is asleep and would not wake — open the sprite page to revive it.`
      : ["signed-out", "refused", "no-sprite"].includes(r.reason)
        ? spriteCore.statusLine(null, r)
        : "Could not reach your sprite to teach it — try again.";
    fail(line, { code: `sprite-${r.reason}` });
    return { ok: false, error: line };
  }
  const who = sprite ? sprite.name : "Your sprite";
  const from = payload.source === "selection" ? " (from your selection)" : payload.source === "clipboard" ? " (from the clipboard)" : payload.source === "snip" ? " (from the last snip)" : "";
  const line = `${who} learned “${payload.title}”${from}${woke ? " (woke it up to do it)" : ""}.`;
  answer(line, { via: "sprite" });
  void refreshSprite();
  return { ok: true, line, kind: payload.kind, title: payload.title };
}

/** One aw* CLI verb: needs-a-query opens the field; otherwise run and speak the output. */
async function runAwVerb(verb, arg) {
  const spec = awCli.AW_VERBS[verb];
  const typed = awCli.cleanArg(arg);
  if (spec.needsArg && !typed) return openMode(verb);
  showOrb();
  pushStatus(`Running ${spec.bin}`, (spec.timeoutMs || awCli.TIMEOUT_MS) + 5000);
  let r;
  try {
    r = await (awRunImpl || awCli.runAw)(verb, typed);
  } catch (error) {
    r = { ok: false, text: String((error && error.message) || error) };
  }
  dropStatuses();
  const text = r && r.text ? String(r.text) : `${spec.bin}: no output`;
  if (r && r.ok) answer(text, { via: spec.bin, title: spec.title });
  else fail(text, { code: r && r.missing ? "aw-missing" : "aw-failed", title: spec.title });
  return { ok: Boolean(r && r.ok), text, missing: Boolean(r && r.missing) };
}

// ── trips: one at a time, the rest wait ─────────────────────────────────────

function sendTrips() {
  send("orb:trips", {
    view: spiritCore.logView(tripLog),
    count: spiritCore.queueCount(tripQueue),
    line: spiritCore.queueLine(tripQueue),
  });
}

function sendTint() {
  send("orb:tint", { name: tint.name, css: tint.css });
}

function sendAttach() {
  send("orb:attach", {
    attached: Boolean(attach),
    label: spiritCore.attachLabel(attach),
    tint: tint.css,
  });
}

function sendHold() {
  send("orb:hold", {
    hold,
    label: spiritCore.holdLabel(hold),
    actions: spiritCore.holdActions(hold, { hasBoard: Boolean(commandRegistry().byId("board.new")) }),
  });
}

function sendResults() {
  send("orb:results", results);
  send("orb:mode", { mode: bubbleMode });
}

function commandRegistry() {
  return require("./command-registry.cjs");
}

function openMode(mode) {
  bubbleMode = mode || null;
  openBubble({ focus: true });
  send("orb:mode", { mode: bubbleMode });
  return { ok: true, mode: bubbleMode };
}

/** Queue one trip and resolve when IT finishes (the bridge's command reply). */
function go(request) {
  const before = tripQueue.items.length;
  if (before >= tripQueue.max) {
    const dropped = tripQueue.items[0];
    const pending = pendingRuns.get(dropped.id);
    if (pending) {
      pendingRuns.delete(dropped.id);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "dropped from the queue", trip: dropped });
    }
  }
  const { trip, position } = spiritCore.enqueue(tripQueue, request);
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingRuns.has(trip.id)) return;
      pendingRuns.delete(trip.id);
      resolve({ ok: false, error: "the trip timed out", trip });
    }, TRIP_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    pendingRuns.set(trip.id, { resolve, timer });
  });
  if (position > 1) pushStatus(spiritCore.queueLine(tripQueue), 8000, 8000);
  sendTrips();
  void pumpTrips();
  return promise;
}

async function pumpTrips() {
  if (tripBusy) return;
  tripBusy = true;
  ensurePump();
  try {
    let trip = spiritCore.dequeue(tripQueue);
    while (trip) {
      let outcome;
      try {
        outcome = await executeTrip(trip);
      } catch (error) {
        outcome = { ok: false, reason: String((error && error.message) || error) };
      }
      spiritCore.finish(tripQueue, trip.id);
      const summary = spiritCore.tripSummary(trip, outcome);
      spiritCore.logTrip(tripLog, { label: summary, ok: outcome.ok !== false });
      sendTrips();
      if (outcome.ok === false && outcome.cancelled !== true) {
        fail(outcome.line || outcome.reason || "the trip did not finish", { code: outcome.refused ? "secret" : "trip" });
      }
      const pending = pendingRuns.get(trip.id);
      if (pending) {
        pendingRuns.delete(trip.id);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: outcome.ok !== false,
          trip: { id: trip.id, kind: trip.kind, target: trip.target, question: trip.question },
          ...(outcome.answer ? { answer: outcome.answer } : {}),
          ...(outcome.held ? { held: outcome.held } : {}),
          ...(outcome.rows ? { rows: outcome.rows } : {}),
          ...(outcome.more != null ? { more: outcome.more } : {}),
          ...(outcome.total != null ? { total: outcome.total } : {}),
          ...(outcome.line ? { line: outcome.line } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.cancelled ? { cancelled: true } : {}),
        });
      }
      trip = spiritCore.dequeue(tripQueue);
    }
  } finally {
    tripBusy = false;
    kick();
  }
}

function isCurrentTrip(trip) {
  return Boolean(tripQueue.cur && tripQueue.cur.id === trip.id);
}

/** Where a trip goes on screen, or null when it has no visible target. */
async function targetPointFor(trip) {
  if (trip.kind === "window") {
    if (!probe) probe = spiritProbe.createWindowProbe();
    const raw = String(trip.target || "").trim();
    const hwnd = /^hwnd:(\d+)$/i.exec(raw) || (/^\d+$/.test(raw) ? [null, raw] : null);
    if (hwnd) {
      const t = await probe.rectOf(Number(hwnd[1]), { excludePid: process.pid });
      if (t) return { point: { x: t.bounds.x + t.bounds.width / 2, y: t.bounds.y + Math.min(120, t.bounds.height / 3) }, target: t };
    }
    const { BrowserWindow } = electron();
    const want = raw.toLowerCase();
    let found;
    try {
      found = BrowserWindow.getAllWindows().find((w) => alive(w) && w.isVisible()
        && String(w.getTitle() || "").toLowerCase().includes(want));
    } catch { found = null; }
    if (found) {
      const b = found.getBounds();
      return {
        point: { x: b.x + b.width / 2, y: b.y + Math.min(120, b.height / 3) },
        target: { kind: "desk", windowId: found.id, title: found.getTitle(), bounds: b },
      };
    }
    return { point: null, target: null };
  }
  if (trip.kind === "region") {
    const area = displayForOrb().workArea;
    return { point: { x: area.x + area.width / 2, y: area.y + area.height / 2 }, target: null };
  }
  if (trip.kind === "web") {
    ensureBubble();
    placeBubble();
    const b = alive(bubbleWindow) ? bubbleWindow.getBounds() : null;
    if (b) return { point: { x: b.x + 28, y: b.y + b.height - 28 }, target: null };
  }
  return { point: lookoutPoint(), target: null };
}

async function executeTrip(trip) {
  openBubble({ focus: false });
  const caption = spiritCore.captionFor(trip);
  pushStatus(caption, 90000, 90000);
  const route = await targetPointFor(trip);
  if (!isCurrentTrip(trip)) return { ok: false, cancelled: true };
  if (route.point) {
    const flew = await flyTo(route.point);
    if (flew.cancelled || !isCurrentTrip(trip)) return { ok: false, cancelled: true };
  }
  if (trip.slotId) {
    tint = spiritCore.tintFor(trip.slotId);
    sendTint();
  }
  const outcome = await performTrip(trip, route.target);
  if (!isCurrentTrip(trip)) return { ok: false, cancelled: true };
  await flyHome(520);
  return outcome;
}

async function performTrip(trip, windowTarget) {
  if (trip.kind === "file") {
    const secret = spiritCore.secretPathReason(trip.target);
    if (secret) {
      return { ok: false, refused: true, line: secret.line, reason: secret.reason };
    }
    let stat;
    try { stat = fs.statSync(trip.target); } catch { stat = null; }
    if (!stat || !stat.isFile()) return { ok: false, reason: `${trip.target} is not there` };
    if (trip.question) {
      const r = await ops.readFile(trip.target, trip.question);
      if (!r.ok) return { ok: false, refused: r.refused, line: r.line || r.reason, reason: r.reason };
      answer(r.answer, { via: "file", held: trip.target });
      speakAnswer(r.answer, trip.slotId, { onlyIfAttached: true });
      return { ok: true, answer: r.answer };
    }
    hold = spiritCore.holdFromFile(trip.target);
    sendHold();
    const line = `Holding ${hold.label} — ${trip.target}`;
    answer(line, { held: trip.target });
    speakAnswer(`I found ${hold.label}. It is on your screen.`, trip.slotId, { onlyIfAttached: true });
    return { ok: true, held: hold, answer: line };
  }

  if (trip.kind === "folder") {
    const r = await ops.listFolder(trip.target);
    if (!r.ok) return { ok: false, refused: r.refused, line: r.line || r.reason, reason: r.reason };
    results = { mode: "folder", query: trip.target, rows: r.rows, more: r.more, total: r.total };
    sendResults();
    openBubble({ focus: false });
    bubbleMode = null;
    send("orb:mode", { mode: null });
    const line = `${r.total} item${r.total === 1 ? "" : "s"} in ${spiritCore.baseName(trip.target) || trip.target}.`;
    answer(line, { via: "file", folder: trip.target });
    speakAnswer(line, trip.slotId, { onlyIfAttached: true });
    return { ok: true, answer: line, rows: r.rows, more: r.more, total: r.total };
  }

  if (trip.kind === "window") {
    if (!windowTarget) {
      return { ok: false, reason: `no window matching “${trip.target}”` };
    }
    const shot = await captureQuietRect(windowTarget.bounds);
    if (trip.question) {
      if (!shot) return { ok: false, reason: "that window could not be captured" };
      const r = await runAsk(shot, orbCore.buildPrompt("text", trip.question), trip.question, { label: spiritCore.captionFor(trip) });
      if (!r.ok) return { ok: false, reason: r.error };
      speakAnswer(r.text, trip.slotId, { onlyIfAttached: true });
      return { ok: true, answer: r.text };
    }
    const line = `That is “${windowTarget.title || trip.target}”.`;
    if (shot) scheduleCaptureCleanup(shot);
    answer(line, { via: "window" });
    speakAnswer(line, trip.slotId, { onlyIfAttached: true });
    return { ok: true, answer: line };
  }

  if (trip.kind === "region") {
    if (!claimAsk()) return { ok: false, reason: "one ask at a time" };
    regionWait = true;
    try {
      let before;
      try { before = capture().lastScreenshot(); } catch { before = null; }
      const shown = hideForCapture();
      let started;
      try { started = await capture().startSnip({ mode: "region" }); } catch (error) {
        started = { ok: false, reason: String((error && error.message) || error) };
      } finally {
        restoreAfterCapture(shown);
      }
      if (!started || started.ok !== true) return { ok: false, reason: (started && started.reason) || "snip did not open" };
      pushStatus("Select the part to look at (this saves a snapshot to Aither Screenshots)", REGION_WAIT_MS, REGION_WAIT_MS);
      const shot = await waitForNewScreenshot(before, REGION_WAIT_MS);
      if (!shot) return { ok: false, reason: "no region was selected" };
      regionWait = false;
      const r = await runAsk(shot, orbCore.buildPrompt("region", trip.question || ""), trip.question || "Explain this region", { label: spiritCore.captionFor(trip) });
      if (!r.ok) return { ok: false, reason: r.error };
      speakAnswer(r.text, trip.slotId, { onlyIfAttached: true });
      return { ok: true, answer: r.text };
    } finally {
      releaseAsk();
    }
  }

  if (trip.kind === "web") {
    const r = await ops.webSearch(trip.target, { answer: Boolean(trip.question), limit: 12 });
    if (!r.ok) return { ok: false, line: r.line || r.reason, reason: r.reason };
    results = { mode: "web", query: trip.target, rows: r.rows, more: r.more, total: r.total, answer: r.answer || null };
    sendResults();
    openBubble({ focus: false });
    bubbleMode = null;
    send("orb:mode", { mode: null });
    if (r.answer) {
      answer(r.answer, { via: "web" });
      speakAnswer(r.answer, trip.slotId, { onlyIfAttached: true });
    } else {
      const line = `${spiritCore.resultCountLine(r)} for ${spiritCore.quote(trip.target)}.`;
      answer(line, { via: "web" });
      speakAnswer(line, trip.slotId, { onlyIfAttached: true });
    }
    return { ok: true, answer: r.answer || null, rows: r.rows, more: r.more, total: r.total };
  }

  // search
  const r = await ops.findFiles(trip.target);
  if (!r.ok) return { ok: false, line: r.reason, reason: r.reason };
  if (!r.rows.length) {
    results = { mode: "find", query: trip.target, rows: [], more: 0, total: 0 };
    sendResults();
    openBubble({ focus: false });
    bubbleMode = null;
    send("orb:mode", { mode: null });
    const line = `I could not find anything for ${spiritCore.quote(trip.target)}.`;
    answer(line, { via: "file" });
    speakAnswer(line, trip.slotId, { onlyIfAttached: true });
    return { ok: true, answer: line, rows: [], more: 0, total: 0 };
  }
  results = { mode: "find", query: trip.target, rows: r.rows, more: r.more, total: r.total };
  sendResults();
  openBubble({ focus: false });
  bubbleMode = null;
  send("orb:mode", { mode: null });
  // "go find this file and give me the path": one hit is held automatically.
  if (r.rows.length === 1 && r.more === 0) {
    hold = spiritCore.holdFromFile(r.rows[0].target);
    sendHold();
    const line = `Holding ${hold.label} — ${hold.path}`;
    answer(line, { held: hold.path, via: "file" });
    speakAnswer(`I found ${hold.label}. It is on your screen.`, trip.slotId, { onlyIfAttached: true });
    return { ok: true, held: hold, answer: line, rows: r.rows, more: r.more, total: r.total };
  }
  const line = `${spiritCore.resultCountLine(r)} for ${spiritCore.quote(trip.target)} — pick one in the bubble.`;
  answer(line, { via: "file" });
  speakAnswer(line, trip.slotId, { onlyIfAttached: true });
  return { ok: true, answer: line, rows: r.rows, more: r.more, total: r.total };
}

// ── holds, results, drops and the right-click menu ─────────────────────────

function openHeld() {
  if (!hold) return { ok: false, error: "nothing is held" };
  const { shell } = electron();
  if (hold.kind === "file") {
    void shell.openPath(hold.path);
    return { ok: true, opened: hold.path };
  }
  if (hold.kind === "web") {
    return openUrl(hold.url);
  }
  return { ok: false, error: "nothing to open" };
}

function openUrl(url) {
  const target = String(url || "");
  if (openUrlImpl) return openUrlImpl(target);
  try {
    const { shell } = electron();
    void shell.openExternal(target);
    return { ok: true, url: target };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

async function runHoldAction(action) {
  if (!hold) return { ok: false, error: "nothing is held" };
  const what = String(action || "");
  const { shell, clipboard } = electron();
  // Reading is an ask too: one at a time, with the same loud sentence.
  const asks = new Set(["read", "what", "summarize"]);
  if (asks.has(what)) {
    if (inflight) return busyLine();
    inflight = true;
    ensurePump();
    try {
      return await holdReadAction(what);
    } finally {
      releaseAsk();
    }
  }
  if (what === "open") return openHeld();
  if (what === "show") {
    if (hold.kind !== "file") return { ok: false, error: "a link has no folder" };
    shell.showItemInFolder(hold.path);
    return { ok: true, shown: hold.path };
  }
  if (what === "copy") {
    clipboard.writeText(hold.kind === "file" ? hold.path : hold.kind === "web" ? hold.url : hold.text);
    pushStatus(`Copied ${hold.kind === "file" ? "the path" : hold.kind === "web" ? "the link" : "the text"}`, 5000, 5000);
    return { ok: true, copied: true };
  }
  if (what === "board") {
    if (!commandRegistry().byId("board.new")) return { ok: false, error: "there is no whiteboard on this desk" };
    const payload = hold.kind === "file" ? { path: hold.path } : hold.kind === "web" ? { url: hold.url } : { text: hold.text };
    if (!runCommandImpl) return { ok: false, error: "the board command is not wired" };
    return runCommandImpl("board.new", JSON.stringify(payload));
  }
  return { ok: false, error: `unknown hold action ${what}` };
}

async function holdReadAction(what) {
  if (what === "read") {
    openBubble({ focus: false });
    if (hold.kind === "file") {
      const r = await ops.readFile(hold.path, null);
      if (!r.ok) {
        fail(r.line || r.reason || "the file could not be read", { code: r.refused ? "secret" : "file" });
        spiritCore.logTrip(tripLog, { label: r.refused ? "refused a credential" : "could not read it", ok: false });
        sendTrips();
        return r;
      }
      answer(r.answer, { via: "file", held: hold.path });
      speakAnswer(r.answer, null, { onlyIfAttached: true });
      return { ok: true, answer: r.answer };
    }
    if (hold.kind === "web") {
      const r = await ops.readWeb(hold.url, null);
      if (!r.ok) {
        fail(r.line || r.reason || "the page could not be read", { code: "web" });
        return r;
      }
      answer(r.answer, { via: "web", held: hold.url });
      speakAnswer(r.answer, null, { onlyIfAttached: true });
      return { ok: true, answer: r.answer };
    }
    // Text: the vision ladder reads it against the screen (there is no text
    // transport on the orb, and the prompt carries the text itself).
    if (!claimAsk()) return busyLine();
    try {
      const shot = await captureScreen();
      if (!shot) return { ok: false, error: "screen capture failed" };
      return await runAsk(shot, orbCore.buildPrompt("text", `Summarize this text the owner dropped on you:\n\n${hold.text}`), "Summarize this");
    } finally {
      releaseAsk();
    }
  }
  if (what === "what") {
    if (hold.kind !== "file") return { ok: false, error: "that is not an image on disk" };
    if (!claimAsk()) return busyLine();
    try {
      return await runAsk(hold.path, orbCore.buildPrompt("text", "What is this image? Say what it shows and anything notable in it."), "What is this?");
    } finally {
      releaseAsk();
    }
  }
  if (what === "summarize") {
    if (hold.kind === "file" || hold.kind === "web") return runHoldAction("read");
    return runHoldAction("read"); // text handled above
  }
  if (what === "board") {
    if (!commandRegistry().byId("board.new")) return { ok: false, error: "there is no whiteboard on this desk" };
    const payload = hold.kind === "file" ? { path: hold.path } : hold.kind === "web" ? { url: hold.url } : { text: hold.text };
    if (!runCommandImpl) return { ok: false, error: "the board command is not wired" };
    return runCommandImpl("board.new", JSON.stringify(payload));
  }
  return { ok: false, error: `unknown hold action ${what}` };
}

async function pickResult(index, action = "hold") {
  const row = results && results.rows ? results.rows[Number(index)] : null;
  if (!row) return { ok: false, error: "that result is no longer up" };
  if (row.kind === "web" || row.url) {
    if (action === "open") return openUrl(row.url || row.target);
    hold = spiritCore.holdFromWeb(row);
    if (!hold) return { ok: false, error: "that is not a link" };
    sendHold();
    openBubble({ focus: false });
    pushStatus(`Holding ${hold.label}`, 6000, 6000);
    return { ok: true, held: hold };
  }
  if (action === "open") {
    const { shell } = electron();
    void shell.openPath(row.target);
    return { ok: true, opened: row.target };
  }
  hold = spiritCore.holdFromFile(row.target);
  sendHold();
  // The visible trip: it goes back out to the lookout and returns holding it.
  const verdict = await go({ kind: "file", target: row.target });
  return { ok: verdict.ok !== false, held: hold, verdict };
}

function scheduleTempCleanup(file) {
  const timer = setTimeout(() => {
    try { fs.unlinkSync(file); } catch { /* the owner or the OS already took it */ }
  }, 120000);
  if (timer.unref) timer.unref();
}

function dragHoldOut(sender) {
  if (!hold) return { ok: false, error: "nothing is held" };
  const { nativeImage } = electron();
  let icon = nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png"));
  if (!icon.isEmpty()) icon = icon.resize({ width: 32, height: 32 });
  if (hold.kind === "file") {
    const files = Array.isArray(hold.files) && hold.files.length ? hold.files : [hold.path];
    sender.startDrag({ file: files[0], files, icon });
    return { ok: true, dragging: files.length, paths: files };
  }
  const stamp = `${process.pid}-${Date.now()}`;
  if (hold.kind === "web") {
    const file = path.join(os.tmpdir(), `aither-spirit-link-${stamp}.url`);
    fs.writeFileSync(file, `[InternetShortcut]\r\nURL=${hold.url}\r\n`);
    sender.startDrag({ file, icon });
    return { ok: true, dragging: 1, paths: [file], url: hold.url };
  }
  const file = path.join(os.tmpdir(), `aither-spirit-note-${stamp}.txt`);
  fs.writeFileSync(file, hold.text);
  scheduleTempCleanup(file);
  sender.startDrag({ file, icon });
  return { ok: true, dragging: 1, paths: [file] };
}

async function receiveDrop({ paths = [], text = "" } = {}) {
  openBubble({ focus: false });
  const list = (Array.isArray(paths) ? paths : []).filter(Boolean).map(String);
  if (list.length) {
    const secret = list.map((p) => spiritCore.secretPathReason(p)).find(Boolean);
    if (secret) {
      fail(secret.line, { code: "secret" });
      spiritCore.logTrip(tripLog, { label: "refused a credential", ok: false });
      sendTrips();
      return { ok: false, refused: true, line: secret.line };
    }
    hold = spiritCore.holdFromFiles(list);
  } else {
    hold = spiritCore.holdFromText(text);
  }
  if (!hold) return { ok: false, error: "nothing to hold" };
  sendHold();
  const line = `Holding ${spiritCore.holdLabel(hold)} — pick what to do with it.`;
  answer(line, { dropped: true });
  speakAnswer(line, null, { onlyIfAttached: true });
  spiritCore.logTrip(tripLog, { label: `holding ${spiritCore.holdLabel(hold)}`, ok: true });
  sendTrips();
  return { ok: true, hold };
}

/** The bead rail's doors as fairy menu rows; missing ids are skipped. */
const DESK_DOORS = Object.freeze([
  ["inbox.open", "Notifications"], ["console.open", "Apps"], ["browser.open", "Aither Browser"],
  ["chat.open", "Chat"], ["desktop.overlay.toggle", "AitherOS Online"], ["avatar.toggle", "Show avatar"],
]);
function deskDoors(reg) {
  return DESK_DOORS.filter(([id]) => reg && reg.byId && reg.byId(id)).map(([id, label]) => ({
    // The fairy's door names the actual ask, not a generic "Notifications":
    // "Needs you (3)" is the same group label the launcher and the deck use.
    label: id === "inbox.open" ? (attention.count ? `Needs you (${attention.count})` : "Inbox") : label,
    click: () => { void runCommandImpl?.(id); },
  }));
}

/** Needs-you, carried on the fairy instead of the red chip: main calls this. */
let attention = { count: 0, line: null };
function setAttention(count, line = null) {
  attention = { count: Math.max(0, Number(count) || 0), line: line ? String(line).slice(0, 160) : null };
  send("orb:badge", orbCore.unreadCount(queue) + attention.count);
  send("orb:attention", attention);
  return attention;
}

// ── attention: the fairy carries the cards (fairy-attention.cjs) ────────────
//
// Owner, 2026-11-08: the cards "need to live in the fairy ... it can come flutter
// in front of my eyes to get my attention without blocking anything". So a card is
// no longer a window: the fairy picks the ONE that matters now (fairy-attention
// plan), and either glows where it rests with a whisper beside it (L1) or flies to
// where the owner is looking -- the pointer, never ON it -- flutters there with the
// whisper (L2/L3), then goes home. The whisper never takes focus and is
// click-through except while the pointer is on it; an ignored nudge climbs the
// ladder, an answered/opened one starts it over. While this loop runs and the fairy
// is on screen, the desk's heartbeat tells awask so its Tk card window stays down.

let attentionCards = [];
let attentionMems = {};
let attentionTimer = null;
let attentionSoon = null;
let attentionTicking = false;
let attentionLastAt = 0;
let attentionVoiceAt = 0;
let attentionAway = false;
let attentionReturnUntil = 0;
/** {decision, view, startedAt, until, anchor, whisperAt, hovered, shown, timer, flutter} */
let nudging = null;
/** Injected by main: answer(id,key), open(id|null), quiet() -> "", idleMs(), speak(line,{force});
 *  tests also pass fullScreen() so no real window probe is spawned. */
let attentionHooks = {};

function attentionFile() {
  if (process.env.DESK_FAIRY_ATTENTION_FILE) return String(process.env.DESK_FAIRY_ATTENTION_FILE);
  const { app } = electron();
  return path.join(app.getPath("userData"), "fairy-attention.json");
}

function loadAttention() {
  try {
    const raw = JSON.parse(fs.readFileSync(attentionFile(), "utf8"));
    attentionMems = fairyAttention.sanitizeMems(raw && raw.cards);
    attentionLastAt = Number(raw && raw.lastNudgeAt) || 0;
    attentionVoiceAt = Number(raw && raw.lastVoiceAt) || 0;
  } catch {
    attentionMems = {}; // unreadable memory = every card starts at the bottom of the ladder
  }
}

function saveAttention() {
  try {
    const file = attentionFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cards: attentionMems, lastNudgeAt: attentionLastAt, lastVoiceAt: attentionVoiceAt }));
    fs.renameSync(tmp, file);
  } catch { /* per-viewer convenience: losing it restarts the ladder, nothing more */ }
}

/** main hands over the ranked decision queue (decisions only, no reports) on every change. */
function setAttentionCards(cards) {
  attentionCards = Array.isArray(cards) ? cards.filter((c) => c && typeof c.id === "string") : [];
  const ids = new Set(attentionCards.map((c) => c.id));
  const before = Object.keys(attentionMems).length;
  attentionMems = fairyAttention.pruneMems(attentionMems, ids);
  if (Object.keys(attentionMems).length !== before) saveAttention();
  // Answered somewhere else (the Inbox, Discord, the phone): the whisper goes.
  if (nudging && !ids.has(nudging.decision.card.id)) endNudge("answered");
  ensureAttention();
  scheduleAttentionTick(1500); // a NEW card is judged now, not on the next 15 s tick
  return { ok: true, count: attentionCards.length };
}

function ensureAttention() {
  if (attentionTimer || quitting) return;
  attentionTimer = setInterval(() => { void attentionTick(); }, ATTENTION_TICK_MS);
  if (attentionTimer.unref) attentionTimer.unref();
}

function scheduleAttentionTick(ms) {
  if (attentionSoon || quitting) return;
  attentionSoon = setTimeout(() => { attentionSoon = null; void attentionTick(); }, ms);
  if (attentionSoon.unref) attentionSoon.unref();
}

function stopAttention() {
  if (attentionTimer) { clearInterval(attentionTimer); attentionTimer = null; }
  if (attentionSoon) { clearTimeout(attentionSoon); attentionSoon = null; }
  if (nudging) {
    if (nudging.timer) clearInterval(nudging.timer);
    if (nudging.flutter) clearInterval(nudging.flutter);
    nudging = null;
  }
}

/** Does the fairy carry the cards right now? Only while it is meant to be on screen
 *  and its loop runs -- hidden, the awask window comes back (fail toward visible). */
function ownsAttention() {
  return Boolean(attentionTimer && !quitting && state.visible && alive(orbWindow));
}

function hookValue(name, ...args) {
  const fn = attentionHooks && attentionHooks[name];
  if (typeof fn !== "function") return undefined;
  try { return fn(...args); } catch { return undefined; }
}

/** A full-screen app or game in front (the probe's quiet op). "" = not quiet / unknown. */
async function fullScreenNow() {
  if (typeof (attentionHooks && attentionHooks.fullScreen) === "function") {
    try { return String((await attentionHooks.fullScreen()) || ""); } catch { return ""; }
  }
  if (process.platform !== "win32") return "";
  try {
    if (!probe) probe = spiritProbe.createWindowProbe();
    if (typeof probe.quietState !== "function") return "";
    const verdict = await probe.quietState({ excludePid: process.pid });
    return verdict && verdict.quiet ? String(verdict.reason || "a full-screen app") : "";
  } catch {
    return ""; // a probe that cannot answer must not silence the fairy forever
  }
}

/** One judgement: maybe start a nudge. Returns the plan (for tests and the bridge). */
async function attentionTick() {
  if (attentionTicking || quitting || !alive(orbWindow)) return { act: "none", reason: "not ready" };
  attentionTicking = true;
  try {
    const nowMs = Date.now();
    const idleMs = Math.max(0, Number(hookValue("idleMs")) || 0);
    if (idleMs >= fairyAttention.DEFAULTS.awayMs) {
      attentionAway = true;
    } else if (attentionAway && idleMs < 30_000) {
      attentionAway = false;
      attentionReturnUntil = nowMs + 5 * 60_000; // the next nudge is "while you were away"
    }
    const busy = Boolean(nudging || flight || tripBusy || dragging || inflight || drafting || regionWait
      || (alive(bubbleWindow) && bubbleWindow.isVisible()));
    const quiet = !state.visible ? "the fairy is hidden" : String(hookValue("quiet") || "");
    const ctx = {
      nowMs,
      lastNudgeAt: attentionLastAt,
      lastVoiceAt: attentionVoiceAt,
      quiet,
      idleMs,
      busy,
      returned: nowMs < attentionReturnUntil,
    };
    let decision = fairyAttention.plan(attentionCards, attentionMems, ctx);
    if (decision.act === "nudge") {
      const full = await fullScreenNow();
      if (full) decision = { act: "none", reason: `held while quiet: ${full}` };
    }
    if (decision.act === "nudge" && !nudging && !quitting) startNudge(decision);
    return decision;
  } finally {
    attentionTicking = false;
  }
}

function ensureNudge() {
  if (alive(nudgeWindow)) return nudgeWindow;
  const { BrowserWindow } = electron();
  nudgeWindow = new BrowserWindow({
    ...NUDGE_SIZE,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    // focusable:false -- the whisper NEVER takes the keyboard from what the owner is doing.
    alwaysOnTop: true, hasShadow: false, focusable: false, title: "Aither nudge",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "orb-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  nudgeWindow.setAlwaysOnTop(true, "screen-saver");
  try { nudgeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* no-op */ }
  nudgeWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  nudgeWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  // Click-through until the pointer is ON the card (the page reports it): the
  // transparent margin and a whisper you are not touching never block a click.
  nudgeWindow.setIgnoreMouseEvents(true, { forward: true });
  nudgeWindow.on("closed", () => { nudgeWindow = null; });
  void nudgeWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "nudge" } });
  return nudgeWindow;
}

function sendNudge(channel, payload) {
  try {
    if (alive(nudgeWindow)) nudgeWindow.webContents.send(channel, payload);
  } catch { /* page mid-load: init() carries the view */ }
}

function showWhisper() {
  if (!nudging) return;
  const win = ensureNudge();
  const at = nudging.whisperAt || { x: 0, y: 0 };
  win.setBounds({ x: Math.round(at.x), y: Math.round(at.y), ...NUDGE_SIZE });
  nudging.shown = true;
  sendNudge("orb:nudge-view", { ...nudging.view, side: nudging.side || "right" });
  if (!win.isVisible()) win.showInactive();
}

function startFlutter() {
  if (!nudging || !nudging.anchor) return;
  if (nudging.flutter) clearInterval(nudging.flutter);
  const level = nudging.decision.level;
  nudging.flutter = setInterval(() => {
    if (!nudging || !nudging.anchor || flight || dragging) return;
    const d = fairyAttention.flutterOffset(Date.now(), level);
    setOrbCenter({ x: nudging.anchor.x + d.x, y: nudging.anchor.y + d.y });
  }, ORBIT_MS);
  if (nudging.flutter.unref) nudging.flutter.unref();
}

function speakNudge(decision, { force = false } = {}) {
  const line = fairyAttention.voiceLine(decision.card, Date.now(), { more: decision.more });
  attentionVoiceAt = Date.now();
  return hookValue("speak", line, { force }) !== false;
}

function startNudge(decision) {
  if (!alive(orbWindow) || !decision || !decision.card) return { ok: false };
  const view = fairyAttention.whisperView(decision, Date.now());
  if (!view) return { ok: false };
  const nowMs = Date.now();
  const id = decision.card.id;
  attentionMems[id] = fairyAttention.recordShown(attentionMems[id] || {}, nowMs);
  attentionLastAt = nowMs;
  if (decision.returned) attentionReturnUntil = 0;
  nudging = {
    decision, view, startedAt: nowMs, until: nowMs + (decision.showMs || 9000),
    anchor: null, whisperAt: null, side: "right", hovered: false, shown: false, timer: null, flutter: null,
  };
  const n = nudging;
  ensureNudge();
  // The chime rides the level change (the orb page synthesizes it). The plan already
  // held this nudge while quiet; a muted desk or "Fairy sounds: off" is silent too.
  send("orb:nudge", { level: decision.level, chime: chimeFor(decision.level) });
  if (decision.level >= fairyAttention.LEVEL.FLUTTER) {
    const { screen } = electron();
    let cursor = null;
    let area;
    try {
      cursor = screen.getCursorScreenPoint();
      area = screen.getDisplayNearestPoint(cursor).workArea;
    } catch { area = displayForOrb().workArea; }
    const place = fairyAttention.nudgePlacement(cursor, area, ORB_SIZE, NUDGE_SIZE);
    n.anchor = place.orb;
    n.whisperAt = place.whisper;
    n.side = place.side;
    // The clock starts when it ARRIVES: the flight is not reading time.
    const durationMs = decision.level >= fairyAttention.LEVEL.INSIST ? 620 : 860;
    n.until += durationMs;
    void flyTo(place.orb, { durationMs }).then((r) => {
      if (nudging !== n) return;
      if (r && r.cancelled) return; // grabbed or re-routed mid-air: beginDrag ended it
      showWhisper();
      startFlutter();
    });
  } else {
    // A glow: the whisper beside the fairy where it rests.
    const [x, y] = orbWindow.getPosition();
    n.whisperAt = orbCore.bubblePosition(
      { x, y, width: ORB_SIZE.width, height: ORB_SIZE.height }, NUDGE_SIZE, displayForOrb().workArea, 6,
    );
    showWhisper();
  }
  saveAttention();
  if (decision.voice) speakNudge(decision);
  n.timer = setInterval(() => {
    if (nudging !== n) return;
    const now = Date.now();
    // A whisper the owner is reading (pointer on it) stays while they read.
    if (n.hovered) n.until = Math.max(n.until, now + 2500);
    if (now >= n.until) endNudge("timeout");
  }, NUDGE_STEP_MS);
  if (n.timer.unref) n.timer.unref();
  return { ok: true, id, level: decision.level };
}

async function returnFromNudge() {
  if (!alive(orbWindow) || dragging) return;
  if (attach && attach.kind === "avatar") {
    const p = spiritCore.orbitPoint(attach.bounds, Date.now() + 700);
    if (p) await flyTo(p, { durationMs: 700 });
  } else if (attach) {
    const dock = spiritCore.dockPosition(attach, ORB_SIZE);
    await flyTo({ x: dock.x + ORB_SIZE.width / 2, y: dock.y + ORB_SIZE.height / 2 }, { durationMs: 700 });
  } else {
    await flyHome(760);
  }
}

/** End the running nudge. `outcome` feeds the ladder: timeout = ignored. */
function endNudge(outcome = "timeout", { stay = false } = {}) {
  const n = nudging;
  if (!n) return { ok: true, ended: false };
  nudging = null;
  if (n.timer) clearInterval(n.timer);
  if (n.flutter) clearInterval(n.flutter);
  const id = n.decision.card.id;
  const nowMs = Date.now();
  const mem = attentionMems[id] || {};
  if (outcome === "timeout") {
    attentionMems[id] = fairyAttention.recordIgnored(mem, { importance: n.decision.importance, nowMs });
  } else if (outcome === "acted" || outcome === "seen") {
    attentionMems[id] = fairyAttention.recordActed(mem);
  } else if (outcome === "later") {
    attentionMems[id] = fairyAttention.recordLater(mem, nowMs);
  } else if (outcome === "mute") {
    attentionMems[id] = fairyAttention.recordMute(mem);
  } else if (outcome === "keep") {
    attentionMems[id] = fairyAttention.recordKeep(fairyAttention.recordActed(mem));
  }
  saveAttention();
  if (alive(nudgeWindow)) {
    try {
      nudgeWindow.setIgnoreMouseEvents(true, { forward: true });
      nudgeWindow.hide();
    } catch { /* gone */ }
  }
  sendNudge("orb:nudge-view", null);
  send("orb:nudge", { level: 0 });
  if (n.anchor && !stay && !quitting) void returnFromNudge();
  return { ok: true, ended: true, outcome };
}

/** Close the whisper after a short confirmation line the owner can read. */
function confirmThenEnd(n, line, outcome) {
  sendNudge("orb:nudge-flash", { text: line });
  n.until = Date.now() + 60_000; // the confirmation, not the timer, ends it
  const t = setTimeout(() => { if (nudging === n) endNudge(outcome); }, 1300);
  if (t.unref) t.unref();
}

/** The whisper's buttons (and a click on the fairy itself mid-nudge = open). */
async function nudgeAct(action, key) {
  const n = nudging;
  if (!n) return { ok: false, error: "nothing is up" };
  const card = n.decision.card;
  const what = String(action || "");
  if (what === "size") {
    // The page measured its card; fit the window to it and keep it on screen.
    const h = Math.max(NUDGE_MIN_H, Math.min(NUDGE_MAX_H, Math.round(Number(key) || 0)));
    if (!alive(nudgeWindow) || !h) return { ok: false };
    const b = nudgeWindow.getBounds();
    let y = b.y;
    try {
      const { screen } = electron();
      const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y }).workArea;
      if (y + h > area.y + area.height) y = Math.max(area.y, area.y + area.height - h);
    } catch { /* no screen module (tests) */ }
    nudgeWindow.setBounds({ x: b.x, y, width: NUDGE_SIZE.width, height: h });
    return { ok: true, height: h };
  }
  if (what === "hover") {
    n.hovered = key === true || key === "true";
    if (alive(nudgeWindow)) nudgeWindow.setIgnoreMouseEvents(!n.hovered, { forward: true });
    return { ok: true };
  }
  if (what === "answer") {
    const opt = (Array.isArray(card.options) ? card.options : []).find((o) => o && o.key === String(key));
    if (!opt || String(card.kind).toLowerCase() === "credential") {
      return { ok: false, error: "not one of this card's options" };
    }
    let verdict;
    try { verdict = await hookValue("answer", card.id, opt.key); } catch { verdict = false; }
    if (nudging !== n) return { ok: Boolean(verdict) };
    if (!verdict) {
      sendNudge("orb:nudge-flash", { text: "That did not go through. Open it?", error: true });
      return { ok: false, error: "the answer did not go through" };
    }
    const pending = Boolean(verdict && typeof verdict === "object" && verdict.pending);
    confirmThenEnd(n, pending ? "Finish it in the approval window" : `Done: ${opt.label || opt.key}`, "acted");
    return { ok: true, pending };
  }
  if (what === "open" || what === "more") {
    hookValue("open", what === "more" ? null : card.id);
    endNudge("acted");
    return { ok: true };
  }
  if (what === "later" || what === "dismiss") {
    endNudge("later");
    return { ok: true };
  }
  if (what === "mute") {
    confirmThenEnd(n, "Okay, it stays on the badge.", "mute");
    return { ok: true };
  }
  if (what === "keep") {
    confirmThenEnd(n, "I'll keep at you about this one.", "keep");
    return { ok: true };
  }
  if (what === "read") {
    n.until = Math.max(n.until, Date.now() + 9000);
    return { ok: speakNudge(n.decision, { force: true }) };
  }
  if (what === "talk") return talkNudge(n);
  if (what === "chat") {
    const r = chatAboutCard(card.id);
    if (r.ok && nudging === n) endNudge("seen", { stay: true });
    return r;
  }
  return { ok: false, error: `unknown nudge action ${what}` };
}

/** The chime for a nudge at `level`, or null when the fairy should stay silent. */
function chimeFor(level) {
  if (state.sounds === false) return null;
  if (hookValue("soundMuted")) return null;
  const pattern = fairyAttention.chimePattern(level);
  return pattern.length ? pattern : null;
}

/** "Fairy sounds: on/off" -- persisted in orb.json. */
function setSounds(on) {
  state.sounds = Boolean(on);
  saveState();
  return { ok: true, sounds: state.sounds };
}

/**
 * "Talk": a spoken back-and-forth about THIS card through the desk's own voice card
 * flow (main's `talk` hook = answerCardByVoice), which answers through the ONE desk
 * answer path. The whisper stays up while the owner talks and shows the outcome.
 */
async function talkNudge(n) {
  const card = n.decision.card;
  if (String(card.kind).toLowerCase() === "credential") {
    sendNudge("orb:nudge-flash", { text: "A secret is never said out loud. Open it to enter it.", error: true });
    return { ok: false, error: "a credential card is not answered by voice" };
  }
  if (typeof (attentionHooks && attentionHooks.talk) !== "function") {
    sendNudge("orb:nudge-flash", { text: "Talking is not wired in this build. Open it?", error: true });
    return { ok: false, error: "no talk hook" };
  }
  if (n.talking) return { ok: false, error: "already talking about it" };
  n.talking = true;
  n.until = Math.max(n.until, Date.now() + 100_000); // the question, then up to 90 s to answer
  sendNudge("orb:nudge-flash", { text: "Listening: say an option, or what to do instead", keep: true });
  let verdict;
  try { verdict = await attentionHooks.talk(card); } catch (error) { verdict = { ok: false, error: String((error && error.message) || error) }; }
  n.talking = false;
  if (nudging !== n) return verdict || { ok: false };
  const v = verdict && typeof verdict === "object" ? verdict : { ok: false };
  if (v.muted) {
    n.until = Date.now() + 9000;
    sendNudge("orb:nudge-flash", { text: "Your mic is muted. Unmute it from the tray, or pick an option here.", error: true });
    return { ok: false, muted: true, error: "microphone is muted" };
  }
  if (v.ok && v.kind === "answer") {
    confirmThenEnd(n, v.pending ? "Finish it in the approval window" : `Done: ${v.label || "answered"}`, "acted");
    return v;
  }
  if (v.ok && v.kind === "steer") {
    confirmThenEnd(n, "Sent what you said to the session", "acted");
    return v;
  }
  n.until = Date.now() + 9000;
  sendNudge("orb:nudge-flash", { text: v.error ? `I did not get that (${String(v.error).slice(0, 60)})` : "I did not get that. Try again, or pick one here.", error: true });
  return { ok: false, error: v.error || "no answer" };
}

/** The card the fairy is nudging about right now ({id, title}), or null. */
function nudgeCard() {
  if (!nudging) return null;
  const card = nudging.decision.card;
  return { id: card.id, title: String(card.title || "") };
}

/**
 * Open the fairy bubble focused with an open card loaded as context: whatever the
 * owner types next is answered about that card (askText, bubbleMode "card").
 * For a session's card, main's `session` hook adds what the session last said.
 */
function chatAboutCard(id) {
  const card = attentionCards.find((c) => c && c.id === String(id || ""));
  if (!card) return { ok: false, error: "that card is no longer open" };
  let session = null;
  if (card.sessionId) {
    const s = hookValue("session", card);
    if (s && typeof s === "object" && s.ok) session = s;
  }
  cardChat = {
    id: card.id,
    title: String(card.title || "this card").replace(/^Claude Code needs you:\s*/i, "").slice(0, 80),
    context: fairyAttention.chatContext(card, Date.now(), { session }),
  };
  suppressed = false;
  bubbleMode = "card";
  openBubble({ focus: true });
  send("orb:mode", { mode: "card", title: cardChat.title });
  return { ok: true, id: card.id, mode: "card" };
}

function spiritMenu() {
  const { Menu } = electron();
  const reg = commandRegistry();
  const anythingHeld = Boolean(hold);
  const template = [
    { label: "Search the web…", click: () => openMode("web") },
    { label: "Ask a question…", click: () => { openMode(null); try { bubbleWindow.focus(); } catch { /* gone */ } } },
    { label: "Find a file…", click: () => openMode("find") },
    ...(anythingHeld ? [{ label: `Read ${spiritCore.holdLabel(hold)}`, click: () => { void runHoldAction("read"); } }] : []),
    { type: "separator" },
    { label: attach ? "Detach the spirit" : "Attach the spirit", click: () => { void toggleAttach(); } },
    { label: "Send home", click: () => { void sendHome(); } },
    // The nudge chime (owner 2026-11-08): on by default, remembered in orb.json.
    { label: `Fairy sounds: ${state.sounds === false ? "off" : "on"}`, click: () => { setSounds(state.sounds === false); } },
    ...(reg.byId("quick.open") ? [{ label: "Quick menu", click: () => { void runCommandImpl?.("quick.open"); } }] : []),
    { type: "separator" },
    // The fairy IS the owner's sprite: its own rows sit on its own menu.
    { label: sprite ? `${sprite.name}: how are you?` : "How is my sprite?", click: () => { void spriteStatus(); } },
    { label: "Teach it the selection", click: () => { void spriteTeach(null); } },
    { label: "Open Sprite…", click: () => { openUrl(spriteCore.SPRITE_PAGE); } },
    { type: "separator" },
    // The desk's doors live on the fairy now (owner 2026-11-02: "consolidate the
    // awdesk icons around the fairy"): the bead rail's rows, plus Show avatar.
    ...deskDoors(reg),
    { type: "separator" },
    { label: "Hide the spirit", click: () => hideOrb() },
  ];
  try {
    Menu.buildFromTemplate(template).popup({ window: orbWindow });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

// ── drag and click ──────────────────────────────────────────────────────────

function beginDrag() {
  if (dragging || !alive(orbWindow)) return { ok: true };
  // Grabbing the fairy mid-nudge: the owner saw it. It stays where they put it.
  if (nudging) endNudge("seen", { stay: true });
  // Pulling the orb off a body/window detaches it; dropping it again re-attaches.
  if (attach) detach({ silent: true });
  if (flight) {
    flight.cancelled = true;
    finishFlight();
  }
  const { screen } = electron();
  let cursor = { x: 0, y: 0 };
  try { cursor = screen.getCursorScreenPoint(); } catch { /* keep zero */ }
  const [x, y] = orbWindow.getPosition();
  dragging = { cx: cursor.x, cy: cursor.y, x, y, moved: 0 };
  if (alive(bubbleWindow)) bubbleWindow.hide();
  dragTimer = setInterval(() => {
    if (!dragging || !alive(orbWindow)) return;
    let cur;
    try { cur = screen.getCursorScreenPoint(); } catch { return; }
    const dx = cur.x - dragging.cx;
    const dy = cur.y - dragging.cy;
    dragging.moved = Math.max(dragging.moved, Math.abs(dx) + Math.abs(dy));
    moveOrb(dragging.x + dx, dragging.y + dy);
  }, DRAG_STEP_MS);
  if (dragTimer.unref) dragTimer.unref();
  return { ok: true };
}

async function endDrag() {
  if (!dragging) return { ok: true, click: false };
  const moved = dragging.moved > CLICK_SLOP_PX;
  let dropPoint;
  try {
    const { screen } = electron();
    dropPoint = screen.getCursorScreenPoint();
  } catch { dropPoint = null; }
  dragging = null;
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (alive(orbWindow)) {
    const [x, y] = orbWindow.getPosition();
    const area = displayForOrb().workArea;
    const pos = orbCore.clampToWorkArea({ x, y }, ORB_SIZE, area);
    if (pos.x !== x || pos.y !== y) moveOrb(pos.x, pos.y);
    state.x = pos.x;
    state.y = pos.y;
    saveState();
  }
  let attached = null;
  if (moved && dropPoint) {
    const target = await resolveDropTarget(dropPoint);
    // Dropped on a body -> it orbits again; dropped anywhere else -> it stays free.
    state.freeRoam = !(target && target.kind === "avatar");
    saveState();
    if (target) {
      await attachTo(target);
      attached = publicAttach();
    } else {
      hideVeil();
    }
  }
  return { ok: true, click: !moved, moved, attached };
}

function toggleBubbleFromOrb() {
  // A click on the fairy while it carries a card opens THAT card.
  if (nudging) return nudgeAct("open");
  // A click mid-trip cancels the trip and brings the spirit home.
  if (tripBusy || flight) {
    const r = cancelTrip();
    return { ...r, visible: Boolean(alive(bubbleWindow) && bubbleWindow.isVisible()) };
  }
  if (alive(bubbleWindow) && bubbleWindow.isVisible()) {
    return closeBubble();
  }
  openBubble({ focus: true });
  return { ok: true, visible: true };
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function fromOrb(sender) {
  const ids = [orbWindow, bubbleWindow, nudgeWindow]
    .filter(alive)
    .map((w) => w.webContents);
  return ids.some((wc) => wc === sender);
}

function handlers() {
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !fromOrb(event.sender)) return { ok: false, error: "not the orb" };
    try {
      return await fn(event.sender, ...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  return {
    "desk:orb-init": guard((sender) => {
      let view = "orb";
      try { view = new URL(sender.getURL()).searchParams.get("view") || view; } catch { /* filename only */ }
      return {
        ok: true,
        view,
        line: queue.cur,
        badge: orbCore.unreadCount(queue),
        summary: orbCore.queueSummary(queue),
        visible: orbVisible(),
        hold,
        holdActions: spiritCore.holdActions(hold, { hasBoard: Boolean(commandRegistry().byId("board.new")) }),
        results,
        trips: { view: spiritCore.logView(tripLog), count: spiritCore.queueCount(tripQueue), line: spiritCore.queueLine(tripQueue) },
        tint: { name: tint.name, css: tint.css },
        attach: publicAttach(),
        mode: bubbleMode,
        modeTitle: bubbleMode === "card" && cardChat ? cardChat.title : null,
        sprite: publicSprite(),
        nudge: nudging && nudging.shown ? nudging.view : null,
        nudgeLevel: nudging ? nudging.decision.level : 0,
      };
    }),
    "desk:orb-hit": guard((_sender, inside) => {
      if (dragging) return { ok: true };
      if (alive(orbWindow)) orbWindow.setIgnoreMouseEvents(!inside, { forward: true });
      return { ok: true };
    }),
    "desk:orb-drag-start": guard(() => beginDrag()),
    "desk:orb-drag-end": guard(() => endDrag()),
    "desk:orb-click": guard(() => toggleBubbleFromOrb()),
    // The badge click (fairy, 2026-11-06) lands on the SAME Inbox list every
    // other entry point uses. It opens; it never answers.
    "desk:orb-needs-you": guard(() => {
      void runCommandImpl?.("inbox.open");
      return { ok: true };
    }),
    "desk:orb-ask": guard(async (_sender, verb, text, slotId) => {
      const what = String(verb || "");
      const asked = String(slotId || "") || null;
      const slot = asked || pendingSlot;
      if (asked || pendingSlot) pendingSlot = null;
      if (what === "screen") return askScreen({ slotId: slot });
      if (what === "region") return askRegion({ slotId: slot });
      if (what === "text") return askText(text, { slotId: slot });
      // Carry the body remembered when its menu row opened the field: the
      // delegation must not lose the slot between the handler and run().
      if (what === "find") return run("find", { surface: "bubble", arg: text, slotId: slot });
      if (what === "web") return run("web", { surface: "bubble", arg: text, slotId: slot });
      // The bubble field typed for a sprite teach or an aw* verb (openMode set it).
      if (what === "sprite-teach" || awCli.AW_VERBS[what]) return run(what, { surface: "bubble", arg: text });
      return { ok: false, error: `unknown orb ask ${what}` };
    }),
    "desk:orb-copy": guard((_sender, id) => {
      const line = queue.cur && (!id || queue.cur.id === id) ? queue.cur : null;
      if (!line) return { ok: false, error: "that answer is no longer up" };
      const { clipboard } = electron();
      clipboard.writeText(line.text);
      return { ok: true, chars: line.text.length };
    }),
    "desk:orb-pin": guard((_sender, id, pinned) => {
      const r = orbCore.setPinned(queue, String(id || ""), pinned !== false, Date.now());
      kick();
      return r;
    }),
    "desk:orb-close": guard(() => closeBubble()),
    "desk:orb-state": guard((_sender, next) => {
      drafting = Boolean(next && next.drafting);
      syncBubble();
      return { ok: true };
    }),
    "desk:orb-toggle": guard(() => toggleOrb()),
    // The whisper's buttons. The KEY is checked against the card's own options in
    // main; the page cannot answer with a choice the card does not have.
    "desk:nudge-act": guard((_sender, action, key) => nudgeAct(action, key)),
    "desk:spirit-menu": guard(() => spiritMenu()),
    "desk:spirit-pick": guard((_sender, index, action) => pickResult(index, action)),
    "desk:spirit-hold": guard((_sender, action) => runHoldAction(action)),
    "desk:spirit-drag-hold": guard((sender) => dragHoldOut(sender)),
    "desk:spirit-drop": guard((_sender, payload) => receiveDrop(payload || {})),
    "desk:spirit-cancel": guard(() => cancelTrip()),
    "desk:spirit-home": guard(() => sendHome()),
    "desk:spirit-attach": guard(() => toggleAttach()),
    "desk:spirit-mode": guard((_sender, mode) => openMode(mode ? String(mode) : null)),
  };
}

function ensureIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(handlers())) ipcMain.handle(channel, handler);
}

// ── what main.cjs calls ─────────────────────────────────────────────────────

function ensureOps() {
  if (ops) return ops;
  ops = spiritOps.createSpiritOps({
    universal: universalImpl || (() => require("./search-window.cjs").universal()),
    searchClient: searchClientImpl || (() => require("./search-client.cjs").createSearchClient()),
  });
  return ops;
}

/** Start the orb once: load its spot, build the window, wire the channels. */
function startOrb(opts = {}) {
  if (opts.capture) captureImpl = opts.capture;
  if (opts.askVision) askVisionImpl = opts.askVision;
  if (opts.speak) speakImpl = opts.speak;
  if (opts.avatarTargets) avatarTargetsImpl = opts.avatarTargets;
  if (opts.runCommand) runCommandImpl = opts.runCommand;
  if (opts.openUrl) openUrlImpl = opts.openUrl;
  if (opts.universal) universalImpl = opts.universal;
  if (opts.searchClient) searchClientImpl = opts.searchClient;
  if (opts.spriteToken) spriteTokenImpl = opts.spriteToken;
  if (opts.spriteClient) spriteClientImpl = opts.spriteClient;
  if (opts.attention && typeof opts.attention === "object") attentionHooks = { ...opts.attention };
  ensureIpc();
  loadState();
  loadAttention();
  ensureOrb();
  placeOrb();
  ensureOps();
  if (state.visible) showOrb();
  pruneCaptures(null); // a previous session's full-display PNG does not wait for another ask
  kick();
  startSeek();
  startHover();
  setTimeout(() => { void seekAvatar(); }, 3000).unref?.();
  // The fairy dresses as the sprite once the desk's sign-in has had a moment.
  if (spriteKick) clearTimeout(spriteKick);
  spriteKick = setTimeout(() => { spriteKick = null; void refreshSprite(); }, 4000);
  spriteKick.unref?.();
  startSpritePoll();
  ensureAttention();
  return { ok: true, visible: state.visible };
}

function stopOrb() {
  quitting = true;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  if (flightTimer) { clearInterval(flightTimer); flightTimer = null; }
  stopFollow();
  stopOrbit();
  if (seekTimer) { clearInterval(seekTimer); seekTimer = null; }
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
  if (spriteTimer) { clearInterval(spriteTimer); spriteTimer = null; }
  if (spriteKick) { clearTimeout(spriteKick); spriteKick = null; }
  stopAttention();
  for (const pending of pendingRuns.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: "the desk is quitting" });
  }
  pendingRuns = new Map();
  if (probe) {
    try { probe.stop(); } catch { /* already gone */ }
    probe = null;
  }
  for (const win of [nudgeWindow, veilWindow, bubbleWindow, orbWindow]) {
    try { if (alive(win)) win.destroy(); } catch { /* already gone */ }
  }
  nudgeWindow = null;
  veilWindow = null;
  bubbleWindow = null;
  orbWindow = null;
  flight = null;
}

/** Registry verbs (command-registry rows carry `orb: "toggle" | "ask-screen" |
 *  "find" | "web" | "attach" | "go"`). The verdict is RETURNED so the bridge's
 *  POST /commands/run can report what happened. */
function run(verb, { arg = null, slotId = null } = {}) {
  const what = String(verb || "");
  if (quitting) return { ok: false, error: "the desk is quitting" };
  // A row on a body's menu: that body speaks what happens next, even when the
  // sentence is typed into the bubble a moment later.
  const body = String(slotId || "") || null;
  if (body) pendingSlot = body;
  if (what === "toggle") return toggleOrb();
  if (what === "ask-screen") {
    const use = body || pendingSlot;
    pendingSlot = null;
    showOrb();
    return askScreen({ slotId: use });
  }
  if (what === "find") {
    showOrb();
    const said = String(arg == null ? "" : arg).trim();
    if (!said) return openMode("find");
    const use = body || pendingSlot;
    pendingSlot = null;
    return go({ kind: "search", target: said, slotId: use });
  }
  if (what === "web") {
    showOrb();
    const said = String(arg == null ? "" : arg).trim();
    if (!said) return openMode("web");
    const use = body || pendingSlot;
    pendingSlot = null;
    return go({ kind: "web", target: said, slotId: use });
  }
  if (what === "attach") {
    showOrb();
    return toggleAttach();
  }
  if (what === "cancel") return cancelTrip();
  // The sprite (command-registry sprite.*) and the aw* CLIs (aw.*).
  if (what === "sprite-status") return spriteStatus();
  if (what === "sprite-teach") return spriteTeach(arg);
  if (what === "sprite-open") return openUrl(spriteCore.SPRITE_PAGE);
  if (awCli.AW_VERBS[what]) return runAwVerb(what, arg);
  if (what === "go") {
    const parsed = spiritCore.parseArg(arg);
    if (!parsed.ok) {
      fail(parsed.error);
      return { ok: false, error: parsed.error };
    }
    showOrb();
    const use = parsed.request.slotId || body || pendingSlot;
    pendingSlot = null;
    return go({ ...parsed.request, slotId: use });
  }
  return { ok: false, error: `unknown orb verb ${what}` };
}

/** For tests and callers that already have an image. */
async function askImage(imagePath, prompt, question) {
  if (!claimAsk()) return busyLine();
  try {
    return await runAsk(imagePath, prompt, question);
  } finally {
    releaseAsk();
  }
}

module.exports = {
  ORB_SIZE, BUBBLE_SIZE, TICK_MS, REGION_WAIT_MS,
  startOrb, stopOrb, run, ensureIpc, showOrb, hideOrb, toggleOrb, openBubble, setAttention,
  // attention: the fairy carries the cards (fairy-attention.cjs)
  NUDGE_SIZE, setAttentionCards, attentionTick, ownsAttention, nudgeAct, endNudge,
  nudgeCard, chatAboutCard, setSounds, soundsOn: () => state.sounds !== false,
  nudging: () => (nudging ? { id: nudging.decision.card.id, level: nudging.decision.level, shown: nudging.shown } : null),
  attentionMems: () => attentionMems,
  askScreen, askRegion, askText, askImage, toggleBubbleFromOrb, beginDrag, endDrag,
  stateFile, loadState, saveState, pump, queue: () => queue, state: () => state,
  // spirit
  go, sendHome, attachTo, detach, toggleAttach, cancelTrip, receiveDrop, pickResult, runHoldAction,
  hold: () => hold, results: () => results, attach: () => attach, tripLog: () => tripLog,
  __reset: () => {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    if (flightTimer) { clearInterval(flightTimer); flightTimer = null; }
    lastVeilKey = "";
    stopFollow();
    for (const pending of pendingRuns.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "reset" });
    }
    pendingRuns = new Map();
    stopAttention();
    attentionCards = [];
    attentionMems = {};
    attentionLastAt = 0;
    attentionVoiceAt = 0;
    attentionReturnUntil = 0;
    attentionAway = false;
    attentionHooks = {};
    cardChat = null;
    for (const win of [nudgeWindow, veilWindow, bubbleWindow, orbWindow]) {
      try { if (alive(win)) win.destroy(); } catch { /* gone */ }
    }
    nudgeWindow = null;
    veilWindow = null;
    bubbleWindow = null;
    orbWindow = null;
    quitting = false;
    queue = orbCore.createQueue();
    state = orbCore.sanitizeState(null);
    lastImage = null;
    inflight = false;
    drafting = false;
    suppressed = false;
    regionWait = false;
    attach = null;
    flight = null;
    trail = [];
    home = null;
    tint = spiritCore.tintFor("slot0");
    hold = null;
    results = null;
    tripQueue = spiritCore.createTripQueue();
    tripLog = spiritCore.createTripLog();
    tripBusy = false;
    bubbleMode = null;
    pendingSlot = null;
    sprite = null;
    lastCaption = "";
    if (spriteTimer) { clearInterval(spriteTimer); spriteTimer = null; }
    if (spriteKick) { clearTimeout(spriteKick); spriteKick = null; }
    spriteClientImpl = null;
    spriteTokenImpl = null;
    awRunImpl = null;
    clipboardImpl = null;
    selectionImpl = null;
  },
  __setSpriteClient: (c) => { spriteClientImpl = c; },
  __setAwRun: (f) => { awRunImpl = f; },
  __setClipboard: (f) => { clipboardImpl = f; },
  __setSelection: (f) => { selectionImpl = f; },
  __setTeachRetryDelay: (ms) => { teachRetryDelayMs = Number(ms) || 0; },
  __setLastCaption: (t) => { lastCaption = String(t || ""); },
  sprite: () => publicSprite(),
  refreshSprite, restTint,
  __setCapture: (c) => { captureImpl = c; },
  __setAskVision: (f) => { askVisionImpl = f; },
  __setSpeak: (f) => { speakImpl = f; },
  __setAvatarTargets: (f) => { avatarTargetsImpl = f; },
  __setOps: (o) => { ops = o; },
  __setWired: () => { wired = true; },
  // The veil's layout AND the orb's move both leaked (2026-11-07); assert them directly.
  __test: { clampRect, coverVeil, drawVeil, moveOrb, veilPlacement, veilRect },
  __setAttentionHooks: (h) => { attentionHooks = { ...(h || {}) }; },
};
