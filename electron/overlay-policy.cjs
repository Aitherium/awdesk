"use strict";

/**
 * overlay-policy.cjs -- WHEN the desk may bring the AitherOS Online overlay (and the
 * other surfaces it raises by itself) onto the screen.
 *
 * Report, 2026-10-14: the overlay "randomly pops up on the side of the monitor". Every
 * door that shows it without a click now names a TRIGGER, and this module answers
 * whether that trigger may act under the user's settings (cast.json `overlay`,
 * cast-config.cjs OVERLAY_FIELDS):
 *
 *   user          a tray click, a hotkey, a menu row, a desk:// link, a CLI flag.
 *                 ALWAYS allowed -- an explicit action is never second-guessed.
 *   start         Desk starting up             -> overlay.autoOpenOnStart (default off)
 *   edge          the cursor resting at an edge -> overlay.edgeReveal      (default off)
 *   request       another program asked: an agent's MCP desktop_open, a loopback POST
 *                 /desktop/overlay, a bridge-run command. Allowed (it is usually the
 *                 user asking through an agent or the browser extension) except under
 *                 Do not disturb.
 *   workspace     the desk opening the signed-in WORKSPACE by itself: a customer desk's
 *                 taskbar at start, the AitherDesktop window after a sign-in
 *                 -> overlay.workspaceAutoOpen (default ON: unchanged for everyone)
 *
 * overlay.doNotDisturb suppresses EVERY trigger but `user`. overlay.workspaceAutoOpen
 * off does the same for the workspace pop-ups AND every other automatic door (customer
 * report, customer report 2026-11-19: "an Aitherium sidebar keeps popping up" -- one switch that
 * means "never open a workspace window unless I click"). An unknown trigger is
 * refused: a new automatic door must be named here before it can raise anything.
 *
 * THERE IS NO `notification` DOOR (A1, attention plan): a decision card arrives as an
 * OS toast and never opens a window, so `overlay.raiseOnNotifications` had no window
 * left to raise and its switch was removed everywhere (settings, tray/palette row,
 * cast.json). The old key in an existing cast.json is ignored, not an error.
 *
 * Pure (no electron): every decision is asserted under `node --test`.
 */

const TRIGGERS = Object.freeze({
  USER: "user",
  START: "start",
  EDGE: "edge",
  REQUEST: "request",
  WORKSPACE: "workspace",
});

const EDGES = Object.freeze(["left", "right", "top", "bottom"]);
const DWELL_MIN_MS = 150;
const DWELL_MAX_MS = 5000;

/** The quiet defaults: nothing appears unless the user asks for it. */
const DEFAULTS = Object.freeze({
  autoOpenOnStart: false,
  edgeReveal: false,
  edge: "right",
  edgeDwellMs: 600,
  doNotDisturb: false,
  // Not a door: where the Inbox and Fleet doors LEAD (space-home.cjs). Off = as before.
  spaceHome: false,
  // The workspace pop-ups (customer taskbar at start, the window after sign-in). ON keeps
  // the behaviour every desk had; OFF = nothing workspace-shaped opens unless clicked.
  workspaceAutoOpen: true,
});

/** Which setting gates which automatic trigger. */
const TRIGGER_FLAG = Object.freeze({
  [TRIGGERS.START]: "autoOpenOnStart",
  [TRIGGERS.EDGE]: "edgeReveal",
  [TRIGGERS.WORKSPACE]: "workspaceAutoOpen",
});

/** The resolved settings, every field present and valid; anything else -> its default. */
function normalize(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const bool = (key) => (typeof r[key] === "boolean" ? r[key] : DEFAULTS[key]);
  const dwell = Number.isInteger(r.edgeDwellMs) && r.edgeDwellMs >= DWELL_MIN_MS && r.edgeDwellMs <= DWELL_MAX_MS
    ? r.edgeDwellMs : DEFAULTS.edgeDwellMs;
  return {
    autoOpenOnStart: bool("autoOpenOnStart"),
    edgeReveal: bool("edgeReveal"),
    edge: EDGES.includes(r.edge) ? r.edge : DEFAULTS.edge,
    edgeDwellMs: dwell,
    doNotDisturb: bool("doNotDisturb"),
    spaceHome: bool("spaceHome"),
    workspaceAutoOpen: bool("workspaceAutoOpen"),
  };
}

/**
 * A settings patch from a renderer or a menu row, reduced to known keys with valid
 * values. Junk is dropped (never written), so cast.json cannot learn a bad value here.
 * @returns {object} possibly empty
 */
