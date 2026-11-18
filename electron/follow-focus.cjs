"use strict";

/**
 * follow-focus.cjs -- should the fairy cluster attach to the window the owner just
 * switched to? (attention plan A4.)
 *
 * The desk already knows WHERE the focused window is: foreground-probe.cjs keeps one
 * resident PowerShell answering GetForegroundWindow. What was missing is the RULE
 * that turns "the focus moved" into one attach target -- or none. That rule is pure
 * and lives here, so `node --test` can assert it with no display, no timers and no
 * PowerShell.
 *
 * The rule (owner 2026-11-18, plan A4):
 *   - only while "Fairies follow my window" is on (default on);
 *   - the focus must HOLD for SETTLE_MS, so alt-tabbing through windows never drags
 *     the cluster across the screen;
 *   - never the desk's own window (pid), never a full-screen app or game, never a
 *     window too small to stand on;
 *   - an attach the owner made by hand is never stolen.
 *
 * What this module does NOT answer: how quickly the cluster reaches the window once
 * attached. That is the live 4 Hz tether plus the probe interval; it is a measured
 * fact, never something a unit test may claim.
 */

/** The focus has to hold this long before the cluster moves to it. */
const SETTLE_MS = 400;
/** A window narrower or shorter than this is not a place to stand. */
const MIN_TARGET_PX = 40;
/** Shell windows that are never "the window I am working in". */
const SHELL_CLASSES = new Set(["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The rideable target a foreground descriptor describes, or null. */
function targetFromForeground(fg) {
  if (!fg || typeof fg !== "object") return null;
  const x = num(fg.x);
  const y = num(fg.y);
  const width = num(fg.width);
  const height = num(fg.height);
  if ([x, y, width, height].some((v) => v === null) || width < MIN_TARGET_PX || height < MIN_TARGET_PX) return null;
  if (SHELL_CLASSES.has(String(fg.cls || ""))) return null;
  return {
    kind: "window",
    hwnd: num(fg.hwnd),
    title: String(fg.title || fg.cls || "a window").slice(0, 200),
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
    follow: true,
  };
}

/**
 * decideFollow({enabled, fg, attach, changedAt, now, settleMs, ownPid}) ->
 *   {act: "none"|"attach"|"release", target?: {...}, reason: string}
 *
 * `fg` is the foreground descriptor from foreground-probe.cjs
 * ({hwnd, pid, cls, title, x, y, width, height, quiet}) or null.
 * `attach` is the CURRENT attachment ({kind, hwnd, follow, auto}) or null.
 * `changedAt` is when `fg` last changed; `now` is the clock.
 */
function decideFollow({
  enabled = false,
  fg = null,
  attach = null,
  changedAt = 0,
  now = Date.now(),
  settleMs = SETTLE_MS,
  ownPid = null,
} = {}) {
  if (enabled !== true) return { act: "none", reason: "follow is off" };
  if (!fg) return { act: "none", reason: "no window in front" };

  const following = Boolean(attach && attach.follow === true);
  const release = (reason) => (following ? { act: "release", reason } : { act: "none", reason });

  // The desk's own windows: the overlay, the console, the orb. The cluster docks on
  // the AitherOS window through setDockWindow; it must never "follow" itself.
  if (ownPid != null && Number(fg.pid) === Number(ownPid)) return release("the desk's own window");
  if (SHELL_CLASSES.has(String(fg.cls || ""))) return release("the desktop shell");

  // A full-screen app, game or presentation: the plan's own exclusion.
  if (fg.quiet) return release(String(fg.quiet));

  const target = targetFromForeground(fg);
  if (!target) return release("too small to ride");

  // Already riding exactly that window: the tether moves it, this rule does nothing.
  if (following && target.hwnd != null && Number(attach.hwnd) === Number(target.hwnd)) {
    return { act: "none", reason: "already following it" };
  }
  // A hand-placed fairy stays where the owner put it.
  if (attach && attach.follow !== true && attach.auto !== true) return { act: "none", reason: "attached by hand" };

  // Debounce: a focus that just landed may be an alt-tab in flight. An unknown
  // change time counts as held (the caller simply has no clock for it).
  const held = num(changedAt) == null ? Infinity : Math.max(0, Number(now) - Number(changedAt));
  if (held < Math.max(0, Number(settleMs) || 0)) {
    return { act: "none", reason: "waiting for the focus to settle" };
  }
  return { act: "attach", target, reason: "the focus moved" };
}

/** Turning the toggle off lets go of an attach FOLLOW made; a hand attach is untouched. */
function releaseOnDisable(attach) {
  return Boolean(attach && attach.follow === true);
}

module.exports = { SETTLE_MS, MIN_TARGET_PX, targetFromForeground, decideFollow, releaseOnDisable };
