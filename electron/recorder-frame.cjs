"use strict";

/**
 * recorder-frame.cjs -- the VISIBLE frame around a live region recording (owner
 * 2026-11-02: "I dragged a box but can't see the box"; "should be able to resize
 * the recording area on the fly").
 *
 * WHAT IT IS. One frameless, transparent, always-on-top window whose bounds are
 * the region INFLATED by FRAME_BAND, so the border and its grab handles are drawn
 * strictly OUTSIDE the pixels being recorded. It also carries
 * setContentProtection(true) (WDA_EXCLUDEFROMCAPTURE) as a second belt: on a
 * display where the OS clips the band at a screen edge, nothing reappears in the
 * capture. recorder-core.cjs owns every number (frameWindowBounds, frameHandles,
 * hitFrameHandle, dragRegion); this module owns only the window.
 *
 * CLICK-THROUGH WITH LIVE HANDLES. The window is setIgnoreMouseEvents(true,
 * {forward:true}) at rest: the desktop underneath keeps every click, while mouse
 * MOVES are still forwarded to the page so it can say "the pointer is on a
 * handle". On that signal the window becomes interactive (setIgnoreMouseEvents
 * false), and the page's own down/up drive a drag. The RESIZE ITSELF is polled
 * here from screen.getCursorScreenPoint(), because the cursor leaves the
 * (resizing) window mid-drag and renderer move events cannot be trusted then.
 *
 * Every window handle is destroyed by recorder-window.cjs's finish()/failure
 * paths; this module never throws into them.
 */

const path = require("node:path");
const core = require("./recorder-core.cjs");

let electronImpl = null;
function electron() {
  return electronImpl ? electronImpl() : require("electron");
}

const POLL_MS = 16;
/**
 * A drag whose pointer never comes back (a missed pointerup outside the window,
 * the page's pointer capture released by a re-render) must not leave the poller
 * running and the window interactive forever: after this long with no cursor
 * movement the drag is ended from here.
 */
const DRAG_IDLE_MS = 10_000;
const PROTECT_TRIES = 12;
/** Windows whose protection is still being re-applied (one interval each). */
const protecting = new WeakSet();

/**
 * Keep re-applying content protection until Windows accepts it. Measured 2026-11-02
 * on Electron 39: the call made before a transparent window is mapped is silently
 * dropped roughly one run in three (isContentProtected() stays false), and a single
 * retry can land in the same window. Bounded (5 tries / ~0.6 s), never throws.
 */
function protect(win) {
  const apply = () => {
    try { win.setContentProtection(true); } catch { return false; }
    return true;
  };
  if (!apply()) return;
  if (typeof win.isContentProtected !== "function") return;
  // The affinity only takes a while after the transparent window is mapped: measured
  // 0.6-0.9 s, so retry for ~1.5 s. One interval per window (called twice).
  if (protecting.has(win)) return;
  protecting.add(win);
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    let done;
    try { done = !win || win.isDestroyed() || win.isContentProtected(); } catch { done = true; }
    if (done || tries > PROTECT_TRIES) { clearInterval(timer); protecting.delete(win); return; }
    if (!apply()) { clearInterval(timer); protecting.delete(win); }
  }, 120);
  if (timer.unref) timer.unref();
}

/** The live frame, or null: {win, ctl}. `ctl` is what recorder-window.cjs holds. */
let current = null;

function boundsFor(region, display, band) {
  return core.frameWindowBounds({ region, displayBounds: display.bounds, band });
}

/**
 * Open the frame for a recording that is about to start.
 *
 * @param {{region:{x,y,width,height}, display:Electron.Display,
 *          onRegion?:(region)=>void, band?:number}} opts
 * @returns {null | {window, webContentsId, info, setRegion, setState,
 *                   setInteractive, beginDrag, endDrag, destroy}}
 */