function cleanPatch(patch) {
  const p = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const out = {};
  for (const key of ["autoOpenOnStart", "edgeReveal", "doNotDisturb", "spaceHome", "workspaceAutoOpen"]) {
    if (typeof p[key] === "boolean") out[key] = p[key];
  }
  if (EDGES.includes(p.edge)) out.edge = p.edge;
  if (Number.isInteger(p.edgeDwellMs) && p.edgeDwellMs >= DWELL_MIN_MS && p.edgeDwellMs <= DWELL_MAX_MS) {
    out.edgeDwellMs = p.edgeDwellMs;
  }
  return out;
}

/**
 * May `trigger` raise a surface right now?
 * @param {object} settings  overlay settings (raw or normalized)
 * @param {string} trigger   one of TRIGGERS
 * @returns {{allow: boolean, reason: string}}
 */
function decide(settings, trigger) {
  if (trigger === TRIGGERS.USER) return { allow: true, reason: "explicit user action" };
  const s = normalize(settings);
  if (!Object.values(TRIGGERS).includes(trigger)) {
    return { allow: false, reason: `unknown trigger ${JSON.stringify(trigger)}` };
  }
  if (s.doNotDisturb) return { allow: false, reason: "do not disturb is on" };
  if (!s.workspaceAutoOpen) return { allow: false, reason: "overlay.workspaceAutoOpen is off" };
  if (trigger === TRIGGERS.REQUEST) return { allow: true, reason: "requested by another program" };
  const flag = TRIGGER_FLAG[trigger];
  return s[flag]
    ? { allow: true, reason: `overlay.${flag} is on` }
    : { allow: false, reason: `overlay.${flag} is off` };
}

/** Is the cursor on `edge` of `bounds` (within `px` pixels)? */
function atEdge(cursor, bounds, edge, px = 2) {
  if (!cursor || !bounds) return false;
  const { x, y } = cursor;
  const inX = x >= bounds.x && x < bounds.x + bounds.width;
  const inY = y >= bounds.y && y < bounds.y + bounds.height;
  if (edge === "left") return inY && x >= bounds.x && x <= bounds.x + px;
  if (edge === "right") return inY && x <= bounds.x + bounds.width - 1 && x >= bounds.x + bounds.width - 1 - px;
  if (edge === "top") return inX && y >= bounds.y && y <= bounds.y + px;
  if (edge === "bottom") return inX && y <= bounds.y + bounds.height - 1 && y >= bounds.y + bounds.height - 1 - px;
  return false;
}

/**
 * The edge-reveal watcher. `tick()` is driven by a timer in main (and by hand in
 * tests): it reveals ONCE per dwell -- the cursor must leave the edge before it can
 * fire again -- and never while the policy says no (edge off, or do not disturb).
 *
 * @param {object} deps
 * @param {() => object} deps.settings   the current overlay settings
 * @param {() => {x:number,y:number}} deps.cursor
 * @param {() => {x:number,y:number,width:number,height:number}} deps.bounds  the display
 * @param {() => boolean} deps.visible   is the overlay already on screen
 * @param {() => void} deps.reveal       show it
 * @param {() => number} [deps.now]
 */
function createEdgeWatcher({ settings, cursor, bounds, visible, reveal, now = Date.now }) {
  let since = null; // when the cursor arrived at the edge
  let fired = false; // revealed during this stay at the edge
  function tick() {
    const s = normalize(settings());
    if (!decide(s, TRIGGERS.EDGE).allow) {
      since = null;
      fired = false;
      return false;
    }
    let here;
    try { here = atEdge(cursor(), bounds(), s.edge); } catch { here = false; }
    if (!here) {
      since = null;
      fired = false;
      return false;
    }
    const t = now();
    if (since === null) since = t;
    if (fired || t - since < s.edgeDwellMs) return false;
    fired = true;
    if (visible()) return false;
    reveal();
    return true;
  }
  return { tick, reset: () => { since = null; fired = false; } };
}

/**
 * Would running registry command `id` put the overlay on screen? (main gates these when
 * another program runs them over the bridge.) The toggle shows a hidden overlay; a shell
 * pick opens a closed one (living-desktop-window setShell).
 * @param {string} id
 * @param {object|null} command  the registry record
 * @param {{open?: boolean, visible?: boolean}} overlay  desktopStatus().overlay
 */
function wouldShowOverlay(id, command, overlay) {
  const o = overlay || {};
  if (id === "desktop.overlay.toggle") return !o.visible;
  if (command && typeof command === "object" && "shell" in command) return !o.open;
  return false;
}

module.exports = {
  TRIGGERS, EDGES, DEFAULTS, DWELL_MIN_MS, DWELL_MAX_MS,
  normalize, cleanPatch, decide, atEdge, createEdgeWatcher, wouldShowOverlay,
};
