"use strict";

/**
 * goblin-window.cjs -- summon and dismiss GargBot's goblin on the owner's desk.
 *
 * One small frameless always-on-top window (goblin.html). Summon grows it out of the
 * fairy's spot with avatar-grow.cjs's frames; dismiss shrinks it back into the fairy and
 * closes it. The window is created on summon and destroyed on dismiss, so a dismissed
 * goblin costs nothing. electron is injected (tests pass a fake).
 */

const path = require("node:path");
const avatarGrow = require("./avatar-grow.cjs");
const core = require("./goblin-core.cjs");

function createGoblin({ electron, onChange = () => {}, onDismissRequest = null, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  let win = null;
  let busy = false;
  let weapon = "noodle";
  let mood = "idle";
  let moodTimer = null;

  const alive = () => Boolean(win && !win.isDestroyed());

  function push() {
    if (alive()) {
      try { win.webContents.send("goblin:state", { weapon, mood }); } catch { /* page still loading: it paints its own default */ }
    }
  }

  function setMood(next, { forMs = 0 } = {}) {
    mood = core.moodOf(next);
    push();
    if (moodTimer) { clearTimeout(moodTimer); moodTimer = null; }
    if (forMs > 0) {
      moodTimer = setTimeout(() => { moodTimer = null; mood = "idle"; push(); }, forMs);
      if (moodTimer.unref) moodTimer.unref();
    }
    return { ok: true, mood };
  }

  async function playFrames(frames) {
    for (const frame of frames) {
      if (!alive()) return;
      try { win.setBounds(frame.bounds); win.setOpacity(frame.opacity); } catch { /* mid-teardown */ }
      await wait(avatarGrow.FRAME_MS);
    }
  }

  /** Grow the goblin out of `from` (the fairy's bounds, or null). */
  async function summon({ from = null, weapon: wanted = weapon } = {}) {
    if (alive()) return { ok: true, summoned: true, already: true };
    if (busy) return { ok: false, error: "the goblin is already moving" };
    busy = true;
    try {
      const { BrowserWindow, screen } = electron;
      weapon = core.weaponOf(wanted);
      const point = from ? { x: Math.round(from.x + from.width / 2), y: Math.round(from.y + from.height / 2) } : screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(point).workArea;
      const to = core.standBounds(from, area);
      const frames = avatarGrow.growFrames(from, to);
      win = new BrowserWindow({
        ...frames[0].bounds, show: false, frame: false, transparent: true, resizable: false, minimizable: false,
        maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
        focusable: false, title: "GargBot goblin", backgroundColor: "#00000000",
        webPreferences: { preload: path.join(__dirname, "goblin-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
      });
      win.setAlwaysOnTop(true, "screen-saver");
      try { win.setMinimumSize(1, 1); } catch { /* older electron */ }
      win.setOpacity(0);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.on("closed", () => { win = null; onChange({ summoned: false }); });
      // The whole body is a drag region (to move him), and on Windows a drag region answers a right
      // click with the native system menu: the DOM contextmenu never fires. Take it here: a right click
      // on the goblin sends him back into the fairy (review of #96).
      win.on("system-context-menu", (event) => {
        event.preventDefault();
        // The same path the DOM right click takes (the swarm shrinks him into the fairy), never a bare dismiss.
        if (typeof onDismissRequest === "function") onDismissRequest(); else void dismiss();
      });
      const loaded = win.loadFile(path.join(__dirname, "goblin.html"), { query: { weapon } });
      await Promise.race([loaded, wait(4000)]);
      win.showInactive();
      await playFrames(frames);
      if (alive()) { win.setBounds(to); win.setOpacity(1); }
      setMood("happy", { forMs: 1800 });
      onChange({ summoned: true });
      return { ok: true, summoned: true, bounds: to };
    } catch (error) {
      log("goblin summon failed", error && error.message);
      if (alive()) { try { win.destroy(); } catch { /* gone */ } }
      win = null;
      return { ok: false, error: String((error && error.message) || error) };
    } finally {
      busy = false;
    }
  }

  /** Shrink the goblin back into `to` (the fairy's bounds, or null) and close it. */
  async function dismiss({ to = null } = {}) {
    if (!alive()) return { ok: true, summoned: false, already: true };
    if (busy) return { ok: false, error: "the goblin is already moving" };
    busy = true;
    try {
      const body = win.getBounds();
      await playFrames(avatarGrow.shrinkFrames(body, to));
      if (alive()) win.destroy();
      win = null;
      onChange({ summoned: false });
      return { ok: true, summoned: false };
    } finally {
      busy = false;
    }
  }

  function setWeapon(next) {
    weapon = core.weaponOf(next);
    push();
    return { ok: true, weapon };
  }

  return {
    summon,
    dismiss,
    setMood,
    setWeapon,
    isSummoned: () => alive(),
    window: () => (alive() ? win : null),
    bounds: () => (alive() ? win.getBounds() : null),
  };
}

module.exports = { createGoblin };
