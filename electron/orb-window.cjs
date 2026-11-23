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
const neuronsModel = require("./neurons-model.cjs");
const orbVision = require("./orb-vision.cjs");
const spiritCore = require("./spirit-core.cjs");
const spiritOps = require("./spirit-ops.cjs");
const spiritProbe = require("./spirit-probe.cjs");
const spriteCore = require("./sprite-core.cjs");
const awCli = require("./aw-cli.cjs");
const selectionReader = require("./selection-reader.cjs");
const fairyAttention = require("./fairy-attention.cjs");
const agentFairy = require("./agent-fairy.cjs");
const fairyMenu = require("./fairy-menu.cjs");
const freeSpace = require("./free-space.cjs");
const companionMenu = require("./companion-menu.cjs");
const fairyOwner = require("./fairy-owner.cjs");
const fairyCounts = require("./fairy-counts.cjs");
const fairyCluster = require("./fairy-cluster.cjs");
const displayMode = require("./display-mode.cjs");
const orbRadial = require("./orb-radial-menu.cjs");
const linkOpener = require("./link-opener.cjs");
const fairyHoverGuard = require("./fairy-hover-guard.cjs");
const fairyPanel = require("./fairy-panel.cjs");
const agentsPanel = require("./agents-panel.cjs");
const fairyControl = require("./fairy-control.cjs");
const foregroundProbe = require("./foreground-probe.cjs");
const fairyFlight = require("./fairy-flight.cjs");
const followFocus = require("./follow-focus.cjs");
const fairyDrop = require("./fairy-drop.cjs");
const cardStay = require("./card-stay.cjs");

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
/** A tether is a SHORT link to the dock beside the fairy. Beyond this many px (a
 *  stale attach, a window on the far side of the desk) it is not drawn at all: the
 *  dashed line across unrelated windows the owner saw was exactly that. */
const TETHER_MAX_PX = 280;
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
/** The fairy cluster (fairy-cluster.cjs): one per decision and live session, capped
 *  into a counted bead. swarmCompanions is what it draws right now. */
let swarmWindow = null;
let swarmCompanions = [];
/** Live session rows (Claude Code tabs Map + awsh daemon rows) and which sources read. */
let clusterSessions = [];
let clusterOk = { cards: true, sessions: true, presence: true };
const clusterReaper = fairyCluster.createReaper();
let clusterTotal = 0;
let clusterLabel = "";
/** The orb was shown BY the cluster (decisions waiting while hidden), not by the owner. */
let autoSurfaced = false;
/** Card ids waiting when the owner hid the fairy himself (null = he has not). */
let ownerHidIds = null;
let clusterTimer = null;
/** Tool flights (fairy-flight.cjs): the last plan the renderer was given, the live
 *  planner (it remembers a finished call long enough to fly home), and one timer that
 *  re-plans when the last leg is over. No per-frame IPC: the veil page animates. */
let toolFlightPlan = { flights: [], returning: [], hover: [], throttled: [], reducedMotion: false };
let toolFlightTimer = null;
const toolFlightPlanner = fairyFlight.createFlightPlanner();
/** Where the ONE cluster is centred while the fairy itself is down (a full avatar stands
 *  where it was): the agent swarm sets it so the light fairies keep orbiting the avatar
 *  instead of vanishing with the orb. null = follow the orb, as always. */
let swarmAnchor = null;
/** Fine control (fairy-control.cjs): the click-selected fairy, every live companion before the
 *  view filters it, the pinned fairies' own windows, the drag in flight, the focused window. */
let selectedAgent = "";
let allCompanions = [];
let pinWindows = new Map();
let pinDrag = null;
/** The orbs swarm mode owns (display-mode.cjs, owner 2026-11-20): each is a pin
 *  window we placed; being here, and not in swarmView.pins, keeps a mode switch from
 *  persisting them as the owner's pins. */
let swarmPinAgents = new Set();
/** Drop behaviour (fairy-drop.cjs, owner 2026-11-23): a "timed" drop's return timer, a
 *  hand placement that follow must not steal, the drop resolution in flight, and the
 *  pinned fairies that ride a window (agent -> {hwnd, corner}). */
let dropReturnTimer = null;
let manualPlacement = false;
let resolvingDrop = false;
let pinDocks = new Map();
let pinDockTimer = null;
/** The ONE ring (owner 2026-11-23): the fairy flies to the centre, the ring opens
 *  around it, and it flies back on release/cancel. The desktop right-click arrives
 *  from the native hook (desktop-right-hook.cjs); `ringOpen` freezes follow/orbit/
 *  hover meanwhile. */
let ringOpen = false;
let ringReturn = null;
let ringOpener = null;
let extraRunner = null;
let fgContent = null;
let fgProbeImpl = null;
/** Follow-the-focused-window (plan A4): the descriptor the probe last reported, when it
 *  changed, and the settle timer that waits for the focus to hold before it moves. */
let followSeen = null;
let followChangedAt = 0;
let followDebounce = null;
let followBusy = false;
/** Bounded retries while the fairy is mid-flight/card; a new focus resets the count. */
let followRetries = 0;
/** The taskbar rect on the cluster's OWN display (DIPs) dock mode sits on, every bar
 *  the probe published (so the right monitor's is chosen), and the refresh timer. */
let taskbarRect = null;
let taskbarBars = [];
let taskbarTimer = null;
let lastSwarmViewKey = "";
let lastCompanionsWho = "";
let lastBounds = null;
/** Visual neurons (neurons-model.cjs): the agent step graph, off unless switched on.
 *  Steps are batched at NEURONS_FLUSH_MS (<= 10 Hz) -- never one IPC per step. */
const NEURONS_FLUSH_MS = 100;
const neurons = neuronsModel.createNeurons();
let neuronTimer = null;
let lastNeuronPayload = "";
/** agent -> its last drawn state, so only a TRANSITION opens a "thinking" node. */
let lastNeuronStates = new Map();
let state = orbCore.sanitizeState(null);
/** How the companion is drawn (display-mode.cjs, owner 2026-11-20): avatar, fairy,
 *  both or swarm. Persisted by main in avatar-dock.json; applied here by
 *  setDisplayModeState from the menu, the palette, the key or the boot restore. */
let display = displayMode.normalize(null);
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
/** New results APPEND here while the card is open (owner 2026-11-22: "new results
 *  stream into the open card instead of replacing or closing it"). Reset on dismiss. */
let resultStream = [];
let tripQueue = spiritCore.createTripQueue();
let tripLog = spiritCore.createTripLog();
let tripBusy = false;
/** The longest one spirit trip may run before it is called failed (a vision read is ~30 s). */
let TRIP_LIMIT_MS = 120_000;
let bubbleMode = null; // "find" | "web" | "card" | null
/** The card the bubble is chatting about (bubbleMode "card"): {id, title, context}. */
let cardChat = null;
/** The body whose avatar-menu row opened the bubble: it speaks the answer the
 *  owner types there (an avatar-menu row cannot carry a text prompt). */
let pendingSlot = null;
let regionWait = false;
/** A bubble the owner closed stays closed until something NEW arrives. */
let suppressed = false;
/** The asking card is OPEN: the owner has not dismissed it (owner 2026-11-22). This,
 *  not a live line, is what keeps `bubbleWanted()` true after focus moves away. */
let cardOpen = false;
/** Card idle timeout (card-stay.cjs): OFF by default; armed only when the owner sets one. */
let cardIdleTimer = null;
/** A pinned card's move settled: dock it after this debounce (ensures one snap per drag). */
let cardMoveTimer = null;
/** The fairy has grown into Aither's full avatar (expandToAvatar); transient, never saved. */
let expanded = false;
/** Aither's body is up as its OWN surface (main's avatar window, not a grow): the
 *  fairy stands down while it is, without forgetting that the owner wants her
 *  (state.visible stays true). Owner 2026-11-20: "WHY DOES CLICKING DESKTOP TRAY
 *  OPEN A SEPARATE AVATAR WHEN THE FAIRY IS SUPPOSED TO TURN INTO THAT AVATAR" --
 *  the tray's Show avatar raised the body and left the fairy floating beside it.
 *  One companion surface, always; docking in the browser is the declared exception. */
let stoodDownForAvatar = false;
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
    // the owner's hide survives a crash: the cards waiting when they hid it stay quiet
    ownerHidIds = state.ownerHid ? new Set(state.ownerHidIds) : null;
  } catch {
    state = orbCore.sanitizeState(null); // unreadable state -> defaults, never a crash
  }
  return state;
}

function saveState() {
  try {
    const file = stateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    // A cluster-surfaced orb (decisions waiting) is not the owner's choice to show it.
    fs.writeFileSync(tmp, JSON.stringify(autoSurfaced ? { ...state, visible: false } : state));
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
      if (display && display.workArea) return fairyArea(display.workArea);
    } catch { /* fall through to the primary */ }
  }
  try { return fairyArea(screen.getPrimaryDisplay().workArea); } catch { return { x: 0, y: 0, width: 1920, height: 1080 }; }
}

// ── A box the fairy never rests in (the tenant site's own companion) ────────
// living-desktop-window.cjs reports where the overlay page draws `[data-companion]`
// (GARG's goblin). The fairy's resting spot, its whisper, its answer bubble and its
// menu are placed in the work area MINUS that box (orb-core areaAvoiding). The saved
// spot in orb.json is not rewritten: back in a workspace with no companion the fairy
// returns to it. RESERVE_PAD keeps the swarm that circles the fairy off the box too.
const RESERVE_PAD = 124;
let reservedBox = null;
function fairyArea(area) {
  return area ? orbCore.areaAvoiding(area, reservedBox, RESERVE_PAD) : area;
}
function setReservedBox(box) {
  const next = box && Number(box.width) > 0 && Number(box.height) > 0
    ? { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) } : null;
  if (JSON.stringify(next) === JSON.stringify(reservedBox)) return false;
  reservedBox = next;
  // At rest only: a flight, a drag, an attachment or a nudge finishes on its own terms.
  if (alive(orbWindow) && !dragging && !attach && !tripBusy && !nudging) {
    placeOrb();
    try { placeSwarm(); } catch { /* no swarm yet */ }
  }
  return true;
}

/** Where the fairy rests (window top-left): the saved spot, or the first-run corner,
 *  inside the area it may use right now (fairyArea). Every resting path asks this. */
function restSpot() {
  const area = restoreWorkArea();
  return state.x != null && state.y != null
    ? orbCore.clampToWorkArea({ x: state.x, y: state.y }, ORB_SIZE, area)
    : orbCore.defaultOrbPosition(area, ORB_SIZE);
}

// ── One cluster: the fairy docks on the AitherOS window (owner, 2026-11-12) ─────
// "I have two clusters of fairies. When the AitherOS desktop/app/workspace is open, the
// fairy cluster from awdesk should become this one: attach to the AitherOS desktop and
// not be stuck behind the goblin, and automatically detach."
// The second cluster is the served page's own fairy (Veil os-fairy.tsx); the desk hides
// it in its own windows (living-desktop-window HIDE_PAGE_FAIRY_CSS), so the one cluster
// is this one, with the counts of fairy-counts.cjs. While the AitherOS window is open
// and not minimised the fairy is attached to it with the EXISTING attach/follow (kind
// "desk"), marked `auto`; it rides the window's bottom-right, left of the tenant's
// companion. Closed, hidden or minimised: it lets go and flies back to its resting
// spot. An attachment the owner made by hand is never replaced or dropped by this.
let dockWindowId = 0;
function dockSpot(target) {
  const base = target && target.auto
    ? orbCore.windowDockSpot(target.bounds, ORB_SIZE, reservedBox, RESERVE_PAD)
    // A hand drop remembers its corner (`attach.corner`), so following a window that
    // moves or resizes keeps the fairy where the owner put it instead of flipping to
    // whichever corner is nearest now. Without a corner this is the old top-right.
    : spiritCore.dockPosition(target, ORB_SIZE, { corner: target && target.corner, dropPoint: target && target.dropPoint });
  // A body has no buttons under it; a WINDOW does. Owner 2026-11-16: the fairy sat on
  // CertTrack's "Review" tab. Stand on the first spot of the window that covers nothing.
  if (!target || target.kind === "avatar") return base;
  const b = spiritCore.normBounds(target.bounds);
  if (!b) return base;
  const pick = freeSpace.pickFree(
    freeSpace.dockCandidates(b, ORB_SIZE, { first: base }), ORB_SIZE, obstaclesFor(target), { pad: 10, area: b },
  );
  return pick ? { x: pick.x, y: pick.y } : base;
}

// -- what is clickable under the fairy (free-space.cjs) -------------------------------
// The desk's own windows are asked, from inside the page, where their buttons, tabs and
// fields are; a window owned by another program gets its title bar as one obstacle. The
// answers are cached for a second and a half: the dock follows a window at 4 Hz and must
// never wait on a page.
const OBSTACLE_TTL_MS = 1500;
const obstacleCache = new Map(); // windowId -> { at, rects }
const obstacleBusy = new Set();

function ownWindowIds() {
  return new Set([orbWindow, bubbleWindow, veilWindow, nudgeWindow, swarmWindow, menuWindow, tipWindow]
    .filter((w) => alive(w)).map((w) => w.id));
}

async function refreshObstacles(win) {
  if (!alive(win) || obstacleBusy.has(win.id)) return;
  const cached = obstacleCache.get(win.id);
  if (cached && Date.now() - cached.at < OBSTACLE_TTL_MS) return;
  obstacleBusy.add(win.id);
  try {
    const wc = win.webContents;
    const rows = await Promise.race([
      wc.executeJavaScript(freeSpace.probeSource(), true),
      new Promise((resolve) => { const t = setTimeout(() => resolve(null), 800); if (t.unref) t.unref(); }),
    ]);
    if (!Array.isArray(rows)) return; // a page that would not answer is "unknown", not "empty"
    let zoom = 1;
    try { zoom = wc.getZoomFactor ? wc.getZoomFactor() : 1; } catch { /* default 1 */ }
    obstacleCache.set(win.id, { at: Date.now(), rects: freeSpace.toScreenRects(rows, win.getContentBounds(), zoom) });
  } catch { /* a page mid-navigation: try again next tick */ } finally {
    obstacleBusy.delete(win.id);
  }
}

/** Ask every visible desk window (the fairy's own excluded) what is clickable in it. */
async function refreshAllObstacles() {
  const { BrowserWindow } = electron();
  const own = ownWindowIds();
  let wins;
  try { wins = BrowserWindow.getAllWindows(); } catch { wins = []; }
  const live = wins.filter((w) => alive(w) && !own.has(w.id) && w.isVisible() && !w.isMinimized());
  for (const id of [...obstacleCache.keys()]) if (!live.some((w) => w.id === id)) obstacleCache.delete(id);
  await Promise.all(live.map((w) => refreshObstacles(w)));
}

/** The clickable rects for one dock target (screen coordinates). */
function obstaclesFor(target) {
  if (!target) return [];
  if (target.kind === "desk" && target.windowId) {
    const cached = obstacleCache.get(target.windowId);
    return cached ? cached.rects : [];
  }
  // Another program's window: no page to ask, so its title bar and tab strip stand in.
  const chrome = freeSpace.chromeObstacle(target.bounds);
  return chrome ? [chrome] : [];
}

/** Every clickable rect we know of across the desk's windows, for the flutter. */
function allObstacles() {
  const out = [];
  for (const entry of obstacleCache.values()) if (Date.now() - entry.at < 60_000) out.push(...entry.rects);
  return out;
}
/** `win` = the AitherOS window to ride, or null when there is none to ride. */
async function setDockWindow(win) {
  const ride = alive(win) && win.isVisible() && !win.isMinimized() ? win : null;
  dockWindowId = ride ? ride.id : 0;
  if (!alive(orbWindow) || dragging || ringOpen) return { ok: false };
  // Hidden fairies stay hidden (owner 2026-11-13): docking never shows them.
  if (ride && !state.visible) return { ok: true, docked: false, why: "the fairies are hidden" };
  if (ride) {
    // Where the OWNER put the fairy wins over both the AitherOS dock and follow: a
    // drop is not something the desk may undo a second later (owner 2026-11-23).
    if (manualPlacement) return { ok: true, docked: false, why: "placed by hand" };
    // A FOLLOW attach is not a hand attach: the AitherOS window outranks "follow my
    // window" (one cluster), so it takes the cluster from whatever follow was riding.
    if (attach && !attach.auto && !attach.follow) return { ok: true, docked: false, why: "attached by hand" };
    if (attach && attach.auto && attach.windowId === ride.id) return { ok: true, docked: true };
    const r = await attachTo({ kind: "desk", windowId: ride.id, title: ride.getTitle() || "AitherOS", bounds: ride.getBounds(), auto: true },
      { quiet: true });
    return { ok: Boolean(r && r.ok), docked: Boolean(r && r.ok) };
  }
  if (attach && attach.auto) {
    home = null; // back to the RESTING spot, not to wherever it was when it docked
    detach({ silent: true });
    await flyHome(480);
    return { ok: true, docked: false };
  }
  return { ok: true, docked: false };
}

function placeOrb() {
  if (!alive(orbWindow)) return;
  const pos = restSpot();
  orbWindow.setBounds({ ...pos, ...ORB_SIZE });
}

function placeBubble() {
  if (!alive(bubbleWindow) || !alive(orbWindow)) return;
  const size = { width: BUBBLE_SIZE.width, height: bubbleHeight };
  // A pinned card stands where the owner put it (card-stay.cjs), clamped onto the
  // display that spot belongs to. Everything else still opens beside the fairy.
  const card = cardStay.normalizeCard(state.card);
  if (card.pin && card.x != null && card.y != null) {
    const at = { x: card.x + size.width / 2, y: card.y + size.height / 2 };
    const area = workAreaAt(at) || fairyArea(displayForOrb().workArea);
    const pos = orbCore.clampToWorkArea({ x: card.x, y: card.y }, size, area);
    bubbleWindow.setBounds({ ...pos, ...size });
    return;
  }
  const [x, y] = orbWindow.getPosition();
  const area = fairyArea(displayForOrb().workArea);
  const pos = orbCore.bubblePosition(
    { x, y, width: ORB_SIZE.width, height: ORB_SIZE.height },
    size,
    area,
    10,
  );
  bubbleWindow.setBounds({ ...pos, ...size });
}

// ── the panel: one box, one button (fairy-panel.cjs, owner 2026-11-14) ──────
/** The bubble's height, set by the page from its content (no dead space). */
let bubbleHeight = 180;
/** The session the owner switched the panel to (null = follow the attach). */
let panelSessionId = null;
/** session id ("free" = none) -> the last few exchanges, newest last. */
let panelHistory = new Map();
let panelSessions = { rows: null, note: "" };
let panelTimer = null;
let panelSessionsInflight = false;
const PANEL_POLL_MS = 5000;

function currentPanelView() {
  return fairyPanel.panelView({
    sessions: panelSessions.rows,
    sessionsNote: panelSessions.note,
    cards: attentionCards,
    history: panelHistory,
    chosenId: panelSessionId,
    attach: publicAttach(),
    current: queue.cur,
  });
}

function sendPanelView() {
  if (!alive(bubbleWindow)) return null;
  const view = currentPanelView();
  try { bubbleWindow.webContents.send("orb:panel-view", view); } catch { /* page mid-load: init carries it */ }
  return view;
}

/** Re-read the live sessions (the harness daemon, via main's hook). Never throws. */
async function refreshPanelSessions() {
  if (panelSessionsInflight) return panelSessions;
  const fn = attentionHooks && attentionHooks.sessions;
  if (typeof fn !== "function") return panelSessions;
  panelSessionsInflight = true;
  try {
    const shaped = agentsPanel.shapeSessions(await fn());
    panelSessions = { rows: shaped.ok ? shaped.rows : [], note: shaped.note };
  } catch (e) {
    panelSessions = { rows: [], note: String((e && e.message) || "sessions unavailable") };
  } finally {
    panelSessionsInflight = false;
  }
  sendPanelView();
  return panelSessions;
}

/** Poll the sessions only while the panel is on screen (perf first). */
function syncPanelPoll() {
  const up = alive(bubbleWindow) && bubbleWindow.isVisible();
  if (up && !panelTimer) {
    void refreshPanelSessions();
    panelTimer = setInterval(() => { void refreshPanelSessions(); }, PANEL_POLL_MS);
    if (panelTimer.unref) panelTimer.unref();
  } else if (!up && panelTimer) {
    clearInterval(panelTimer);
    panelTimer = null;
  }
}

function panelKey() {
  const v = currentPanelView();
  return v.line.kind === "session" ? v.line.id : "free";
}

/** What one action returned, as one line of history. */
function exchangeText(r) {
  if (!r || typeof r !== "object") return "";
  if (r.ok === false) return String(r.error || r.reason || r.line || "it did not work");
  if (r.text || r.answer) return String(r.text || r.answer);
  if (results && Array.isArray(results.rows)) {
    const top = results.rows[0];
    return `${results.rows.length} result${results.rows.length === 1 ? "" : "s"}${top ? `: ${top.title || top.target || top.url || ""}` : ""}`;
  }
  if (r.held && r.held.path) return `holding ${r.held.path}`;
  return "";
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
  if (swarmCompanions.length) placeSwarm();
}

function setOrbCenter(point) {
  moveOrb(
    Number(point && point.x) - ORB_SIZE.width / 2,
    Number(point && point.y) - ORB_SIZE.height / 2,
  );
}

function orbVisible() {
  // The display mode can take the orb disc down while leaving the cluster up: `both`
  // and `swarm` are avatar + cluster, and `avatar` is the VRM alone (owner 2026-11-20).
  const mk = displayMode.layers(display.mode);
  return Boolean(state.visible && mk.orb && alive(orbWindow) && orbWindow.isVisible());
}

// ── the windows ─────────────────────────────────────────────────────────────

function send(channel, payload) {
  for (const win of [orbWindow, bubbleWindow]) {
    try {
      if (alive(win)) win.webContents.send(channel, payload);
    } catch { /* a page mid-load misses one update; the next tick resends */ }
  }
}

/**
 * Is a card or panel open over the fairy (the whisper, the bubble)? The orb and
 * swarm pages drop their native hover tooltips while it is: measured 2026-11-09,
 * "Aither: HOST AT 97.5% COMMIT ... (16 cards)" drew over the open card's title.
 */
let lastPanelOpen = null;
function panelOpen() {
  return Boolean(nudging) || Boolean(alive(bubbleWindow) && bubbleWindow.isVisible());
}
function sendPanel() {
  const open = panelOpen();
  if (open === lastPanelOpen) return open;
  lastPanelOpen = open;
  if (open) releaseHover();
  for (const win of [orbWindow, swarmWindow]) {
    try {
      if (alive(win)) win.webContents.send("orb:panel", { open });
    } catch { /* a page mid-load: init() carries it */ }
  }
  return open;
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
    width: BUBBLE_SIZE.width, height: bubbleHeight,
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
  // A pinned card is draggable; an unpinned one stays where the fairy opened it.
  if (typeof bubbleWindow.setMovable === "function") {
    try { bubbleWindow.setMovable(cardStay.normalizeCard(state.card).pin); } catch { /* no-op */ }
  }
  bubbleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bubbleWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  bubbleWindow.on("closed", () => { bubbleWindow = null; });
  // Owner 2026-11-22: losing focus MUST NOT close the card. The old handler closed it
  // whenever the pointer was off it -- clicking away, another app, or the Snipping
  // Tool taking focus (so the card was gone before it could be screenshotted). The
  // card now stays until Esc, the close button, a click on the fairy, or the opt-in
  // idle timeout (card-stay.cjs, OFF by default).
  bubbleWindow.on("blur", () => {
    drafting = false;
    syncBubble();
  });
  // A pinned card is dragged by its own grip: when the move settles, it docks to the
  // nearest screen corner (the same rule a dropped fairy follows) and remembers it.
  bubbleWindow.on("moved", () => {
    if (!alive(bubbleWindow)) return;
    const card = cardStay.normalizeCard(state.card);
    if (!card.pin) return;
    // Our own placement (open, resize, clamp) must not re-dock: only a position the
    // owner moved the window TO (different from the one we saved) is a drag.
    const [x, y] = bubbleWindow.getPosition();
    if (card.x === x && card.y === y) return;
    if (cardMoveTimer) clearTimeout(cardMoveTimer);
    cardMoveTimer = setTimeout(dockCard, 260);
    if (cardMoveTimer.unref) cardMoveTimer.unref();
  });
  void bubbleWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "bubble" } });
  return bubbleWindow;
}

/**
 * The swarm: every companion fairy (one per agent with a card waiting), on rings
 * around the fairy that grow with the count. Its own transparent window, sized to
 * the outer ring and centred on the orb, so the 72 px orb window never grows (the
 * 2026-11-07 GPU leak was a growing orb). Click-through except the companion under
 * the pointer (the page reports it); never focused; kept BELOW the orb window so
 * the orb disc still takes its own presses.
 */
