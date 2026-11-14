"use strict";

/**
 * companion-menu.cjs -- the ONE list of what a person can do about the desk's
 * companions, read by the right-click menu on every companion and by the tray.
 *
 * Owner, 2026-11-13 (a bug from Jason, relayed): "on his desktop he sees BOTH the
 * fairy and the goblin overlays and cannot hide them or anything. Hide them by
 * default, and get the whole right-click menu working so everything is easily
 * accessible to anyone on desktop."
 *
 * The companions:
 *   fairy   the desk's own cluster: the "Aither spirit" orb and the swarm around it
 *           (orb-window.cjs). One cluster, one switch -- never per sprite.
 *   tenant  the companion a tenant site draws on its own page (`[data-companion]`,
 *           GARG's goblin) inside the desk's AitherOS windows (living-desktop-window).
 *
 * Both are HIDDEN until somebody shows them (orb.json `visible` / `tenantCompanion`,
 * per user). An install that existed before this rule is moved to hidden once
 * (`companionsV`), and only when it is a packaged install -- a dev checkout keeps
 * what its owner left.
 *
 * Every item here is wired: orb-window.companionAction runs each id. A menu never
 * shows an item that would do nothing (Show all while everything shows, End quiet
 * while not quiet).
 *
 * PURE: no electron, no fs. The caller owns the clock.
 */

const HOUR = 3600_000;

/** orb.json migration version: 1 = "companions hidden by default" has been applied. */
const COMPANIONS_VERSION = 1;

const QUIETS = Object.freeze({ "quiet-1h": 1, "quiet-4h": 4 });

/** Every id this module can put on a menu. */
const IDS = Object.freeze([
  "hide-this", "hide-all", "show-all",
  "open-desktop", "open-spaces", "open-chat", "settings",
  "quiet-1h", "quiet-4h", "quiet-off",
  "quit",
]);

function isCompanionId(id) {
  return IDS.includes(String(id || ""));
}

/** When a quiet id runs out, or null for an id that is not a quiet. */
function quietUntilFor(id, nowMs) {
  const hours = QUIETS[String(id || "")];
  return hours ? (Number(nowMs) || Date.now()) + hours * HOUR : null;
}

function clockLabel(ms) {
  const d = new Date(Number(ms) || 0);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Apply the hidden-by-default rule to a sanitized orb state, once.
 *
 * Args:
 *   state: orb-core.sanitizeState output.
 *   opts.packaged: this is an installed build (app.isPackaged). Only an installed
 *     build is moved to hidden; a fresh state (no orb.json) is hidden either way
 *     because sanitizeState defaults both switches off.
 *
 * Returns {state, changed}.
 */
function migrate(state, { packaged = false } = {}) {
  const s = { ...(state || {}) };
  if (Number(s.companionsV) >= COMPANIONS_VERSION) return { state: s, changed: false };
  if (packaged) {
    s.visible = false;
    s.tenantCompanion = false;
  }
  s.companionsV = COMPANIONS_VERSION;
  return { state: s, changed: true };
}

/**
 * The companion rows.
 *
 * Args:
 *   opts.target: "fairy" | "tenant" | null -- the companion that was right-clicked
 *     (null: the tray, which is about all of them).
 *   opts.fairyVisible / opts.tenantVisible: what shows now.
 *   opts.quietUntil: ms epoch quiet mode ends (0 = not quiet).
 *   opts.nowMs: the clock.
 *   opts.doors: include the doors (desktop, Spaces, chat, settings, quit). The tray
 *     already carries chat, settings and quit in its own groups and passes
 *     {doors: "tray"} to get only the two it lacks at the top level.
 *
 * Returns items: {id, label, hint} or {sep:true}; never a disabled item.
 */
function items({
  target = null, fairyVisible = false, tenantVisible = false, quietUntil = 0, nowMs = Date.now(), doors = true,
} = {}) {
  const out = [];
  if (target === "fairy" && fairyVisible) {
    out.push({ id: "hide-this", label: "Hide the fairies", hint: "The tray icon brings them back" });
  } else if (target === "tenant" && tenantVisible) {
    out.push({ id: "hide-this", label: "Hide this companion", hint: "The tray icon brings it back" });
  }
  if (fairyVisible || tenantVisible) {
    out.push({ id: "hide-all", label: "Hide all companions", hint: "The fairies and the workspace's own companion" });
  }
  if (!fairyVisible || !tenantVisible) {
    out.push({ id: "show-all", label: "Show all companions", hint: "The fairies and the workspace's own companion" });
  }
  out.push({ sep: true });
  out.push({ id: "open-desktop", label: "Open AitherOS desktop", hint: "Your workspace desktop" });
  out.push({ id: "open-spaces", label: "Open Spaces", hint: "Spaces in the Aither Browser" });
  if (doors !== "tray") {
    out.push({ id: "open-chat", label: "Chat with Aither", hint: "Talk to Aither" });
    out.push({ id: "settings", label: "Settings", hint: "Desk settings" });
  }
  out.push({ sep: true });
  if (Number(quietUntil) > Number(nowMs)) {
    out.push({ id: "quiet-off", label: `End quiet mode (until ${clockLabel(quietUntil)})`, hint: "Popups and nudges come back" });
  } else {
    out.push({ id: "quiet-1h", label: "Quiet for 1 hour", hint: "No popups, nudges or chimes for an hour" });
    out.push({ id: "quiet-4h", label: "Quiet for 4 hours", hint: "No popups, nudges or chimes for four hours" });
  }
  if (doors !== "tray") {
    out.push({ sep: true });
    out.push({ id: "quit", label: "Quit Aither", hint: "Close the desk app" });
  }
  return out;
}

/** Plain Electron menu rows for `list` (no electron needed to check the shape). */
function menuRows(list, run) {
  const rows = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item) continue;
    if (item.sep) {
      if (rows.length && rows[rows.length - 1].type !== "separator") rows.push({ type: "separator" });
      continue;
    }
    rows.push({ label: item.label, click: () => run(item.id) });
  }
  while (rows.length && rows[rows.length - 1].type === "separator") rows.pop();
  return rows;
}

module.exports = {
  COMPANIONS_VERSION,
  IDS,
  isCompanionId,
  quietUntilFor,
  clockLabel,
  migrate,
  items,
  menuRows,
};
