"use strict";

/**
 * The window layer under `node --test`, with a fake Electron.
 *
 * The five orb review defects are asserted here because four of them only exist
 * in the window layer: the pump re-opening a closed bubble, a secondary-monitor
 * spot clamped onto the primary, the spirit photographing itself, and the
 * one-ask guard being set after the capture await. `node --test` has no display,
 * so `BrowserWindow`, `screen` and `ipcMain` are small honest fakes: bounds,
 * visibility, send() and handle() behave; nothing draws.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// ── the fake Electron, installed before orb-window is required ─────────────

const displays = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 3840, height: 2160 },
    workArea: { x: 0, y: 0, width: 3840, height: 2120 },
  },
  {
    id: 2,
    bounds: { x: 1920, y: 2160, width: 1920, height: 1080 },
    workArea: { x: 1920, y: 2160, width: 1920, height: 1040 },
  },
];

function distanceTo(display, point) {
  const b = display.bounds;
  const x = Math.max(b.x, Math.min(point.x, b.x + b.width));
  const y = Math.max(b.y, Math.min(point.y, b.y + b.height));
  return Math.hypot(point.x - x, point.y - y);
}

function nearestDisplay(point) {
  let best = displays[0];
  let bestDistance = Infinity;
  for (const display of displays) {
    const d = distanceTo(display, point);
    if (d < bestDistance) { bestDistance = d; best = display; }
  }
  return best;
}

let cursor = { x: 100, y: 100 };

const fakeScreen = {
  getPrimaryDisplay: () => displays[0],
  getAllDisplays: () => displays.slice(),
  getDisplayNearestPoint: (point) => nearestDisplay(point),
  getDisplayMatching: (rect) => nearestDisplay({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }),
  getCursorScreenPoint: () => ({ ...cursor }),
  dipToScreenRect: (_win, rect) => rect,
};

function fakeWebContents() {
  const events = new EventEmitter();
  return {
    sent: [],
    url: "",
    send(channel, payload) { this.sent.push([channel, payload]); },
    on(name, fn) { events.on(name, fn); },
    emit(name, ...args) { events.emit(name, ...args); },
    setWindowOpenHandler() {},
    getURL() { return this.url; },
  };
}

let nextWindowId = 1;

class FakeWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.id = nextWindowId++;
    this.bounds = {
      x: Number(opts.x) || 0,
      y: Number(opts.y) || 0,
      width: Number(opts.width) || 0,
      height: Number(opts.height) || 0,
    };
    this.visible = false;
    this.destroyed = false;
    this.focused = false;
    this.ignoreMouse = null;
    this.webContents = fakeWebContents();
    FakeWindow.all.push(this);
  }

  loadFile(file, { query } = {}) {
    const view = (query && query.view) || "orb";
    this.webContents.url = `file:///${String(file).replace(/\\/g, "/")}?view=${view}`;
  }
  loadURL(url) { this.webContents.url = url; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents(ignore) { this.ignoreMouse = ignore; }
  getPosition() { return [this.bounds.x, this.bounds.y]; }
  setPosition(x, y) { this.bounds.x = Math.round(x); this.bounds.y = Math.round(y); }
  getBounds() { return { ...this.bounds }; }
  setBounds(next) { Object.assign(this.bounds, next); }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { if (!this.destroyed) this.visible = true; }
  show() { if (!this.destroyed) this.visible = true; }
  hide() { this.visible = false; }
  isDestroyed() { return this.destroyed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.emit("closed");
  }
  focus() { this.focused = true; }
  isFocused() { return this.focused; }
  getTitle() { return this.opts.title || ""; }

  static all = [];
  static getAllWindows() { return FakeWindow.all.filter((w) => !w.destroyed); }
  static fromId(id) { return FakeWindow.all.find((w) => w.id === id) || null; }
}

const fakeIpc = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };

const fakeElectron = {
  BrowserWindow: FakeWindow,
  screen: fakeScreen,
  ipcMain: fakeIpc,
  app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0-test" },
  clipboard: { writeText() {} },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, resize() { return this; } }),
  },
  shell: { openPath() {}, showItemInFolder() {}, openExternal() {} },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
};

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function patchedElectron(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

// ── the module under test ──────────────────────────────────────────────────

const STATE = path.join(os.tmpdir(), `spirit-orb-state-${process.pid}.json`);
process.env.DESK_ORB_FILE = STATE;

const orbWindow = require("./orb-window.cjs");
const spiritCore = require("./spirit-core.cjs");

function orbWin() { return FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Aither spirit") || null; }
function bubbleWin() { return FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Ask Aither") || null; }

function handler(channel) {
  const fn = fakeIpc.handlers.get(channel);
  assert.ok(fn, `${channel} is not registered`);
  return fn;
}

async function invoke(channel, win, ...args) {
  return handler(channel)({ sender: win.webContents }, ...args);
}

function image() {
  return { isEmpty: () => false, toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) };
}

function captureFake({ onFrame = null } = {}) {
  return {
    calls: 0,
    async nativeFrame(display) {
      this.calls += 1;
      if (onFrame) onFrame(this.calls, display);
      return image();
    },
    lastScreenshot() { return null; },
    async startSnip() { return { ok: false, reason: "not used in this test" }; },
  };
}

function writeState(next) {
  fs.writeFileSync(STATE, JSON.stringify(next));
}

function start(opts = {}) {
  const capture = opts.capture || captureFake();
  const r = orbWindow.startOrb({
    capture,
    askVision: opts.askVision || (async () => ({ ok: true, text: "The screen shows a notes file.", via: "test" })),
    ...(opts.speak ? { speak: opts.speak } : {}),
    ...(opts.avatarTargets ? { avatarTargets: opts.avatarTargets } : {}),
  });
  return { ...r, capture };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.beforeEach(() => {
  orbWindow.__reset();
  FakeWindow.all.length = 0;
  fs.rmSync(STATE, { force: true });
  cursor = { x: 100, y: 100 };
});

test.after(() => {
  orbWindow.__reset();
  fs.rmSync(STATE, { force: true });
});

// ── defect 2 (medium): the saved spot belongs to ITS monitor ──────────────

test("a remembered spot on the second monitor is restored there, not clamped onto the primary", () => {
  writeState({ visible: false, x: 2500, y: 2900 });
  start();
  const orb = orbWin();
  assert.ok(orb);
  assert.deepEqual(orb.getBounds(), { x: 2500, y: 2900, width: 72, height: 72 });
});

test("a remembered spot that is off every display is pulled onto the nearest one", () => {
  writeState({ visible: false, x: 9000, y: 9000 });
  start();
  const bounds = orbWin().getBounds();
  const display = nearestDisplay({ x: 9000, y: 9000 });
  assert.ok(bounds.x >= display.workArea.x && bounds.x + bounds.width <= display.workArea.x + display.workArea.width);
  assert.ok(bounds.y >= display.workArea.y && bounds.y + bounds.height <= display.workArea.y + display.workArea.height);
});

// ── defect 1 (high): a closed bubble stays closed while a line is up ─────

test("closing the bubble is final for a line that is up and pinned (the pump must not re-sync it)", async () => {
  let n = 0;
  start({ askVision: async () => ({ ok: true, text: `answer ${++n}`, via: "test" }) });
  await orbWindow.askScreen();
  const bubble = bubbleWin();
  assert.ok(bubble && bubble.isVisible(), "an answer opens the bubble");

  const line = orbWindow.queue().cur;
  assert.ok(line, "the answer is up");
  await invoke("desk:orb-pin", bubble, line.id, true); // pinned is the worst case
  await invoke("desk:orb-close", bubble);
  assert.equal(bubble.isVisible(), false, "the close button closed it");

  orbWindow.pump();
  assert.equal(bubble.isVisible(), false, "the 250ms pump re-synced it back open");

  // A genuinely NEW answer is allowed to reopen it: suppress only the old one.
  await orbWindow.askImage(path.join(os.tmpdir(), "unused.png"), "prompt", "follow up");
  orbWindow.pump();
  assert.equal(bubble.isVisible(), true, "a new answer reopens the bubble");
});

test("hiding the spirit hides the bubble too, and the pump leaves it hidden", async () => {
  start();
  await orbWindow.askScreen();
  orbWindow.hideOrb();
  assert.equal(orbWin().isVisible(), false);
  assert.equal(bubbleWin().isVisible(), false);
  orbWindow.pump();
  assert.equal(orbWin().isVisible(), false);
  assert.equal(bubbleWin().isVisible(), false);
});

// ── defect 3 (medium): the spirit is never inside its own screenshot ─────

test("the orb and bubble are hidden while the screen is captured, then restored", async () => {
  const frames = [];
  let capture;
  capture = captureFake({
    onFrame: (_n, display) => frames.push({
      orb: orbWin().isVisible(),
      bubble: Boolean(bubbleWin() && bubbleWin().isVisible()),
      bounds: display.bounds,
    }),
  });
  start({ capture });
  await orbWindow.askScreen();

  assert.equal(frames.length, 1);
  assert.equal(frames[0].orb, false, "the orb photographed itself");
  assert.equal(frames[0].bubble, false, "the bubble photographed itself");
  assert.deepEqual(frames[0].bounds, displays[0].bounds, "with no attach, the display under the orb");
  assert.equal(orbWin().isVisible(), true, "the orb is restored after the capture");
  assert.equal(bubbleWin().isVisible(), true, "the bubble is restored for the answer");
});

// ── defect 4 (medium): the guard is set BEFORE the capture await ─────────

test("a second ask is refused immediately, before either one takes a screenshot", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const capture = captureFake();
  start({ capture, askVision: () => gate });

  const first = orbWindow.askScreen();
  const second = await orbWindow.askScreen();
  assert.equal(second.ok, false);
  assert.match(second.error, /One ask at a time/);
  await wait(150); // enough for the first ask to reach nativeFrame
  assert.equal(capture.calls, 1, "the refused ask never took a screenshot");

  release({ ok: true, text: "only once", via: "test" });
  const verdict = await first;
  assert.equal(verdict.ok, true);
  assert.equal(capture.calls, 1);
});

// ── attach: a body is a dock, its colour is the tint ─────────────────────

test("attaching to an avatar puts the spirit in orbit around its upper body", async () => {
  const target = {
    kind: "avatar",
    slotId: "slot2",
    title: "Iris",
    bounds: { x: 100, y: 100, width: 400, height: 600 },
  };
  start({ avatarTargets: async () => [target] });
  const res = await orbWindow.attachTo(target);
  assert.equal(res.ok, true);
  assert.equal(orbWindow.attach().kind, "avatar");
  assert.equal(orbWindow.attach().slotId, "slot2");
  // On the orbit ellipse around (300, 316): rx 168, ry ~44 (spirit-core.orbitPoint).
  const [x, y] = orbWin().getPosition();
  const cx = x + orbWindow.ORB_SIZE.width / 2;
  const cy = y + orbWindow.ORB_SIZE.height / 2;
  const r = ((cx - 300) / 168) ** 2 + ((cy - 316) / (168 * 0.26)) ** 2;
  assert.ok(Math.abs(r - 1) < 0.25, `on the ring, got ${r.toFixed(2)}`);

  orbWindow.detach({ silent: true });
  assert.equal(orbWindow.attach(), null);
});

// ── a whole trip: find a file, watch it go, come back holding it ─────────

test("a find trip flies out, holds the one hit, and answers with its path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spirit-trip-"));
  const file = path.join(dir, "notes.md");
  fs.writeFileSync(file, "# Notes");
  start();
  orbWindow.__setOps({
    async findFiles() {
      return { ok: true, rows: [{ kind: "file", title: "notes.md", subtitle: dir, target: file }], more: 0, total: 1 };
    },
    async readFile() { return { ok: true, answer: "It is a note." }; },
    async listFolder() { return { ok: true, rows: [], more: 0, total: 0 }; },
    async webSearch() { return { ok: true, rows: [], more: 0, total: 0, answer: null }; },
  });

  const verdict = await orbWindow.go({ kind: "search", target: "notes" });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.held.path, file);
  assert.equal(orbWindow.hold().path, file);
  assert.equal(orbWindow.results().mode, "find");
  const log = orbWindow.tripLog().items;
  assert.ok(log.some((e) => /holding notes\.md/i.test(e.label)), "the trip is in the visible log");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("spirit.go refuses a kind it does not know, loudly", async () => {
  start();
  const verdict = await orbWindow.run("go", { arg: '{"kind":"teleport","target":"x"}' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /unknown spirit kind/);
  orbWindow.pump();
  const line = orbWindow.queue().cur;
  assert.ok(line && line.kind === "error" && /unknown spirit kind/.test(line.text));
});

// ── drops: a credential never becomes a hold ─────────────────────────────

test("dropping a credential is refused; dropping a note is held", async () => {
  start();
  const refused = await orbWindow.receiveDrop({ paths: ["C:\\Users\\wzns\\.env"] });
  assert.equal(refused.ok, false);
  assert.equal(refused.line, "1 file refused — it looks like a credential");
  assert.equal(orbWindow.hold(), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spirit-drop-"));
  const note = path.join(dir, "note.md");
  fs.writeFileSync(note, "hello");
  const held = await orbWindow.receiveDrop({ paths: [note] });
  assert.equal(held.ok, true);
  assert.equal(orbWindow.hold().path, note);
  assert.ok(orbWindow.results() === null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── a body's menu row: the remembered slot survives the typed query ───────

test("a body that opened Find a file… speaks the result the owner typed for it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spirit-slot-"));
  const file = path.join(dir, "agenda.md");
  fs.writeFileSync(file, "# Agenda");
  const spoken = [];
  start({ speak: (text, opts) => { spoken.push({ text, slotId: opts.slotId, origin: opts.origin }); } });
  orbWindow.__setOps({
    async findFiles() {
      return { ok: true, rows: [{ kind: "file", title: "agenda.md", subtitle: dir, target: file }], more: 0, total: 1 };
    },
    async readFile() { return { ok: true, answer: "It is an agenda." }; },
    async listFolder() { return { ok: true, rows: [], more: 0, total: 0 }; },
    async webSearch() { return { ok: true, rows: [], more: 0, total: 0, answer: null }; },
  });

  // The avatar-menu row opens the bubble's field with that body remembered.
  const opened = orbWindow.run("find", { surface: "avatar-menu", slotId: "slot3" });
  assert.equal(opened.ok, true);
  assert.equal(opened.mode, "find");

  const bubble = bubbleWin();
  const verdict = await invoke("desk:orb-ask", bubble, "find", "agenda");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.held.path, file);
  assert.ok(spoken.some((s) => s.slotId === "slot3" && s.origin === "desk:spirit"),
    "the body that asked is the body that speaks");
  fs.rmSync(dir, { recursive: true, force: true });
});