function ensureSwarm() {
  if (alive(swarmWindow)) return swarmWindow;
  const { BrowserWindow } = electron();
  swarmWindow = new BrowserWindow({
    x: 0, y: 0, width: 160, height: 160,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, focusable: false, title: "Aither swarm",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "orb-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  swarmWindow.setAlwaysOnTop(true, "screen-saver");
  try { swarmWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* no-op */ }
  swarmWindow.setIgnoreMouseEvents(true, { forward: true });
  swarmWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  swarmWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  swarmWindow.on("closed", () => { swarmWindow = null; });
  void swarmWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "swarm" } });
  return swarmWindow;
}

/** The avatar window's rect, when main can see it: both/swarm hang the cluster on it. */
function avatarBoundsNow() {
  const fn = attentionHooks && attentionHooks.avatarBounds;
  if (typeof fn !== "function") return null;
  try {
    const r = fn();
    return r && Number(r.width) > 0 && Number(r.height) > 0 ? r : null;
  } catch { return null; }
}

/** Half the cluster window's side for `count` fairies (fairy-control owns the ring). */
function clusterHalfFor(count) {
  return Math.max(48, fairyControl.swarmExtent(state.swarmView.mode, Math.max(1, count), state.swarmView.radius));
}

/** Where the cluster is centred: beside the avatar (both/swarm), the anchor while a
 *  body stands in for the fairy, else the orb. */
function clusterCenter() {
  if (display.mode === "both" || display.mode === "swarm") {
    const avatar = avatarBoundsNow();
    if (avatar) {
      const area = workAreaAt({ x: avatar.x + avatar.width / 2, y: avatar.y + avatar.height / 2 }) || restoreWorkArea();
      const count = displayMode.capacity(display.mode, swarmCompanions.length || 1, display);
      const point = displayMode.clusterCenter(display.mode, { avatarRect: avatar, clusterHalf: clusterHalfFor(count), area });
      if (point) return point;
    }
  }
  if (swarmAnchor && !orbVisible()) return { x: swarmAnchor.x, y: swarmAnchor.y };
  if (alive(orbWindow)) {
    const b = orbWindow.getBounds();
    return { x: b.x + ORB_SIZE.width / 2, y: b.y + ORB_SIZE.height / 2 };
  }
  return { x: 0, y: 0 };
}

/** The swarm window's rect for the view (fairy-control.boundsFor), or null = no window. */
function swarmBounds(count) {
  const centre = clusterCenter();
  const area = workAreaAt(centre) || { x: 0, y: 0, width: 1920, height: 1080 };
  // Dock mode anchors to the taskbar when its rect is known (plan A4).
  return fairyControl.boundsFor(state.swarmView, count, centre, area, taskbarForDock());
}

/**
 * The fairy above its swarm. Measured live 2026-11-09 (ctypes GetWindow order):
 * "Aither spirit" at z 12 above "Aither swarm" at z 21 -- right -- but nothing
 * kept it so after a later swarm show. Raised after every companion update.
 */
function raiseOrbOverSwarm() {
  try {
    if (alive(orbWindow) && typeof orbWindow.moveTop === "function") orbWindow.moveTop();
  } catch { /* a window mid-teardown */ }
}

/** Show, size, follow or hide the swarm for the current companions. */
function placeSwarm(companions = swarmCompanions, { raise = false } = {}) {
  const list = Array.isArray(companions) ? companions : [];
  // The cluster is ON (owner 2026-11-16, overriding 2026-11-13's "don't show a swarm":
  // "the cluster of fairies should grow with agents and decisions queued"); orb.json
  // `cluster: false` (or the swarm switch set off) turns it off. Nothing live = no window.
  // The display MODE (owner 2026-11-20) gates it too: `avatar` has no cluster, and
  // both/swarm draw it beside the avatar even while the ask orb itself is down.
  const mk = displayMode.layers(display.mode);
  const onDesk = orbVisible() || swarmAnchor || display.mode === "both" || display.mode === "swarm";
  // `swarm` draws each fairy as its own orb around the avatar (syncSwarmOrbs), so the
  // small ring window stays down -- there is still ONE cluster, it just has another form.
  const next = mk.cluster && display.mode !== "swarm" && list.length && onDesk
    && (state.cluster !== false || state.swarm === true) ? swarmBounds(list.length) : null;
  if (!next) {
    if (alive(swarmWindow) && swarmWindow.isVisible()) swarmWindow.hide();
    lastBounds = null;
    syncForegroundProbe();
    sendSwarmView();
    syncPins();
    try { syncSwarmOrbs(); } catch { /* cosmetic */ }
    return;
  }
  const win = ensureSwarm();
  const cur = win.getBounds();
  if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) {
    win.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height }); // full bounds every time: a bare setPosition drifts the size
  }
  lastBounds = next;
  if (!win.isVisible()) {
    win.showInactive();
    raise = true;
  }
  // The orb disc stays above its swarm, so a press on the fairy is the fairy's and
  // its glow is never drawn under the companions.
  if (raise) raiseOrbOverSwarm();
  syncForegroundProbe();
  sendSwarmView();
  syncPins();
  try { syncSwarmOrbs(); } catch { /* cosmetic */ }
}

/**
 * Centre the ONE cluster on a point while the fairy is down (the agent swarm: light
 * fairies keep orbiting the full avatar that stands where the orb was). null releases it.
 */
function setSwarmAnchor(point) {
  swarmAnchor = point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
    ? { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }
    : null;
  placeSwarm(swarmCompanions, { raise: true });
  return { ok: true, anchor: swarmAnchor };
}

/** The swarm's own switch (orb.json `swarm`): the agent fairies orbiting the main one. */
function setSwarmVisible(on) {
  const next = on === true;
  // The swarm switch is the cluster's switch too (2026-11-16): off hides the cluster.
  if (state.swarm !== next || state.cluster !== next) { state.swarm = next; state.cluster = next; saveState(); }
  sendFairy({ force: true });
  placeSwarm(swarmCompanions, { raise: true });
  return { ok: true, swarm: state.swarm === true };
}

// ── display mode: avatar, fairy, both, swarm (display-mode.cjs, owner 2026-11-20) ──
// "the docked avatar AND a fairy -- or a swarm of fairies -- at the same time."
// One setting, persisted by main in avatar-dock.json beside `docked`; the pure
// layout (cluster beside the avatar, never on it) is display-mode.cjs.

/** The mode the desk draws now, and how many fairies a swarm shows. */
function displayModeState() {
  return { ...display };
}

/** Put each window on the layers this mode allows, WITHOUT touching the owner's
 *  remembered `visible`: a mode switch is not a show/hide. `both`/`swarm` take the
 *  orb disc down and leave the cluster up beside the avatar; `avatar` takes both. */
function applyDisplayLayers() {
  const mk = displayMode.layers(display.mode);
  if (alive(orbWindow)) {
    if (mk.orb && state.visible) { if (!orbWindow.isVisible()) orbWindow.showInactive(); }
    else if (orbWindow.isVisible()) orbWindow.hide();
  }
  if (!mk.orb && alive(bubbleWindow) && bubbleWindow.isVisible()) bubbleWindow.hide();
}

/**
 * Apply a display mode (owner pick, avatar/fairy menu, palette, key or boot restore).
 * Settles the ONE cluster: a hand/follow attach lets go, the trail veil comes down,
 * stray pins go where a slot layout owns the fairies, then both windows are placed
 * again -- a switch never leaves an overlay painted from the previous mode.
 */
function setDisplayModeState(next) {
  const before = display.mode;
  display = displayMode.normalize(next);
  const plan = displayMode.settle(before, display.mode);
  if (plan.changed) {
    if (attach && attach.auto) { attach = null; stopFollow(); }
    if (pinDrag) {
      pinDrag = null;
      if (pinWatchdog) { clearTimeout(pinWatchdog); pinWatchdog = null; }
    }
    hideMenu();
    hideTip();
    hideVeil({ force: true });
    releaseHover();
    if (display.mode !== "swarm") {
      for (const agent of [...swarmPinAgents]) destroyPin(agent);
      swarmPinAgents = new Set();
    }
    if (plan.clearPins) for (const agent of [...pinWindows.keys()]) destroyPin(agent);
  }
  applyDisplayLayers();
  sendFairy({ force: true });
  placeSwarm(swarmCompanions, { raise: true });
  return displayModeState();
}

/** A `dm:<mode>` menu pick. Draw it here at once, then tell main (it persists the
 *  choice and settles the avatar window); a build with no hook still works, so the
 *  row is never dead. */
function displayPick(what) {
  const r = displayMode.applyModePick(display, what);
  if (r.error) return { ok: false, error: r.error };
  if (!r.changed) return { ok: true, mode: display.mode, changed: false };
  setDisplayModeState(r.settings);
  const applied = hookValue("setDisplayMode", r.settings);
  return { ok: true, mode: display.mode, changed: true, applied: applied || null };
}

// ── fine control over the fairies (fairy-control.cjs, owner 2026-11-16) ─────────
// Select, a full tooltip, a menu per fairy, pin out of / back into the swarm, gather /
// scatter / one orb / dock / filter, the scroll radius, and keeping off the focused
// window. The view lives in orb.json `swarmView`; the pure rules are fairy-control.cjs.

const PIN_SIZE = Object.freeze({ width: 44, height: 44 });
const pinKeys = new Map();

function viewCompanions(all = allCompanions) {
  const split = fairyControl.applyView(all, state.swarmView);
  const dec = (c) => fairyControl.decorate(c, state.swarmView, { selected: selectedAgent });
  // `swarm` draws up to N (owner 2026-11-20); `avatar` draws none; fairy/both all.
  const room = displayMode.capacity(display.mode, split.visible.length, display);
  const visible = room === split.visible.length ? split.visible : split.visible.slice(0, room);
  return {
    visible: state.swarmView.mode === "orb" ? [] : visible.map(dec),
    pinned: split.pinned.map(dec),
    split: { ...split, visible, hidden: split.hidden + (split.visible.length - visible.length) },
  };
}

/** What the swarm and orb pages need beside the companion rows. */
function swarmViewPayload() {
  const v = state.swarmView;
  const { split } = viewCompanions();
  let avoid = null;
  if (v.avoid && fgContent && lastBounds && v.mode !== "dock" && v.mode !== "orb") {
    const c = clusterCenter();
    const sitsOnIt = c.x >= fgContent.x && c.x <= fgContent.x + fgContent.width
      && c.y >= fgContent.y && c.y <= fgContent.y + fgContent.height;
    // The fairy put on that window on purpose: the ring keeps its place around it.
    if (!sitsOnIt) {
      avoid = fairyControl.relativeRect(fgContent, { x: lastBounds.x + lastBounds.width / 2, y: lastBounds.y + lastBounds.height / 2 });
    }
  }
  return {
    mode: v.mode, radius: v.radius, kind: v.kind, edge: lastBounds ? lastBounds.edge : "",
    total: split.total, shown: split.visible.length, hidden: split.hidden, pinned: split.pinned.length, avoid,
    selected: selectedAgent,
  };
}

/** The pin window's own fairy (its agent comes in the page URL). */
function pinMateFor(sender) {
  let agent = "";
  try { agent = String(new URL(sender.getURL()).searchParams.get("agent") || "").toLowerCase(); } catch { /* filename only */ }
  const c = viewCompanions().pinned.find((x) => x.agent === agent) || (pinDrag && pinDrag.agent === agent
    ? fairyControl.decorate(allCompanions.find((x) => x.agent === agent) || { agent }, state.swarmView, { selected: selectedAgent }) : null);
  return c || null;
}

function sendSwarmView({ force = false } = {}) {
  const payload = swarmViewPayload();
  const key = JSON.stringify(payload);
  if (!force && key === lastSwarmViewKey) return payload;
  lastSwarmViewKey = key;
  for (const win of [swarmWindow, orbWindow]) {
    try { if (alive(win)) win.webContents.send("orb:swarm-view", payload); } catch { /* page mid-load: init() carries it */ }
  }
  return payload;
}

function screenToDip(p) {
  try {
    const { screen } = electron();
    return typeof screen.screenToDipPoint === "function" ? screen.screenToDipPoint(p) : p;
  } catch { return p; }
}

/** A stable key for one foreground descriptor: the window, its box, its quiet verdict. */
function foregroundKey(fg) {
  if (!fg) return "";
  return [Number(fg.hwnd) || 0, Number(fg.pid) || 0, fg.x, fg.y, fg.width, fg.height, String(fg.quiet || "")].join("|");
}

/**
 * The probe reported the window in front. Two readers, one sample: the ring's obstacle
 * (fgContent) and the follow rule, which waits for the focus to hold (followFocus).
 */
function onForeground(rect) {
  fgContent = fairyControl.contentRect(rect);
  const changed = foregroundKey(rect) !== foregroundKey(followSeen);
  followSeen = rect;
  if (changed) {
    followChangedAt = Date.now();
    followRetries = 0;
    if (followDebounce) { clearTimeout(followDebounce); followDebounce = null; }
    if (rect && state.follow === true) {
      followDebounce = setTimeout(() => { followDebounce = null; void applyFollow(); }, followFocus.SETTLE_MS);
      if (followDebounce.unref) followDebounce.unref();
    }
  }
  sendSwarmView();
}

/** How often the rule is retried while a flight, a card or a drag holds the fairy, and
 *  for how many ticks: long enough to outlast a 560 ms flight, short enough that a card
 *  left open never wakes the main process for minutes. */
const FOLLOW_RETRY_MS = 700;
const FOLLOW_RETRIES_MAX = 20;

/** The focus is held but the fairy was busy: try again shortly, not on a non-existent tick. */
function scheduleFollowRetry() {
  if (followDebounce || quitting || state.follow !== true) return;
  if (followRetries >= FOLLOW_RETRIES_MAX) return;
  followRetries += 1;
  followDebounce = setTimeout(() => { followDebounce = null; void applyFollow(); }, FOLLOW_RETRY_MS);
  if (followDebounce.unref) followDebounce.unref();
}

/**
 * Run the pure follow rule against the last foreground sample and do what it says.
 * An attach the owner made by hand is never stolen; a follow-made attach is let go
 * when the focus lands on one of the desk's own windows (the AitherOS dock takes it
 * back) or on a full-screen app/game.
 */
async function applyFollow() {
  if (followBusy || quitting) {
    // A focus that landed while the previous attach was still flying must not be lost.
    if (!quitting) scheduleFollowRetry();
    return { act: "none", reason: "busy" };
  }
  if (!state.visible || !alive(orbWindow)) return { act: "none", reason: "the fairy is down" };
  // The owner put it there by hand: follow never moves it again until the next drag.
  if (manualPlacement || resolvingDrop || ringOpen) return { act: "none", reason: "placed by hand" };
  followBusy = true;
  try {
    const decision = followFocus.decideFollow({
      enabled: state.follow === true,
      fg: followSeen,
      attach,
      changedAt: followChangedAt,
      now: Date.now(),
      ownPid: process.pid,
    });
    if (decision.act === "attach") {
      // Never yank the fairy out of a flight, a card or a drag: retry shortly instead.
      if (flight || tripBusy || nudging || dragging || regionWait) {
        scheduleFollowRetry();
        return { act: "none", reason: "the fairy is busy" };
      }
      if (attach && attach.hwnd && decision.target.hwnd && Number(attach.hwnd) === Number(decision.target.hwnd)) {
        return { act: "none", reason: "already following it" };
      }
      await attachTo(decision.target, { quiet: true });
      followRetries = 0;
      return decision;
    }
    if (decision.act === "release") {
      if (attach && attach.follow) {
        // The AitherOS window may be exactly what was focused: ride it again, as the
        // one-cluster rule wants. Otherwise fly HOME and take the veil down: a silent
        // detach left the cluster stranded on the window it followed with the trail and
        // tether still painted across the screen (owner screenshots 2026-11-19).
        const w = dockWindowId
          ? (() => { try { return electron().BrowserWindow.fromId(dockWindowId); } catch { return null; } })()
          : null;
        if (alive(w) && w.isVisible() && !w.isMinimized()) {
          detach({ silent: true });
          void setDockWindow(w).catch(() => { /* window gone this tick */ });
        } else {
          detach();
        }
      }
      return decision;
    }
    return decision;
  } catch {
    // attachTo/setDockWindow are the only awaited calls here; an async rejection from
    // either must not become an unhandled rejection in the main process.
    return { act: "none", reason: "the follow step failed" };
  } finally {
    followBusy = false;
  }
}

/** The tray/MCP door: "Fairies follow my window", default on. */
function setFollow(on) {
  const next = on !== false;
  const changed = (state.follow === true) !== next;
  state.follow = next;
  if (changed) saveState();
  if (!next) {
    // Toggle-off path: let go of what FOLLOW made; a hand attach stays where it is.
    if (followDebounce) { clearTimeout(followDebounce); followDebounce = null; }
    followRetries = 0;
    if (followFocus.releaseOnDisable(attach)) {
      detach({ silent: true });
      if (dockWindowId) {
        const w = (() => { try { return electron().BrowserWindow.fromId(dockWindowId); } catch { return null; } })();
        if (alive(w)) void setDockWindow(w).catch(() => { /* window gone */ });
      }
    }
  } else if (followSeen) {
    // Switched back on with a window already in front: settle, then follow it.
    followRetries = 0;
    followChangedAt = Date.now();
    if (followDebounce) clearTimeout(followDebounce);
    followDebounce = setTimeout(() => { followDebounce = null; void applyFollow(); }, followFocus.SETTLE_MS);
    if (followDebounce.unref) followDebounce.unref();
  }
  syncForegroundProbe();
  return { ok: true, follow: state.follow === true };
}

function followState() {
  return state.follow === true;
}

/**
 * The focused-window probe runs while a ring is on screen to be kept clear OR while
 * the cluster is meant to follow the focused window.
 */
function syncForegroundProbe() {
  const ring = alive(swarmWindow) && swarmWindow.isVisible() && state.swarmView.mode !== "dock" && state.swarmView.mode !== "orb";
  const follow = state.follow === true && orbVisible();
  // Dock mode's taskbar rect is its own watch: turning "follow my window" off must not
  // silently drop a docked strip back off the taskbar.
  const dock = state.swarmView.mode === "dock" && (orbVisible() || Boolean(swarmAnchor));
  if (!ring && !follow && !dock) {
    if (fgProbeImpl) fgProbeImpl.stop();
    stopTaskbarWatch();
    return;
  }
  let canDip = false;
  try { canDip = typeof electron().screen.screenToDipPoint === "function"; } catch { /* no screen module (tests) */ }
  if (!canDip) return; // no real screen: nothing to probe, nothing to spawn
  if (ring || follow) {
    if (!fgProbeImpl) {
      fgProbeImpl = foregroundProbe.createForegroundProbe({
        toDip: screenToDip,
        onChange: onForeground,
      });
    }
    fgProbeImpl.start();
  } else if (fgProbeImpl) {
    fgProbeImpl.stop(); // nothing reads the focus: no ring, and following is off
  }
  if (dock) startTaskbarWatch(); else stopTaskbarWatch();
}

// ── the taskbar (plan A4: dock mode sits ON it) ─────────────────────────────
/**
 * The Shell_TrayWnd rect in DIPs, or null. It is published by the same resident window
 * oracle the attach uses (spirit-probe's "tray" op), and converted to the unit the
 * windows are placed in, exactly as the foreground probe converts its rect.
 */
async function refreshTaskbar() {
  if (process.platform !== "win32") { taskbarRect = null; taskbarBars = []; return taskbarRect; }
  try {
    if (!probe) probe = spiritProbe.createWindowProbe();
    const bars = await probe.taskbars();
    // Every bar, not just the primary: the cluster may sit on a second monitor, and the
    // primary bar is on the FIRST monitor. Picking by display bounds keeps the strip on
    // the display the fairies are actually on.
    const all = [bars && bars.primary, ...((bars && Array.isArray(bars.secondaries)) ? bars.secondaries : [])].filter(Boolean);
    taskbarBars = all.map((bar) => {
      const a = screenToDip({ x: bar.x, y: bar.y });
      const b = screenToDip({ x: bar.x + bar.width, y: bar.y + bar.height });
      return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    });
    const centre = clusterCenter();
    const display = (() => {
      try { return electron().screen.getDisplayNearestPoint(centre); } catch { return null; }
    })();
    const next = display && display.bounds
      ? fairyControl.taskbarForDisplay(taskbarBars, display.bounds)
      : (taskbarBars[0] || null);
    const changed = !taskbarRect !== !next
      || (taskbarRect && next && ["x", "y", "width", "height"].some((k) => Math.round(taskbarRect[k]) !== Math.round(next[k])));
    taskbarRect = next;
    if (changed && state.swarmView.mode === "dock") placeSwarm(swarmCompanions);
    return taskbarRect;
  } catch {
    return taskbarRect;
  }
}

/** Only while dock mode is in use: one probe line every TASKBAR_MS, nothing else. */
const TASKBAR_MS = 10_000;
function startTaskbarWatch() {
  if (state.swarmView.mode !== "dock") { stopTaskbarWatch(); return; }
  if (taskbarTimer) return;
  taskbarTimer = setInterval(() => { void refreshTaskbar(); }, TASKBAR_MS);
  if (taskbarTimer.unref) taskbarTimer.unref();
  void refreshTaskbar();
}
function stopTaskbarWatch() {
  if (taskbarTimer) { clearInterval(taskbarTimer); taskbarTimer = null; }
}
/** The taskbar rect dock mode should use right now (null when unknown or unused). */
function taskbarForDock() {
  return state.swarmView.mode === "dock" ? taskbarRect : null;
}

/** Change the view, keep it, redraw. */
function setView(patch) {
  state.swarmView = fairyControl.normalizeView({ ...state.swarmView, ...patch });
  saveState();
  sendFairy({ force: true });
  syncForegroundProbe(); // dock mode swaps the taskbar watch in and out
  return state.swarmView;
}

function selectAgent(agent) {
  const key = String(agent || "").trim().toLowerCase();
  if (key === selectedAgent) return { ok: true, selected: selectedAgent };
  selectedAgent = key;
  if (key) hookValue("select", key);
  sendFairy({ force: true });
  return { ok: true, selected: selectedAgent };
}

function swarmWheel(deltaY) {
  const next = fairyControl.stepRadius(state.swarmView.radius, deltaY);
  if (next === state.swarmView.radius) return { ok: true, radius: next };
  setView({ radius: next });
  return { ok: true, radius: state.swarmView.radius };
}

// -- pinned fairies: each its own small window ------------------------------------

function ensurePin(agent) {
  const have = pinWindows.get(agent);
  if (alive(have)) return have;
  const win = overlayWindow(`Aither pin ${agent}`, { focusable: false });
  win.setBounds({ x: 0, y: 0, ...PIN_SIZE });
  win.on("closed", () => { if (pinWindows.get(agent) === win) pinWindows.delete(agent); });
  void win.loadFile(path.join(__dirname, "orb.html"), { query: { view: "pin", agent } });
  pinWindows.set(agent, win);
  pinKeys.delete(agent);
  return win;
}

function destroyPin(agent) {
  const win = pinWindows.get(agent);
  pinWindows.delete(agent);
  pinKeys.delete(agent);
  pinDocks.delete(agent);
  try { if (alive(win)) win.destroy(); } catch { /* gone */ }
}

function clampPin(at) {
  const centre = { x: at.x + PIN_SIZE.width / 2, y: at.y + PIN_SIZE.height / 2 };
  const area = menuAreaAt(centre);
  if (!area) return { x: Math.round(at.x), y: Math.round(at.y) };
  return {
    x: Math.round(Math.min(Math.max(area.x, at.x), area.x + area.width - PIN_SIZE.width)),
    y: Math.round(Math.min(Math.max(area.y, at.y), area.y + area.height - PIN_SIZE.height)),
  };
}

/** Make the pin windows match the view: one per pinned agent that is live, none for the rest. */
function syncPins() {
  const v = state.swarmView;
  const show = !quitting && (orbVisible() || Boolean(swarmAnchor));
  const live = new Map(viewCompanions().pinned.map((c) => [c.agent, c]));
  for (const [agent, at] of Object.entries(v.pins)) {
    if (pinDrag && pinDrag.agent === agent) continue; // under the pointer: the drag moves it
    const c = live.get(agent);
    const have = pinWindows.get(agent);
    if (!c || !show) {
      if (alive(have) && have.isVisible()) { try { have.hide(); } catch { /* gone */ } }
      continue;
    }
    const win = ensurePin(agent);
    const next = clampPin(at);
    const cur = win.getBounds();
    if (cur.x !== next.x || cur.y !== next.y || cur.width !== PIN_SIZE.width) win.setBounds({ ...next, ...PIN_SIZE });
    const key = JSON.stringify(c);
    if (pinKeys.get(agent) !== key) {
      pinKeys.set(agent, key);
      deliverTo(win, "orb:pin-mate", { mate: c });
    }
    if (!win.isVisible()) win.showInactive();
  }
  for (const agent of [...pinWindows.keys()]) {
    if (swarmPinAgents.has(agent)) continue; // swarm mode owns where this orb stands
    if (!v.pins[agent] && !(pinDrag && pinDrag.agent === agent)) destroyPin(agent);
  }
}

