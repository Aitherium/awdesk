"use strict";

/**
 * game-posture -- Desk stands down while the host posture is "Game on".
 *
 * Owner, 2026-10-16 21:33: "i launched the game and there is a bunch of lag just in the
 * start menu". Measured that night: one HIDDEN Desk renderer at 4.5-7 cores and the Desk
 * GPU process at 1-2.4 cores, every Desk process at ABOVE_NORMAL. On the owner's box
 * Desk turns Chromium's background throttling off app-wide (main.cjs: renderer
 * backgrounding and occlusion off, `backgroundThrottling: false` on the avatar) so the
 * avatar never drops to 1 fps -- which also lets a hidden window keep animating, drawn in
 * software (present-policy.cjs), ahead of the game.
 *
 * Host posture (AitherOS/lib/core/HostPosture.py): ~/.aither/posture.json says
 * `desired: "game"` (with no `until`, or one in the future), or ~/.aither/gaming.lock is
 * active (the same rule fleet_verbs.py applies). While it holds, every 10 s:
 *
 *   - every window's webContents.setBackgroundThrottling(true) (its previous value is
 *     kept and restored), so a hidden or covered page stops animating;
 *   - the always-on-top avatar overlay is hidden (and hidden again if something re-shows
 *     it), then shown again after the game only if it was visible before;
 *   - every Desk process drops to BELOW_NORMAL, restored after the game.
 *
 * Startup switches (occlusion, renderer backgrounding) cannot change at runtime; the
 * per-window throttle is what makes a hidden page stop. Pure core (createGamePosture) with
 * injected effects; startGamePosture wires it to Electron.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BELOW = os.constants.priority.PRIORITY_BELOW_NORMAL;
const GAMING_LOCK_DEFAULT_MS = 12 * 3600 * 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // absent or corrupt: not a game signal
  }
}

/** True while the host posture is "Game on" (posture.json) or the gaming lock is active. */
function hostIsGaming({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const aither = path.join(home, ".aither");
  const postureFile = (env && env.AITHER_POSTURE_FILE) || path.join(aither, "posture.json");
  const doc = readJson(postureFile);
  if (doc && doc.desired === "game") {
    const until = doc.until ? Date.parse(doc.until) : NaN;
    if (!doc.until || (Number.isFinite(until) && until > now)) return true;
  }
  const lockFile = (env && env.AITHER_GAMING_LOCK) || path.join(aither, "gaming.lock");
  let stat;
  try {
    stat = fs.statSync(lockFile);
  } catch {
    return false;
  }
  const lock = readJson(lockFile);
  const expires = lock && lock.expires ? Date.parse(lock.expires) : NaN;
  if (Number.isFinite(expires)) return expires > now;
  return now - stat.mtimeMs < GAMING_LOCK_DEFAULT_MS;
}

/**
 * @param deps.read            () => boolean, the host is gaming
 * @param deps.overlayVisible  () => boolean
 * @param deps.hideOverlay / showOverlay
 * @param deps.restorePriority the priority to put back after the game (null = leave it)
 */
function createGamePosture({ app, BrowserWindow, read, overlayVisible, hideOverlay, showOverlay,
  restorePriority = null, setPriority = os.setPriority, log = () => {} }) {
  let active = false;
  let overlayWasVisible = false;
  const previous = new Map(); // webContents id -> its throttling before the game

  const windows = () => BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed());
  const pids = () => {
    try {
      return app.getAppMetrics().map((m) => m.pid);
    } catch {
      return [];
    }
  };
  const prioritise = (p) => {
    if (p == null) return;
    for (const pid of pids()) {
      try {
        setPriority(pid, p);
      } catch {
        /* exited between the listing and the call */
      }
    }
  };

  function standDown() {
    for (const w of windows()) {
      const wc = w.webContents;
      if (!wc) continue;
      if (!previous.has(wc.id)) {
        let was = false;
        try {
          was = typeof wc.getBackgroundThrottling === "function" ? wc.getBackgroundThrottling() : false;
        } catch {
          was = false;
        }
        previous.set(wc.id, was);
      }
      try {
        wc.setBackgroundThrottling(true);
      } catch {
        /* a window mid-teardown */
      }
    }
    if (overlayVisible()) {
      overlayWasVisible = true;
      void hideOverlay();
    }
    prioritise(BELOW);
  }

  function standUp() {
    for (const w of windows()) {
      const wc = w.webContents;
      if (!wc || !previous.has(wc.id)) continue;
      try {
        wc.setBackgroundThrottling(previous.get(wc.id));
      } catch {
        /* a window mid-teardown */
      }
    }
    previous.clear();
    if (overlayWasVisible) showOverlay();
    overlayWasVisible = false;
    prioritise(restorePriority);
  }

  function tick() {
    let gaming = false;
    try {
      gaming = Boolean(read());
    } catch {
      gaming = false;
    }
    if (gaming) {
      if (!active) log("game posture: Game on -- Desk stands down");
      active = true;
      standDown(); // idempotent; also catches windows opened and overlays re-shown mid-game
    } else if (active) {
      active = false;
      log("game posture: game over -- Desk back");
      standUp();
    }
    return active;
  }

  return { tick, active: () => active };
}

/** Wire it to Electron: a 10 s timer (unref'd) plus one tick now. */
function startGamePosture({ app, BrowserWindow, overlayVisible, hideOverlay, showOverlay,
  restorePriority = null, log = () => {}, intervalMs = 10000, setIntervalFn = setInterval }) {
  const gp = createGamePosture({
    app, BrowserWindow, read: () => hostIsGaming(), overlayVisible, hideOverlay, showOverlay,
    restorePriority, log,
  });
  gp.tick();
  const timer = setIntervalFn(() => gp.tick(), intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return gp;
}

module.exports = { BELOW, createGamePosture, hostIsGaming, startGamePosture };
