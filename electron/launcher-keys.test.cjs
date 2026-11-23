"use strict";

// Alt+Space, decided from the PHYSICAL keys (owner 2026-11-23: the ring made the whole
// PC stutter). A HOLD must never show the launcher or sample the focused app; a TAP
// must still sample the app under the owner and then open the box.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLauncher } = require("./launcher-window.cjs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function stubObject(overrides = {}) {
  const target = { ...overrides };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === "then") return undefined;
      return () => undefined;
    },
  });
}

function harness({ keys = { space: true, alt: true }, openRing = null } = {}) {
  const calls = { shown: 0, sampled: 0, captured: 0, start: 0, end: 0 };
  const state = { keys: { ...keys }, radial: null };
  class FakeWindow {
    constructor() {
      this.webContents = stubObject({
        setWindowOpenHandler() {}, openDevTools() {}, executeJavaScript: async () => undefined,
        isLoading: () => false, getURL: () => "file:///launcher.html",
      });
    }
    isDestroyed() { return false; }
    isVisible() { return calls.shown > 0; }
    isFocused() { return true; }
    getBounds() { return { x: 0, y: 0, width: 10, height: 10 }; }
    getPosition() { return [0, 0]; }
    getContentBounds() { return { x: 0, y: 0, width: 10, height: 10 }; }
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    hide() { calls.shown = 0; }
    show() { calls.shown += 1; }
    showInactive() { calls.shown += 1; }
    focus() {}
    destroy() {}
    close() {}
    setPosition() {}
    setBounds() {}
    setSize() {}
    center() {}
    on() {}
    once() {}
    off() {}
    removeAllListeners() {}
  }
  const electron = {
    BrowserWindow: FakeWindow,
    ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    shell: {}, clipboard: { readText: () => "" },
  };
  const quickMenu = { openRadial(opts) { state.radial = opts; return { ok: true }; }, closeRadial() {} };
  const launcher = createLauncher({
    electron, registry: { byId: () => null }, quickMenu, run: async () => ({ ok: true }),
    keyState: async () => (state.keys ? { ...state.keys } : null),
    pollMs: 1,
    openRing,
    hostContext: () => { calls.sampled += 1; return { ok: true }; },
    assist: { capture: () => { calls.captured += 1; return null; }, group: () => null, choose: () => ({ ok: true }) },
    onHoldStart: () => { calls.start += 1; },
    onHoldEnd: () => { calls.end += 1; },
  });
  return { launcher, calls, state };
}

test("a HOLD opens the ring with no launcher window and no host sample", async () => {
  const h = harness();
  h.launcher.press();
  await wait(150); // before HOLD_MS (280): nothing decided yet
  assert.equal(h.calls.shown, 0, "the launcher must not appear on a hold");
  assert.equal(h.calls.sampled, 0, "no host context was sampled");
  assert.equal(h.calls.captured, 0, "no assist capture ran");
  assert.equal(h.calls.start, 0, "not a hold yet");
  await wait(400); // past HOLD_MS with the keys still down
  assert.equal(h.calls.start, 1, "the hold did not start");
  assert.ok(h.state.radial && typeof h.state.radial.onDone === "function");
  assert.equal(h.calls.shown, 0, "still no launcher window");
  assert.equal(h.calls.sampled, 0, "still no host sample");
  h.state.radial.onDone();
  assert.equal(h.calls.end, 1);
});

test("a TAP samples the foreground while it still has focus, then opens the box", async () => {
  const h = harness();
  h.launcher.press();
  h.state.keys = { space: false, alt: false }; // released before HOLD_MS
  await wait(120);
  assert.ok(h.calls.shown >= 1, "a tap opens the launcher");
  assert.equal(h.calls.sampled, 1, "the foreground was sampled on the tap");
  assert.equal(h.calls.captured, 1);
  assert.equal(h.calls.start, 0, "a tap is not a hold");
});

test("a mute key probe falls back to the old path instead of sticking", async () => {
  const h = harness();
  h.state.keys = null; // the probe cannot answer
  h.launcher.press();
  for (let i = 0; i < 40 && h.calls.shown === 0; i += 1) await wait(25);
  assert.ok(h.calls.shown >= 1, "the fallback shows the launcher");
  assert.equal(h.calls.sampled, 1);
});

test("a HOLD opens the ONE ring (fairy-first) when the opener is wired", async () => {
  const rings = [];
  const h = harness({ openRing: (opts) => { rings.push(opts); return { ok: true }; } });
  h.launcher.press();
  await wait(160);
  await wait(400); // past HOLD_MS
  assert.equal(rings.length, 1, "the hold did not open the fairy ring");
  assert.equal(rings[0].hold, true, "the ring must know it is the Alt+Space hold");
  assert.equal(h.calls.shown, 0, "and no launcher window appeared");
  rings[0].onDone();
  assert.equal(h.calls.end, 1, "closing the ring ends push-to-talk");
});