/**
 * Swarm mode (owner 2026-11-20): "a swarm of fairies ... spread around the avatar,
 * each a separate draggable orb with its own agent badge". Every orb is a pin
 * window placed by display-mode.swarmOrbs on a radius outside the body; not in
 * swarmView.pins, so leaving the mode destroys exactly these and nothing the owner
 * pinned by hand.
 */
function syncSwarmOrbs() {
  if (display.mode !== "swarm") {
    for (const agent of [...swarmPinAgents]) destroyPin(agent);
    swarmPinAgents = new Set();
    return [];
  }
  const avatar = avatarBoundsNow();
  if (!avatar) return [];
  const area = workAreaAt({ x: avatar.x + avatar.width / 2, y: avatar.y + avatar.height / 2 }) || restoreWorkArea();
  const { visible } = viewCompanions();
  const orbs = displayMode.swarmOrbs(avatar, visible, { max: display.swarm, area });
  const want = new Set(orbs.map((o) => o.agent));
  for (const agent of [...swarmPinAgents]) {
    if (want.has(agent)) continue;
    destroyPin(agent);
    swarmPinAgents.delete(agent);
  }
  const mates = new Map(visible.map((c) => [String(c.agent || "").toLowerCase(), c]));
  for (const orb of orbs) {
    const win = ensurePin(orb.agent);
    swarmPinAgents.add(orb.agent);
    if (!alive(win)) continue;
    const cur = win.getBounds();
    if (cur.x !== orb.rect.x || cur.y !== orb.rect.y || cur.width !== orb.rect.width || cur.height !== orb.rect.height) {
      win.setBounds(orb.rect);
    }
    const c = mates.get(orb.agent) || null;
    const key = JSON.stringify(c);
    if (pinKeys.get(orb.agent) !== key) {
      pinKeys.set(orb.agent, key);
      deliverTo(win, "orb:pin-mate", { mate: c ? fairyControl.decorate(c, state.swarmView, { selected: selectedAgent }) : null });
    }
    if (!win.isVisible()) win.showInactive();
  }
  return orbs;
}

/**
 * A drag of one fairy, from the ring ("swarm") or from its own pin ("pin"). main reads
 * the real cursor on every phase (the page only says what happened), so a page that
 * lost its mouse capture cannot strand a fairy. start: the pin window follows the
 * pointer; end: dropped on the fairy it rejoins the ring, anywhere else it is pinned.
 */
function swarmDrag(phase, agentRaw, from = "swarm") {
  const agent = String(agentRaw || "").trim().toLowerCase();
  const p = cursorPoint();
  if (phase === "start") {
    const c = allCompanions.find((x) => x.agent === agent);
    if (!c) return { ok: false, error: "no such fairy" };
    if (pinDrag) swarmDrag("end", pinDrag.agent, pinDrag.from);
    hideTip();
    hideMenu();
    const win = ensurePin(agent);
    const b = alive(win) ? win.getBounds() : { x: p.x, y: p.y };
    const grab = from === "pin" && (state.swarmView.pins[agent] || swarmPinAgents.has(agent))
      ? { dx: p.x - b.x, dy: p.y - b.y }
      : { dx: PIN_SIZE.width / 2, dy: PIN_SIZE.height / 2 };
    pinDrag = { agent, from, grab };
    armPinWatchdog();
    // From the ring the press belongs to the ring's window (it holds the mouse): the pin
    // window that follows the pointer must not steal it.
    if (from === "swarm") { try { win.setIgnoreMouseEvents(true); } catch { /* gone */ } }
    win.setBounds({ x: Math.round(p.x - grab.dx), y: Math.round(p.y - grab.dy), ...PIN_SIZE });
    pinKeys.set(agent, "");
    deliverTo(win, "orb:pin-mate", { mate: fairyControl.decorate(c, state.swarmView, { selected: selectedAgent }) });
    if (!win.isVisible()) win.showInactive();
    return { ok: true, dragging: agent };
  }
  if (!pinDrag || pinDrag.agent !== agent) return { ok: false, error: "no drag in flight" };
  const win = pinWindows.get(agent);
  const grab = pinDrag.grab;
  if (phase === "move") {
    armPinWatchdog();
    if (alive(win)) win.setBounds({ x: Math.round(p.x - grab.dx), y: Math.round(p.y - grab.dy), ...PIN_SIZE });
    return { ok: true };
  }
  if (phase === "end") {
    pinDrag = null;
    if (pinWatchdog) { clearTimeout(pinWatchdog); pinWatchdog = null; }
    try { if (alive(win)) win.setIgnoreMouseEvents(false); } catch { /* gone */ }
    // Swarm mode: the orb is never pinned as the owner's; it returns to its slot.
    if (display.mode === "swarm") {
      const orbs = syncSwarmOrbs();
      const mine = orbs.find((o) => o.agent === agent);
      if (mine) {
        try { if (alive(win)) win.setBounds(mine.rect); } catch { /* gone */ }
        return {
          ok: true, pinned: false, rejoined: true,
          releasedTo: displayMode.releaseTarget({
            mode: "swarm",
            slot: { x: mine.rect.x + mine.rect.width / 2, y: mine.rect.y + mine.rect.height / 2 },
            home: home || orbCenter(),
          }),
        };
      }
    }
    const pins = { ...state.swarmView.pins };
    // both/swarm are slot layouts: "return" flies the fairy back to its slot. A PIN
    // or a timed stay keeps a drop outside the ring where it landed, even in a slot
    // layout -- otherwise every drop flew straight back (owner 2026-11-23).
    const slotLayout = display.mode === "both" || display.mode === "swarm";
    const centre = clusterCenter();
    const nearCluster = fairyControl.joinsCluster(p, centre);
    const verdict = fairyDrop.decideDrop(dropBehaviorFor(agent));
    const rejoin = verdict.mode === "return" ? (slotLayout || nearCluster) : nearCluster;
    let result;
    if (rejoin) {
      delete pins[agent];
      pinDocks.delete(agent);
      result = {
        ok: true, pinned: false, rejoined: true,
        releasedTo: displayMode.releaseTarget({ mode: display.mode, slot: centre, home: home || orbCenter() }),
      };
    } else {
      pins[agent] = clampPin({ x: p.x - grab.dx, y: p.y - grab.dy });
      result = { ok: true, pinned: true, at: pins[agent] };
      // A drop over a real window snaps to that window's nearest corner and rides it.
      void snapPinToWindow(agent, p);
      if (verdict.returnAfterMs != null) schedulePinReturn(agent, verdict.returnAfterMs);
    }
    setView({ pins });
    return result;
  }
  return { ok: false, error: `unknown drag phase ${phase}` };
}

/** A drag the page never finished (it lost the pointer; the swarm window is not focusable so no blur comes)
 *  ends itself after PIN_DRAG_IDLE_MS without a move: the window gets the mouse back (review of #101). */
const PIN_DRAG_IDLE_MS = 10_000;
let pinWatchdog = null;
function armPinWatchdog() {
  if (pinWatchdog) clearTimeout(pinWatchdog);
  pinWatchdog = setTimeout(() => {
    pinWatchdog = null;
    if (pinDrag) swarmDrag("end", pinDrag.agent, pinDrag.from);
  }, PIN_DRAG_IDLE_MS);
  if (pinWatchdog.unref) pinWatchdog.unref();
}

/** Pin `agent` centred on a point (a menu pick, the bridge) -- or unpin it (at null). */
function pinAgent(agent, at = null) {
  const key = String(agent || "").trim().toLowerCase();
  const pins = { ...state.swarmView.pins };
  if (!at) delete pins[key];
  else pins[key] = clampPin({ x: at.x - PIN_SIZE.width / 2, y: at.y - PIN_SIZE.height / 2 });
  if (!pins[key]) pinDocks.delete(key);
  setView({ pins });
  return { ok: true, pinned: Boolean(pins[key]), at: pins[key] || null };
}

// -- a pinned fairy that rides a window (owner 2026-11-23) -------------------------
// A companion dropped over a real window docks to that window's nearest corner and
// follows it: moves and resizes move the fairy, a minimise hides it with the window,
// and a close sends it home (back into the ring).
const PIN_DOCK_MS = 250;

/** Snap a freshly pinned fairy to the window under the drop, and remember that window. */
async function snapPinToWindow(agent, point) {
  const t = await probeTargetAt(point);
  if (!t || t.kind !== "window" || !t.hwnd) return null;
  const pins = { ...state.swarmView.pins };
  if (!pins[agent]) return null; // unpinned while the probe was out
  const dock = fairyDrop.dockFor(t.bounds, PIN_SIZE, { dropPoint: point });
  pins[agent] = clampPin({ x: dock.x, y: dock.y });
  pinDocks.set(agent, { hwnd: t.hwnd, corner: dock.corner });
  setView({ pins });
  ensurePinDockTimer();
  return dock;
}

/** "Stay N seconds" for a companion: back into the ring after N. */
function schedulePinReturn(agent, ms) {
  const timer = setTimeout(() => {
    const pins = { ...state.swarmView.pins };
    if (!pins[agent]) return; // moved or unpinned already
    delete pins[agent];
    pinDocks.delete(agent);
    setView({ pins });
  }, Math.max(0, Number(ms) || 0));
  if (timer.unref) timer.unref();
}

function unpinToRing(agent) {
  const pins = { ...state.swarmView.pins };
  delete pins[agent];
  pinDocks.delete(agent);
  setView({ pins });
}

function ensurePinDockTimer() {
  if (pinDockTimer || pinDocks.size === 0) return;
  pinDockTimer = setInterval(() => { void refreshPinDocks(); }, PIN_DOCK_MS);
  if (pinDockTimer.unref) pinDockTimer.unref();
}

async function refreshPinDocks() {
  if (quitting) return;
  for (const [agent, info] of [...pinDocks]) {
    if (!state.swarmView.pins[agent]) { pinDocks.delete(agent); continue; }
    if (!probe) probe = spiritProbe.createWindowProbe();
    let now;
    try { now = await probe.rectOf(info.hwnd, { excludePid: process.pid }); } catch { now = null; }
    if (!now) {
      unpinToRing(agent); // the window closed: home, back into the ring
      continue;
    }
    const win = ensurePin(agent);
    if (!alive(win)) continue;
    const minimised = now.minimised || fairyDrop.windowState(now.bounds, { visible: now.visible }) === "minimised";
    if (minimised) {
      try { if (win.isVisible()) win.hide(); } catch { /* gone */ }
      continue;
    }
    const at = clampPin(fairyDrop.cornerAnchor(now.bounds, info.corner, PIN_SIZE));
    const cur = win.getBounds();
    if (cur.x !== at.x || cur.y !== at.y) win.setBounds({ ...at, ...PIN_SIZE });
    if (!win.isVisible() && orbVisible()) { try { win.showInactive(); } catch { /* gone */ } }
    const stored = state.swarmView.pins[agent];
    if (stored && (stored.x !== at.x || stored.y !== at.y)) setView({ pins: { ...state.swarmView.pins, [agent]: at } });
  }
  if (pinDocks.size === 0 && pinDockTimer) {
    clearInterval(pinDockTimer);
    pinDockTimer = null;
  }
}

// -- menu picks -------------------------------------------------------------------

async function controlPick(what, ms) {
  const agent = String((ms && ms.agent) || "");
  const view = state.swarmView;
  // "When I drop it…" -- a per-fairy answer to the drop behaviour (owner 2026-11-23).
  if (what.startsWith("fc:drop:")) {
    const rest = what.slice("fc:drop:".length);
    const patch = rest === "pin" ? { mode: "pin" }
      : rest === "return" ? { mode: "return" }
        : rest.startsWith("timed:") ? { mode: "timed", seconds: Number(rest.slice(6)) || 10 }
          : null;
    if (!patch) return { ok: false, error: `unknown drop row ${what}` };
    return setDropBehavior(agent, patch);
  }
  if (what === "fc:chat") return chatWithAgent(agent);
  if (what === "fc:grow") {
    let r;
    try { r = await hookValue("growAgent", agent); } catch (error) { r = { ok: false, error: String((error && error.message) || error) }; }
    return r && typeof r === "object" ? r : { ok: false, error: "growing a fairy is not wired in this build" };
  }
  if (what === "fc:mute") {
    const muted = fairyControl.toggleIn(view.muted, agent);
    if (muted.includes(agent)) {
      // Muting is for real: attentionTick leaves a muted agent's cards out of the nudge plan (the badge
      // keeps counting) and a nudge it already shows is put away. Unmuting needs no clean-up: nothing
      // was written to the cards (review of #101).
      for (const c of attentionCards) {
        if (c && agentFairy.cardAgent(c) === agent) endNudgeFor(c.id, "snoozed");
      }
    }
    setView({ muted });
    return { ok: true, muted: muted.includes(agent) };
  }
  if (what === "fc:pin") {
    if (view.pins[agent]) return pinAgent(agent, null);
    return pinAgent(agent, (ms && ms.at) || cursorPoint());
  }
  if (what === "fc:hide") {
    setView({ hidden: view.hidden.includes(agent) ? view.hidden : [...view.hidden, agent] });
    return { ok: true, hidden: agent };
  }
  if (what === "fc:session") {
    let r;
    try { r = await hookValue("focusAgentSession", agent, menuCard(ms)); } catch (error) { r = { ok: false, error: String(error) }; }
    return r && typeof r === "object" ? r : { ok: false, error: "no session for this agent" };
  }
  return { ok: false, error: `unknown menu item ${what}` };
}

function swarmViewMenu({ at = null } = {}) {
  const { split } = viewCompanions();
  const built = fairyControl.viewItems(state.swarmView, {
    total: split.total, hidden: split.hidden, pinned: split.pinned.length,
  });
  return showMenu("swarmview", built, { at });
}

function swarmPick(what, ms) {
  if (what === "sv:menu") return swarmViewMenu({ at: (ms && ms.at) || null });
  const r = fairyControl.applyViewPick(state.swarmView, what);
  if (r.error) return { ok: false, error: r.error };
  if (r.changed) setView(r.view);
  return { ok: true, view: state.swarmView };
}

/** The bridge / MCP door: {mode, kind, radius, showHidden, unpinAll, select, hide, pin:{agent,x,y}|{agent,off}}. */
function swarmViewOp(req = {}) {
  const patch = {};
  if (req.mode != null) {
    if (!fairyControl.MODES.includes(req.mode)) return { ok: false, error: `mode is one of ${fairyControl.MODES.join(", ")}` };
    patch.mode = req.mode;
  }
  if (req.kind != null) {
    if (!fairyControl.KIND_FILTERS.includes(req.kind)) return { ok: false, error: `kind is one of ${fairyControl.KIND_FILTERS.join(", ")}` };
    patch.kind = req.kind;
  }
  if (req.radius != null) patch.radius = req.radius;
  if (req.avoid != null) patch.avoid = req.avoid === true;
  if (req.showHidden === true) patch.hidden = [];
  if (req.unpinAll === true) patch.pins = {};
  if (Object.keys(patch).length) setView(patch);
  if (req.select != null) selectAgent(req.select);
  if (req.pin && req.pin.agent) {
    if (req.pin.off) pinAgent(req.pin.agent, null);
    else if (Number.isFinite(Number(req.pin.x)) && Number.isFinite(Number(req.pin.y))) pinAgent(req.pin.agent, { x: Number(req.pin.x), y: Number(req.pin.y) });
    else return { ok: false, error: "pin needs x and y (or off: true)" };
  }
  if (req.hide) setView({ hidden: [...new Set([...state.swarmView.hidden, String(req.hide).toLowerCase()])] });
  let scale = 1;
  try { scale = electron().screen.getDisplayNearestPoint(clusterCenter()).scaleFactor || 1; } catch { /* no screen module (tests) */ }
  const { visible } = viewCompanions();
  return {
    ok: true, view: state.swarmView, ...swarmViewPayload(), pins: Object.keys(state.swarmView.pins), bounds: lastBounds, scale,
    fg: fgContent, mates: visible.map((c) => ({ agent: c.agent, label: c.label, group: c.group, state: c.state, count: c.count })),
    pinBounds: Object.fromEntries([...pinWindows].filter(([, w]) => alive(w) && w.isVisible()).map(([a, w]) => [a, w.getBounds()])),
  };
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
  // A flight can start while the page is still loading (the veil is created on the
  // first tool call): the payload sent into the void is re-sent once it is awake.
  veilWindow.webContents.on("did-finish-load", () => { lastVeilKey = ""; try { drawVeil(); } catch { /* gone */ } });
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
  const tether = attach && !attach.minimised && !ringOpen
    ? (() => {
      const anchor = spiritCore.anchorFor(attach);
      // A stale attach can point off every display, or far across the desk; its
      // dashed tether then crosses unrelated windows (owner screenshots 2026-11-23).
      // Only a SHORT, on-screen link to the dock beside the fairy is drawn.
      if (!anchor || !spiritCore.containsPoint(displayUnion(), anchor, 40)) return null;
      const orb = orbCenter();
      if (Math.hypot(anchor.x - orb.x, anchor.y - orb.y) > TETHER_MAX_PX) return null;
      return [local(anchor), local(orb)];
    })()
    : null;
  return {
    width: b.width,
    height: b.height,
    tint: tint.css,
    trail: trail.map(local),
    tether,
    // The sub-fairies out doing an agent's work: the page eases each leg itself
    // from these timestamps (one payload per change, never one per frame).
    flights: toolFlightLegs().map((f) => {
      const fairy = agentFairy.crewFairy(f.agent);
      return {
        id: f.id,
        agent: f.agent,
        label: f.label,
        tool: f.tool,
        surface: f.surface,
        mode: f.mode,
        state: f.state,
        color: fairy.color,
        core: fairy.core,
        from: local(f.from),
        to: local(f.to),
        startedAt: f.startedAt,
        durationMs: f.durationMs,
      };
    }),
  };
}

/** A cheap content key: identical frames are never re-sent to the renderer. */
function veilKey(payload) {
  if (!payload) return "";
  const points = (list) => (Array.isArray(list) ? list.map((p) => `${p.x},${p.y}`).join(";") : "");
  const flights = Array.isArray(payload.flights)
    ? payload.flights.map((f) => `${f.id}|${f.state}|${f.startedAt}|${points([f.from, f.to])}`).join(";")
    : "";
  return `${payload.width}x${payload.height}|${payload.tint}|${points(payload.trail)}|${points(payload.tether)}|${flights}`;
}

// ── tool flights: the fairy GOES DO the work (fairy-flight.cjs) ────────────────
// The desk learns a running tool from the harness daemon's session row
// ("running Bash" -> fairy-cluster.cjs carries tool + surface). Here we find the
// window each surface lives in, ask the pure planner for the legs, and hand the
// veil page ONE payload per change — the page animates the legs itself, so a fleet
// of sub-fairies costs no IPC per frame.

/** Which desk window each surface lives in, in screen DIPs. null = not open. */
function surfaceRects() {
  const out = { files: null, library: null, browser: null, terminal: null };
  const { BrowserWindow } = electron();
  const own = ownWindowIds();
  let wins;
  try { wins = BrowserWindow.getAllWindows(); } catch { wins = []; }
  for (const w of wins) {
    if (!alive(w) || own.has(w.id) || !w.isVisible()) continue;
    try { if (w.isMinimized && w.isMinimized()) continue; } catch { /* no such verb */ }
    let title = "";
    let url = "";
    try { title = String(w.getTitle() || ""); } catch { /* mid-teardown */ }
    try { url = String(w.webContents && w.webContents.getURL ? w.webContents.getURL() : ""); } catch { /* mid-teardown */ }
    const hay = `${title} ${url}`;
    const bounds = (() => { try { return w.getBounds(); } catch { return null; } })();
    if (!bounds) continue;
    if (/files\.html|aither files|file explorer|disk explorer/i.test(hay)) out.files = out.files || bounds;
    else if (/sessions\.html|aither sessions/i.test(hay)) out.terminal = out.terminal || bounds;
    else if (/library|knowledge/i.test(title)) out.library = out.library || bounds;
    else if (/aither browser|browser-chrome\.html/i.test(hay)) out.browser = out.browser || bounds;
  }
  // The Library app lives in the Files window; the terminal lives in the browser's
  // dock. Both are places the work is actually visible, never an invented target.
  if (!out.library) out.library = out.files;
  if (!out.terminal && out.browser) out.terminal = out.browser;
  return out;
}

/** Every companion currently naming a live tool call -> one call per sub-fairy. */
function currentToolCalls() {
  const calls = [];
  for (const c of allCompanions) {
    if (!c || !c.tool || !c.surface || c.surface === "unknown") continue;
    calls.push({
      id: `${c.agent}|${c.sessionId || c.agent}|${c.tool}`,
      agent: c.agent,
      session: c.sessionId || "",
      label: c.label || c.agent,
      tool: c.tool,
      surface: c.surface,
    });
  }
  return calls;
}

function toolFlightLegs() {
  return [...toolFlightPlan.flights, ...toolFlightPlan.returning];
}

/**
 * Re-plan the tool flights. Called on every companion/session update (the daemon's
 * 6 s feed) and once when the last leg lands. Never per frame: the renderer eases
 * the legs from the timestamps in the payload.
 */
function updateToolFlights() {
  const now = Date.now();
  // No fairies on screen (hidden by the owner, or the cluster switched off) = no
  // flight: the work is not shown by a stray glow with no fairy behind it.
  const shown = Boolean(orbVisible() || swarmAnchor) && (state.cluster !== false || state.swarm === true);
  if (!shown) {
    toolFlightPlanner.reset();
    toolFlightPlan = { flights: [], returning: [], hover: [], throttled: [], reducedMotion: state.reducedMotion === true };
  } else {
    toolFlightPlan = toolFlightPlanner.plan(currentToolCalls(), {
      surfaces: surfaceRects(),
      cluster: clusterCenter(),
      nowMs: now,
      maxSubFairies: fairyFlight.MAX_SUB_FAIRIES,
      reducedMotion: state.reducedMotion === true,
    });
  }
  if (toolFlightTimer) { clearTimeout(toolFlightTimer); toolFlightTimer = null; }
  const legs = toolFlightLegs();
  if (legs.length) {
    showVeil();
    drawVeil();
    // Only a RETURN leg has a deadline (it merges and is forgotten). An outbound leg
    // stands at its window while the call runs; the session feed ends it. No timer
    // churn while an agent works.
    const homeward = legs.filter((f) => f.state === "return" && now < f.startedAt + f.durationMs + fairyFlight.MERGE_MS);
    if (homeward.length) {
      const lastEnd = Math.max(...homeward.map((f) => f.startedAt + f.durationMs + fairyFlight.MERGE_MS + 120));
      const wait = Math.max(300, Math.min(60_000, lastEnd - now));
      toolFlightTimer = setTimeout(() => { toolFlightTimer = null; updateToolFlights(); }, wait);
      if (toolFlightTimer.unref) toolFlightTimer.unref();
    }
  } else {
    drawVeil(); // clears the canvas flight list
    if (!attach && !tripBusy && !flight) hideVeil();
  }
  return toolFlightPlan;
}

/** The owner's setting (and the OS preference in the page) decides if fairies fly. */
function setReducedMotion(on) {
  state.reducedMotion = on === true;
  saveState();
  updateToolFlights();
  return { ok: true, reducedMotion: state.reducedMotion };
}

