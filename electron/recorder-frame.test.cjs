"use strict";

// recorder-frame.cjs under node --test with a fake Electron: the live frame's
// hover decision goes through core.hitFrameHandle (one hit-test path), and a drag
// that activates the frameless window hands focus back when it ends.

const test = require("node:test");
const assert = require("node:assert/strict");
const frameCtl = require("./recorder-frame.cjs");

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

function fakeElectron({ point = { x: 0, y: 0 } } = {}) {
  const wins = [];
  const cursor = { ...point };
  class FakeWindow {
    constructor(opts) {
      this.opts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.handlers = new Map();
      this.destroyed = false;
      this.focused = false;
      this.ignoreMouse = null;
      this.blurs = 0;
      this.webContents = { id: 4242, setWindowOpenHandler() {}, on() {}, send() {} };
      wins.push(this);
    }

    on(event, fn) {
      const list = this.handlers.get(event) || [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    once(event, fn) { return this.on(event, fn); }

    emit(event, ...args) {
      for (const fn of this.handlers.get(event) || []) fn(...args);
    }

    setAlwaysOnTop() {}
    setContentProtection() {}
    setIgnoreMouseEvents(ignore) { this.ignoreMouse = ignore; }
    showInactive() {}
    setBounds(bounds) { this.bounds = bounds; }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    blur() { this.focused = false; this.blurs += 1; }
    loadFile() { return Promise.resolve(); }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return {
    wins,
    electron: {
      BrowserWindow: FakeWindow,
      screen: { getCursorScreenPoint: () => ({ ...cursor }) },
    },
  };
}

test.afterEach(() => {
  frameCtl.destroyFrame();
  frameCtl.__setElectronForTest(null);
});

test("hover runs through core.hitFrameHandle and drives the window's mouse mode", () => {
  const env = fakeElectron();
  frameCtl.__setElectronForTest(() => env.electron);
  const ctl = frameCtl.showFrame({ region: { x: 100, y: 100, width: 800, height: 600 }, display: DISPLAY });
  assert.ok(ctl, "the frame opened");
  const win = env.wins[0];
  win.emit("ready-to-show");

  // Window = region inflated by the band (824 x 624): a corner is a handle.
  assert.deepEqual(ctl.hoverAt(2, 2), { ok: true, edge: "nw" });
  assert.equal(win.ignoreMouse, false, "a handle makes the window interactive");
  // The recorded middle is not a handle: the click goes to the desktop.
  assert.deepEqual(ctl.hoverAt(412, 312), { ok: true, edge: null });
  assert.equal(win.ignoreMouse, true);
  // The same numbers the page draws, from core.regionLabel.
  assert.equal(ctl.info().label, "800×600");
  assert.equal(ctl.info().handles.find((h) => h.edge === "move").height, 12);
});

test("a drag that focuses the frame restores the owner's focus when it ends", () => {
  const env = fakeElectron();
  frameCtl.__setElectronForTest(() => env.electron);
  const ctl = frameCtl.showFrame({ region: { x: 100, y: 100, width: 800, height: 600 }, display: DISPLAY });
  const win = env.wins[0];
  win.emit("ready-to-show");

  // Clicking a handle activates the frameless window (focusable:true).
  win.focused = true;
  assert.equal(ctl.beginDrag("move").ok, true);
  assert.equal(win.ignoreMouse, false);
  assert.equal(ctl.endDrag().ok, true);
  assert.equal(win.blurs, 1, "endDrag hands focus back to the previously active app");
  assert.equal(win.ignoreMouse, true);

  // An activation outside a drag is handed back immediately too.
  win.focused = true;
  win.emit("focus");
  assert.equal(win.blurs, 2);
});

test("a frame destroyed under a live drag stops it and never leaves the window interactive", () => {
  const env = fakeElectron();
  frameCtl.__setElectronForTest(() => env.electron);
  const ctl = frameCtl.showFrame({ region: { x: 100, y: 100, width: 800, height: 600 }, display: DISPLAY });
  const win = env.wins[0];
  win.emit("ready-to-show");
  ctl.beginDrag("se");
  assert.equal(win.ignoreMouse, false);
  frameCtl.destroyFrame();
  assert.equal(win.destroyed, true);
  assert.equal(win.ignoreMouse, true, "no drag poller or interactive window outlives the frame");
});
