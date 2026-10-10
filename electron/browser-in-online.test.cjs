"use strict";

// Slice 23: the Aither Browser as a window OF AitherOS Online. The state machine runs on
// stub windows; the wiring (preload relay, overlay-only IPC, overlay-only frame flag,
// the owned-window focus guard) is driven through the real modules.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const { INSIDE_MIN, createBrowserInOnline, screenRect } = require("./browser-in-online.cjs");

function stubWin(bounds = { x: 100, y: 100, width: 1200, height: 800 }) {
  const calls = [];
  let visible = true;
  let destroyed = false;
  let min = [720, 480];
  let parent = null;
  return {
    calls,
    get parent() { return parent; },
    getBounds: () => ({ ...bounds }),
    setBounds: (b) => { calls.push(["setBounds", b]); bounds = { ...b }; },
    getMinimumSize: () => min.slice(),
    setMinimumSize: (w, h) => { calls.push(["setMinimumSize", w, h]); min = [w, h]; },
    setParentWindow: (p) => { calls.push(["setParentWindow", p ? "overlay" : null]); parent = p; },
    isVisible: () => visible,
    show: () => { calls.push(["show"]); visible = true; },
    showInactive: () => { calls.push(["showInactive"]); visible = true; },
    hide: () => { calls.push(["hide"]); visible = false; },
    focus: () => calls.push(["focus"]),
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
  };
}

function stubOverlay({ visible = true, zoom = 1 } = {}) {
  return {
    isVisible: () => visible,
    setVisible: (v) => { visible = v; },
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 40, width: 1920, height: 1040 }),
    webContents: { getZoomFactor: () => zoom },
  };
}

const RECT = { x: 200, y: 100, w: 900, h: 600 };

test("screenRect maps the body's CSS px to screen DIP, and refuses a non-rect", () => {
  assert.deepEqual(screenRect(RECT, { x: 0, y: 40 }, 1), { x: 200, y: 140, width: 900, height: 600 });
  assert.deepEqual(screenRect(RECT, { x: 10, y: 0 }, 1.25), { x: 260, y: 125, width: 1125, height: 750 });
  assert.equal(screenRect({ x: 1, y: 1, w: 0, h: 10 }, { x: 0, y: 0 }), null);
  assert.equal(screenRect({ x: "1", y: 1, w: 5, h: 10 }, { x: 0, y: 0 }), null);
  assert.equal(screenRect(null, { x: 0, y: 0 }), null);
});

test("shown: the browser becomes an owned window of the overlay, laid over the frame's body", () => {
  const b = stubWin();
  const o = stubOverlay();
  const changes = [];
  const bio = createBrowserInOnline({ browser: () => b, onChange: (v) => changes.push(v) });
  assert.equal(bio.apply({ state: "shown", rect: RECT }, o), true);
  assert.equal(b.parent, o);
  assert.deepEqual(b.calls.find((c) => c[0] === "setMinimumSize"), ["setMinimumSize", INSIDE_MIN.width, INSIDE_MIN.height]);
  assert.deepEqual(b.getBounds(), { x: 200, y: 140, width: 900, height: 600 });
  assert.deepEqual(changes, [true]);
  // A move of the frame moves the browser; it does not re-parent.
  bio.apply({ state: "shown", rect: { ...RECT, x: 300 } }, o);
  assert.equal(b.getBounds().x, 300);
  assert.equal(b.calls.filter((c) => c[0] === "setParentWindow").length, 1);
});

test("focus: the OS raised its window, so the real browser is shown and focused", () => {
  const b = stubWin();
  const o = stubOverlay();
  const bio = createBrowserInOnline({ browser: () => b });
  assert.equal(bio.apply({ state: "shown", focus: true }, o), false, "a bare focus before any frame does nothing");
  assert.equal(b.calls.length, 0);
  bio.apply({ state: "shown", rect: RECT }, o);
  b.calls.length = 0;
  bio.apply({ state: "shown", focus: true }, o);
  assert.deepEqual(b.calls, [["show"], ["focus"]]);
});

test("hidden: minimized or swept in the OS hides the browser; shown brings it back without stealing focus", () => {
  const b = stubWin();
  const o = stubOverlay();
  const bio = createBrowserInOnline({ browser: () => b });
  bio.apply({ state: "hidden" }, o);
  assert.equal(b.calls.length, 0, "a browser that never went in is never hidden by the OS");
  bio.apply({ state: "shown", rect: RECT }, o);
  bio.apply({ state: "hidden" }, o);
  assert.equal(b.isVisible(), false);
  b.calls.length = 0;
  bio.apply({ state: "shown", rect: RECT }, o);
  assert.ok(b.calls.some((c) => c[0] === "showInactive"));
  assert.ok(!b.calls.some((c) => c[0] === "focus"));
});

test("detached: the browser is its own window again, at its old bounds and size floor", () => {
  const b = stubWin({ x: 5, y: 6, width: 1300, height: 900 });
  const o = stubOverlay();
  const changes = [];
  const bio = createBrowserInOnline({ browser: () => b, onChange: (v) => changes.push(v) });
  bio.apply({ state: "shown", rect: RECT }, o);
  bio.apply({ state: "hidden" }, o);
  assert.equal(bio.apply({ state: "detached" }, o), true);
  assert.equal(b.parent, null);
  assert.deepEqual(b.getBounds(), { x: 5, y: 6, width: 1300, height: 900 });
  assert.deepEqual(b.getMinimumSize(), [720, 480]);
  assert.equal(b.isVisible(), true, "a detach never strands the browser hidden");
  assert.deepEqual(changes, [true, false]);
  assert.equal(bio.isInside(), false);
});