function showFrame({ region, display, onRegion = null, band = core.FRAME_BAND }) {
  if (!region || !display) return null;
  destroyFrame();
  const { BrowserWindow } = electron();
  const bounds = boundsFor(region, display, band);
  if (!bounds || bounds.width < 8 || bounds.height < 8) return null;
  let win = null;
  try {
    win = new BrowserWindow({
      ...bounds,
      frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true,
      enableLargerThanScreen: true,
      // focusable:true but shown with showInactive(): a drag may focus it, and a
      // non-focusable Windows window is not reliable about receiving mouse down.
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, "recorder-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
  } catch {
    return null;
  }
  try { win.setAlwaysOnTop(true, "screen-saver"); } catch { /* level unsupported */ }
  // Belt: even where the band is clipped to a screen edge, this window is never
  // part of a capture. It costs nothing when the band is wholly outside the region.
  protect(win);
  try { win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* no forwarding: handles stay cold */ }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    if (!win || win.isDestroyed()) return;
    win.showInactive();
    // Re-apply once the HWND is mapped (see protect(): the pre-show call can be
    // dropped). The band geometry is the primary guarantee either way.
    protect(win);
  });
  // A frame that dies on its own must not leave the drag poller running.
  win.on("closed", () => {
    if (current && current.ctl.window === win) stopDrag();
  });
  // A click on a handle may activate this window (it is focusable:true so Windows
  // reliably delivers the mouse down). Outside a drag nothing here needs the
  // keyboard: hand focus back so the owner's next keystroke is not swallowed.
  win.on("focus", () => { if (!dragging) restoreFocus(); });
  void win.loadFile(path.join(__dirname, "recorder-frame.html"));

  let state = "recording";
  let dragging = null; // {edge, start, startCursor}

  function publicInfo() {
    const b = Math.max(2, Math.round(Number(band) || core.FRAME_BAND));
    const winBounds = boundsFor(region, display, band) || { width: 0, height: 0 };
    return {
      ok: true,
      region: { width: Math.round(region.width), height: Math.round(region.height) },
      // The size line the page shows ("1280×720"), from core so the bar, the frame
      // and the toast cannot round it three different ways.
      label: core.regionLabel(region),
      band: b,
      width: winBounds.width,
      height: winBounds.height,
      state,
      // One list drives BOTH the drawn handles and the hit zones (the page renders
      // these rects; main hit-tests the same numbers).
      handles: core.frameHandles({ width: winBounds.width, height: winBounds.height, band: b }),
    };
  }

  function pushUpdate() {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send("recorder:frame-update", publicInfo()); } catch { /* page not ready */ }
  }

  function setRegion(next) {
    if (!next) return;
    region = {
      x: Math.round(next.x), y: Math.round(next.y),
      width: Math.max(2, Math.round(next.width)), height: Math.max(2, Math.round(next.height)),
    };
    const b = boundsFor(region, display, band);
    if (win && !win.isDestroyed() && b) {
      try { win.setBounds(b); } catch { /* off-screen bounds refused: the region is still right */ }
    }
    pushUpdate();
  }

  function setState(next) {
    state = String(next || state);
    pushUpdate();
  }

  function setInteractive(hot) {
    if (!win || win.isDestroyed()) return { ok: false, reason: "no frame" };
    if (dragging) return { ok: true };
    try {
      // forward:true keeps move events flowing so the page can find the next handle.
      win.setIgnoreMouseEvents(!hot, { forward: true });
    } catch {
      return { ok: false, reason: "the frame cannot change mouse mode" };
    }
    return { ok: true };
  }

  /**
   * The drag ended: this window must not keep the keyboard. Windows returns focus
   * to the previously active window on blur, so the owner's next keystroke lands
   * in their app instead of an invisible band.
   */
  function restoreFocus() {
    if (!win || win.isDestroyed()) return;
    try { if (win.isFocused()) win.blur(); } catch { /* nothing to restore */ }
  }

  /** The single hover hit-test: core.hitFrameHandle over the SAME handle list. */
  function hoverAt(x, y) {
    if (!win || win.isDestroyed()) return { ok: false, reason: "no frame" };
    if (dragging) return { ok: true, edge: null };
    const info = publicInfo();
    const edge = core.hitFrameHandle(Number(x), Number(y), info.handles);
    setInteractive(Boolean(edge));
    return { ok: true, edge };
  }

  function stopDrag() {
    if (dragging && dragging.timer) clearInterval(dragging.timer);
    dragging = null;
    setInteractive(false);
    restoreFocus();
  }

  function beginDrag(edge) {
    if (!win || win.isDestroyed() || dragging) return { ok: false, reason: "no frame drag" };
    const { screen } = electron();
    let cursor;
    try { cursor = screen.getCursorScreenPoint(); } catch { return { ok: false, reason: "no cursor" }; }
    dragging = {
      edge: String(edge || "move"), start: { ...region }, startCursor: cursor,
      lastCursor: { ...cursor }, lastMoveAt: Date.now(), timer: null,
    };
    try { win.setIgnoreMouseEvents(false); } catch { /* the page still gets the drag */ }
    dragging.timer = setInterval(() => {
      if (!dragging) return;
      let now;
      try { now = electron().screen.getCursorScreenPoint(); } catch { return; }
      // A missed pointerup leaves the cursor still: this ends the drag after
      // DRAG_IDLE_MS instead of polling and staying interactive forever.
      if (now.x !== dragging.lastCursor.x || now.y !== dragging.lastCursor.y) {
        dragging.lastCursor = { x: now.x, y: now.y };
        dragging.lastMoveAt = Date.now();
      } else if (Date.now() - dragging.lastMoveAt > DRAG_IDLE_MS) {
        stopDrag();
        return;
      }
      const next = core.dragRegion({
        start: dragging.start, edge: dragging.edge,
        dx: now.x - dragging.startCursor.x, dy: now.y - dragging.startCursor.y,
        // dragRegion works in the SAME space as the region (display-relative DIP), so
        // the display's bounds are handed to it as a rect based at 0/0 -- not as the
        // absolute screen rect, which would clamp a region to the display's origin.
        bounds: { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height },
      });
      if (!next) return;
      if (next.x === region.x && next.y === region.y && next.width === region.width && next.height === region.height) return;
      setRegion(next);
      try { if (typeof onRegion === "function") onRegion({ ...next }); } catch { /* the recorder's own handler must not kill the drag */ }
    }, POLL_MS);
    if (dragging.timer.unref) dragging.timer.unref();
    return { ok: true };
  }

  function endDrag() {
    if (!dragging) return { ok: true };
    stopDrag();
    return { ok: true };
  }

  function destroy() {
    stopDrag();
    if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch { /* already gone */ }
    }
    win = null;
    if (current && current.ctl === ctl) current = null;
  }

  const ctl = {
    window: win,
    webContentsId: win.webContents.id,
    info: publicInfo,
    setRegion,
    setState,
    setInteractive,
    hoverAt,
    beginDrag,
    endDrag,
    destroy,
    isDestroyed: () => !win || win.isDestroyed(),
  };
  current = { win, ctl };
  pushUpdate();
  return ctl;
}

/** Tear the frame down (finish, failure, a second start). Safe when absent. */
function destroyFrame() {
  if (!current) return false;
  const c = current.ctl;
  current = null;
  try { c.destroy(); } catch { /* gone */ }
  return true;
}

/** Test seam (the recorder-window.cjs __setStateForTest shape): a fake Electron. */
function __setElectronForTest(fn) {
  electronImpl = typeof fn === "function" ? fn : null;
}

module.exports = { showFrame, destroyFrame, __setElectronForTest };
