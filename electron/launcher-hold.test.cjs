"use strict";

/**
 * Alt+Space in talk mode "hold" is push-to-talk (owner 2026-11-17: "integrate with
 * alt+space for push to talk too"). The TAP stays the launcher; the HOLD starts
 * listening and the keyup -- which only the radial window can see -- stops it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLauncher } = require("./launcher-window.cjs");


function stubObject(overrides = {}) {
  const target = { ...overrides };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === "then") return undefined;
      return (...args) => (args.length ? undefined : undefined);
    },
  });
}

class FakeWindow {
  constructor() {
    this.webContents = stubObject({ setWindowOpenHandler() {}, openDevTools() {},
      executeJavaScript: async () => undefined, isLoading: () => false });
  }
  isDestroyed() { return false; }
  isVisible() { return true; }
  isFocused() { return true; }  // the box took focus, so a hold can be proven
  getBounds() { return { x: 0, y: 0, width: 10, height: 10 }; }
  getPosition() { return [0, 0]; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  hide() {} show() {} showInactive() {} focus() {} destroy() {} close() {}
  setPosition() {} setBounds() {} setSize() {} center() {}
  on() {} once() {} off() {} removeAllListeners() {}
}

function harness() {
  const calls = { start: 0, end: 0 };
  let radial = null;
  const electron = {
    BrowserWindow: FakeWindow, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    shell: {}, clipboard: { readText: () => "" },
  };
  const quickMenu = {
    openRadial(opts) { radial = opts; return { ok: true }; },
    closeRadial() {},
  };
  const l = createLauncher({
    electron, registry: { byId: () => null }, quickMenu,
    run: async () => ({ ok: true }),
    onHoldStart: () => { calls.start += 1; },
    onHoldEnd: () => { calls.end += 1; },
  });
  return { l, calls, radial: () => radial };
}

test("holding Alt+Space starts listening; the keyup the radial sees stops it", async () => {
  const h = harness();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  h.l.press();          // key down -> pending (a tap would open the launcher here)
  await wait(400);      // past HOLD_MS: the box waits for the auto-repeat
  h.l.press();          // the OS auto-repeat while pending IS the hold proof
  assert.equal(h.calls.start, 1, "the hold did not start listening");
  assert.equal(h.calls.end, 0);
  assert.ok(h.radial() && typeof h.radial().onDone === "function", "no radial took the keyup");
  h.radial().onDone();  // the owner lets go
  assert.equal(h.calls.end, 1, "the keyup did not stop listening");
});

test("a launcher with no talk wiring behaves exactly as before", () => {
  const electron = {
    BrowserWindow: FakeWindow, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    shell: {}, clipboard: { readText: () => "" },
  };
  const l = createLauncher({ electron, registry: { byId: () => null }, quickMenu: { openRadial: () => ({ ok: false }) }, run: async () => ({ ok: true }) });
  assert.doesNotThrow(() => { l.press(); l.press(); });
});
