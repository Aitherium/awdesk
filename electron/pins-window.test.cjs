"use strict";

// pins-window.cjs against a FAKE electron: the assertions are about what the
// module asks Electron for (sandbox flags, no preload on web content, the
// navigation rules, click-through), which is exactly what a refactor could lose.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pins = require("./pins-window.cjs");

function fakeElectron() {
  const log = { windows: [], views: [], handlers: {}, perm: null };
  class Contents {
    constructor() { this.listeners = {}; this.url = ""; this.muted = null; this.loaded = null; this.openHandler = null; }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    on(name, fn) { this.listeners[name] = fn; }
    send() {}
    getURL() { return this.url; }
    setAudioMuted(m) { this.muted = m; }
    loadURL(url, opts) { this.url = url; this.loaded = { url, opts }; return Promise.resolve(); }
    reload() {}
  }
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.webContents = new Contents(); this.destroyed = false; this.visible = false;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.ignore = null; this.top = null; this.opacity = null; this.children = [];
      this.contentView = { addChildView: (v) => this.children.push(v) };
      this.events = {};
      log.windows.push(this);
    }
    setAlwaysOnTop(on, level) { this.top = on ? level : false; }
    setOpacity(o) { this.opacity = o; }
    setIgnoreMouseEvents(on, opts) { this.ignore = on ? opts || {} : false; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    getBounds() { return { ...this.bounds }; }
    on(name, fn) { this.events[name] = fn; }
    once(name, fn) { this.events[name] = fn; }
    loadFile(f) { this.file = f; return Promise.resolve(); }
  }
  class WebContentsView {
    constructor(opts) { this.opts = opts; this.webContents = new Contents(); this.bounds = null; log.views.push(this); }
    setBounds(b) { this.bounds = b; }
  }
  return {
    log,
    electron: {
      BrowserWindow, WebContentsView,
      ipcMain: { handle: (ch, fn) => { log.handlers[ch] = fn; } },
      screen: {
        getCursorScreenPoint: () => ({ x: 500, y: 400 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
        getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      },
      session: { fromPartition: () => ({
        setPermissionRequestHandler: (fn) => { log.perm = fn; },
        setPermissionCheckHandler: () => {},
      }) },
      app: { getPath: () => os.tmpdir() },
    },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-test-"));
  const fake = fakeElectron();
  const opened = [];
  pins.__reset();
  pins.configurePins({
    electron: fake.electron, storeFile: path.join(dir, "pins.json"),
    openInBrowser: (url) => { opened.push(url); return { ok: true }; },
    launchApp: (src) => { opened.push(`launch:${src}`); return { ok: true }; },
  });
  return { dir, fake, opened, file: path.join(dir, "pins.json") };
}

test("a GIF pin: frameless, transparent, sandboxed controls page, on top, saved to disk", () => {
  const { fake, file } = setup();
  const r = pins.addPin("https://media.tenor.com/abc/cat.gif");
  assert.equal(r.ok, true);
  const win = fake.log.windows[0];
  assert.equal(win.opts.frame, false);
  assert.equal(win.opts.transparent, true);
  assert.equal(win.opts.resizable, true);
  assert.equal(win.opts.webPreferences.sandbox, true);
  assert.equal(win.opts.webPreferences.nodeIntegration, false);
  assert.equal(fake.log.views.length, 0, "an image needs no web view");
  win.events["ready-to-show"]();
  assert.equal(win.top, "floating");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.pins.length, 1);
  assert.equal(saved.pins[0].kind, "gif");
});

test("a web page pin runs in a view with NO preload, its own partition, and navigation policy", () => {
  const { fake, opened } = setup();
  pins.addPin("https://example.com/docs");
  const view = fake.log.views[0];
  assert.ok(view, "a page gets a WebContentsView");
  const wp = view.opts.webPreferences;
  assert.equal(wp.preload, undefined, "no preload reaches embedded content");
  assert.equal(wp.sandbox, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.partition, pins.PARTITION);
  assert.equal(view.bounds.y, 26, "the page sits under the grab strip");
  // A view in a transparent window is not composited on Windows: web pins are opaque.
  assert.equal(fake.log.windows[0].opts.transparent, false);
  // A popup is denied and opens as an Aither browser tab instead.
  assert.deepEqual(view.webContents.openHandler({ url: "https://other.example/x" }), { action: "deny" });
  assert.deepEqual(opened, ["https://other.example/x"]);
  // Same-origin navigation stays; cross-origin is stopped and sent to the browser.
  view.webContents.url = "https://example.com/docs";
  let prevented = false;
  view.webContents.listeners["will-navigate"]({ preventDefault: () => { prevented = true; } }, "https://example.com/next");
  assert.equal(prevented, false);
  view.webContents.listeners["will-navigate"]({ preventDefault: () => { prevented = true; } }, "https://evil.example/");
  assert.equal(prevented, true);
  assert.equal(opened[1], "https://evil.example/");
  // javascript: never reaches the browser either.
  view.webContents.listeners["will-navigate"]({ preventDefault: () => {} }, "javascript:alert(1)");
  assert.equal(opened.length, 2);
  // Every permission but fullscreen is denied.
  let granted = null;
  fake.log.perm(null, "media", (g) => { granted = g; });
  assert.equal(granted, false);
});

test("a YouTube pin loads the nocookie embed with a referrer", () => {
  const { fake } = setup();
  pins.addPin("https://youtu.be/dQw4w9WgXcQ");
  const loaded = fake.log.views[0].webContents.loaded;
  assert.match(loaded.url, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  assert.ok(loaded.opts.httpReferrer);
});

test("lock = click-through; mute reaches the page; desktop level drops always-on-top", () => {
  const { fake } = setup();
  const { pin } = pins.addPin("https://youtu.be/dQw4w9WgXcQ");
  const win = fake.log.windows[0];
  pins.setPin(pin.id, { locked: true, muted: true, onTop: false, opacity: 0.4 });
  assert.deepEqual(win.ignore, { forward: true });
  assert.equal(fake.log.views[0].webContents.muted, true);
  assert.equal(win.top, false);
  assert.equal(win.opacity, 0.4);
  pins.setPin(pin.id, { locked: false });
  assert.equal(win.ignore, false);
});

test("the pin: IPC answers only its own windows, and an app pin launches instead of embedding", async () => {
  const { fake, opened } = setup();
  const { pin } = pins.addPin("aither://terminal");
  assert.equal(fake.log.views.length, 0, "an aither:// page is never embedded");
  const h = pins.handlers();
  assert.equal(h["pin:close"]({ sender: {} }).ok, false, "a foreign sender is refused");
  const sender = fake.log.windows[0].webContents;
  assert.equal(h["pin:init"]({ sender }).pin.id, pin.id);
  h["pin:launch"]({ sender });
  assert.deepEqual(opened, ["launch:aither://terminal"]);
  // The controls page cannot change identity through pin:set.
  h["pin:set"]({ sender }, { kind: "url", id: "x", opacity: 0.5 });
  assert.equal(pins.listPins()[0].kind, "app");
  assert.equal(pins.listPins()[0].opacity, 0.5);
});

test("pins come back on restart; hidden ones stay hidden; close removes for good", () => {
  const { file } = setup();
  const a = pins.addPin("https://media.tenor.com/a.gif").pin;
  const b = pins.addPin("https://example.com/").pin;
  pins.setPin(b.id, { hidden: true });
  // "restart": a fresh module state reading the same file
  const fake2 = fakeElectron();
  pins.__reset();
  pins.configurePins({ electron: fake2.electron, storeFile: file });
  const r = pins.restorePins();
  assert.equal(r.total, 2);
  assert.equal(r.opened, 1);
  assert.equal(pins.closePin(a.id).ok, true);
  assert.equal(pins.listPins().length, 1);
  assert.equal(pins.closePin("nope").ok, false);
});

test("addPin refuses what a pin cannot show, and pinTab pins a tab's page", () => {
  setup();
  assert.equal(pins.addPin("javascript:alert(1)").ok, false);
  assert.equal(pins.pinTab(null).ok, false);
  const r = pins.pinTab({ url: "https://example.com/a", title: "Docs" });
  assert.equal(r.ok, true);
  assert.equal(r.pin.title, "Docs");
});

test("traySubmenu: rows, a +N more, and the bulk rows; empty says how to add one", () => {
  setup();
  const empty = pins.traySubmenu();
  assert.match(empty[0].label, /^0 pins/);
  for (let i = 0; i < 7; i += 1) pins.addPin(`https://media.tenor.com/g${i}.gif`);
  const rows = pins.traySubmenu();
  assert.ok(rows.some((r) => /^\+2 more/.test(r.label || "")));
  assert.ok(rows.some((r) => r.label === "Close all pins"));
});

test("middle-drag moves a pin, Shift resizes, Ctrl duplicates; a locked pin will not move; it never leaves the screen", () => {
  const { fake } = setup();
  const { pin } = pins.addPin({ kind: "gif", src: "https://media.tenor.com/a.gif", title: "a", bounds: { x: 100, y: 100, width: 300, height: 200 } });
  const win = fake.log.windows[0];
  win.setBounds = (b) => { win.bounds = { ...b }; };
  assert.equal(pins.grabStart(pin.id, { x: 500, y: 500 }).gesture, "move");
  pins.grabMove(pin.id, { x: 560, y: 520 });
  assert.deepEqual([win.bounds.x, win.bounds.y], [160, 120]);
  pins.grabEnd(pin.id);
  assert.equal(pins.grabStart(pin.id, { x: 0, y: 0, shift: true }).gesture, "resize");
  pins.grabMove(pin.id, { x: 50, y: 30 });
  assert.deepEqual([win.bounds.width, win.bounds.height], [350, 230]);
  pins.grabEnd(pin.id);
  // Off the screen: clamped back so at least 48 px stays on the work area.
  pins.grabStart(pin.id, { x: 0, y: 0 });
  pins.grabMove(pin.id, { x: 9000, y: 9000 });
  assert.ok(win.bounds.x <= 1920 - 48 && win.bounds.y <= 1040 - 48, JSON.stringify(win.bounds));
  pins.grabEnd(pin.id);
  const dup = pins.grabStart(pin.id, { x: 0, y: 0, ctrl: true });
  assert.equal(dup.gesture, "duplicate");
  assert.notEqual(dup.targetId, pin.id);
  assert.equal(pins.listPins().length, 2, "Ctrl+middle-drag made a second pin");
  pins.grabEnd(pin.id);
  pins.setPin(pin.id, { locked: true });
  assert.equal(pins.grabStart(pin.id, { x: 0, y: 0 }).ok, false, "locked: no move");
  assert.equal(pins.grabStart(pin.id, { x: 0, y: 0, ctrl: true }).ok, true, "locked: can still be duplicated");
  const copy = pins.listPins().find((p) => p.id !== pin.id && p.id !== dup.targetId);
  assert.equal(copy.locked, false, "the copy is unlocked");
});

test("a web pin's page: before-mouse-event middle press is taken for the drag", () => {
  const { fake } = setup();
  const { pin } = pins.addPin("https://example.com/");
  const view = fake.log.views[0];
  const handler = view.webContents.listeners["before-mouse-event"];
  assert.equal(typeof handler, "function", "the page's mouse events are watched");
  let prevented = false;
  handler({ preventDefault: () => { prevented = true; } }, { type: "mouseDown", button: "middle", globalX: 10, globalY: 10, modifiers: [] });
  assert.equal(prevented, true, "no autoscroll: the press became a grab");
  prevented = false;
  handler({ preventDefault: () => { prevented = true; } }, { type: "mouseDown", button: "left", globalX: 10, globalY: 10, modifiers: [] });
  assert.equal(prevented, false, "a left click reaches the page");
  pins.grabEnd(pin.id);
});