test("never inside an overlay that is not on screen; a closed browser is forgotten", () => {
  const b = stubWin();
  const o = stubOverlay({ visible: false });
  const bio = createBrowserInOnline({ browser: () => b });
  assert.equal(bio.apply({ state: "shown", rect: RECT }, o), false);
  assert.equal(b.parent, null);
  o.setVisible(true);
  bio.apply({ state: "shown", rect: RECT }, o);
  o.setVisible(false);
  bio.apply({ state: "shown", rect: RECT }, o);
  assert.equal(b.parent, null, "the overlay hid: the browser came out");
  bio.apply({ state: "shown", rect: RECT }, stubOverlay());
  b.destroy();
  bio.browserClosed();
  assert.equal(bio.isInside(), false);
  assert.doesNotThrow(() => bio.apply({ state: "shown", rect: RECT }, stubOverlay()));
});

// ── the wiring, through the real modules ────────────────────────────────────────

function loadPreload({ argv = [] } = {}) {
  const listeners = [];
  const sent = [];
  const win = {
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage() {},
    location: { origin: "https://aitherium.com" },
  };
  const ctx = vm.createContext({
    window: win,
    document: { documentElement: { setAttribute() {} } },
    navigator: {},
    sessionStorage: { getItem: () => null, setItem() {} },
    process: { argv },
    require: () => ({ ipcRenderer: { on() {}, send: (...a) => sent.push(a), invoke: async () => null } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8"), ctx);
  const send = async (data) => { for (const fn of listeners) await fn({ source: win, origin: "https://aitherium.com", data }); };
  return { send, sent: () => JSON.parse(JSON.stringify(sent)) };
}

test("the overlay preload relays desk-window, shaped; the browser's own Online tab never does", async () => {
  const p = loadPreload();
  await p.send({ __aither: "desk-window", id: "browser", state: "shown", rect: { ...RECT, extra: 1 }, focus: true });
  await p.send({ __aither: "desk-window", id: "browser", state: "hidden", rect: { x: "1" } });
  await p.send({ __aither: "desk-window", id: "browser", state: "maximise" });
  await p.send({ __aither: "desk-window", id: "avatar", state: "shown" });
  assert.deepEqual(p.sent(), [
    ["living-desktop:desk-window", { state: "shown", rect: RECT, focus: true }],
    ["living-desktop:desk-window", { state: "hidden", rect: null, focus: false }],
  ]);
  const tab = loadPreload({ argv: ["--aither-desk-surface=browser-tab"] });
  await tab.send({ __aither: "desk-window", id: "browser", state: "shown", rect: RECT });
  assert.deepEqual(tab.sent(), []);
});

function loadWindowModule() {
  const handlers = {};
  const fake = {
    BrowserWindow: function BrowserWindow() {},
    ipcMain: { on(ch, fn) { handlers[ch] = fn; }, handle() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => ({ workArea: {} }) },
    session: { fromPartition: () => ({ cookies: { get: async () => [], set: async () => {}, remove: async () => {} } }) },
    shell: { openExternal: async () => {} },
  };
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return fake;
    return original.call(this, request, ...rest);
  };
  try {
    const file = require.resolve("./living-desktop-window.cjs");
    delete require.cache[file];
    return { ldw: require(file), handlers };
  } finally {
    Module._load = original;
  }
}

test("only the overlay's desk-state says frame:true, and only for an open browser", () => {
  const { ldw } = loadWindowModule();
  const snap = { cards: [], browser: { open: true, driving: false } };
  assert.equal(ldw.framedForOverlay(snap).browser.frame, true);
  assert.equal(snap.browser.frame, undefined, "the shared snapshot is not mutated (the browser tab gets it plain)");
  const closed = { browser: { open: false } };
  assert.equal(ldw.framedForOverlay(closed), closed);
  const src = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  assert.match(src, /wc === overlayWc && desktopWin\.isVisible\(\) \? framedForOverlay\(snapshot\) : snapshot/);
});

test("desk-window IPC is taken from the overlay window alone (no overlay open: ignored)", () => {
  const { handlers } = loadWindowModule();
  const fn = handlers["living-desktop:desk-window"];
  assert.equal(typeof fn, "function");
  assert.doesNotThrow(() => fn({ sender: {} }, { state: "shown" }));
  const src = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  assert.match(src, /if \(!isOpen\(\) \|\| event\.sender !== desktopWin\.webContents\) return;/);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /window: \(msg, overlay\) => browserInOnline\.apply\(msg, overlay\)/);
  assert.match(main, /isOverlayVisible\(\)\) browserInOnline\.detach\(\)/);
  assert.match(main, /reason === "closed"\) browserInOnline\.browserClosed\(\)/);
});

test("a click into the owned browser is not attention leaving the OS (no Stage Manager sweep)", async () => {
  const { ldw } = loadWindowModule();
  const handlers = {};
  const sent = [];
  let childFocused = true;
  const child = { isDestroyed: () => false, isFocused: () => childFocused };
  const win = {
    isDestroyed: () => false,
    on: (n, fn) => { handlers[n] = fn; },
    getChildWindows: () => [child],
    webContents: { send: (ch, v) => sent.push([ch, v]) },
  };
  ldw.wireHostFocus(win);
  handlers.blur();
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(sent, [], "focus went to the browser inside Online");
  childFocused = false;
  handlers.blur();
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(sent, [["living-desktop:host-focus", false]]);
});