function drawVeil() {
  if (!alive(veilWindow)) return;
  const points = trail.slice();
  if (alive(orbWindow)) points.push(orbCenter());
  if (attach && !attach.minimised && !ringOpen) {
    const anchor = spiritCore.anchorFor(attach);
    const orb = orbCenter();
    if (anchor
      && spiritCore.containsPoint(displayUnion(), anchor, 40)
      && Math.hypot(anchor.x - orb.x, anchor.y - orb.y) <= TETHER_MAX_PX) {
      points.push(anchor);
    }
  }
  for (const f of toolFlightLegs()) points.push(f.from, f.to);
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

function hideVeil({ force = false } = {}) {
  // The accumulated flight trail is never allowed to outlive the flight, even when a
  // sub-fairy keeps the overlay up (the stale polyline the owner saw).
  trail = [];
  lastVeilKey = "";
  // A sub-fairy still out doing work keeps the overlay up; the page animates it.
  if (!force && toolFlightLegs().length) {
    drawVeil();
    return;
  }
  if (alive(veilWindow)) veilWindow.hide();
}

// ── visibility ──────────────────────────────────────────────────────────────

function showOrb({ auto = false } = {}) {
  if (!auto) { autoSurfaced = false; ownerHidIds = null; state.ownerHid = false; state.ownerHidIds = []; }
  // One cluster on this machine, ever (owner 2026-11-13): a second desk process (another
  // profile, a test build) never shows its own fairies while another desk owns them.
  const owner = fairyOwner.claim();
  if (!owner.ok) {
    suppressed = true;
    return { ok: false, visible: false, error: `another Aither desk (pid ${owner.pid}) shows the fairies` };
  }
  const win = ensureOrb();
  const was = state.visible;
  state.visible = true;
  if (!was) saveState();
  // Grown into the avatar: the body IS the fairy right now (one cluster), so the orb
  // stays down until "Back to the fairy" (collapseToFairy). Stood down because the
  // body is up as its own surface: same rule -- one companion, never two. `suppressed`
  // stays true here: pump/syncBubble must not pop the ask panel beside the body.
  if (expanded || stoodDownForAvatar) {
    suppressed = true;
    return { ok: true, visible: true, expanded, body: stoodDownForAvatar };
  }
  suppressed = false;
  if (!win.isVisible()) win.showInactive();
  if (attach) showVeil();
  placeSwarm();
  if (!was) {
    notifyCompanions();
    // Shown while an AitherOS window is up: ride it (one cluster, PR #68).
    if (dockWindowId) {
      try { void setDockWindow(electron().BrowserWindow.fromId(dockWindowId)); } catch { /* window gone */ }
    }
  }
  return { ok: true, visible: true };
}

function hideOrb({ auto = false } = {}) {
  // NOTE: the stand-down flag is NOT cleared here. An automatic hide (a card leaving
  // the auto-surfaced fairy) and an owner hide both happen while the body can still be
  // up; clearing it let the next showOrb float the fairy beside the body again. Only
  // the body leaving (returnFromAvatar) or a grow ending clears it.
  // The owner hid it with cards waiting: those cards do not bring it back, a NEW one does.
  if (!auto) {
    autoSurfaced = false; ownerHidIds = new Set(attentionCards.map((c) => c.id));
    state.ownerHid = true; state.ownerHidIds = [...ownerHidIds];
  }
  releaseHover();
  suppressed = true;
  cardOpen = false;
  clearCardIdle();
  pendingSlot = null;
  if (nudging) endNudge("hidden");
  if (alive(bubbleWindow)) bubbleWindow.hide();
  if (alive(orbWindow)) orbWindow.hide();
  if (alive(swarmWindow)) swarmWindow.hide();
  hideMenu();
  hideTip();
  hideVeil();
  sendPanel();
  const was = state.visible;
  state.visible = false;
  // The tool flights have no fairy to come from any more: take their overlay down
  // now, not on the next session tick (a frozen sub-fairy must not outlive the fairy).
  try { updateToolFlights(); } catch { /* cosmetic */ }
  if (was || !auto) {   // an owner hide is saved even when it was already hidden (its card ids changed)
    saveState();
    notifyCompanions();
  }
  syncForegroundProbe(); // no orb on screen: no probe to keep it off (or following) anything
  fairyOwner.release(); // hidden: another desk may show the one cluster
  return { ok: true, visible: false };
}

function toggleOrb() {
  return state.visible && alive(orbWindow) && orbWindow.isVisible()
    ? hideOrb()
    : showOrb();
}

/** The bubble is up while the owner has it OPEN (owner 2026-11-22: losing focus or
 *  moving the pointer away must not close it), or while a line/trip/hold needs it.
 *  A bubble the owner dismissed stays closed until something NEW arrives. */
function bubbleWanted() {
  if (suppressed || stoodDownForAvatar || !state.visible) return false;
  return cardOpen || Boolean(queue.cur) || queue.items.length > 0 || inflight || drafting
    || regionWait || Boolean(hold) || Boolean(results) || tripBusy;
}

function clearCardIdle() {
  if (cardIdleTimer) {
    clearTimeout(cardIdleTimer);
    cardIdleTimer = null;
  }
}

/** Re-arm the card's opt-in idle timeout (card-stay.cjs). A pinned card never arms;
 *  the default mode arms nothing at all. */
function armCardIdle() {
  clearCardIdle();
  if (!cardOpen || !alive(bubbleWindow) || !bubbleWindow.isVisible()) return;
  const { closeAfterMs } = cardStay.decide(state.card);
  if (closeAfterMs == null) return;
  cardIdleTimer = setTimeout(() => {
    cardIdleTimer = null;
    if (cardOpen && alive(bubbleWindow) && bubbleWindow.isVisible()) closeBubble();
  }, Math.max(0, closeAfterMs));
  if (cardIdleTimer.unref) cardIdleTimer.unref();
}

/** Activity inside the card (typing, pointer, wheel): restart the idle countdown. */
function touchCard() {
  if (cardOpen) armCardIdle();
}

function syncBubble() {
  if (!alive(bubbleWindow)) return;
  const wanted = bubbleWanted();
  if (wanted && !bubbleWindow.isVisible()) {
    placeBubble();
    bubbleWindow.showInactive();
    send("orb:line", queue.cur);
    armCardIdle();
  } else if (!wanted && bubbleWindow.isVisible()) {
    bubbleWindow.hide();
    drafting = false;
    cardOpen = false;
    clearCardIdle();
  }
  sendPanel();
  syncPanelPoll();
}

function openBubble({ focus = false } = {}) {
  showOrb();
  // ONE surface (owner 2026-11-20): while the body is up it carries the cards, so no
  // floating ask panel may pop where the fairy used to rest. (showOrb already refuses
  // to raise the orb; without this guard openBubble raised the bubble anyway.)
  if (expanded || stoodDownForAvatar) {
    sendPanel();
    return { ok: true, suppressed: true };
  }
  // Opening the card is the owner's "something new": it is no longer suppressed.
  suppressed = false;
  cardOpen = true;
  const win = ensureBubble();
  placeBubble();
  if (!win.isVisible()) win.showInactive();
  send("orb:line", queue.cur);
  armCardIdle();
  if (focus) {
    win.focus();
    try { win.webContents.send("orb:focus"); } catch { /* page loading: focuses on load */ }
  }
  sendPanel();
  syncPanelPoll();
  sendPanelView();
}

function closeBubble() {
  suppressed = true;
  cardOpen = false;
  clearCardIdle();
  bubbleMode = null;
  cardChat = null;
  pendingSlot = null;
  drafting = false;
  // Dismissing the card also dismisses what it was showing: a reopen starts clean
  // instead of resurrecting results the owner put away (owner 2026-11-22).
  resultStream = [];
  if (results) {
    results = null;
    send("orb:results", null);
  }
  if (alive(bubbleWindow)) bubbleWindow.hide();
  sendPanel();
  syncPanelPoll();
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
  sendBadge();
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
      if (!name.startsWith("aither-orb-") || !/\.(png|jpg)$/.test(name)) continue;
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

/** A rect of the screen (physical pixels) as a JPEG for the vision ladder.
 *
 *  MEASURED 2026-11-23: this used to write a full 4K PNG, and `imageDataUrl`
 *  then decoded that PNG, downscaled and re-encoded it as JPEG -- an encode
 *  (~940 ms measured for 4K PNG on this box), a temp-file round trip and a
 *  decode for pixels the model never saw. The capture is now downscaled and
 *  JPEG-encoded ONCE here, at the same 1024 long edge the model is sent, so the
 *  data-URI path re-encodes nothing. One file still lands in %TEMP% because the
 *  gateway/direct doors upload a path. */
const CAPTURE_MAX_EDGE = 1024;
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
  let jpg;
  let ext = "jpg";
  try {
    let img = image;
    const size = typeof image.getSize === "function" ? image.getSize() : null;
    if (size && Math.max(size.width, size.height) > CAPTURE_MAX_EDGE) {
      const scale = CAPTURE_MAX_EDGE / Math.max(size.width, size.height);
      img = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "good",
      });
    }
    jpg = img.toJPEG(82);
  } catch { jpg = null; }
  if (!jpg && typeof image.toPNG === "function") {
    // An image object without a JPEG encoder (a test double, or an old Electron):
    // fall back to PNG rather than calling the capture a failure.
    try { jpg = image.toPNG(); ext = "png"; } catch { jpg = null; }
  }
  // An undecodable nativeImage yields an empty buffer; that is a failed capture,
  // not an image the vision ladder should be asked about.
  if (!jpg || !jpg.length) return null;
  const out = path.join(os.tmpdir(), `aither-orb-${process.pid}-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(out, jpg);
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
  // The trail WAS the flight. Clear it on EVERY landing, before deciding whether the
  // veil stays: hideVeil() returns early while a sub-fairy is still out, which left a
  // stale polyline with visible joints crossing the desktop (owner screenshots
  // 2026-11-23). The tether alone keeps a docked attach legible.
  trail = [];
  if (!attach && !tripBusy && toolFlightLegs().length === 0) {
    hideVeil();
  } else {
    drawVeil();
  }
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
  const area = fairyArea(displayForOrb().workArea);
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

/** Start the resident window probe now, so a hotkey's first question is cheap. */
function warmProbe() {
  if (!probe) probe = spiritProbe.createWindowProbe();
  try { void probe.ping(); } catch { /* fail-soft: the probe answers null */ }
  return Boolean(probe);
}

/**
 * Is Alt/Space still physically down? The Alt+Space HOLD decides from this instead
 * of showing a focus-taking window on every press (owner 2026-11-23: the ring made
 * the whole PC stutter). null = the probe cannot answer; the caller falls back.
 */
async function keyState() {
  if (!probe) probe = spiritProbe.createWindowProbe();
  try {
    return await probe.keyDown();
  } catch {
    return null;
  }
}

// ── the ONE ring (owner 2026-11-23) ─────────────────────────────────────────
// Hold Alt+Space: the fairy FLIES to the centre of the display under the cursor and
// the ring expands around it. Release on a slice runs it; release in the centre (or
// Esc / click-away) cancels; either way the fairy flies back to its dock or home.
// The same ring opens on a right-click on the empty desktop (desktop-right.cjs),
// anchored at the click point. `ringOpen` freezes follow/orbit/hover while it is up.

/** main injects the ring window API (openRadial + releaseSelection) and the handler
 *  for the ring's own ids. */
function setRingOpener(api) {
  ringOpener = api && (typeof api === "function" || typeof api.openRadial === "function") ? api : null;
  return Boolean(ringOpener);
}
function setExtraRunner(fn) {
  extraRunner = typeof fn === "function" ? fn : null;
  return Boolean(extraRunner);
}

/** The display under a point: its work area and its centre (screen DIPs). */
function displayAt(point) {
  const { screen } = electron();
  let display;
  try { display = screen.getDisplayNearestPoint(point); } catch { display = screen.getPrimaryDisplay(); }
  const area = (display && display.workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
  return { area, centre: { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) } };
}

/** Snapshot what to fly back to: the attach (if any) else the resting spot. */
function ringHome() {
  return {
    attach: attach && !attach.auto ? { ...attach } : null,
    auto: Boolean(attach && attach.auto),
    x: state.x,
    y: state.y,
  };
}

function restoreAfterRing(back) {
  // A dock (hand or the AitherOS auto-dock) is restored by re-filing to the target;
  // the follow tick then corrects any move the window made while the ring was up.
  if (attach && spiritCore.normBounds(attach.bounds)) {
    void attachTo({ ...attach }, { quiet: true });
    return;
  }
  if (back && back.x != null && back.y != null) {
    state.x = back.x;
    state.y = back.y;
    saveState();
  }
  void flyHome(420);
}

/**
 * Fly to `at` (default: the centre of the display under the cursor) and open the ONE
 * ring around the fairy. `hold` = the Alt+Space hold (release selects). Resolves once
 * the ring is on screen; the returned promise never rejects.
 */
async function openRing({ at = null, hold = false, onDone = null, page = 0, fly = true, pages = null } = {}) {
  const api = ringOpener;
  const openFn = typeof api === "function" ? api
    : (api && typeof api.openRadial === "function" ? (o) => api.openRadial(o) : null);
  if (!openFn) return { ok: false, reason: "no ring renderer is wired" };
  if (ringOpen) {
    // A leaked session (a close path that skipped onDone) must never wedge the ring.
    const visible = api && typeof api.isVisible === "function" ? api.isVisible() : false;
    if (visible) {
      // Pressing the key again closes it (and the fairy goes back).
      if (typeof api.hide === "function") api.hide();
      return { ok: true, closed: true };
    }
    ringOpen = false;
    ringReturn = null;
  }
  let point = at && Number.isFinite(Number(at.x)) && Number.isFinite(Number(at.y))
    ? { x: Number(at.x), y: Number(at.y) } : null;
  if (!point) {
    try { point = electron().screen.getCursorScreenPoint(); } catch { point = null; }
  }
  if (!point) return { ok: false, reason: "no cursor" };
  const { centre } = displayAt(point);
  // Settings "Ring opens at": the CENTRE of the screen under the cursor (default,
  // the owner's design, for the hold and the desktop right-click alike) or exactly
  // where the owner clicked / the cursor when the key went down. `fly:false` (the
  // fairy's OWN right-click) opens the ring where the fairy already is.
  const destination = !fly ? point : (ringAtMode() === "click" ? point : centre);
  ringReturn = { ...ringHome(), moved: Boolean(fly) };
  ringOpen = true;
  clearDropReturn();
  // No tether/trail while the fairy is at the ring anchor (it would draw a long line
  // across the desk); the ring is the only thing the owner should see.
  hideVeil({ force: true });
  if (flight) { flight.cancelled = true; finishFlight(); }
  try {
    if (fly) await flyTo({ x: destination.x, y: destination.y }, { durationMs: 420 });
    const opened = openFn({
      at: destination,
      hold: Boolean(hold),
      page,
      ...(Array.isArray(pages) && pages.length ? { pages } : {}),
      onDone: (result) => {
        ringOpen = false;
        const back = ringReturn;
        ringReturn = null;
        if (back && back.moved) restoreAfterRing(back);
        if (typeof onDone === "function") { try { onDone(result); } catch { /* caller */ } }
      },
    });
    // A hold released DURING the fly-out cannot reach the ring's keyup listener. Read
    // the physical keys once it is up; if they are already up, treat it as a release
    // (the cursor direction picks, or the centre cancels).
    if (hold && opened && opened.ok !== false && api && typeof api.releaseSelection === "function") {
      Promise.resolve().then(() => keyState()).then((k) => {
        if (ringOpen && k && !k.space && !k.alt) api.releaseSelection();
      }).catch(() => { /* the ring waits for Esc / click-away */ });
    }
    if (!opened || opened.ok === false) {
      ringOpen = false;
      const back = ringReturn;
      ringReturn = null;
      if (back && back.moved) restoreAfterRing(back);
      return opened || { ok: false, reason: "the ring did not open" };
    }
    return opened;
  } catch (error) {
    ringOpen = false;
    const back = ringReturn;
    ringReturn = null;
    if (back && back.moved) restoreAfterRing(back);
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** The ring's own ids (the dock answers, Windows' menu), run from the ring. */
function runRingExtra(id) {
  const what = String(id || "");
  if (what === "orb.drop.pin") return setDropBehavior("orb", { mode: "pin" });
  if (what === "orb.drop.timed") return setDropBehavior("orb", { mode: "timed", seconds: 10 });
  if (what === "orb.drop.return") return setDropBehavior("orb", { mode: "return" });
  // ── "This fairy": everything the old orb right-click menu did, as ring slices ──
  if (what.startsWith("ring:card:")) return openFairyCard(what.slice("ring:card:".length));
  if (what.startsWith("ring:body:")) return pickBody(what.slice("ring:body:".length));
  switch (what) {
    case "ring:queue": if (nudging) endNudge("seen", { stay: true }); openQueue(); return { ok: true };
    case "ring:show-hide": return state.visible ? hideOrb() : showOrb();
    case "ring:expand": return expandToAvatar();
    case "ring:collapse": return collapseToFairy();
    case "ring:drop:pin": return setDropBehavior("orb", { mode: "pin" });
    case "ring:drop:timed": return setDropBehavior("orb", { mode: "timed", seconds: 10 });
    case "ring:drop:return": return setDropBehavior("orb", { mode: "return" });
    case "ring:swarm": return swarmViewMenu({ at: cursorPoint() });
    case "ring:quiet:1h": return companionAction("quiet-1h", { target: "fairy" });
    case "ring:quiet:4h": return companionAction("quiet-4h", { target: "fairy" });
    case "ring:quiet:off": return companionAction("quiet-off", { target: "fairy" });
    case "ring:hide-this": return companionAction("hide-this", { target: "fairy" });
    case "ring:hide-all": return companionAction("hide-all", { target: "fairy" });
    case "ring:show-all": return companionAction("show-all", { target: "fairy" });
    case "ring:sounds": return setSounds(state.sounds === false);
    case "ring:flights": return setReducedMotion(state.reducedMotion !== true);
    case "ring:web": return openMode("web");
    case "ring:ask": return openMode(null);
    case "ring:find": return openMode("find");
    case "ring:read": return runHoldAction("read");
    case "ring:attach": return toggleAttach();
    case "ring:home": return sendHome();
    case "ring:sprite": return spriteStatus();
    case "ring:teach": return spriteTeach(null);
    case "ring:sprite-page": return openUrl(spriteCore.SPRITE_PAGE);
    case "ring:quick": return runCommandImpl ? runCommandImpl("quick.open") : { ok: false, error: "no command door" };
    case "ring:desktop": return companionAction("open-desktop", { target: "fairy" });
    case "ring:spaces": return companionAction("open-spaces", { target: "fairy" });
    case "ring:chat": return companionAction("open-chat", { target: "fairy" });
    case "ring:settings": return companionAction("settings", { target: "fairy" });
    case "ring:quit": return companionAction("quit", { target: "fairy" });
    default: break;
  }
  if (typeof extraRunner === "function") return extraRunner(what);
  return { ok: false, error: `unknown ring row ${what}` };
}

/**
 * The fairy's OWN ring pages (right-click on the fairy). Nothing the old orb menu did
 * is missing: the cards become one slice each, and every control is a slice.
 * Guarded to <= 11 slices a page (the 142 px radius fits 11 x 74 px circles).
 */
function selfRingPages() {
  const cards = Array.isArray(attentionCards) ? attentionCards : [];
  const cardSpec = cards.slice(0, 6).map((c, i) => ({
    id: `ring:card:${c.id}`,
    short: `Card ${i + 1}`,
    label: String((c && c.title) || "a card").replace(/^Claude Code needs you:\s*/i, ""),
    extra: true,
  }));
  const bodies = (hookValue("aitherBodies") || []).slice(0, 2);
  const quietOn = Number(state.muteUntil) > Date.now();
  const visible = state.visible === true;
  const anyHidden = !visible || !state.tenantCompanion;
  const page = (id, label, spec) => ({ id, label, spec });
  return [
    page("tools", "Tools", RADIAL_SPEC_FOR_SELF()),
    page("self", "This fairy", [
      ...cardSpec,
      ...(cards.length ? [{ id: "ring:queue", short: "Answer window", extra: true }] : []),
      { id: "ring:show-hide", short: visible ? "Hide fairies" : "Show fairies", extra: true },
    ]),
    page("controls", "Controls", [
      ...(avatarMode() === "fairy" ? [{ id: "ring:expand", short: "Show Aither", extra: true }] : []),
      ...(avatarMode() === "expanded" ? [{ id: "ring:collapse", short: "Back to fairy", extra: true }] : []),
      ...bodies.map((b) => ({ id: `ring:body:${b.id}`, short: b.label, extra: true })),
      { id: "display.mode.fairy", short: "Fairy" },
      { id: "display.mode.avatar", short: "Avatar" },
      { id: "display.mode.both", short: "Both" },
      { id: "display.mode.swarm", short: "Swarm" },
      { id: "inbox.open", short: "Inbox" },
    ]),
    page("companion", "Companion", [
      ...(visible ? [{ id: "ring:hide-this", short: "Hide fairies", extra: true }] : []),
      ...(visible || state.tenantCompanion ? [{ id: "ring:hide-all", short: "Hide all", extra: true }] : []),
      ...(anyHidden ? [{ id: "ring:show-all", short: "Show all", extra: true }] : []),
      quietOn
        ? { id: "ring:quiet:off", short: "End quiet", extra: true }
        : { id: "ring:quiet:1h", short: "Quiet 1h", extra: true },
      ...(quietOn ? [] : [{ id: "ring:quiet:4h", short: "Quiet 4h", extra: true }]),
      { id: "ring:swarm", short: "Swarm layout", extra: true },
      { id: "ring:sounds", short: state.sounds === false ? "Sounds on" : "Sounds off", extra: true },
      { id: "ring:flights", short: state.reducedMotion === true ? "Flights on" : "Flights off", extra: true },
    ]),
    page("setup", "Fairy setup", [
      { id: "ring:drop:pin", short: "Pin drop", extra: true },
      { id: "ring:drop:timed", short: "Stay drop", extra: true },
      { id: "ring:drop:return", short: "Home drop", extra: true },
      { id: "ring:web", short: "Search web", extra: true },
      { id: "ring:ask", short: "Ask", extra: true },
      { id: "ring:find", short: "Find file", extra: true },
      ...(hold ? [{ id: "ring:read", short: "Read held", extra: true }] : []),
    ]),
    page("desk", "Desk", [
      { id: "ring:attach", short: attach ? "Let go" : "Stay on window", extra: true },
      { id: "ring:home", short: "Home", extra: true },
      { id: "ring:sprite", short: "My sprite", extra: true },
      { id: "ring:teach", short: "Teach it", extra: true },
      { id: "ring:sprite-page", short: "Sprite page", extra: true },
      { id: "ring:desktop", short: "Open desktop", extra: true },
      { id: "ring:spaces", short: "Spaces", extra: true },
    ]),
    page("desk2", "Desk 2", [
      { id: "ring:chat", short: "Chat", extra: true },
      { id: "console.open", short: "Open Aither" },
      { id: "browser.open", short: "Browser" },
      { id: "avatar.toggle", short: "Show avatar" },
      { id: "ring:settings", short: "Settings", extra: true },
      { id: "ring:quit", short: "Quit Aither", extra: true },
    ]),
  ];
}

/** The tool page's spec (the same ten the general ring leads with). */
function RADIAL_SPEC_FOR_SELF() {
  return [
    { id: "snip.region", short: "Snip" },
    { id: "record.region", short: "Record" },
    { id: "ink.toggle", short: "Draw" },
    { id: "note.new", short: "Note" },
    { id: "board.new", short: "Board" },
    { id: "orb.ask-screen", fallback: "chat.open", short: "Ask" },
    { id: "desktop.overlay.toggle", short: "Overlay" },
    { id: "terminal.open", short: "Terminal" },
    { id: "files.open", short: "Files" },
    { id: "audio.settings", short: "Audio" },
  ];
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
  if (!attach || flight || tripBusy || nudging || ringOpen) return;
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
    attach.title = now.title || attach.title;
    // A minimised window: the fairy waits with it (hidden) and comes back when the
    // window is restored. A closed window resolves as null above and flies home.
    if (now.minimised || fairyDrop.windowState(now.bounds, { visible: now.visible }) === "minimised") {
      if (!attach.minimised) {
        attach.minimised = true;
        if (alive(orbWindow) && orbWindow.isVisible()) {
          try { orbWindow.hide(); } catch { /* gone */ }
        }
        hideVeil();
      }
      return;
    }
    if (attach.minimised) {
      attach.minimised = false;
      if (state.visible && alive(orbWindow) && !orbWindow.isVisible()) {
        try { orbWindow.showInactive(); } catch { /* gone */ }
      }
    }
    bounds = now.bounds;
  } else if (attach.kind === "desk" && attach.windowId) {
    const { BrowserWindow } = electron();
    const win = BrowserWindow.fromId(attach.windowId);
    if (!alive(win)) {
      detach({ reason: attach.auto ? null : "that window closed" });
      return;
    }
    if (attach.auto && (!win.isVisible() || win.isMinimized())) {
      void setDockWindow(null);
      return;
    }
    bounds = win.getBounds();
    void refreshObstacles(win); // the next tick docks on what this finds
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
  const dock = dockSpot(attach);
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
    if (!attach || attach.kind !== "avatar" || flight || tripBusy || dragging || nudging || ringOpen) return;
    const p = spiritCore.orbitPoint(attach.bounds, Date.now());
    if (!p) return;
    setOrbCenter(p);
    if (p.front !== lastFront) { lastFront = p.front; send("orb:depth", { front: p.front }); }
  }, ORBIT_MS);
  if (orbitTimer.unref) orbitTimer.unref();
}

/** A free spirit (not set free by the owner) finds an avatar and starts orbiting it. */
async function seekAvatar() {
  // A hand-placed fairy is not seeking a body: it stays where the owner put it.
  if (attach || flight || tripBusy || dragging || nudging || state.freeRoam || manualPlacement || resolvingDrop || ringOpen || !orbVisible()) return;
  const body = (await attachableTargets()).find((t) => t && t.kind === "avatar");
  if (body) await attachTo(body, { quiet: true });
}

/** Free and idle: hover around the remembered spot (state.x/y is the window's top-left). */
let hoverTimer = null;
function startHover() {
  if (hoverTimer) return;
  hoverTimer = setInterval(() => {
    if (attach || flight || tripBusy || dragging || nudging || resolvingDrop || ringOpen || !orbVisible()) return;
    if (state.x == null || state.y == null) return;
    const d = spiritCore.hoverOffset(Date.now());
    // The hover circles the RESTING spot: the saved one, kept inside the area the
    // fairy may use right now (restSpot), so it never drifts back onto a reserved box.
    const rest = restSpot();
    setOrbCenter({ x: rest.x + ORB_SIZE.width / 2 + d.x, y: rest.y + ORB_SIZE.height / 2 + d.y });
  }, ORBIT_MS);
  if (hoverTimer.unref) hoverTimer.unref();
}

function startSeek() {
  if (seekTimer) clearInterval(seekTimer);
  seekTimer = setInterval(() => { void seekAvatar(); }, ORBIT_SEEK_MS);
  if (seekTimer.unref) seekTimer.unref();
}

async function attachTo(target, { quiet = false, dropPoint = null } = {}) {
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
  // An explicit attach replaces a pending "stay N seconds" return.
  clearDropReturn();
  if (!attach && !home) home = orbCenter();
  const next = { ...target, bounds: spiritCore.normBounds(target.bounds) };
  // A hand drop remembers which corner it chose (fixed for the life of the attach)
  // and where the pointer was, so the first dock is the nearest corner -- not the
  // top-right the fairy would otherwise fly across the window to reach.
  if (dropPoint && next.kind !== "avatar") {
    next.corner = fairyDrop.nearestCorner(next.bounds, dropPoint);
    next.dropPoint = { x: Math.round(Number(dropPoint.x) || 0), y: Math.round(Number(dropPoint.y) || 0) };
  }
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
    const dock = dockSpot(attach);
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

/** The last detach's flight home, settled once the veil is down (tests await it). */
let homeFlight = Promise.resolve();
function detach({ silent = false, reason = null } = {}) {
  if (!attach) return { ok: true, attached: false };
  stopFollow();
  stopOrbit();
  const was = attach;
  attach = null;
  // A window that minimised hid the fairy; when it closes the fairy comes back
  // home, so it must be visible for the flight.
  if (state.visible && alive(orbWindow) && !orbWindow.isVisible()) {
    try { orbWindow.showInactive(); } catch { /* gone */ }
  }
  tint = restTint();
  sendTint();
  if (reason) pushStatus(reason, 6000, 6000);
  if (!silent) {
    const back = home || orbCenter();
    homeFlight = flyTo(back, { durationMs: 480 }).then(() => { if (!attach) hideVeil(); });
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
  sendPanelView();
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

/**
 * New results while the card is open APPEND to what it already shows; dismissing the
 * card is the only thing that clears the list (owner 2026-11-22: "new results stream
 * into the open card instead of replacing or closing it"). Rows are de-duplicated by
 * url/target/title, newest last, capped so a long session cannot grow without bound.
 */
function publishResults(next) {
  if (!next) {
    results = null;
    resultStream = [];
    sendResults();
    return null;
  }
  const keyOf = (row) => String((row && (row.url || row.target || row.path || row.title)) || "");
  if (cardOpen && alive(bubbleWindow) && bubbleWindow.isVisible()) {
    const seen = new Set(resultStream.map(keyOf).filter(Boolean));
    for (const row of next.rows || []) {
      const key = keyOf(row);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      resultStream.push(row);
    }
    resultStream = resultStream.slice(-60);
  } else {
    resultStream = (next.rows || []).slice(0, 60);
  }
  results = {
    ...next,
    rows: resultStream.slice(),
    total: Math.max(Number(next.total) || 0, resultStream.length),
  };
  sendResults();
  touchCard();
  return results;
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
      let limit = null;
      try {
        // A trip that never settles (a vision or file call that hangs) held tripBusy
        // for good, and every later trip and click queued behind it (2026-11-10).
        outcome = await Promise.race([
          executeTrip(trip),
          new Promise((resolve) => {
            limit = setTimeout(() => resolve({ ok: false, timedOut: true, reason: "the trip took too long" }), TRIP_LIMIT_MS);
            if (limit.unref) limit.unref();
          }),
        ]);
      } catch (error) {
        outcome = { ok: false, reason: String((error && error.message) || error) };
      }
      if (limit) clearTimeout(limit);
      spiritCore.finish(tripQueue, trip.id);
      if (outcome && outcome.timedOut) {
        // The hung step may still settle later: isCurrentTrip() is false by then, so it
        // returns quietly. The spirit stops wherever it is and goes home now.
        if (flight) { flight.cancelled = true; finishFlight(); }
        void flyHome(520);
      }
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
  // An agent that sent the spirit lends it its fairy colour and name for the trip
  // (agent-fairies.json); otherwise the body's own slot tint, as before.
  const lent = spiritCore.tripTint(trip);
  if (trip.slotId || lent.agent) {
    tint = lent;
    sendTint();
  }
  if (lent.agent) setSpeaker(lent.agent, caption);
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
    publishResults({ mode: "folder", query: trip.target, rows: r.rows, more: r.more, total: r.total });
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
    publishResults({ mode: "web", query: trip.target, rows: r.rows, more: r.more, total: r.total, answer: r.answer || null });
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
    publishResults({ mode: "find", query: trip.target, rows: [], more: 0, total: 0 });
    openBubble({ focus: false });
    bubbleMode = null;
    send("orb:mode", { mode: null });
    const line = `I could not find anything for ${spiritCore.quote(trip.target)}.`;
    answer(line, { via: "file" });
    speakAnswer(line, trip.slotId, { onlyIfAttached: true });
    return { ok: true, answer: line, rows: [], more: 0, total: 0 };
  }
  publishResults({ mode: "find", query: trip.target, rows: r.rows, more: r.more, total: r.total });
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
    // `id` is the menu ROW key (what desk:menu-pick looks the row up by); the command
    // that runs is the closed-over registry id below, never this prefixed key.
    id: `door:${id}`,
    label: id === "inbox.open" ? (attentionCards.length ? `Needs you (${attentionCards.length})` : "Inbox") : label,
    click: () => { void runCommandImpl?.(id); },
  }));
}

/** Needs-you, carried on the fairy instead of the red chip: main calls this. */
let attention = { count: 0, line: null };
function setAttention(count, line = null) {
  attention = { count: Math.max(0, Number(count) || 0), line: line ? String(line).slice(0, 160) : null };
  sendBadge();
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
/** When the fairy last said "M older cards are on the list" (once a day at most). */
let attentionOlderAt = 0;
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
    attentionOlderAt = Number(raw && raw.olderMentionedAt) || 0;
  } catch {
    attentionMems = {}; // unreadable memory = every card starts at the bottom of the ladder
  }
}

function saveAttention() {
  try {
    const file = attentionFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cards: attentionMems, lastNudgeAt: attentionLastAt, lastVoiceAt: attentionVoiceAt, olderMentionedAt: attentionOlderAt }));
    fs.renameSync(tmp, file);
  } catch { /* per-viewer convenience: losing it restarts the ladder, nothing more */ }
}

/**
 * Every number the fairy shows, from one function (fairy-counts.cjs): the badge is the
 * queue's count, "N more waiting" is that minus the card shown, a companion's badge is
 * its agent's share. Owner 2026-11-12: four different numbers were on screen at once.
 */
let attentionOpen = null;
function currentCounts() {
  let worn = "";
  try { worn = agentFairy.crewKey(currentFairy().agent) || ""; } catch { /* no look yet */ }
  return fairyCounts.fairyCounts({
    decisions: attentionCards,
    open: attentionOpen,
    agentOf: agentFairy.cardAgent,
    worn,
    blockers: attention.count,
    unread: orbCore.unreadCount(queue),
  });
}

/** The orb badge: the cards that need the owner. With none, the answers left to read.
 *  `label` is the ONE visible count's name (owner 2026-11-22: "each number must say
 *  what it counts"); every other number is behind the hover/ring, never a raw badge. */
function badgeView(counts = currentCounts()) {
  if (counts.needYou > 0) return { n: counts.badge, label: "waiting", title: fairyCounts.badgeTitle(counts) };
  return {
    n: counts.unread,
    label: counts.unread ? "unread" : "",
    title: counts.unread ? `${counts.unread} answer${counts.unread === 1 ? "" : "s"} to read` : "",
  };
}

function sendBadge() {
  send("orb:badge", badgeView());
}

/** main hands over the ranked decision queue (decisions only, no reports) on every
 *  change, and every open card beside it so reports can be named, never guessed. */
function setAttentionCards(cards, allOpen = null) {
  attentionCards = Array.isArray(cards) ? cards.filter((c) => c && typeof c.id === "string") : [];
  attentionOpen = Array.isArray(allOpen) ? allOpen : null;
  const ids = new Set(attentionCards.map((c) => c.id));
  const before = Object.keys(attentionMems).length;
  attentionMems = fairyAttention.pruneMems(attentionMems, ids);
  if (Object.keys(attentionMems).length !== before) saveAttention();
  // Answered somewhere else (the Inbox, Discord, the phone): the whisper goes.
  if (nudging && !ids.has(nudging.decision.card.id)) endNudge("answered");
  surfaceForCards();
  sendFairy();
  sendBadge();
  sendPanelView();
  ensureAttention();
  ensureClusterClock();
  scheduleAttentionTick(1500); // a NEW card is judged now, not on the next 15 s tick
  return { ok: true, count: attentionCards.length };
}

// ── the agent fairy: whose colours the fairy wears (agent-fairy.cjs) ────────
//
// Owner, 2026-11-09: the desk fairy takes on the colour of whoever is talking or
// whose card it carries; when several agents have cards waiting, small companion
// fairies (one per agent, at most four) orbit it, and hovering one shows that
// agent's card. The owner's idle fairy stays Aither white-gold.

/** {agent, until} -- the agent whose line is being spoken, for about that long. */
let fairySpeaker = null;
let fairySpeakerTimer = null;
let lastFairyKey = "";
let lastCompanionsKey = "";

/** The fairy to wear now: the carried card's agent, else the speaker, else Aither. */
function currentFairy(nowMs = Date.now()) {
  if (nudging && nudging.decision && nudging.decision.card) {
    const f = agentFairy.crewFairy(nudging.decision.card.agent);
    if (f.known || f.crew) return f;
  }
  if (fairySpeaker && nowMs < fairySpeaker.until) return agentFairy.crewFairy(fairySpeaker.agent);
  return agentFairy.restingFairy();
}

/** Who is active on the platform (GET /atlas/presence via MCP atlas_presence). */
let agentPresence = [];
/** agent -> until (ms): a line spoken or a post just now; the companion flashes. */
let agentPosts = new Map();
let agentPostTimer = null;

function speakingNow(nowMs = Date.now()) {
  const out = [];
  for (const [agent, until] of agentPosts) {
    if (until > nowMs) out.push(agent);
    else agentPosts.delete(agent);
  }
  return out;
}

/**
 * The cluster now (fairy-cluster.cjs): one fairy per queued decision, per live agent
 * session and per working platform agent, reconciled against what was there before
 * (an entry its source dropped leaves; an unreadable source's entries are reaped
 * after 30 s), then capped into a counted bead.
 */
function currentCompanions(nowMs = Date.now()) {
  const entries = fairyCluster.liveEntries({
    cards: attentionCards, sessions: clusterSessions, presence: agentPresence, nowMs,
  });
  const { kept } = clusterReaper.reconcile(entries, { nowMs, ok: clusterOk });
  const c = fairyCluster.collapse(kept, fairyCluster.CAP);
  clusterTotal = c.total;
  clusterLabel = fairyCluster.countLabel(kept);
  const talking = new Set(speakingNow());
  return c.shown.map((e) => (e.kind !== "decision" && talking.has(e.agent) ? { ...e, state: "speaking" } : e));
}

/** What the cluster holds: {total, label, shown}. For the bridge, tray and proofs. */
function clusterState() {
  const shown = currentCompanions();
  return { total: clusterTotal, label: clusterLabel, shown: shown.length, keys: clusterReaper.keys(), autoSurfaced };
}

/**
 * Main hands over the live agent sessions: the Claude Code tabs (session-context
 * liveSessions, pid-checked) and the awsh daemon's rows. `ok:false` = that read
 * failed; the cluster then holds the last fairies for 30 s, never forever.
 */
function setClusterSessions(sources, { ok = true } = {}) {
  // Unreadable: nothing is "fresh" from this source; the reaper holds the last fairies
  // for its 30 s and then lets them go (orphans never stay).
  clusterSessions = ok === false ? [] : (Array.isArray(sources) ? sources : [sources]);
  clusterOk = { ...clusterOk, sessions: ok !== false };
  sendFairy();
  return { ok: true, total: clusterTotal };
}

/**
 * Decisions ride the fairy (owner 2026-11-16: "these bullshit decision cards instead
 * of fairies"). A hidden orb with decisions waiting comes up by itself -- the cluster
 * IS the decision surface now -- and goes back down when the queue empties, unless
 * the owner showed it himself meanwhile. Grown into the avatar: the body carries it.
 */
function surfaceForCards() {
  if (quitting || expanded) return;
  // both/swarm show the cluster itself, beside the avatar: there is no orb disc to
  // bring up, and surfacing one would break the mode's layout (owner 2026-11-20).
  if (display.mode === "both" || display.mode === "swarm") return;
  const fresh = !ownerHidIds || attentionCards.some((c) => !ownerHidIds.has(c.id));
  if (attentionCards.length > 0 && !state.visible && fresh) {
    autoSurfaced = true; // before showOrb: its save must not record the owner's choice
    const r = showOrb({ auto: true });
    if (!r || !r.ok) autoSurfaced = false;
  } else if (attentionCards.length === 0 && autoSurfaced) {
    autoSurfaced = false;
    if (state.visible) hideOrb({ auto: true });
  }
}

/** Reconcile on a clock too: a fairy whose source went silent leaves within ~30 s. */
function ensureClusterClock() {
  if (clusterTimer || quitting) return;
  clusterTimer = setInterval(() => { try { sendFairy(); } catch { /* cosmetic */ } }, 10_000);
  if (clusterTimer.unref) clusterTimer.unref();
}

/**
 * Main hands over the platform presence list: every agent that is active (its
 * Discord bot, its work on Atlas' board, a card). A list that could not be read
 * is NOT handed over (the last one stands), so a dead gateway never empties the swarm.
 */
function setPresence(list) {
  agentPresence = Array.isArray(list) ? list.slice(0, 200) : [];
  sendFairy();
  return { ok: true, count: agentPresence.length };
}

/**
 * An agent just spoke or posted (its Discord bot, the relay): its companion flashes
 * bright for a few seconds. The main fairy is not re-coloured by a post -- only by
 * the card it carries or a line spoken aloud.
 */
function noteAgentPosted(agent, { ms = 4000 } = {}) {
  const key = agentFairy.crewKey(agent);
  if (!key) return { ok: false, reason: "not an agent" };
  agentPosts.set(key, Date.now() + ms);
  if (agentPostTimer) clearTimeout(agentPostTimer);
  agentPostTimer = setTimeout(() => { agentPostTimer = null; sendFairy(); }, ms + 50);
  if (agentPostTimer.unref) agentPostTimer.unref();
  sendFairy();
  return { ok: true, agent: key };
}

/** Click a companion: talk to THAT agent (main opens its chat; the hook decides how). */
function chatWithAgent(agent) {
  // The counted bead: the whole waiting list, never a chat with "more".
  if (String(agent || "") === "more") {
    const r = hookValue("openList");
    return r === undefined ? { ok: false, reason: "no waiting list in this build" } : { ok: true, list: true };
  }
  const key = agentFairy.crewKey(agent);
  if (!key) return { ok: false, reason: "not an agent" };
  const row = currentCompanions().find((c) => c.agent === key) || null;
  const opened = hookValue("chat", key, { threadUrl: row ? row.threadUrl : "", dmUrl: row ? row.dmUrl : "" });
  return opened === false || opened === undefined
    ? { ok: false, reason: "chat is not wired in this build" }
    : { ok: true, agent: key };
}

/** Push the look and the companions to the orb page, only when they changed. */
function sendFairy({ force = false } = {}) {
  const look = currentFairy();
  const key = JSON.stringify(look);
  if (force || key !== lastFairyKey) {
    lastFairyKey = key;
    send("orb:fairy", look);
  }
  allCompanions = currentCompanions();
  const { visible: companions, pinned } = viewCompanions(allCompanions);
  // Visual neurons: a companion that STARTS working opens a thought node; a state
  // that did not change adds nothing. Spoken lines come from setSpeaker, which
  // every line the desk says goes through.
  if (neuronsOn()) {
    const seen = new Set();
    for (const c of companions) {
      const key = String(c.agent || "");
      if (!key) continue;
      seen.add(key);
      const was = lastNeuronStates.get(key);
      if (c.state === "working" && was !== "working") {
        noteNeuron({ agent: key, kind: "thinking", text: c.title || c.label || "working" });
      }
      lastNeuronStates.set(key, c.state);
    }
    for (const key of [...lastNeuronStates.keys()]) if (!seen.has(key)) lastNeuronStates.delete(key);
  }
  const ckey = JSON.stringify({ companions, pinned: pinned.map((c) => [c.agent, c.state, c.count, c.selected]), view: state.swarmView });
  if (force || ckey !== lastCompanionsKey) {
    lastCompanionsKey = ckey;
    swarmCompanions = companions;
    // Who is in the ring changed: every fairy has a new slot, so let go of any hover. A change of
    // radius, layout or selection keeps the same fairies, and the wheel must keep the window.
    const who = JSON.stringify(companions.map((c) => [c.agent, c.state, c.count]));
    if (who !== lastCompanionsWho) { lastCompanionsWho = who; releaseHover(); }
    send("orb:companions", companions);
    placeSwarm(companions, { raise: true });
    try {
      if (alive(swarmWindow)) swarmWindow.webContents.send("orb:companions", companions);
    } catch { /* page mid-load: init() carries the list */ }
  }
  // A session's running tool changed (or one ended): re-plan the tool flights. The
  // planner keeps a finished call for its trip home, so this is safe to call often.
  try { updateToolFlights(); } catch { /* cosmetic: a bad surface never breaks the cluster */ }
  return { look, companions };
}

/**
 * Someone is talking: the fairy wears that agent's colours for about as long as
 * the line takes, then returns to the card it carries or to Aither. An unknown
 * name (a character, not an agent) changes nothing.
 */
function setSpeaker(agent, text = "") {
  const key = agentFairy.normalizeAgent(agent);
  if (!key) return { ok: false, reason: "not an agent with a fairy" };
  const ms = agentFairy.speakingMs(text);
  fairySpeaker = { agent: key, until: Date.now() + ms };
  agentPosts.set(key, Date.now() + ms); // its companion flashes while it talks
  if (fairySpeakerTimer) clearTimeout(fairySpeakerTimer);
  fairySpeakerTimer = setTimeout(() => { fairySpeakerTimer = null; fairySpeaker = null; sendFairy(); }, ms + 50);
  if (fairySpeakerTimer.unref) fairySpeakerTimer.unref();
  // Visual neurons: a spoken line is a step the owner can see.
  noteNeuron({ agent: key, kind: "line", text });
  sendFairy();
  return { ok: true, agent: key, ms };
}

// ── visual neurons (neurons-model.cjs): see an agent think ───────────────────
//
// Owner, 2026-11-18: "visual neurons -- let the owner SEE agents think". A step
// (thinking, a tool call, a result, a spoken line) becomes a node around that
// agent's fairy; edges are the sequence and the fan-out of parallel tool calls.
// OFF unless Settings -> Visual neurons switches it on. The model owns the rules
// (nodes, edges, decay, caps, layout); this owns WHEN a step is noted and the ONE
// batched send (<= 10 Hz, never one IPC per step and never per frame).

function neuronsOn() {
  return state.neurons === true;
}

/** Note one step. Cheap and silent when the overlay is off (the default). */
function noteNeuron(event) {
  if (!neuronsOn()) return false;
  if (!neurons.ingest(event)) return false;
  scheduleNeuronFlush();
  return true;
}

function scheduleNeuronFlush() {
  if (neuronTimer) return;
  neuronTimer = setTimeout(() => { neuronTimer = null; flushNeurons(); }, NEURONS_FLUSH_MS);
  if (neuronTimer.unref) neuronTimer.unref();
}

/** What the pages draw: one graph per agent, plus the decay clock they fade on. */
function neuronPayload(nowMs = Date.now()) {
  return { on: neuronsOn(), ...neurons.snapshot(nowMs) };
}

function flushNeurons({ force = false } = {}) {
  const payload = neuronPayload();
  const key = JSON.stringify(payload);
  if (!force && key === lastNeuronPayload) return payload;
  lastNeuronPayload = key;
  for (const win of [orbWindow, bubbleWindow, swarmWindow]) {
    try { if (alive(win)) win.webContents.send("orb:neurons", payload); } catch { /* page mid-load: init() carries it */ }
  }
  return payload;
}

/** The switch (Settings, the palette row, POST /commands/run). Off is the default. */
function setNeurons(next) {
  const want = next === true;
  if (state.neurons !== want) { state.neurons = want; saveState(); }
  if (!want) { neurons.reset(); lastNeuronStates.clear(); }
  flushNeurons({ force: true });
  return { ok: true, neurons: want };
}

/**
 * Hovering a companion shows that agent's card in the whisper, beside the fairy
 * where it rests. A PEEK, not a nudge: it neither climbs nor resets the ladder,
 * and a real nudge in flight keeps its card.
 */
function peekCard(id, { explicit = false } = {}) {
  const card = attentionCards.find((c) => c && c.id === String(id || ""));
  if (!card) return { ok: false, reason: "no such card" };
  // An old card never pops on a hover: the badge and the list only (owner
  // 2026-11-09, "Waiting 22 d"). A click on its fairy is asking, so it opens.
  if (!explicit && fairyAttention.isStale(card, Date.now())) return { ok: false, reason: "old: the badge only" };
  if (nudging && nudging.decision.card.id === card.id) {
    if (explicit) {
      nudging.until = Math.max(nudging.until, Date.now() + fairyMenu.PINNED_MS);
      nudging.explicit = true;
    }
    return { ok: true, id: card.id, already: true };
  }
  if (nudging && !nudging.peek && !explicit) return { ok: false, reason: "a nudge is showing" };
  // A hover never replaces a card the owner CLICKED open, or one the pointer is on:
  // on the way from the orb to the card's buttons the pointer crosses the companion
  // fairies, and each hover swapped the card out (owner 2026-11-10: "I click but I
  // can't get to the card because it changes when I hover over a different fairy").
  if (nudging && !explicit && (nudging.explicit || nudging.hovered)) {
    return { ok: false, reason: "the owner opened this one" };
  }
  // A click outranks a running nudge; "preempted" teaches the ladder nothing.
  // A fairy that had flown out to the pointer still goes home when this one ends.
  const away = nudging && nudging.anchor ? nudging.anchor : null;
  if (nudging) endNudge(nudging.peek ? "peek" : "preempted", { stay: true });
  const f = agentFairy.crewFairy(card.agent);
  const decision = {
    act: "nudge", card, level: fairyAttention.LEVEL.GLOW, importance: 0, arrival: false, returned: false,
    why: fairyAttention.whyNow(card, Date.now()),
    lead: f.known || f.crew ? `From ${f.label}` : "Waiting on you",
    // A CLICKED card is pinned: it stays until closed or another click (owner
    // 2026-11-12), never timed out from under the pointer.
    more: fairyCounts.moreAfter(attentionCards, card.id), voice: false, showMs: explicit ? fairyMenu.PINNED_MS : 8000,
  };
  const r = startNudge(decision, { peek: true });
  if (away && nudging && !nudging.anchor) nudging.anchor = away;
  if (explicit && nudging) nudging.explicit = true;
  return r;
}

/**
 * A click on an agent's fairy: that agent's newest card opens in the whisper,
 * never the empty chat bubble (owner 2026-11-09). `id` is the companion's card;
 * an id that is gone falls back to the same agent's newest open card.
 */
function openFairyCard(id, agent = "") {
  let card = attentionCards.find((c) => c && c.id === String(id || ""));
  if (!card && agent) {
    const key = agentFairy.crewKey(agent);
    const mine = key ? attentionCards.filter((c) => c && agentFairy.cardAgent(c) === key) : [];
    card = mine.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0];
  }
  if (!card) return { ok: false, reason: "no card for that fairy" };
  return peekCard(card.id, { explicit: true });
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
  if (display.mode === "avatar") return false; // no cluster on an avatar-only desk
  return Boolean(attentionTimer && !quitting && state.visible && alive(orbWindow));
}

/**
 * Will the fairy cluster carry a NEW card? True while the attention loop runs and the
 * orb exists, hidden or not: a hidden orb comes up for a card (surfaceForCards), and a
 * fairy grown into the avatar carries it in the body. This is the desk's claim on the
 * card (the `.desk-alive` "attention": "fairy"), so awask leaves its Tk card window
 * down (owner 2026-11-16: "still getting these bullshit decision cards instead of
 * fairies"). The cluster turned off (orb.json cluster:false) gives the claim back.
 */
function carriesCards() {
  if (display.mode === "avatar") return false; // the one cluster is off in avatar mode
  return Boolean(attentionTimer && !quitting && alive(orbWindow) && state.cluster !== false);
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
    const muted = Number(state.muteUntil) > nowMs ? "nudges muted from the fairy's menu" : "";
    // The body carries the cards while it is up (one companion surface).
    const quiet = !state.visible ? "the fairy is hidden" : (stoodDownForAvatar ? "the body is carrying the cards" : muted || String(hookValue("quiet") || ""));
    const ctx = {
      nowMs,
      lastNudgeAt: attentionLastAt,
      lastVoiceAt: attentionVoiceAt,
      olderMentionedAt: attentionOlderAt,
      quiet,
      idleMs,
      busy,
      returned: nowMs < attentionReturnUntil,
    };
    // A muted agent (fairy menu > Mute) never nudges; its cards stay on the badge and in the list.
    const mutedAgents = state.swarmView.muted;
    const nudgeable = mutedAgents.length ? attentionCards.filter((c) => !mutedAgents.includes(agentFairy.cardAgent(c))) : attentionCards;
    let decision = fairyAttention.plan(nudgeable, attentionMems, ctx);
    // "N more waiting" is everything else that needs the owner, the same number a
    // click shows and the badge minus one -- not only the cards due a nudge.
    if (decision.act === "nudge" && decision.card) {
      decision = { ...decision, more: fairyCounts.moreAfter(attentionCards, decision.card.id) };
    }
    if (decision.act === "nudge") {
      const full = await fullScreenNow();
      if (full) decision = { act: "none", reason: `held while quiet: ${full}` };
    }
    if (decision.act === "nudge" && !nudging && !quitting) {
      // Where the flutter lands is judged against what is clickable right now.
      try { await refreshAllObstacles(); } catch { /* the placement then uses what it last knew */ }
      if (!nudging && !quitting) startNudge(decision);
    }
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
      // An occluded transparent window is throttled: its fade stalled mid-way and the
      // last frame (~30%) stayed over the page (owner 2026-11-14). It is small; let it paint.
      backgroundThrottling: false,
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

/** The whisper's fade, then the window goes: never hidden mid-fade, never left up. */
const NUDGE_FADE_MS = 280;
let nudgeHideTimer = null;
function cancelNudgeHide() {
  if (nudgeHideTimer) { clearTimeout(nudgeHideTimer); nudgeHideTimer = null; }
}

function showWhisper() {
  if (!nudging) return;
  cancelNudgeHide();
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

/**
 * A card that just ARRIVED is delivered by the fairy out loud (owner 2026-11-15:
 * "the fucking fairy isn't talking to me"): with the mic on it ASKS -- the voice card
 * flow speaks the question and the next words answer it ("option two", "later"),
 * through the one desk answer path; with the mic off it says the question, the
 * suggestion and how many more wait. The whisper's buttons work either way.
 */
function deliverArrival(n) {
  const d = n.decision;
  attentionVoiceAt = Date.now();
  if (d.mentionOlder) attentionOlderAt = Date.now();
  const line = fairyAttention.arrivalLine(d.card, d);
  const credential = String(d.card.kind).toLowerCase() === "credential";
  const canTalk = !credential && typeof (attentionHooks && attentionHooks.talk) === "function"
    && !hookValue("micMuted");
  if (canTalk) {
    // The voice card prompt says the question and its numbered options, then
    // listens; only the backlog line goes before it, so nothing is said twice.
    const others = Math.max(0, (Number(d.needNow) || 0) - 1);
    const pre = [
      others ? `${others} more need${others === 1 ? "s" : ""} you after this one.` : "",
      d.mentionOlder && d.older > 0 ? `${d.older} older card${d.older === 1 ? " is" : "s are"} on the list.` : "",
    ].filter(Boolean).join(" ");
    if (pre) hookValue("speak", pre, { force: true });
    void talkNudge(n);
    return { ok: true, mode: "ask", line };
  }
  return { ok: hookValue("speak", line, { force: true }) !== false, mode: "say" };
}

function startNudge(decision, { peek = false } = {}) {
  if (!alive(orbWindow) || !decision || !decision.card) return { ok: false };
  const view = fairyAttention.whisperView(decision, Date.now());
  if (!view) return { ok: false };
  const nowMs = Date.now();
  const id = decision.card.id;
  if (!peek) {
    attentionMems[id] = fairyAttention.recordShown(attentionMems[id] || {}, nowMs);
    attentionLastAt = nowMs;
    if (decision.returned) attentionReturnUntil = 0;
  }
  // The whisper is signed by the agent fairy whose card it is.
  view.agent = agentFairy.crewFairy(decision.card.agent);
  nudging = {
    decision, view, peek, startedAt: nowMs, until: nowMs + (decision.showMs || 9000),
    anchor: null, whisperAt: null, side: "right", hovered: false, shown: false, timer: null, flutter: null,
  };
  const n = nudging;
  ensureNudge();
  sendPanel();
  // The fairy wears the colours of the agent whose card it now carries.
  sendFairy();
  // The chime rides the level change (the orb page synthesizes it). The plan already
  // held this nudge while quiet; a muted desk or "Fairy sounds: off" is silent too.
  // A peek is the owner's own hover: no chime, no glow.
  if (!peek) send("orb:nudge", { level: decision.level, chime: chimeFor(decision.level) });
  if (decision.level >= fairyAttention.LEVEL.FLUTTER) {
    const { screen } = electron();
    let cursor = null;
    let area;
    try {
      cursor = screen.getCursorScreenPoint();
      area = screen.getDisplayNearestPoint(cursor).workArea;
    } catch { area = displayForOrb().workArea; }
    const place = fairyAttention.nudgePlacement(cursor, area, ORB_SIZE, NUDGE_SIZE, { obstacles: allObstacles() });
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
      { x, y, width: ORB_SIZE.width, height: ORB_SIZE.height }, NUDGE_SIZE, fairyArea(displayForOrb().workArea), 6,
    );
    showWhisper();
  }
  if (!peek) saveAttention();
  if (decision.arrival && decision.voice && !peek) deliverArrival(n);
  else if (decision.voice && !peek) speakNudge(decision);
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
    const dock = dockSpot(attach);
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
  if (n.peek && (outcome === "timeout" || outcome === "peek")) {
    // A peek was the owner's hover, not a nudge: nothing to learn from it.
  } else if (outcome === "timeout") {
    attentionMems[id] = fairyAttention.recordIgnored(mem, { importance: n.decision.importance, nowMs, climbs: n.decision.climbs });
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
  // Click-through at once; the page fades and unmounts the card; the window hides
  // when the fade is done (hiding first froze the fade's last frame on screen).
  if (alive(nudgeWindow)) {
    try { nudgeWindow.setIgnoreMouseEvents(true, { forward: true }); } catch { /* gone */ }
  }
  sendNudge("orb:nudge-view", null);
  cancelNudgeHide();
  nudgeHideTimer = setTimeout(() => {
    nudgeHideTimer = null;
    if (!nudging && alive(nudgeWindow)) {
      try { nudgeWindow.hide(); } catch { /* gone */ }
    }
  }, NUDGE_FADE_MS);
  if (nudgeHideTimer.unref) nudgeHideTimer.unref();
  send("orb:nudge", { level: 0 });
  sendPanel();
  sendFairy();
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
    let x = b.x;
    try {
      const { screen } = electron();
      const area = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y }).workArea;
      if (y + h > area.y + area.height) y = Math.max(area.y, area.y + area.height - h);
      x = Math.min(Math.max(b.x, area.x), area.x + area.width - NUDGE_SIZE.width);
    } catch { /* no screen module (tests) */ }
    nudgeWindow.setBounds({ x, y, width: NUDGE_SIZE.width, height: h });
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
    if (verdict && typeof verdict === "object" && verdict.ok === false) {
      // A terminal ask the desk could not type into (tui-answer.cjs): nothing was
      // recorded, the session is still waiting -- say where to answer it.
      sendNudge("orb:nudge-flash", { text: verdict.flash || "That did not go through. Open it?", error: true });
      return { ok: false, error: verdict.error || "the answer did not go through" };
    }
    if (!verdict) {
      sendNudge("orb:nudge-flash", { text: "That did not go through. Open it?", error: true });
      return { ok: false, error: "the answer did not go through" };
    }
    const pending = Boolean(verdict && typeof verdict === "object" && verdict.pending);
    confirmThenEnd(n, pending ? "Finish it in the approval window" : `Done: ${opt.label || opt.key}`, "acted");
    return { ok: true, pending };
  }
  if (what === "open" || what === "more") {
    // "more" is the QUEUE, not "open some card": the Inbox opened on whatever it
    // last showed, which is how a card a session was blocked on stayed unfound
    // (owner, 2026-11-10, 99+ waiting). Falls back to the Inbox when the desk did
    // not wire a list (a stripped build).
    if (what === "more" && typeof (attentionHooks && attentionHooks.openList) === "function") {
      hookValue("openList");
    } else {
      hookValue("open", what === "more" ? null : card.id);
    }
    endNudge("acted");
    return { ok: true };
  }
  if (what === "later" || what === "dismiss") {
    endNudge("later");
    return { ok: true };
  }
  // "Open in AitherBrowser" under the card's answers: its page, AitherBrowser first.
  if (what === "browser") return openCardPage(card.id, "aither");
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
  if (v.ok && v.kind === "later") {
    confirmThenEnd(n, "Later it is. I'll bring it back.", "later");
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
  const f = agentFairy.crewFairy(card.agent);
  cardChat = {
    id: card.id,
    // The bubble header names the agent in plain words, never a sprite id/stage/tier.
    who: f.known || f.crew ? f.label : "",
    title: String(card.title || "this card").replace(/^Claude Code needs you:\s*/i, "").slice(0, 80),
    context: fairyAttention.chatContext(card, Date.now(), { session }),
  };
  suppressed = false;
  bubbleMode = "card";
  openBubble({ focus: true });
  send("orb:mode", { mode: "card", title: cardChat.title, who: cardChat.who });
  return { ok: true, id: card.id, mode: "card" };
}

/**
 * The spirit's own rows -- search, ask, find, attach, sounds, the sprite, the desk's
 * doors. They used to open a SECOND menu (a dark native list) from "More...", beside the
 * pill menu every other fairy surface draws; two fairy menus, two looks (owner screenshots
 * 2026-11-16). Now they are a second PAGE of the one pill menu: same window, same keys,
 * same Esc. `run` is looked up again at pick time, so a stale click runs nothing.
 */
function spiritRows() {
  const reg = commandRegistry();
  return [
    { id: "spirit:web", label: "Search the web…", run: () => openMode("web") },
    { id: "spirit:ask", label: "Ask a question…", run: () => { openMode(null); try { bubbleWindow.focus(); } catch { /* gone */ } } },
    { id: "spirit:find", label: "Find a file…", run: () => openMode("find") },
    ...(hold ? [{ id: "spirit:read", label: `Read ${spiritCore.holdLabel(hold)}`, run: () => { void runHoldAction("read"); } }] : []),
    { sep: true },
    { id: "spirit:attach", label: attach ? "Let go of this window" : "Stay on this window", run: () => { void toggleAttach(); } },
    { id: "spirit:home", label: "Back to its corner", run: () => { void sendHome(); } },
    // The nudge chime (owner 2026-11-08): on by default, remembered in orb.json.
    { id: "spirit:sounds", label: `Fairy sounds: ${state.sounds === false ? "off" : "on"}`, run: () => { setSounds(state.sounds === false); } },
    // Tool flights (2026-11-18): the sub-fairies that fly to the window a call belongs
    // to. Off = reduced motion: a still glow, never a flight. Remembered in orb.json.
    { id: "spirit:flights", label: `Fairy flights: ${state.reducedMotion === true ? "off (reduced motion)" : "on"}`, run: () => { setReducedMotion(state.reducedMotion !== true); } },
    ...(reg.byId("quick.open") ? [{ id: "spirit:quick", label: "Quick menu", run: () => { void runCommandImpl?.("quick.open"); } }] : []),
    { sep: true },
    // The fairy IS the owner's sprite: its own rows sit on its own menu.
    { id: "spirit:sprite", label: sprite ? `${sprite.name}: how are you?` : "How is my sprite?", run: () => { void spriteStatus(); } },
    { id: "spirit:teach", label: "Teach it what I selected", run: () => { void spriteTeach(null); } },
    { id: "spirit:sprite-page", label: "Open my sprite page…", run: () => { openUrl(spriteCore.SPRITE_PAGE); } },
    { sep: true },
    // The desk's doors live on the fairy now (owner 2026-11-02: "consolidate the
    // awdesk icons around the fairy"): the bead rail's rows, plus Show avatar.
    ...deskDoors(reg).map((d) => ({ id: d.id, label: d.label, run: d.click })),
  ];
}

/** The second page of the one fairy menu. */
function moreMenu({ atFairy = false } = {}) {
  const rows = spiritRows();
  const items = [...rows.map((r) => (r.sep ? { sep: true } : { id: r.id, label: r.label })),
    { sep: true }, { id: "less", label: "Back", hint: "The short menu" }];
  // Same RADIAL menu as the root: the rows are paginated five + More per ring, so
  // every door stays one or two clicks away and the look never forks (owner 2026-11-20).
  return showMenu("orb", { header: "Aither · more", items }, { atFairy, radial: true });
}

/** The old native "spirit menu" entry points (right click on the page, the bridge) now
 *  open THE pill menu: there is one fairy menu. */
function spiritMenu() {
  // Owner 2026-11-23: the orb's own right-click menu is retired into the ONE ring.
  // "This fairy" is the page it opens on: one slice per open card, plus every control
  // the old menu carried (Hide, Dock answers, display, sprite, desk doors, quit).
  hideMenu();
  hideTip();
  return openRing({
    at: orbCenter(),
    hold: false,
    fly: false,
    pages: selfRingPages(),
    page: 1,
  });
}

// ── drop behaviour (fairy-drop.cjs, owner 2026-11-23) ───────────────────────
/** The behaviour in force for one fairy ("orb" for the main fairy). */
function dropBehaviorFor(agent = "") {
  return fairyDrop.behaviorFor(state, agent);
}

function clearDropReturn() {
  if (dropReturnTimer) {
    clearTimeout(dropReturnTimer);
    dropReturnTimer = null;
  }
}

/** "Stay N seconds": fly home (to where it rested before the drop) unless something
 *  else attaches first. A null delay is "pin": no timer at all. */
function scheduleReturnAfter(ms, homeSpot = null) {
  clearDropReturn();
  if (ms == null) return;
  dropReturnTimer = setTimeout(() => {
    dropReturnTimer = null;
    if (quitting || !state.visible) return;
    if (attach) detach({ silent: true });
    if (homeSpot && homeSpot.x != null && homeSpot.y != null) {
      state.x = homeSpot.x;
      state.y = homeSpot.y;
      saveState();
    }
    void flyHome(520);
  }, Math.max(0, Number(ms) || 0));
  if (dropReturnTimer.unref) dropReturnTimer.unref();
}

/** Settings: set the GLOBAL default for new drops. */
function setDropDefault(patch) {
  const next = fairyDrop.normalizeDrop({ ...(state.drop || {}), ...(patch && typeof patch === "object" ? patch : {}) });
  state = { ...state, drop: next };
  saveState();
  return { ok: true, drop: next };
}

/** The desktop right-click ring switch (owner 2026-11-23), persisted in orb.json. */
function desktopRingOn() {
  return state.desktopRing !== false;
}

function setDesktopRing(on) {
  state = { ...state, desktopRing: on !== false };
  saveState();
  return { ok: true, desktopRing: state.desktopRing };
}

/** "centre" (default) or "click": where the ring opens. */
function ringAtMode() {
  return state.ringAt === "click" ? "click" : "centre";
}

function setRingAt(mode) {
  state = { ...state, ringAt: mode === "click" ? "click" : "centre" };
  saveState();
  return { ok: true, ringAt: state.ringAt };
}

/** A fairy's menu: set ONE fairy's answer ("orb" for the main fairy). */
function setDropBehavior(agent, patch) {
  const current = fairyDrop.behaviorFor(state, agent);
  const next = fairyDrop.normalizeDrop({ ...current, ...(patch && typeof patch === "object" ? patch : {}) });
  state = fairyDrop.withBehavior(state, agent, next);
  saveState();
  return { ok: true, agent: fairyDrop.behaviorKey(agent), drop: next };
}

/** The Settings page's view: the global default plus per-fairy overrides. The asking
 *  card's stay rule rides the same family (owner 2026-11-22: "same settings family as
 *  Settings > Fairy drops"). */
function dropSettings() {
  return {
    drop: { ...(state.drop || fairyDrop.normalizeDrop(null)) },
    byAgent: { ...(state.dropBy || {}) },
    card: cardStay.normalizeCard(state.card),
  };
}

// ── the asking card: stay-open rule, pin and dock (card-stay.cjs) ────────────
/** Settings: how long the card stays open. The idle timeout is OFF by default. */
function setCardSettings(patch) {
  const next = cardStay.normalizeCard({ ...(state.card || {}), ...(patch && typeof patch === "object" ? patch : {}) });
  state = { ...state, card: next };
  saveState();
  if (alive(bubbleWindow) && typeof bubbleWindow.setMovable === "function") {
    try { bubbleWindow.setMovable(next.pin); } catch { /* Windows: no-op on a gone window */ }
  }
  armCardIdle();
  return { ok: true, card: next };
}

/** The card's pin button: stays open and draggable, and exempt from the idle timeout. */
function setCardPin(pinned) {
  const patch = { pin: pinned === true };
  // Pinning keeps the card exactly where it is; a later drag re-docks it.
  if (patch.pin && alive(bubbleWindow)) {
    try {
      const b = bubbleWindow.getBounds();
      patch.x = b.x;
      patch.y = b.y;
    } catch { /* a gone window: keep the saved spot */ }
  }
  const r = setCardSettings(patch);
  touchCard();
  return r;
}

/** A pinned card's drag settled: dock to the nearest screen corner (fairy-drop's rule),
 *  remember it, and keep the card open. Never moves an unpinned card. */
function dockCard() {
  if (!alive(bubbleWindow) || !cardStay.normalizeCard(state.card).pin) return { ok: false };
  let bounds;
  try { bounds = bubbleWindow.getBounds(); } catch { return { ok: false }; }
  const { screen } = electron();
  let area;
  try { area = screen.getDisplayMatching(bounds).workArea; } catch { area = displayForOrb().workArea; }
  const corner = cardStay.dockCorner(area, bounds);
  const pos = cardStay.dockPosition(area, { width: bounds.width, height: bounds.height }, corner);
  bubbleWindow.setBounds({ ...bounds, x: pos.x, y: pos.y });
  state = { ...state, card: cardStay.normalizeCard({ ...state.card, x: pos.x, y: pos.y, corner }) };
  saveState();
  touchCard();
  return { ok: true, x: pos.x, y: pos.y, corner };
}


// ── drag and click ──────────────────────────────────────────────────────────

function beginDrag() {
  if (dragging || !alive(orbWindow) || ringOpen) return { ok: true };
  hideTip();
  // A new grab cancels a pending "stay N seconds" return; the placement itself is
  // cleared only when this drag actually drops somewhere (a plain click must not
  // hand a pinned fairy back to follow).
  clearDropReturn();
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
  sendPanel();
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
  // Where it rested BEFORE this drop: a "return" goes back there, not to where it
  // was let go.
  const restBefore = { x: state.x, y: state.y };
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
    const area = fairyArea(displayForOrb().workArea);
    const pos = orbCore.clampToWorkArea({ x, y }, ORB_SIZE, area);
    if (pos.x !== x || pos.y !== y) moveOrb(pos.x, pos.y);
    state.x = pos.x;
    state.y = pos.y;
    saveState();
  }
  let attached = null;
  if (moved && dropPoint) {
    resolvingDrop = true;
    try {
      const target = await resolveDropTarget(dropPoint);
      // The owner placed it: until the next drag, follow, seek and the AitherOS
      // dock must not move it. This is the "flies away again" bug.
      manualPlacement = true;
      // Dropped on a body -> it orbits again; anywhere else -> it stays free.
      state.freeRoam = !(target && target.kind === "avatar");
      saveState();
      clearDropReturn();
      const verdict = fairyDrop.decideDrop(dropBehaviorFor("orb"));
      if (target && target.kind === "avatar") {
        // A body is not a window: the fairy orbits it, as it always has.
        await attachTo(target, { dropPoint });
        attached = publicAttach();
      } else if (target) {
        if (verdict.dock) {
          // "Home" is where the fairy rested BEFORE this drop, never the drop point:
          // when the window later closes, detach must fly it back there.
          if (!home && restBefore.x != null && restBefore.y != null) {
            home = { x: restBefore.x + ORB_SIZE.width / 2, y: restBefore.y + ORB_SIZE.height / 2 };
          }
          await attachTo(target, { dropPoint, quiet: true });
          attached = publicAttach();
          if (verdict.returnAfterMs != null) scheduleReturnAfter(verdict.returnAfterMs, restBefore);
        } else {
          // "Return immediately": today's behaviour, kept as an option. It goes back
          // to where it rested BEFORE the drop, not to where it was let go.
          attach = null;
          hideVeil();
          if (restBefore.x != null && restBefore.y != null) {
            state.x = restBefore.x;
            state.y = restBefore.y;
            saveState();
          }
          void flyHome(520);
        }
      } else {
        // No window under the drop: pin keeps it here, "return" goes home.
        hideVeil();
        if (verdict.dock) {
          scheduleReturnAfter(verdict.returnAfterMs, restBefore);
        } else {
          if (restBefore.x != null && restBefore.y != null) {
            state.x = restBefore.x;
            state.y = restBefore.y;
            saveState();
          }
          void flyHome(520);
        }
      }
    } finally {
      resolvingDrop = false;
    }
  }
  return { ok: true, click: !moved, moved, attached };
}

function toggleBubbleFromOrb() {
  hideMenu();
  hideTip();
  const waiting = attentionCards.length > 0;
  // A click mid-trip cancels the trip and brings the spirit home. With cards waiting it
  // ALSO opens the queue (owner 2026-11-10: "nothing is happening when I click on
  // fairies... they just change colors"): a trip that never finished held tripBusy, so
  // every click only cancelled a trip.
  if (tripBusy || flight) {
    const r = cancelTrip();
    if (!waiting) return { ...r, visible: Boolean(alive(bubbleWindow) && bubbleWindow.isVisible()) };
  }
  // Owner 2026-11-22: a click on the fairy is a DISMISSAL gesture. It used to close
  // only when no cards were waiting, so an open card could not be put away that way.
  if (alive(bubbleWindow) && bubbleWindow.isVisible()) return closeBubble();
  // Cards waiting: a LEFT click on the orb opens the waiting queue -- every card, one
  // list (owner 2026-11-12: "make the left-click and right-click interactions
  // better"). A companion fairy's click opens ITS card; the orb is the whole queue.
  // The card the fairy carries counts as seen. Chat stays on the right-click menu.
  // Owner 2026-11-13: the badge links to the INBOX, where stale cards are cleared in
  // one place; nothing piles up on screen.
  // Owner 2026-11-18: "what happened to the sleek little box where I could send it on
  // tasks from clicking -- now it just opens AitherBrowser". A click on the orb is the
  // ask box again, cards or not; the waiting count is the BADGE's click (needsYou ->
  // the Inbox), so the queue stays one precise click away instead of hijacking the orb.
  if (waiting && nudging) endNudge("seen", { stay: true });
  openBubble({ focus: true });
  return { ok: true, visible: true };
}

/** The waiting LIST (fairy-queue-window); the Inbox when this build wired no list. */
function openQueue() {
  if (typeof (attentionHooks && attentionHooks.openList) === "function") return hookValue("openList");
  return hookValue("open", null);
}

// ── the right-click menu and the hover tooltip (owner 2026-11-12) ──────────
//
// Both are their own windows: the 72 px orb and the ring-sized swarm are too small
// to draw a menu in, and the orb window never grows (the 2026-11-07 GPU leak).
// The MENU takes focus (the owner asked for it with a right click), so arrows,
// Enter and Esc work, and it closes when it loses focus. The TIP never takes
// focus and never takes a click: one line, after a dwell, beside the pointer.

let menuWindow = null;
/** {kind: "fairy"|"orb", cardId, agent, header, items} while a menu is up. */
let menuState = null;
let tipWindow = null;
const TIP_SIZE = Object.freeze({ width: 300, height: 30 });
/** Windows may refuse the menu the keyboard (no recent input to the desk, so no
 *  foreground right) while Electron still reports it focused: then blur never
 *  fires (measured live 2026-11-12). So a menu closes itself once neither the
 *  pointer nor a key has touched it for this long; it can never be stuck. */
const MENU_IDLE_MS = 6000;
let menuHover = false;
let menuTouchedAt = 0;
let menuIdleTimer = null;
let menuIdleMsOverride = 0;

function overlayWindow(title, { focusable }) {
  const { BrowserWindow } = electron();
  const win = new BrowserWindow({
    x: 0, y: 0, width: 200, height: 100,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, focusable, title,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "orb-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* no-op */ }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  return win;
}

function ensureMenu() {
  if (alive(menuWindow)) return menuWindow;
  menuWindow = overlayWindow("Aither menu", { focusable: true });
  // Clicking anywhere else closes it, exactly like a native context menu.
  menuWindow.on("blur", () => { hideMenu(); });
  menuWindow.on("closed", () => { menuWindow = null; menuState = null; });
  void menuWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "menu" } });
  return menuWindow;
}

/** The safety net under every hover (fairy-hover-guard.cjs): the tip hides itself,
 *  and a window the page made clickable goes back to click-through once the pointer
 *  is off it, whatever the page managed to report (owner 2026-11-14, stuck pills). */
let hoverGuardImpl = null;
function hoverWin(key) {
  return key === "swarm" ? swarmWindow : key === "orb" ? orbWindow : null;
}
function hoverGuard() {
  if (hoverGuardImpl) return hoverGuardImpl;
  hoverGuardImpl = fairyHoverGuard.createHoverGuard({
    cursor: () => cursorPoint(),
    hideTip: () => hideTipWindow(),
    setClickThrough: (key, through) => {
      const win = hoverWin(key);
      if (alive(win)) win.setIgnoreMouseEvents(Boolean(through), { forward: true });
    },
    // The page still thinks the pointer is on it: tell it to drop its hover.
    released: (key) => {
      const win = hoverWin(key);
      try { if (alive(win)) win.webContents.send("orb:hit-reset", true); } catch { /* gone */ }
    },
  });
  return hoverGuardImpl;
}

function ensureTip() {
  if (alive(tipWindow)) return tipWindow;
  tipWindow = overlayWindow("Aither tip", { focusable: false });
  tipWindow.setIgnoreMouseEvents(true);
  tipWindow.on("closed", () => { tipWindow = null; });
  void tipWindow.loadFile(path.join(__dirname, "orb.html"), { query: { view: "tip" } });
  return tipWindow;
}

function publicMenu() {
  return menuState ? { kind: menuState.kind, header: menuState.header, items: menuState.items } : null;
}

/** The view the menu page draws: the flat list as built, plus -- for the orb's radial
 *  menu -- the ring model for the CURRENT page, so a page that reloads restores the
 *  same fan instead of falling back to a vertical stack. Reads `display` through the
 *  same rows the menu was built from (the tick is in the rows, not re-derived here). */
function menuView() {
  const base = publicMenu();
  if (!base) return null;
  if (!menuState.radial) return { ...base, layout: "list" };
  const at = menuState.at;
  const model = orbRadial.radialModel(base.items, { at, area: menuAreaAt(at), page: menuState.page });
  return {
    ...base,
    layout: "radial", page: model.page, pages: model.pages,
    window: model.window, hub: model.hub, nodes: model.nodes,
  };
}

function cursorPoint() {
  try { return electron().screen.getCursorScreenPoint(); } catch { return { x: 0, y: 0 }; }
}

function workAreaAt(point) {
  try { return fairyArea(electron().screen.getDisplayNearestPoint(point).workArea); } catch { return null; }
}

/** Where a MENU may go: the display's whole work area at the click. Never the fairy's
 *  area (which avoids the workspace companion's box): measured 2026-11-13, a right
 *  click on the goblin opened its menu far away beside the fairies, because the area
 *  minus the goblin's box was the left of the screen. A menu anchors to the click. */
function menuAreaAt(point) {
  try { return electron().screen.getDisplayNearestPoint(point).workArea; } catch { return null; }
}

/** Send to a page now, or once it has loaded (a window made a moment ago). */
function deliverTo(win, channel, payload) {
  const go = () => { try { if (alive(win)) win.webContents.send(channel, payload); } catch { /* gone */ } };
  const wc = win.webContents;
  if (typeof wc.isLoading === "function" && wc.isLoading() && typeof wc.once === "function") wc.once("did-finish-load", go);
  else go();
}

function showMenu(kind, built, ctx = {}) {
  hideTip();
  const win = ensureMenu();
  menuState = { kind, cardId: String(ctx.cardId || ""), agent: String(ctx.agent || ""), ...built };
  // A right click puts the menu at the pointer (or the anchor the caller measured); the
  // palette / bridge row ("fairy.menu", keyboard reach) puts it on the fairy.
  const anchor = ctx.at && Number.isFinite(Number(ctx.at.x)) && Number.isFinite(Number(ctx.at.y))
    ? { x: Math.round(Number(ctx.at.x)), y: Math.round(Number(ctx.at.y)) } : null;
  const at = anchor || (ctx.atFairy && alive(orbWindow) ? orbCentre() : cursorPoint());
  // The anchor ACTUALLY used, so a page turn or a re-render draws the same fan.
  menuState.at = { x: Math.round(at.x), y: Math.round(at.y) };
  const area = menuAreaAt(at);
  // The owner's radial (orb-radial-menu.cjs): a ring centred on the click, the four
  // Display modes on the inner ring, one page of actions outside + More, the fan
  // flipped inward when the window clamps at a screen edge. Every other menu (a
  // card's own rows) keeps the list.
  menuState.radial = Boolean(ctx.radial);
  menuState.page = Number(ctx.page) || 0;
  const payload = menuView();
  if (ctx.radial) {
    menuState.page = payload.page;
    win.setBounds(payload.window);
  } else {
    const size = fairyMenu.menuSize(built.items, area);
    const pos = fairyMenu.menuPlacement(at, area, size);
    win.setBounds({ ...pos, ...size });
  }
  deliverTo(win, "orb:menu", payload);
  win.show();
  try {
    win.focus();
    win.webContents.focus();
  } catch { /* focus is a nicety */ }
  menuHover = false;
  menuTouchedAt = Date.now();
  if (!menuIdleTimer) {
    menuIdleTimer = setInterval(() => {
      if (!menuState || !alive(menuWindow)) return stopMenuIdle();
      if (!menuHover && Date.now() - menuTouchedAt >= (menuIdleMsOverride || MENU_IDLE_MS)) hideMenu();
    }, 500);
    if (menuIdleTimer.unref) menuIdleTimer.unref();
  }
  return { ok: true, kind, items: built.items.filter((i) => !i.sep).map((i) => i.id) };
}

function stopMenuIdle() {
  if (menuIdleTimer) { clearInterval(menuIdleTimer); menuIdleTimer = null; }
}

/** The menu page: the pointer entered (true) or left (false) it, or a key ("key"). */
function menuPointer(inside) {
  if (inside !== "key") menuHover = inside === true;
  menuTouchedAt = Date.now();
  return { ok: true };
}

function hideMenu() {
  stopMenuIdle();
  menuHover = false;
  menuState = null;
  if (alive(menuWindow) && menuWindow.isVisible()) {
    try { menuWindow.hide(); } catch { /* gone */ }
  }
  return { ok: true };
}

function orbCentre() {
  const b = orbWindow.getBounds();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

/** Right click on a companion fairy: its card's menu (or "Talk to" for presence), then the
 *  control rows every fairy has (chat, grow, mute, pin, hide, open session, swarm layout). */
function fairyMenuFor(cardId, agent = "", { atFairy = false } = {}) {
  let card = attentionCards.find((c) => c && c.id === String(cardId || "")) || null;
  if (!card && agent) {
    const key = agentFairy.crewKey(agent);
    const mine = key ? attentionCards.filter((c) => c && agentFairy.cardAgent(c) === key) : [];
    card = mine.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0] || null;
  }
  const f = agentFairy.crewFairy(card ? card.agent : agent);
  const label = f.known || f.crew ? f.label : String(agent || "");
  const key = String((card ? agentFairy.cardAgent(card) : agentFairy.crewKey(agent)) || agent || "").toLowerCase();
  const view = state.swarmView;
  const base = fairyMenu.fairyItems(card, { label, agent });
  const rows = fairyControl.controlItems({
    label, agent: key, muted: view.muted.includes(key), pinned: Boolean(view.pins[key]),
    hasSession: Boolean((card && card.sessionId) || key.startsWith("session-")),
    canGrow: typeof (attentionHooks && attentionHooks.growAgent) === "function",
    drop: dropBehaviorFor(key),
  }).filter((r) => card || r.id !== "fc:chat"); // no card: the base menu's "Talk to" is the chat row
  const items = [...base.items, { sep: true }, ...rows];
  // No companion rows here (hide all, quiet, quit...): they live on the orb's menu and the tray, and
  // next to "Hide this fairy" they read as the same thing twice.
  return showMenu("fairy", { ...base, items }, { cardId: card ? card.id : "", agent: key, atFairy });
}

/** The switches and the clock companion-menu.items reads. */
function companionOpts(target) {
  return {
    target,
    fairyVisible: orbVisible(),
    tenantVisible: Boolean(state.tenantCompanion),
    quietUntil: Number(state.muteUntil) || 0,
    nowMs: Date.now(),
  };
}

/** Right click on the workspace's own companion (GARG's goblin): the companion rows.
 *  `target` "tenant" = that companion; null = all of them (palette / bridge). */
function openCompanionMenu(target = "tenant", { at = null } = {}) {
  const kind = target === "tenant" ? "tenant" : "companions";
  return showMenu(kind, {
    header: target === "tenant" ? "Workspace companion" : "Aither companions",
    items: companionMenu.items(companionOpts(target === "tenant" ? "tenant" : null)),
  }, { at });
}

/**
 * The mode the SCREEN is in, which is what the Display tick must say. The state the
 * renderer holds is the owner's preference, but a body that is not up is not
 * "avatar": main's avatarBounds hook is null while the body is down (the sticky hide,
 * a failed raise, the tray's own show/hide). Body down = the fairy is what shows;
 * body up while the preference says fairy = a body surface is what shows.
 */
function displayModeInForce() {
  let body;
  try { body = Boolean(hookValue("avatarBounds")); } catch { body = false; }
  if (!body) return "fairy";
  return display.mode === "fairy" ? "avatar" : display.mode;
}

/** Right click on the orb: the RADIAL menu (owner 2026-11-20). It is built fresh on
 *  every open from the ONE command list, so the Display tick is read from the mode
 *  actually in force at the moment the menu opens -- never a stale render. */
function orbMenu({ atFairy = false, at = null, page = 0 } = {}) {
  const built = fairyMenu.orbItems({
    waiting: attentionCards.length, quietUntil: state.muteUntil, tenantVisible: Boolean(state.tenantCompanion),
    fairyVisible: orbVisible(), nowMs: Date.now(), avatar: avatarMode(),
    bodies: hookValue("aitherBodies") || [], swarm: allCompanions.length,
    display: displayMode.modeItems({ mode: displayModeInForce() }), displayMode: display.mode,
  });
  // "When I drop it…" for the ORB itself (fairy-drop.cjs, owner 2026-11-23), placed
  // just before the final "More…" door.
  const items = Array.isArray(built.items) ? built.items : [];
  const more = items.findIndex((i) => i && i.id === "more");
  const insertAt = more > 0 && items[more - 1] && items[more - 1].sep ? more - 1 : (more >= 0 ? more : items.length);
  built.items = [...items.slice(0, insertAt), ...fairyDrop.menuRows(dropBehaviorFor("orb")), ...items.slice(insertAt)];
  return showMenu("orb", built, { atFairy, radial: true, at, page });
}

/** The card a fairy menu is about, still open, or null. */
function menuCard(ms) {
  return ms && ms.cardId ? attentionCards.find((c) => c && c.id === ms.cardId) || null : null;
}

function setCardMem(id, mem) {
  attentionMems[id] = mem;
  saveAttention();
}

function endNudgeFor(cardId, outcome) {
  if (nudging && nudging.decision.card.id === cardId) endNudge(outcome, { stay: true });
}

/** A pick from the menu. Every id is checked against the items the menu SHOWED. */
async function menuPick(id) {
  const ms = menuState;
  const what = String(id || "");
  if (!ms || !what) { hideMenu(); return { ok: true, closed: true }; }
  // Radial paging is not an action: repaint the SAME menu on its next ring page.
  const page = orbRadial.pageFromId(what);
  if (page != null) {
    if (ms.kind === "orb") orbMenu({ at: ms.at, page });
    return { ok: true, page };
  }
  const item = ms.items.find((i) => i && !i.sep && i.id === what);
  if (!item) { hideMenu(); return { ok: false, error: "not on that menu" }; }
  if (item.disabled) { hideMenu(); return { ok: false, error: item.hint || "not available" }; }
  // A Display pick APPLIES, then repaints the still-open menu from the mode the desk
  // actually entered (main may clamp it). The tick can never lag the screen.
  if (what.startsWith("dm:")) {
    const r = displayPick(what);
    if (!r || r.ok === false) { hideMenu(); return r; }
    let applied = r.applied;
    if (applied && typeof applied.then === "function") {
      try { applied = await applied; } catch { applied = null; }
    }
    if (applied && displayMode.MODES.includes(applied.mode)) {
      setDisplayModeState({ ...display, mode: applied.mode });
    }
    if (ms.kind === "orb") orbMenu({ at: ms.at, page: ms.page });
    return r;
  }
  hideMenu();
  // The companion rows mean the same on every menu (companion-menu.cjs).
  if (companionMenu.isCompanionId(what)) {
    return companionAction(what, { target: ms.kind === "tenant" ? "tenant" : "fairy" });
  }
  if (what.startsWith("sv:")) return swarmPick(what, ms);
  if (what.startsWith("fc:")) return controlPick(what, ms);
  if (ms.kind === "orb") return orbPick(what);
  if (what === "talk") return chatWithAgent(ms.agent);
  const card = menuCard(ms);
  if (!card) return { ok: false, error: "that card is no longer open" };
  if (what === "open") return openFairyCard(card.id, ms.agent);
  if (what.startsWith("answer:")) return answerRecommended(card, what);
  const until = fairyMenu.snoozeUntil(what, Date.now());
  if (until) {
    endNudgeFor(card.id, "snoozed");
    setCardMem(card.id, fairyMenu.recordSnooze(attentionMems[card.id] || {}, until));
    return { ok: true, snoozeUntil: until };
  }
  if (what === "mute") {
    endNudgeFor(card.id, "snoozed");
    setCardMem(card.id, fairyAttention.recordMute(attentionMems[card.id] || {}));
    return { ok: true, muted: card.id };
  }
  if (what === "dismiss") {
    let ok;
    try { ok = await hookValue("cancel", card.id, "owner dismissed it from the desk fairy"); } catch { ok = false; }
    if (!ok) return { ok: false, error: "the card could not be cancelled" };
    endNudgeFor(card.id, "acted");
    return { ok: true, dismissed: card.id };
  }
  if (what === "session") {
    let r;
    try { r = await hookValue("focusSession", card.id); } catch (error) { r = { ok: false, note: String(error) }; }
    return r && typeof r === "object" ? r : { ok: false, error: "no session hook in this build" };
  }
  if (what === "link:open-aither" || what === "link:open-system") {
    return openCardPage(card.id, what === "link:open-aither" ? "aither" : "system");
  }
  if (what === "copy") {
    const link = String(hookValue("cardLink", card.id) || fairyMenu.cardLink(card.id));
    try { electron().clipboard.writeText(link); } catch { return { ok: false, error: "no clipboard" }; }
    return { ok: true, link };
  }
  return { ok: false, error: `unknown menu item ${what}` };
}

/**
 * A card's page (aitherium.com/decide?id=...) in AitherBrowser or the system browser
 * (link-opener.cjs). AitherBrowser is main's openUrl (the browser policy + an Aither
 * Browser window); the system one is shell.openExternal.
 */
function openCardPage(id, prefer = "") {
  const link = String(hookValue("cardLink", id) || fairyMenu.cardLink(id));
  return linkOpener.openLink(link, {
    prefer,
    openAither: (u) => (openUrlImpl ? openUrlImpl(u) : { ok: false, error: "no AitherBrowser in this build" }),
    openSystem: (u) => { void electron().shell.openExternal(u); return { ok: true }; },
  });
}

/** "Answer: <recommended>" -- through the ONE desk answer path (main's answerDeckCard). */
async function answerRecommended(card, what) {
  const opt = fairyMenu.recommendedOption(card);
  if (!opt || `answer:${opt.key}` !== what) return { ok: false, error: "not this card's recommended option" };
  let verdict;
  try { verdict = await hookValue("answer", card.id, opt.key); } catch { verdict = false; }
  if (verdict && typeof verdict === "object" && verdict.ok === false) {
    return { ok: false, error: verdict.error || "the answer did not go through" };
  }
  if (!verdict) return { ok: false, error: "the answer did not go through" };
  endNudgeFor(card.id, "acted");
  return { ok: true, answered: opt.key, pending: Boolean(verdict && verdict.pending) };
}

function orbPick(what) {
  if (what === "inbox" || what === "queue") {
    if (nudging) endNudge("seen", { stay: true });
    if (what === "queue") openQueue();
    else hookValue("open", null);
    return { ok: true };
  }
  if (what === "more") return moreMenu();
  if (what === "less") return orbMenu();
  if (what.startsWith("spirit:") || what.startsWith("door:")) {
    const row = spiritRows().find((r) => r && !r.sep && r.id === what);
    if (!row) return { ok: false, error: "that row is not on the menu any more" };
    try { row.run(); } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
    return { ok: true, ran: what };
  }
  if (what === "expand") return expandToAvatar();
  if (what === "collapse") return collapseToFairy();
  if (what.startsWith("body:")) return pickBody(what.slice(5));
  return { ok: false, error: `unknown menu item ${what}` };
}

/** "Aither (female)" / "Aither (male)" on the orb's menu: main saves the choice
 *  (aither-body.cjs), then the fairy grows into that body. Already grown: main swaps
 *  the body where it stands. */
async function pickBody(id) {
  const r = hookValue("pickAitherBody", id);
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "that body is not on this desk" };
  if (avatarMode() === "fairy") {
    const grown = await expandToAvatar();
    return { ...grown, body: r.body, character: r.character };
  }
  return { ok: true, body: r.body, character: r.character };
}

// -- the avatar: the fairy grows into Aither's full body (owner 2026-11-15) ---------
// "when I click the fairy or right-click and select an option I want it to expand
// into that avatar". The body is main's ONE avatar window (the attention hooks
// `expand` / `collapse`); nothing here renders a VRM. While expanded the orb and its
// swarm are down -- one cluster: the body stands where the fairy was.

/** null = this build wired no avatar to grow into; else "fairy" | "expanded". */
function avatarMode() {
  if (typeof (attentionHooks && attentionHooks.expand) !== "function") return null;
  return expanded ? "expanded" : "fairy";
}

function hideCluster() {
  releaseHover();
  hideMenu();
  hideTip();
  for (const win of [bubbleWindow, orbWindow, swarmAnchor ? null : swarmWindow]) {
    try { if (alive(win) && win.isVisible()) win.hide(); } catch { /* gone */ }
  }
  hideVeil();
}

/** Grow the fairy into the avatar, from where the fairy is. */
async function expandToAvatar() {
  if (avatarMode() === null) return { ok: false, error: "this desk has no avatar to grow into" };
  if (expanded) return { ok: true, expanded: true };
  if (nudging) endNudge("seen", { stay: true });
  const from = alive(orbWindow) && orbWindow.isVisible() ? orbWindow.getBounds() : null;
  hideMenu();
  hideTip();
  let r;
  try { r = await attentionHooks.expand({ from }); } catch (error) { r = { ok: false, error: String((error && error.message) || error) }; }
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "the avatar did not open" };
  expanded = true;
  hideCluster();
  return { ok: true, expanded: true, character: r.character || null };
}

/**
 * Shrink the avatar back into the fairy. `fromAvatar`: the body was already hidden by
 * something else (its own close, the tray) -- only bring the fairy back.
 */
async function collapseToFairy({ fromAvatar = false } = {}) {
  if (!expanded) return { ok: true, expanded: false };
  // Growing DOWN is the only thing that clears a stand-down here; the body can still
  // be up while collapse is called with nothing grown (a dock/palette verb), and the
  // fairy must not float beside it.
  stoodDownForAvatar = false;
  expanded = false;
  if (!fromAvatar && typeof (attentionHooks && attentionHooks.collapse) === "function") {
    const to = alive(orbWindow) ? orbWindow.getBounds() : null;
    try { await attentionHooks.collapse({ to }); } catch { /* the fairy comes back regardless */ }
  }
  if (state.visible && alive(orbWindow) && !orbWindow.isVisible()) {
    // Back where the fairy rests, never where the window was last parked: a fairy that was
    // only ever hidden at the screen's top-left corner came back there (proof run 2026-11-16).
    if (!attach) placeOrb();
    orbWindow.showInactive();
    if (attach) showVeil();
    placeSwarm();
  }
  // The body is gone and the fairy is back: the ask panel may open with her again.
  // Set AFTER the shrink resolves, so no bubble appears while the body is leaving.
  suppressed = false;
  return { ok: true, expanded: false };
}

// -- ONE companion surface (owner 2026-11-20) -------------------------------
// main's avatar window can come up as its own surface (tray "Show avatar", a voice
// session, a room stage). The fairy must never float beside it: two surfaces is the
// bug. She stands down, remembering the owner still wants her; when the body goes she
// comes back to her resting spot. A grow (expandToAvatar) already does this itself.

/** The body is up as its own surface: take the whole fairy cluster down, keep the switch. */
function standDownForAvatar() {
  if (expanded) return { ok: true, already: "expanded" };
  stoodDownForAvatar = true;
  suppressed = true;
  releaseHover();
  hideMenu();
  hideTip();
  if (nudging) endNudge("hidden");
  if (alive(bubbleWindow)) bubbleWindow.hide();
  if (alive(orbWindow)) orbWindow.hide();
  if (alive(swarmWindow)) swarmWindow.hide();
  hideVeil();
  // A flight or a foreground follow outliving the fairy would keep drawing beside the
  // body (hideOrb does the same two calls for the same reason).
  try { updateToolFlights(); } catch { /* cosmetic */ }
  syncForegroundProbe();
  sendPanel();
  return { ok: true, visible: false };
}

/** The body left: the fairy comes back where she rests, if the owner wanted her. */
function returnFromAvatar() {
  stoodDownForAvatar = false;
  suppressed = false;
  if (expanded) return { ok: true, visible: false, expanded: true }; // collapse places her
  if (state.visible && alive(orbWindow) && !orbWindow.isVisible()) {
    if (!attach) placeOrb();
    orbWindow.showInactive();
    if (attach) showVeil();
    placeSwarm();
  }
  return { ok: true, visible: Boolean(state.visible && alive(orbWindow) && orbWindow.isVisible()) };
}

// -- the companions: hidden by default, one set of rows everywhere ------------
// (owner 2026-11-13, companion-menu.cjs). The fairy's switch is orb.json `visible`;
// the workspace companion's is `tenantCompanion` (living-desktop-window hides
// `[data-companion]` while it is off). Listeners: main repaints the tray, the
// overlay re-applies its CSS.
const companionListeners = new Set();
function onCompanionsChange(fn) {
  if (typeof fn !== "function") return () => {};
  companionListeners.add(fn);
  return () => companionListeners.delete(fn);
}
function companionsState() {
  return {
    fairy: orbVisible(),
    tenant: Boolean(state.tenantCompanion),
    quietUntil: Number(state.muteUntil) > Date.now() ? Number(state.muteUntil) : 0,
  };
}
function notifyCompanions() {
  const snap = companionsState();
  for (const fn of companionListeners) {
    try { fn(snap); } catch { /* a listener's failure is its own */ }
  }
}
function setTenantCompanion(visible) {
  const next = visible === true;
  if (Boolean(state.tenantCompanion) === next) return { ok: true, tenant: next };
  state.tenantCompanion = next;
  saveState();
  notifyCompanions();
  return { ok: true, tenant: next };
}
/** Quiet mode: no nudges, chimes or popups until `until` (0 ends it). */
let quietTimer = null;
function setQuiet(until) {
  state.muteUntil = Math.max(0, Number(until) || 0);
  saveState();
  if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
  const left = state.muteUntil - Date.now();
  if (left > 0) {
    quietTimer = setTimeout(() => { quietTimer = null; notifyCompanions(); }, left + 1000);
    if (quietTimer.unref) quietTimer.unref();
  }
  if (state.muteUntil > Date.now() && nudging && !nudging.explicit) endNudge("seen", { stay: true });
  notifyCompanions();
  return { ok: true, quietUntil: state.muteUntil };
}
/** The tray's companion rows (companion-menu items, the tray's own subset). */
function companionTrayItems() {
  return companionMenu.items({ ...companionOpts(null), doors: "tray" });
}

/**
 * Run one companion row. The SAME function answers the right-click menus, the tray
 * and the registry verbs, so a row cannot mean two things.
 *
 * Args:
 *   id: a companion-menu id.
 *   opts.target: "fairy" | "tenant" -- what "Hide this" hides.
 */
function companionAction(id, { target = "fairy" } = {}) {
  const what = String(id || "");
  // main hands the doors in (attention.door); a build without one runs the registry id.
  const door = (name, commandId) => {
    const hook = attentionHooks && attentionHooks.door;
    if (typeof hook === "function") {
      let verdict;
      try { verdict = hook(name); } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
      return { ok: verdict !== false, door: name };
    }
    if (typeof runCommandImpl !== "function") return { ok: false, error: `no ${name} door in this build` };
    void runCommandImpl(commandId);
    return { ok: true, door: name };
  };
  switch (what) {
    case "hide-this":
      return target === "tenant" ? setTenantCompanion(false) : hideOrb();
    case "hide-all":
      hideOrb();
      setTenantCompanion(false);
      return { ok: true, ...companionsState() };
    case "show-all": {
      setTenantCompanion(true);
      const shown = showOrb();
      // Another desk owns the fairies: the companion shows, and the answer says why
      // the fairies did not (never a silent ok).
      return shown.ok === false ? { ok: true, ...companionsState(), fairy: false, note: shown.error }
        : { ok: true, ...companionsState() };
    }
    case "open-desktop": return door("desktop", "desktop.overlay.toggle");
    case "open-spaces": return door("spaces", "osapp.spaces");
    case "open-chat": return door("chat", "chat.open");
    case "settings": return door("settings", "settings.open");
    case "quit": return door("quit", "quit");
    case "quiet-off": return setQuiet(0);
    default: {
      const until = companionMenu.quietUntilFor(what, Date.now());
      if (until) return setQuiet(until);
      return { ok: false, error: `unknown companion row ${what}` };
    }
  }
}

/** The one-line hover tooltip. null/"" hides it. Never focused, never clicked. */
function showTip(text, point) {
  // A fairy's full tooltip is several lines (fairy-control.detailLines); every other tip is one.
  const multi = String(text || "").includes("\n");
  const line = multi ? String(text).slice(0, 420) : String(text || "").slice(0, fairyMenu.TIP_MAX + 1);
  const wrapped = multi ? line.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 40)), 0) : 1;
  const size = multi ? { width: 330, height: 18 + 17 * Math.min(9, wrapped) } : TIP_SIZE;
  // No tooltip over a menu, or over a card the owner clicked open.
  if (!line || menuState || (nudging && nudging.explicit)) return hideTip();
  const win = ensureTip();
  const p = point && Number.isFinite(Number(point.x)) ? { x: Number(point.x), y: Number(point.y) } : cursorPoint();
  const area = workAreaAt(p) || { x: 0, y: 0, width: 1920, height: 1080 };
  let x = Math.round(p.x + 14);
  let y = Math.round(p.y - size.height - 10);
  if (x + size.width > area.x + area.width) x = Math.round(p.x - size.width - 14);
  if (y < area.y) y = Math.round(p.y + 18);
  win.setBounds({ x, y, ...size });
  deliverTo(win, "orb:tip", { text: line, side: x < p.x ? "left" : "right", ...(multi ? { multi: true } : {}) });
  if (!win.isVisible()) win.showInactive();
  hoverGuard().tipShown(p);
  return { ok: true, text: line };
}

function hideTipWindow() {
  if (alive(tipWindow) && tipWindow.isVisible()) {
    try { tipWindow.hide(); } catch { /* gone */ }
  }
}

function hideTip() {
  hideTipWindow();
  if (hoverGuardImpl) hoverGuardImpl.tipHidden();
  return { ok: true, hidden: true };
}

/** Drop every hover at once: the tip, and click-through back on the orb and swarm. */
function releaseHover() {
  if (hoverGuardImpl) hoverGuardImpl.release();
  else hideTipWindow();
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function fromOrb(sender) {
  const ids = [orbWindow, bubbleWindow, nudgeWindow, swarmWindow, menuWindow, tipWindow, ...pinWindows.values()]
    .filter(alive)
    .map((w) => w.webContents);
  return ids.some((wc) => wc === sender);
}

/** One panel/orb action: screen, region, text, find, web, or a typed aw-verb or sprite teach. */
async function orbAsk(what, text, slotId) {
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
        badge: badgeView(),
        summary: orbCore.queueSummary(queue),
        visible: orbVisible(),
        hold,
        holdActions: spiritCore.holdActions(hold, { hasBoard: Boolean(commandRegistry().byId("board.new")) }),
        results,
        // The asking card's stay rule and pin (card-stay.cjs, owner 2026-11-22).
        card: cardStay.normalizeCard(state.card),
        trips: { view: spiritCore.logView(tripLog), count: spiritCore.queueCount(tripQueue), line: spiritCore.queueLine(tripQueue) },
        tint: { name: tint.name, css: tint.css },
        attach: publicAttach(),
        mode: bubbleMode,
        modeTitle: bubbleMode === "card" && cardChat ? cardChat.title : null,
        modeWho: bubbleMode === "card" && cardChat ? cardChat.who : null,
        panel: panelOpen(),
        sprite: publicSprite(),
        nudge: nudging && nudging.shown ? nudging.view : null,
        nudgeLevel: nudging && !nudging.peek ? nudging.decision.level : 0,
        fairy: currentFairy(),
        companions: viewCompanions(currentCompanions()).visible,
        // Visual neurons: the setting and the live graph, so a page that loads
        // after the last flush still draws what is on screen.
        neurons: neuronPayload(),
        swarmView: swarmViewPayload(),
        mate: view === "pin" ? pinMateFor(sender) : null,
        menu: view === "menu" ? menuView() : null,
        tipDwellMs: fairyMenu.TIP_DWELL_MS,
        panelView: view === "bubble" ? currentPanelView() : null,
      };
    }),
    "desk:orb-hit": guard((_sender, inside) => {
      if (dragging) return { ok: true };
      hoverGuard().hit("orb", Boolean(inside), () => orbWindow.getBounds());
      return { ok: true };
    }),
    "desk:orb-drag-start": guard(() => beginDrag()),
    "desk:orb-drag-end": guard(() => endDrag()),
    "desk:orb-click": guard(() => toggleBubbleFromOrb()),
    // The badge click (fairy, 2026-11-06) lands on the SAME Inbox list every
    // other entry point uses. It opens; it never answers.
    // A HOVER never opens a card (owner 2026-11-12: "hovering over fairies causes
    // cards to keep popping and they change so fast"). A page that still asks is
    // refused; a hover shows a one-line tooltip (desk:fairy-tip), a click opens the card.
    "desk:orb-peek": guard(() => ({ ok: false, reason: "a hover never opens a card: click the fairy" })),
    "desk:fairy-tip": guard((_sender, text, point) => (text ? showTip(text, point) : hideTip())),
    // Right click: a companion's menu, or the orb's. A pick is checked against the menu shown.
    "desk:fairy-menu": guard((_sender, id, agent) => fairyMenuFor(id, agent)),
    "desk:orb-menu": guard(() => orbMenu()),
    "desk:menu-pick": guard((_sender, id) => menuPick(id)),
    "desk:menu-hover": guard((_sender, inside) => menuPointer(inside)),
    // A CLICK on a companion (or on one under the fairy's own disc): its newest card.
    "desk:orb-open-card": guard((_sender, id, agent) => openFairyCard(id, agent)),
    // The swarm is click-through except the companion under the pointer.
    // Click a companion: open a chat with that agent.
    "desk:orb-chat-agent": guard((_sender, agent) => chatWithAgent(agent)),
    // Fine control (fairy-control.cjs): select, scroll radius, drag out / back.
    "desk:swarm-select": guard((_sender, agent) => selectAgent(agent)),
    "desk:swarm-wheel": guard((_sender, deltaY) => swarmWheel(deltaY)),
    "desk:swarm-drag": guard((_sender, phase, agent, from) => swarmDrag(String(phase || ""), String(agent || ""), from === "pin" ? "pin" : "swarm")),
    "desk:swarm-hit": guard((_sender, inside) => {
      hoverGuard().hit("swarm", Boolean(inside), () => swarmWindow.getBounds());
      return { ok: true };
    }),
    "desk:orb-needs-you": guard(() => {
      void runCommandImpl?.("inbox.open");
      return { ok: true };
    }),
    "desk:orb-ask": guard(async (sender, verb, text, slotId) => {
      const what = String(verb || "");
      const r = await orbAsk(what, text, slotId);
      const said = { screen: "What's on my screen?", region: "Explain this region" }[what]
        || (what === "find" ? `Find ${String(text || "").trim()}` : what === "web" ? `Search ${String(text || "").trim()}` : String(text || "").trim());
      const a = exchangeText(r);
      if (said && a) {
        fairyPanel.recordExchange(panelHistory, panelKey(), { q: said, a, kind: r && r.ok === false ? "error" : "answer" });
        sendPanelView();
      }
      return r;
    }),
    // The panel's one-line session switcher: pick a session, or "" to follow the attach.
    "desk:panel-session": guard((_sender, id) => {
      const want = String(id || "");
      if (want === "detach") {
        panelSessionId = null;
        const r = detach({ silent: false });
        sendPanelView();
        return r;
      }
      panelSessionId = want || null;
      return { ok: true, view: sendPanelView() };
    }),
    // A card the attached session raised, answered from the panel: the ONE desk answer path.
    "desk:panel-answer": guard(async (_sender, id, key) => {
      const card = attentionCards.find((c) => c && c.id === String(id || ""));
      if (!card) return { ok: false, error: "that card is no longer open" };
      const opt = (card.options || []).find((o) => o && o.key === String(key || ""));
      if (!opt) return { ok: false, error: "that is not one of its options" };
      let verdict;
      try { verdict = await hookValue("answer", card.id, opt.key); } catch { verdict = false; }
      const ok = Boolean(verdict && (verdict === true || verdict.ok !== false));
      return ok ? { ok: true, id: card.id, key: opt.key } : { ok: false, error: (verdict && (verdict.flash || verdict.error)) || "the answer did not go through" };
    }),
    // The page measured its content: the window fits it (no dead space).
    "desk:panel-size": guard((_sender, px) => {
      const h = fairyPanel.fitHeight(px, { max: BUBBLE_SIZE.height });
      if (h !== bubbleHeight) {
        bubbleHeight = h;
        placeBubble();
      }
      return { ok: true, height: bubbleHeight };
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
    // The asking card's own pin (card-stay.cjs): stays open, drag to move, docks to
    // the nearest screen corner. Distinct from `desk:orb-pin`, which pins an ANSWER.
    "desk:orb-pin-card": guard((_sender, pinned) => setCardPin(pinned === true)),
    // Any activity in the open card restarts its opt-in idle timeout (OFF by default).
    "desk:orb-activity": guard(() => {
      touchCard();
      return { ok: true };
    }),
    "desk:orb-state": guard((_sender, next) => {
      drafting = Boolean(next && next.drafting);
      if (drafting) touchCard();
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
  // How the companion is drawn (display-mode.cjs): main restores the persisted mode.
  if (opts.display) display = displayMode.normalize(opts.display);
  ensureIpc();
  loadState();
  {
    // Hidden by default (owner 2026-11-13): an installed build that predates the rule
    // is moved to hidden ONCE; after that the person's own choice holds.
    const m = companionMenu.migrate(state, { packaged: opts.hideByDefault === true });
    if (m.changed) {
      state = m.state; // already sanitized: re-sanitizing would turn a null spot into 0,0
      saveState();
    }
  }
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
  fairyOwner.release();
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  if (flightTimer) { clearInterval(flightTimer); flightTimer = null; }
  if (toolFlightTimer) { clearTimeout(toolFlightTimer); toolFlightTimer = null; }
  toolFlightPlanner.reset();
  stopFollow();
  stopOrbit();
  clearDropReturn();
  if (pinDockTimer) { clearInterval(pinDockTimer); pinDockTimer = null; }
  pinDocks = new Map();
  ringOpen = false;
  ringReturn = null;
  if (seekTimer) { clearInterval(seekTimer); seekTimer = null; }
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
  if (spriteTimer) { clearInterval(spriteTimer); spriteTimer = null; }
  if (spriteKick) { clearTimeout(spriteKick); spriteKick = null; }
  if (clusterTimer) { clearInterval(clusterTimer); clusterTimer = null; }
  if (neuronTimer) { clearTimeout(neuronTimer); neuronTimer = null; }
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
  stopMenuIdle();
  menuIdleMsOverride = 0;
  if (fgProbeImpl) { try { fgProbeImpl.stop(); } catch { /* gone */ } fgProbeImpl = null; }
  for (const agent of [...pinWindows.keys()]) destroyPin(agent);
  for (const win of [menuWindow, tipWindow, nudgeWindow, veilWindow, bubbleWindow, orbWindow]) {
    try { if (alive(win)) win.destroy(); } catch { /* already gone */ }
  }
  menuWindow = null;
  menuState = null;
  tipWindow = null;
  if (hoverGuardImpl) hoverGuardImpl.release();
  hoverGuardImpl = null;
  if (panelTimer) { clearInterval(panelTimer); panelTimer = null; }
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
  // Visual neurons (command-registry neurons.toggle): a plain on/off switch.
  if (what === "neurons") return setNeurons(arg === "on" ? true : arg === "off" ? false : !neuronsOn());
  // The registry's companions.show / companions.hide (palette, jump list, bridge).
  if (what === "show-all" || what === "hide-all") return companionAction(what);
  // The fairy's menu from the keyboard (palette) or the bridge: the orb's menu, or a
  // card's menu when `arg` names an open card. Opens beside the fairy.
  if (what === "menu") {
    if (!orbVisible()) showOrb();
    const id = arg == null ? "" : String(arg).trim();
    return id ? fairyMenuFor(id, "", { atFairy: true }) : orbMenu({ atFairy: true });
  }
  // What the fairy is showing, as numbers: the bridge's way to check the screen
  // (POST /commands/run {"id":"fairy.counts"}). Opens nothing.
  if (what === "counts") {
    const counts = currentCounts();
    const companions = currentCompanions().map((m) => ({ agent: m.agent, label: m.label, count: m.count, kind: m.kind }));
    // Every decision is its own fairy now (fairy-cluster.cjs), so the per-agent badge
    // sum no longer applies; the cluster is checked against the queue instead.
    const problems = fairyCounts.problems(counts, []);
    const drawn = companions.reduce((a, m) => a + (m.kind === "decision" ? 1 : 0), 0)
      + (swarmCompanions.find((m) => m.kind === "more") || { waiting: 0 }).waiting;
    if (state.cluster !== false && drawn > counts.needYou) problems.push(`cluster draws ${drawn} decisions, needYou ${counts.needYou}`);
    return {
      ok: problems.length === 0,
      line: `${fairyCounts.badgeTitle(counts)}. The whisper says "${fairyAttention.moreLabel(counts.more) || "nothing more"}".`,
      counts,
      badge: badgeView(counts),
      companions,
      problems,
    };
  }
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
  startOrb, stopOrb, run, hoverGuard: () => hoverGuardImpl, ensureIpc, showOrb, hideOrb, toggleOrb, openBubble, setAttention,
  // attention: the fairy carries the cards (fairy-attention.cjs)
  NUDGE_SIZE, setAttentionCards, attentionTick, ownsAttention, carriesCards, nudgeAct, endNudge,
  nudgeCard, chatAboutCard, setSounds,
  // the agent fairy (agent-fairy.cjs): whose colours, which companions
  setSpeaker, peekCard, openFairyCard, fairyMenuFor, orbMenu, menuPick, showTip, hideTip,
  // the companions (companion-menu.cjs): hidden by default, one set of rows everywhere
  openCompanionMenu, companionAction, companionTrayItems, companionsState, onCompanionsChange,
  setTenantCompanion, setQuiet, tenantCompanionVisible: () => Boolean(state.tenantCompanion),
  quietUntil: () => (Number(state.muteUntil) > Date.now() ? Number(state.muteUntil) : 0),
  menuState: () => publicMenu(), __setMenuIdleMs: (ms) => { menuIdleMsOverride = Number(ms) || 0; }, fairy: () => currentFairy(), companions: () => currentCompanions(),
  setPresence, noteAgentPosted, chatWithAgent, setClusterSessions, clusterState, surfaceForCards,
  // tool flights: the fairy goes to the window an agent's tool call belongs to
  setReducedMotion, updateToolFlights, flightPlan: () => toolFlightPlan, surfaceRects,
  // visual neurons (neurons-model.cjs): the switch, a step, and the drawn graph
  setNeurons, noteNeuron, neuronsOn, neuronPayload,
  autoSurfaced: () => autoSurfaced,
  swarmViewOp, swarmViewPayload, selectAgent, swarmWheel, swarmDrag, pinAgent, viewCompanions, setView,
  pinWindows: () => pinWindows, __setForeground: (rect) => { fgContent = fairyControl.contentRect(rect); sendSwarmView(); },
  // Follow the focused window (plan A4): the tray toggle, the rule's inputs and outputs.
  setFollow, followState,
  // Drop behaviour (fairy-drop.cjs, owner 2026-11-23): the Settings default, one
  // fairy's own answer, and where the two live.
  setDropDefault, setDropBehavior, dropSettings, dropBehaviorFor,
  desktopRingOn, setDesktopRing, ringAtMode, setRingAt,
  // The asking card (card-stay.cjs, owner 2026-11-22): stay-open rule, pin and dock.
  setCardSettings, setCardPin, dockCard, cardOpen: () => cardOpen,
  __feedForeground: (fg) => { onForeground(fg); },
  __setFollowChangedAt: (t) => { followChangedAt = Number(t) || 0; },
  __followSeen: () => followSeen,
  __applyFollow: () => applyFollow(),
  __taskbar: () => taskbarRect,
  __refreshTaskbar: () => refreshTaskbar(),
  __swarmBounds: (n) => swarmBounds(n),
  __setProbe: (p) => { probe = p; },
  // Alt+Space press detection without stealing the foreground (owner 2026-11-23).
  keyState, warmProbe,
  // The ONE ring (owner 2026-11-23): fly to the centre, open the ring, fly back.
  setRingOpener, setExtraRunner, openRing, runRingExtra,
  __ringOpen: () => ringOpen,
  setSwarmAnchor, setSwarmVisible, swarmVisible: () => state.swarm === true,
  setDisplayModeState, displayModeState, displayModeInForce, displayPick,
  fairyBounds: () => (alive(orbWindow) && orbWindow.isVisible() ? orbWindow.getBounds() : null),
  swarmWindow: () => (alive(swarmWindow) ? swarmWindow : null), soundsOn: () => state.sounds !== false,
  nudging: () => (nudging ? { id: nudging.decision.card.id, level: nudging.decision.level, shown: nudging.shown } : null),
  attentionMems: () => attentionMems,
  askScreen, askRegion, askText, askImage, toggleBubbleFromOrb, beginDrag, endDrag,
  expandToAvatar, collapseToFairy, avatarMode, expanded: () => expanded,
  // one companion surface: the body's own window stands the fairy down and back
  orbVisible, fairyWanted: () => state.visible === true, stoodDown: () => stoodDownForAvatar,
  standDownForAvatar, returnFromAvatar, __suppressed: () => suppressed,
  stateFile, loadState, saveState, pump, queue: () => queue, state: () => state,
  // spirit
  go, sendHome, attachTo, detach, toggleAttach, cancelTrip, receiveDrop, pickResult, runHoldAction,
  hold: () => hold, results: () => results, attach: () => attach, tripLog: () => tripLog,
  __reset: () => {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    if (flightTimer) { clearInterval(flightTimer); flightTimer = null; }
    if (toolFlightTimer) { clearTimeout(toolFlightTimer); toolFlightTimer = null; }
    if (cardIdleTimer) { clearTimeout(cardIdleTimer); cardIdleTimer = null; }
    if (cardMoveTimer) { clearTimeout(cardMoveTimer); cardMoveTimer = null; }
    cardOpen = false;
    resultStream = [];
    toolFlightPlanner.reset();
    toolFlightPlan = { flights: [], returning: [], hover: [], throttled: [], reducedMotion: false };
    lastVeilKey = "";
    lastPanelOpen = null;
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
    companionListeners.clear();
    fairySpeaker = null;
    if (fairySpeakerTimer) { clearTimeout(fairySpeakerTimer); fairySpeakerTimer = null; }
    lastFairyKey = "";
    lastCompanionsKey = "";
    swarmCompanions = [];
    clusterSessions = [];
    clusterOk = { cards: true, sessions: true, presence: true };
    clusterReaper.reset();
    autoSurfaced = false;
    ownerHidIds = null;
    if (clusterTimer) { clearInterval(clusterTimer); clusterTimer = null; }
    allCompanions = [];
    selectedAgent = "";
    pinDrag = null;
    if (pinWatchdog) { clearTimeout(pinWatchdog); pinWatchdog = null; }
    clearDropReturn();
    manualPlacement = false;
    resolvingDrop = false;
    pinDocks = new Map();
    if (pinDockTimer) { clearInterval(pinDockTimer); pinDockTimer = null; }
    ringOpen = false;
    ringReturn = null;
    fgContent = null;
    followSeen = null;
    followChangedAt = 0;
    followBusy = false;
    followRetries = 0;
    if (followDebounce) { clearTimeout(followDebounce); followDebounce = null; }
    stopTaskbarWatch();
    taskbarRect = null;
    taskbarBars = [];
    probe = null; // a fake injected by a test never outlives it
    lastSwarmViewKey = "";
    lastCompanionsWho = "";
    neurons.reset();
    lastNeuronStates.clear();
    lastNeuronPayload = "";
    if (neuronTimer) { clearTimeout(neuronTimer); neuronTimer = null; }
    lastBounds = null;
    display = displayMode.normalize(null);
    swarmPinAgents = new Set();
    if (fgProbeImpl) { try { fgProbeImpl.stop(); } catch { /* gone */ } fgProbeImpl = null; }
    for (const agent of [...pinWindows.keys()]) destroyPin(agent);
    agentPresence = [];
    agentPosts = new Map();
    if (agentPostTimer) { clearTimeout(agentPostTimer); agentPostTimer = null; }
    cardChat = null;
    stopMenuIdle();
    menuIdleMsOverride = 0;
    for (const win of [menuWindow, tipWindow, swarmWindow, nudgeWindow, veilWindow, bubbleWindow, orbWindow]) {
      try { if (alive(win)) win.destroy(); } catch { /* gone */ }
    }
    menuWindow = null;
    menuState = null;
    tipWindow = null;
    if (hoverGuardImpl) hoverGuardImpl.release();
    hoverGuardImpl = null;
    if (panelTimer) { clearInterval(panelTimer); panelTimer = null; }
    panelSessionId = null;
    panelHistory = new Map();
    panelSessions = { rows: null, note: "" };
    bubbleHeight = 180;
    nudgeWindow = null;
    swarmWindow = null;
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
    expanded = false;
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
  setReservedBox,
  setDockWindow,
  __dock: () => ({ windowId: dockWindowId, attached: Boolean(attach && attach.auto) }),
  __homeFlight: () => homeFlight,
  __reservedBox: () => reservedBox,
  __dockSpot: (target) => dockSpot(target),
  __refreshObstacles: () => refreshAllObstacles(),
  __setCapture: (c) => { captureImpl = c; },
  __setAskVision: (f) => { askVisionImpl = f; },
  __setSpeak: (f) => { speakImpl = f; },
  __setAvatarTargets: (f) => { avatarTargetsImpl = f; },
  __setOps: (o) => { ops = o; },
  __setWired: () => { wired = true; },
  __setTripLimitMs: (ms) => { TRIP_LIMIT_MS = Number(ms) || 120_000; },
  // The veil's layout AND the orb's move both leaked (2026-11-07); assert them directly.
  __test: { clampRect, coverVeil, drawVeil, moveOrb, veilPlacement, veilRect },
  __setAttentionHooks: (h) => { attentionHooks = { ...(h || {}) }; },
  __resetAttentionClock: () => { attentionLastAt = 0; attentionVoiceAt = 0; attentionOlderAt = 0; },
};
