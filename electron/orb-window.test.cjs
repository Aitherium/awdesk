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
    once(name, fn) { events.once(name, fn); },
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
  /**
   * Measured 2026-11-07 on Windows at a fractional display scale: a setPosition()
   * on a transparent window re-rounds its width/height and the size creeps up a
   * pixel or two per call. Emulated here so a move that forgets to pin the size
   * fails this suite instead of waiting for the GPU process to eat the machine.
   */
  setPosition(x, y) {
    this.bounds.x = Math.round(x);
    this.bounds.y = Math.round(y);
    this.drift = (this.drift || 0) + 1;
    if (this.drift % 1 === 0) { this.bounds.width += 1; this.bounds.height += 1; }
  }
  getBounds() { return { ...this.bounds }; }
  setBounds(next) { Object.assign(this.bounds, next); }
  isVisible() { return this.visible && !this.destroyed; }
  /** Z-order, top first, the way GetWindow(GW_HWNDNEXT) walks it: a show or a
   *  moveTop puts a window on top. */
  raise() {
    const i = FakeWindow.z.indexOf(this);
    if (i >= 0) FakeWindow.z.splice(i, 1);
    FakeWindow.z.unshift(this);
  }
  moveTop() { if (!this.destroyed) this.raise(); }
  showInactive() { if (!this.destroyed) { this.visible = true; this.raise(); } }
  show() { if (!this.destroyed) { this.visible = true; this.raise(); } }
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
  static z = [];
  static getAllWindows() { return FakeWindow.all.filter((w) => !w.destroyed); }
  static fromId(id) { return FakeWindow.all.find((w) => w.id === id) || null; }
}

const fakeIpc = { handlers: new Map(), handle(channel, fn) { this.handlers.set(channel, fn); } };

let nativeMenuPopups = 0;
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
  Menu: { buildFromTemplate: () => ({ popup() { nativeMenuPopups += 1; } }) },
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
process.env.DESK_FAIRY_OWNER_FILE = path.join(os.tmpdir(), `spirit-fairy-owner-${process.pid}.json`);

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
    ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
    ...(opts.hideByDefault !== undefined ? { hideByDefault: opts.hideByDefault } : {}),
  });
  return { ...r, capture };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.beforeEach(() => {
  orbWindow.__reset();
  // Never read the REAL desktop's selection from a test; tests that want one set it.
  orbWindow.__setSelection(async () => "");
  FakeWindow.all.length = 0;
  FakeWindow.z.length = 0;
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

// ── the fairy IS the owner's AitherSprite (sprite-core.cjs) ─────────────────

function spriteFake({ status, teach, revive } = {}) {
  const calls = { status: 0, teach: [], revive: 0 };
  return {
    calls,
    async status() { calls.status += 1; return status ? status() : { ok: false, reason: "offline", view: null }; },
    async teach(p) { calls.teach.push(p); return teach ? teach(p) : { ok: true, data: {} }; },
    async revive() { calls.revive += 1; return revive ? revive() : { ok: true, data: {} }; },
  };
}

const PIP = { name: "Pip", stage: "teen", form: "wisp", mood_label: "curious", knowledge_count: 1 };

test("the fairy wears the sprite: name/stage/mood to both views, tinted by mood", async () => {
  const client = spriteFake({ status: () => ({ ok: true, view: require("./sprite-core.cjs").spriteView(PIP) }) });
  orbWindow.__setSpriteClient(client);
  start();
  await orbWindow.refreshSprite();
  const sent = orbWin().webContents.sent;
  const dressed = sent.filter(([c]) => c === "orb:sprite").pop()[1];
  assert.equal(dressed.line, "Pip · teen · curious");
  const tint = sent.filter(([c]) => c === "orb:tint").pop()[1];
  assert.equal(tint.css, require("./sprite-core.cjs").MOOD_TINTS.curious);
  const init = await invoke("desk:orb-init", orbWin());
  assert.equal(init.sprite.name, "Pip");
  assert.equal(init.tint.css, tint.css);
});

test("unreachable or signed out: the plain fairy, silently (no bubble line)", async () => {
  const client = spriteFake({ status: () => ({ ok: false, reason: "signed-out", view: null }) });
  orbWindow.__setSpriteClient(client);
  start();
  await orbWindow.refreshSprite();
  assert.equal(orbWindow.sprite(), null);
  assert.deepEqual(orbWindow.restTint(), spiritCore.tintFor("slot0"));
  assert.equal(orbWindow.queue().cur, null, "a background refresh never speaks");
  assert.equal(orbWindow.queue().items.length, 0);
});

test("sprite.status speaks the sprite, or why it is out of reach", async () => {
  orbWindow.__setSpriteClient(spriteFake({ status: () => ({ ok: true, view: require("./sprite-core.cjs").spriteView(PIP) }) }));
  start();
  const ok = await orbWindow.run("sprite-status");
  assert.equal(ok.ok, true);
  assert.match(ok.line, /^Pip is a teen, feeling curious/);
  orbWindow.__setSpriteClient(spriteFake({ status: () => ({ ok: false, reason: "offline", view: null }) }));
  const down = await orbWindow.run("sprite-status");
  assert.equal(down.ok, false);
  assert.match(down.line, /out of reach/);
});

test("sprite.teach teaches the clipboard, refuses a credential, and opens the field when empty", async () => {
  const client = spriteFake();
  orbWindow.__setSpriteClient(client);
  start();
  orbWindow.__setClipboard(() => "The 5090 renders; the Spark serves DeepSeek.");
  const taught = await orbWindow.run("sprite-teach");
  assert.equal(taught.ok, true);
  assert.equal(client.calls.teach[0].kind, "fact");
  assert.equal(client.calls.teach[0].source, "clipboard");

  orbWindow.__setClipboard(() => `token ${"ghp"}_${"Z".repeat(32)}`);
  const refused = await orbWindow.run("sprite-teach");
  assert.equal(refused.ok, false);
  assert.equal(client.calls.teach.length, 1, "a credential never leaves the desk");

  orbWindow.__setClipboard(() => "");
  const opened = await orbWindow.run("sprite-teach");
  assert.equal(opened.mode, "sprite-teach");
  const typed = await invoke("desk:orb-ask", bubbleWin(), "sprite-teach", "D:\\notes\\plan.md");
  assert.equal(typed.ok, true);
  assert.equal(client.calls.teach[1].kind, "link");
});

test("sprite.teach prefers the highlighted selection over the clipboard", async () => {
  const client = spriteFake();
  orbWindow.__setSpriteClient(client);
  start();
  orbWindow.__setSelection(async () => "Highlighted: the pool runs on the Spark.");
  orbWindow.__setClipboard(() => { throw new Error("the clipboard is not read when a selection exists"); });
  const r = await orbWindow.run("sprite-teach");
  assert.equal(r.ok, true);
  assert.equal(client.calls.teach[0].source, "selection");
  assert.match(r.line, /from your selection/);

  orbWindow.__setSelection(async () => `key ${"ghp"}_${"Q".repeat(32)}`);
  const refused = await orbWindow.run("sprite-teach");
  assert.equal(refused.ok, false, "a highlighted credential is refused like a copied one");
  assert.equal(client.calls.teach.length, 1);

  orbWindow.__setSelection(async () => "");
  orbWindow.__setClipboard(() => "copied fallback");
  const fb = await orbWindow.run("sprite-teach");
  assert.equal(client.calls.teach[1].source, "clipboard", "no selection falls back to the clipboard");
  assert.equal(fb.ok, true);
});

test("sprite.teach wakes a dormant sprite once, then teaches (409 is dormancy, not the network)", async () => {
  orbWindow.__setTeachRetryDelay(0);
  const client = spriteFake({ teach: () => (client.calls.teach.length === 1 ? { ok: false, reason: "dormant" } : { ok: true, data: {} }) });
  orbWindow.__setSpriteClient(client);
  start();
  const r = await orbWindow.run("sprite-teach", { arg: "A fact the dormant one needs" });
  assert.equal(r.ok, true);
  assert.equal(client.calls.revive, 1, "revived exactly once");
  assert.equal(client.calls.teach.length, 2, "the teach is retried after waking");
  assert.match(r.line, /woke it up/);

  const asleep = spriteFake({ teach: () => ({ ok: false, reason: "dormant" }), revive: () => ({ ok: false, reason: "offline" }) });
  orbWindow.__setSpriteClient(asleep);
  start();
  const bad = await orbWindow.run("sprite-teach", { arg: "Another fact" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /asleep and would not wake/);
  assert.doesNotMatch(bad.error, /Could not reach/);
});

test("sprite.teach waits out the 2 s teach throttle and retries instead of giving up", async () => {
  orbWindow.__setTeachRetryDelay(0);
  const client = spriteFake({ teach: () => (client.calls.teach.length === 1 ? { ok: false, reason: "throttled" } : { ok: true, data: {} }) });
  orbWindow.__setSpriteClient(client);
  start();
  const r = await orbWindow.run("sprite-teach", { arg: "A throttled fact" });
  assert.equal(r.ok, true);
  assert.equal(client.calls.teach.length, 2);
  assert.equal(client.calls.revive, 0, "a throttle is not dormancy: no revive");
});

test("sprite.teach falls back to the last snip's caption", async () => {
  const client = spriteFake();
  orbWindow.__setSpriteClient(client);
  start();
  orbWindow.__setClipboard(() => "");
  orbWindow.__setLastCaption("A chart of GPU memory.");
  const r = await orbWindow.run("sprite-teach");
  assert.equal(r.ok, true);
  assert.equal(client.calls.teach[0].source, "snip");
});

test("aw verbs: a query verb opens the field, the typed query runs, output lands in the bubble", async () => {
  orbWindow.__setSpriteClient(spriteFake());
  const runs = [];
  orbWindow.__setAwRun(async (verb, arg) => { runs.push([verb, arg]); return { ok: true, text: "2 facts about disks" }; });
  start();
  const opened = await orbWindow.run("aw-recall");
  assert.equal(opened.mode, "aw-recall");
  assert.equal(runs.length, 0);
  const r = await invoke("desk:orb-ask", bubbleWin(), "aw-recall", "disk");
  assert.equal(r.ok, true);
  assert.deepEqual(runs[0], ["aw-recall", "disk"]);
  const lines = [orbWindow.queue().cur, ...orbWindow.queue().items].filter(Boolean);
  assert.ok(lines.some((l) => l.text === "2 facts about disks"));

  const git = await orbWindow.run("aw-git");
  assert.equal(git.ok, true, "a no-arg verb runs at once");
  assert.deepEqual(runs[1], ["aw-git", ""]);
});

test("aw verbs: a missing binary is a bubble error, not a throw", async () => {
  orbWindow.__setSpriteClient(spriteFake());
  orbWindow.__setAwRun(async () => ({ ok: false, missing: true, text: "awrecover is not installed on this computer (not on PATH)." }));
  start();
  const r = await orbWindow.run("aw-recover", { arg: "E:/snaps" });
  assert.equal(r.ok, false);
  assert.equal(r.missing, true);
});

// ── the veil must not grow without bound (2026-11-07) ─────────────────────
// Measured: a transparent always-on-top veil grown to the UNION of every trail
// position reached 25568x24656, and its 60 Hz canvas reallocation took the GPU
// process to 9.2 GB private / 16.9 GB working set. Both are asserted here.

test("the veil shrinks to the current trail instead of keeping where it has been", () => {
  start();
  orbWindow.showOrb();
  const a = { x: 100, y: 100 };
  const far = { x: 3000, y: 2000 };
  const big = orbWindow.__test.coverVeil([a, far]);
  const veil = FakeWindow.all.find((w) => w.opts.title === "Aither spirit trail");
  assert.ok(veil, "the veil window exists");
  assert.deepEqual(veil.getBounds(), big);
  assert.ok(big.width > 2000, JSON.stringify(big));

  const small = orbWindow.__test.coverVeil([a]);
  assert.ok(small.width <= 200 && small.height <= 200, JSON.stringify(small));
  assert.deepEqual(veil.getBounds(), small, "the veil followed the trail instead of unioning with the past");
});

test("the veil stays inside the virtual desktop even if a point is off-screen", () => {
  start();
  const placed = orbWindow.__test.veilPlacement([{ x: 9000, y: 9000 }], { x: 0, y: 0, width: 3840, height: 3240 });
  assert.ok(placed.x + placed.width <= 3840, JSON.stringify(placed));
  assert.ok(placed.y + placed.height <= 3240, JSON.stringify(placed));
});

test("an unchanged veil frame is not re-sent -- a static spirit sends nothing", () => {
  start();
  orbWindow.showOrb();
  orbWindow.__test.coverVeil([{ x: 100, y: 100 }]); // creates the veil, as flyTo does
  orbWindow.__test.drawVeil();
  const veil = FakeWindow.all.find((w) => w.opts.title === "Aither spirit trail");
  assert.ok(veil, "the veil window exists");
  const sent = veil.webContents.sent.filter(([channel]) => channel === "orb:veil").length;
  assert.equal(sent, 1);
  orbWindow.__test.drawVeil();
  orbWindow.__test.drawVeil();
  assert.equal(veil.webContents.sent.filter(([channel]) => channel === "orb:veil").length, sent);
  orbWindow.pump();
});

test("orb.html only reassigns the veil canvas when the pixel size changed", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const at = html.indexOf("function sizeTo(s)");
  assert.ok(at > 0, "sizeTo exists");
  const body = html.slice(at, at + 1200);
  assert.match(body, /if \(w !== canvas\.width \|\| h !== canvas\.height\)/);
  const guard = body.indexOf("if (w !== canvas.width");
  const assign = body.indexOf("canvas.width = w");
  assert.ok(guard >= 0 && assign > guard, "the reallocation must sit INSIDE the size guard");
  assert.match(html, /requestAnimationFrame/, "draws are coalesced to one per display frame");
});

// ── the GPU leak: an orb move must not change the orb's size ──────────────

test("moving the orb never grows it: 300 moves leave a 72 px window", () => {
  writeState({ visible: true, x: 200, y: 200 });
  start();
  for (let i = 0; i < 300; i += 1) orbWindow.__test.moveOrb(200 + (i % 10), 200 + (i % 7));
  assert.deepEqual(orbWin().getBounds(), { x: 209, y: 205, width: 72, height: 72 });
  orbWindow.pump();
});

test("the hover loop cannot inflate the orb (the timer that leaked at 33 ms)", () => {
  writeState({ visible: true, x: 200, y: 200 });
  start();
  const orb = orbWin();
  for (let i = 0; i < 200; i += 1) orbWindow.__test.moveOrb(200, 200);
  assert.equal(orb.getBounds().width, 72);
  assert.equal(orb.getBounds().height, 72);
  orbWindow.pump();
});

test("a move to a point off every display lands on the nearest screen (fairy flew off-screen, 2026-11-07)", () => {
  writeState({ visible: true, x: 200, y: 200 });
  start();
  // Right of the 3840-wide primary: the spot a window parked off-desktop handed the orbit.
  orbWindow.__test.moveOrb(5408, 758);
  const b = orbWin().getBounds();
  assert.deepEqual({ w: b.width, h: b.height }, { w: 72, h: 72 });
  assert.ok(b.x + b.width <= 3840 && b.x >= 0, `x ${b.x} is off the primary`);
  assert.ok(b.y >= 0 && b.y + b.height <= 2120, `y ${b.y} is off the work area`);
  orbWindow.pump();
});

test("no orb-window code path moves the window with setPosition alone", () => {
  const src = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.doesNotMatch(src, /\.setPosition\(/, "use moveOrb: setPosition drifts the size on Windows");
  assert.match(src, /function moveOrb\(/, "moveOrb pins width and height on every move");
});

test("the fairy's badge opens the Inbox list (inbox.open), never answers a card", async () => {
  const calls = [];
  start({ runCommand: (id) => { calls.push(id); return { ok: true }; } });
  orbWindow.showOrb();
  const reply = await handler("desk:orb-needs-you")({ sender: orbWin().webContents });
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(calls, ["inbox.open"]);
  orbWindow.pump();
});

test("the count is a BUTTON, not decoration (owner 2026-11-20: the 58 read as paint)", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  // It takes the pointer only when it has a count, and looks pressable.
  assert.match(html, /#badge\.on \{[^}]*pointer-events: auto/, "a counted badge takes clicks");
  assert.match(html, /#badge\.on:hover[^{]*\{[^}]*box-shadow: 0 0 0 2px #fff/, "it wears a ring on hover");
  assert.match(html, /#badge\.on:active \{ transform: scale\(0\.94\)/, "it presses");
  assert.match(html, /#badge\.on::after \{ content: "›"/, "a chevron says 'this opens something'");
  // The 72 px window ignores clicks outside the disc: the badge must be in the hit test.
  assert.match(html, /function badgeUnder\(e\)/, "the badge's rect is measured");
  assert.match(html, /toggleHit\(onDisc \|\| Boolean\(m\) \|\| badgeUnder\(e\)\)/, "and it is part of the hit test");
  // A keyboard user gets the same door.
  assert.match(html, /badge\.addEventListener\("keydown"/);
  assert.match(html, /role", "button"/);
  // A companion passing over the badge cannot steal the press (review 2026-11-20).
  assert.match(html, /if \(badgeUnder\(e\)\) return;/, "the badge wins before a companion's card");
});

test("the fairy door is labelled Needs you (N) when cards are waiting", () => {
  const src = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  // The door carries the fairy's own number (fairy-counts.cjs), not the blocker strip's.
  assert.match(src, /`Needs you \(\$\{attentionCards\.length\}\)`/);
  assert.match(src, /"desk:orb-needs-you"/, "the badge handler is registered");
  const preload = fs.readFileSync(path.join(__dirname, "orb-preload.cjs"), "utf8");
  assert.match(preload, /needsYou: \(\) => ipcRenderer\.invoke\("desk:orb-needs-you"\)/);
});

// ── attention: the cards live in the fairy (2026-11-08) ─────────────────────

const ATTENTION_FILE = path.join(os.tmpdir(), `fairy-attention-${process.pid}.json`);
process.env.DESK_FAIRY_ATTENTION_FILE = ATTENTION_FILE;

function nudgeWin() { return FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Aither nudge") || null; }

function blockedCard(over = {}) {
  return {
    id: "d-fair",
    title: "Claude Code needs you: AitherOS-Fresh -- Desktop canvas layout",
    kind: "blocked",
    urgency: "high",
    blocking: true,
    createdAt: Math.floor(Date.now() / 1000) - 600,
    deadline: 0,
    options: [{ key: "ack", label: "I am looking now" }, { key: "later", label: "Not now" }],
    defaultKey: "ack",
    agent: "",
    tab: "Desktop canvas layout",
    ...over,
  };
}

function startAttention(hooks = {}, startOpts = {}) {
  fs.rmSync(ATTENTION_FILE, { force: true });
  start(startOpts);
  orbWindow.showOrb();
  const calls = { answer: [], open: [], speak: [] };
  orbWindow.__setAttentionHooks({
    quiet: () => "",
    idleMs: () => 0,
    fullScreen: async () => "",
    answer: async (id, key) => { calls.answer.push([id, key]); return true; },
    open: (id) => { calls.open.push(id); return true; },
    speak: (line, opts) => { calls.speak.push([line, opts]); return true; },
    ...hooks,
  });
  return calls;
}

test("a card that matters flies the fairy to the pointer and shows the whisper beside it, never on it", async () => {
  startAttention();
  cursor = { x: 1500, y: 900 };
  orbWindow.setAttentionCards([blockedCard()]);
  const plan = await orbWindow.attentionTick();
  assert.equal(plan.act, "nudge");
  assert.equal(plan.level, 2, "blocked = flutter");
  assert.deepEqual(orbWindow.nudging(), { id: "d-fair", level: 2, shown: false }, "the whisper waits for the flight");
  await wait(1000);
  const whisper = nudgeWin();
  assert.ok(whisper && whisper.isVisible(), "the whisper is up once the fairy arrived");
  assert.equal(whisper.opts.focusable, false, "the whisper never takes the keyboard");
  assert.equal(whisper.ignoreMouse, true, "click-through until the pointer is on it");
  const w = whisper.getBounds();
  const covers = cursor.x >= w.x && cursor.x <= w.x + w.width && cursor.y >= w.y && cursor.y <= w.y + w.height;
  assert.equal(covers, false, "the whisper does not cover the pointer");
  const o = orbWin().getBounds();
  const dist = Math.hypot(o.x + 36 - cursor.x, o.y + 36 - cursor.y);
  assert.ok(dist < 260 && dist > 50, `the fairy flutters near the pointer (${Math.round(dist)} px)`);
  const view = whisper.webContents.sent.filter(([c]) => c === "orb:nudge-view").pop()[1];
  assert.equal(view.title, "AitherOS-Fresh -- Desktop canvas layout");
  assert.match(view.why, /Desktop canvas layout is stopped until you answer/);
  assert.deepEqual(view.options.map((x) => x.key), ["ack", "later"]);
  orbWindow.endNudge("seen", { stay: true });
});

test("the whisper answers with the card's OWN option through main, and refuses one it does not have", async () => {
  const calls = startAttention();
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const whisper = nudgeWin();
  const hover = await invoke("desk:nudge-act", whisper, "hover", true);
  assert.equal(hover.ok, true);
  assert.equal(whisper.ignoreMouse, false, "the pointer on the card makes it clickable");
  const bad = await invoke("desk:nudge-act", whisper, "answer", "rm -rf");
  assert.equal(bad.ok, false);
  assert.deepEqual(calls.answer, [], "an invented choice never reaches the answer path");
  const good = await invoke("desk:nudge-act", whisper, "answer", "ack");
  assert.equal(good.ok, true);
  assert.deepEqual(calls.answer, [["d-fair", "ack"]]);
  await wait(1500);
  assert.equal(orbWindow.nudging(), null, "the confirmation closes the whisper");
  await wait(350); // the fade finishes, then the window goes
  assert.equal(whisper.isVisible(), false);
  assert.equal(orbWindow.attentionMems()["d-fair"].ignored || 0, 0, "answered is not ignored");
});

test("\"more\" opens the waiting LIST, never the Inbox on whatever card it last showed", async () => {
  // Owner, 2026-11-10: 99+ waiting and the card a session was stopped on could
  // not be found -- the link opened the Inbox on an arbitrary card instead.
  let opened = 0;
  const calls = startAttention({ openList: () => { opened += 1; return true; } });
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const r = await invoke("desk:nudge-act", nudgeWin(), "more");
  assert.equal(r.ok, true);
  assert.equal(opened, 1, "the list is what the link opens");
  assert.deepEqual(calls.open, [], "the Inbox is not opened on a card");
  orbWindow.endNudge("seen", { stay: true });

  // A build with no list wired still has a door: the Inbox, with no card named.
  // (Checked in source: a second nudge in this process is held by pacing.)
  const src = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.match(src, /hookValue\("open", what === "more" \? null : card\.id\)/,
    "the fallback names no card, so the Inbox shows the queue");
});

test("a NEW card is delivered by the fairy out loud: it asks when the mic is on, says it when muted (2026-11-15)", async () => {
  const fresh = (id) => blockedCard({
    id, kind: "decision", urgency: "low", blocking: false, createdAt: Math.floor(Date.now() / 1000) - 30,
    title: "Mirror which Discord channels to Relay?",
    options: [{ key: "a", label: "Mirror #general" }, { key: "b", label: "Mirror nothing yet" }], defaultKey: "b",
  });
  const talked = [];
  const calls = startAttention({ micMuted: () => false, talk: async (card) => { talked.push(card.id); return { ok: true, kind: "later" }; } });
  orbWindow.__resetAttentionClock();
  const old = blockedCard({ id: "d-old", kind: "decision", urgency: "high", blocking: false, createdAt: Math.floor(Date.now() / 1000) - 5 * 86400 });
  orbWindow.setAttentionCards([old, fresh("d-arr1")]);
  const plan = await orbWindow.attentionTick();
  assert.equal(plan.act, "nudge");
  assert.equal(plan.card.id, "d-arr1", "the arrival, not the backlog");
  assert.equal(plan.arrival, true);
  assert.equal(plan.level, 2, "a LOW card still flies to the pointer when it is new");
  assert.deepEqual(talked, ["d-arr1"], "mic on: the voice card flow asks it");
  assert.match(calls.speak.map(([l]) => l).join(" "), /1 older card is on the list/, "the backlog is mentioned");
  await wait(1000);
  const view = nudgeWin().webContents.sent.filter(([c]) => c === "orb:nudge-view").pop()[1];
  assert.equal(view.moreLabel, "1 older", "the backlog folds into one line");
  await wait(1500);
  assert.equal(orbWindow.nudging(), null, "'later' said aloud closes the bubble");
  assert.ok(orbWindow.attentionMems()["d-arr1"].snoozeUntil > Date.now(), "and puts the card off");
  // Muted mic: the fairy SAYS the question with force (the owner's mic mute is input only).
  const calls2 = startAttention({ micMuted: () => true, talk: async () => { throw new Error("must not listen"); } });
  orbWindow.__resetAttentionClock();
  orbWindow.setAttentionCards([fresh("d-arr2")]);
  const p2 = await orbWindow.attentionTick();
  assert.equal(p2.card.id, "d-arr2");
  const said = calls2.speak.find(([l]) => /Mirror which Discord channels to Relay\?/.test(l));
  assert.ok(said, "the question is spoken");
  assert.match(said[0], /I suggest Mirror nothing yet\. Say option one or two, or later\./);
  assert.equal(said[1].force, true);
  orbWindow.endNudge("seen", { stay: true });
  // The same card again (the next poll, or a restart that reloads the memory): no repeat.
  orbWindow.setAttentionCards([fresh("d-arr2")]);
  orbWindow.__resetAttentionClock();
  const p3 = await orbWindow.attentionTick();
  assert.notEqual(p3.arrival, true, "shown once: never an arrival again");
});

test("an ignored nudge counts toward the next level; Later snoozes; answered elsewhere closes it", async () => {
  startAttention();
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  orbWindow.endNudge("timeout");
  assert.equal(orbWindow.attentionMems()["d-fair"].ignored, 1);
  // pacing: the same card is not re-nudged right away
  const again = await orbWindow.attentionTick();
  assert.equal(again.act, "none");
  orbWindow.__setAttentionHooks({ quiet: () => "", idleMs: () => 0, fullScreen: async () => "" });
  orbWindow.setAttentionCards([blockedCard({ id: "d-next", createdAt: Math.floor(Date.now() / 1000) })]);
  // the old card left the queue: its memory is stamped gone and pruned after the grace
  // (an empty start-up feed must not reset the ladder -- 2026-11-19, d-ennp)
  assert.ok(orbWindow.attentionMems()["d-fair"].goneAt > 0, "kept through the grace, stamped gone");
});

test("quiet, a hidden fairy, or the owner away: no nudge, and the claim follows visibility", async () => {
  startAttention({ quiet: () => "Do not disturb" });
  orbWindow.setAttentionCards([blockedCard()]);
  assert.match((await orbWindow.attentionTick()).reason, /Do not disturb/);
  orbWindow.__setAttentionHooks({ quiet: () => "", idleMs: () => 10 * 60_000, fullScreen: async () => "" });
  assert.match((await orbWindow.attentionTick()).reason, /away/);
  orbWindow.__setAttentionHooks({ quiet: () => "", idleMs: () => 0, fullScreen: async () => "game.exe is full-screen" });
  assert.match((await orbWindow.attentionTick()).reason, /full-screen/);
  assert.equal(orbWindow.ownsAttention(), true, "on screen with its loop running: the fairy carries the cards");
  orbWindow.hideOrb();
  assert.equal(orbWindow.ownsAttention(), false, "hidden: awask's window comes back");
});

test("clicking the orb mid-nudge opens the ask box; the card it carried counts as seen", async () => {
  // Owner 2026-11-18: the orb's click is the ask box again; the Inbox is the badge's click.
  let listed = 0;
  startAttention({ openList: () => { listed += 1; return true; } });
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const r = await invoke("desk:orb-click", orbWin());
  assert.equal(r.ok, true);
  assert.equal(r.visible, true, "the ask box opens");
  assert.equal(r.inbox, undefined, "the orb never opens the Inbox");
  assert.equal(listed, 0, "no on-screen list");
  assert.equal(orbWindow.nudging(), null);
  assert.equal(orbWindow.attentionMems()["d-fair"].ignored || 0, 0, "seen, not ignored");
});

test("clicking the orb with cards waiting opens the ask box; the Inbox stays on the badge", async () => {
  // Owner, 2026-11-10: the badge said 1, the click opened an empty chat. 2026-11-12:
  // the orb's click is the waiting LIST; a companion's click is its card.
  let listed = 0;
  const calls = startAttention({ openList: () => { listed += 1; return true; } });
  orbWindow.setAttentionCards([blockedCard({ id: "d-top" }), blockedCard({ id: "d-second" })]);
  await orbWindow.attentionTick();
  await wait(1000);
  orbWindow.endNudge("later", { stay: true });
  await wait(2500); // the fairy flies home; a click mid-flight cancels the flight (by design)
  // An earlier test may have left the chat bubble up; a click on that closes it.
  const b = bubbleWin();
  if (b && b.isVisible()) b.hide();
  assert.equal(orbWindow.nudging(), null);
  const r = await invoke("desk:orb-click", orbWin());
  assert.equal(r.ok, true);
  assert.equal(r.visible, true, "the ask box opens with cards waiting too");
  assert.equal(listed, 0, "no on-screen list");
  assert.deepEqual(calls.open, [], "the orb's click never opens the Inbox");
  assert.equal(orbWindow.nudging(), null, "no card pops from the orb's click");
  bubbleWin().hide();
  // Nothing waiting: the click still opens the chat.
  orbWindow.setAttentionCards([]);
  const chat = await invoke("desk:orb-click", orbWin());
  assert.equal(chat.visible, true);
  assert.equal(chat.card, undefined);
});

test("a trip that hangs never swallows the click: the ask box still opens, and the trip times out", async () => {
  // Owner, 2026-11-10: "nothing is happening when I click on fairies... they just change
  // colors". A trip whose step never settled held tripBusy, and every click only
  // cancelled that trip.
  let listed = 0;
  startAttention({ openList: () => { listed += 1; return true; } });
  orbWindow.setAttentionCards([]);
  orbWindow.__setTripLimitMs(1500);
  const never = () => new Promise(() => {});
  orbWindow.__setOps({ findFiles: never, readFile: never, listFolder: never, webSearch: never });
  const trip = orbWindow.go({ kind: "search", target: "hangs" });
  await wait(400);
  const b = bubbleWin();
  if (b && b.isVisible()) b.hide();
  orbWindow.setAttentionCards([blockedCard({ id: "d-trip" })]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  const r = await invoke("desk:orb-click", orbWin());
  assert.equal(r.ok, true);
  assert.equal(r.visible, true, "the click is never swallowed by the hung trip");
  assert.equal(listed, 0, "no on-screen list");
  bubbleWin().hide();
  // The hung trip itself ends on its limit instead of holding the spirit for good.
  const hung = orbWindow.go({ kind: "search", target: "hangs again" });
  const verdict = await Promise.race([hung, wait(6000).then(() => ({ stuck: true }))]);
  assert.notEqual(verdict.stuck, true, "a hung trip must end on its limit");
  assert.equal(verdict.ok, false);
  await Promise.race([trip, wait(100)]);
  orbWindow.__setTripLimitMs(120_000);
  orbWindow.setAttentionCards([]);
});

test("an ordinary card only glows beside the fairy where it rests", async () => {
  startAttention();
  const homeBefore = orbWin().getBounds();
  orbWindow.setAttentionCards([blockedCard({
    id: "d-glow", kind: "decision", urgency: "normal", blocking: false, tab: "",
    options: [{ key: "cut", label: "Cut 0.4.4 now" }, { key: "wait", label: "Wait" }], defaultKey: "wait",
  })]);
  const plan = await orbWindow.attentionTick();
  assert.equal(plan.level, 1);
  await wait(50);
  const whisper = nudgeWin();
  assert.ok(whisper.isVisible(), "a glow shows the whisper at once (no flight)");
  const after = orbWin().getBounds();
  assert.ok(Math.abs(after.x - homeBefore.x) < 40 && Math.abs(after.y - homeBefore.y) < 40, "the fairy stayed home");
  orbWindow.endNudge("seen", { stay: true });
});

// ── the fairy's voice: chime, Talk, Chat (2026-11-08) ───────────────────────

function lastNudgeSignal() {
  const sent = orbWin().webContents.sent.filter(([c, p]) => c === "orb:nudge" && p && p.level > 0);
  return sent.length ? sent[sent.length - 1][1] : null;
}

test("a nudge chimes by level (a flutter = a two-note rise)", async () => {
  startAttention();
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  const sig = lastNudgeSignal();
  assert.equal(sig.level, 2);
  assert.equal(sig.chime.length, 2, "a flutter is a two-note rise");
  assert.equal(orbWin().opts.webPreferences.autoplayPolicy, "no-user-gesture-required", "the chime plays without a click");
  orbWindow.endNudge("seen", { stay: true });
});

test("Fairy sounds off is remembered and silences the chime", async () => {
  startAttention();
  assert.equal(orbWindow.setSounds(false).sounds, false);
  assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).sounds, false, "the switch is remembered in orb.json");
  orbWindow.setAttentionCards([blockedCard({ id: "d-quiet1" })]);
  await orbWindow.attentionTick();
  assert.equal(lastNudgeSignal().chime, null, "sounds off: no chime");
  orbWindow.endNudge("seen", { stay: true });
});

test("every desk voice muted: the nudge is silent", async () => {
  startAttention({ soundMuted: () => true });
  orbWindow.setAttentionCards([blockedCard({ id: "d-mute1" })]);
  await orbWindow.attentionTick();
  assert.equal(lastNudgeSignal().chime, null, "every voice muted: no chime");
  orbWindow.endNudge("seen", { stay: true });
});

test("Talk runs the voice card flow for THIS card and shows the outcome in the whisper", async () => {
  const talked = [];
  startAttention({
    talk: async (card) => { talked.push(card.id); return { ok: true, kind: "answer", key: "ack", label: "I am looking now" }; },
  });
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const whisper = nudgeWin();
  const r = await invoke("desk:nudge-act", whisper, "talk");
  assert.equal(r.ok, true);
  assert.deepEqual(talked, ["d-fair"], "the talk hook got the nudged card");
  const flashes = whisper.webContents.sent.filter(([c]) => c === "orb:nudge-flash").map(([, p]) => p);
  assert.ok(flashes.some((f) => /Listening/.test(f.text) && f.keep), "it says it is listening, options still clickable");
  assert.ok(flashes.some((f) => /Done: I am looking now/.test(f.text)));
  await wait(1500);
  assert.equal(orbWindow.nudging(), null, "answered by voice closes the whisper");
});

test("Talk with the mic muted says so in the whisper and keeps the card up", async () => {
  startAttention({ talk: async () => ({ ok: false, muted: true, error: "microphone is muted" }) });
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const whisper = nudgeWin();
  const r = await invoke("desk:nudge-act", whisper, "talk");
  assert.equal(r.ok, false);
  assert.equal(r.muted, true);
  const flash = whisper.webContents.sent.filter(([c]) => c === "orb:nudge-flash").pop()[1];
  assert.match(flash.text, /mic is muted/i);
  assert.equal(flash.error, true);
  assert.ok(orbWindow.nudging(), "the whisper stays: the owner can still click an option");
  orbWindow.endNudge("seen", { stay: true });
});

test("Chat opens the fairy bubble focused with the card as context; the next question is about the card", async () => {
  const prompts = [];
  const askVision = async (_img, prompt) => { prompts.push(prompt); return { ok: true, text: "Waiting costs a day.", via: "test" }; };
  startAttention({}, { askVision });
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  assert.deepEqual(orbWindow.nudgeCard(), { id: "d-fair", title: blockedCard().title }, "the launcher's fairy row reads this");
  const whisper = nudgeWin();
  const r = await invoke("desk:nudge-act", whisper, "chat");
  assert.equal(r.ok, true);
  assert.equal(orbWindow.nudging(), null, "the whisper hands over to the bubble");
  assert.equal(orbWindow.nudgeCard(), null);
  const bubble = bubbleWin();
  assert.ok(bubble && bubble.isVisible() && bubble.focused, "the bubble is up and focused");
  const mode = bubble.webContents.sent.filter(([c]) => c === "orb:mode").pop()[1];
  assert.equal(mode.mode, "card");
  assert.equal(mode.title, "AitherOS-Fresh -- Desktop canvas layout");
  const asked = await invoke("desk:orb-ask", bubble, "text", "what happens if I wait?");
  assert.equal(asked.ok, true);
  const p = prompts.pop();
  assert.match(p, /AitherOS-Fresh -- Desktop canvas layout/);
  assert.match(p, /1\. I am looking now \(suggested\)/);
  assert.match(p, /The owner asks: what happens if I wait\?/);
  // closing the bubble drops the card: the next question is about the screen again
  await invoke("desk:orb-close", bubble);
  await invoke("desk:orb-ask", bubble, "text", "and this?");
  assert.doesNotMatch(prompts.pop(), /Desktop canvas layout/);
});

test("Chat on a card that is no longer open is refused, and the bubble stays shut", async () => {
  startAttention();
  const r = orbWindow.chatAboutCard("d-gone");
  assert.equal(r.ok, false);
  assert.equal(bubbleWin(), null);
});

test("the whisper page has Talk and Chat buttons wired to nudgeAct, and the orb page synthesizes the chime", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  assert.match(html, /data-act="talk"/);
  assert.match(html, /data-act="chat"/);
  assert.match(html, /api\.nudgeAct\(b\.dataset\.act\)/);
  assert.match(html, /createOscillator\(\)/);
  assert.doesNotMatch(html, /new Audio\(|\.mp3|\.wav/, "no audio files");
});

test("the whisper grows to fit its full button labels, clamped and kept on screen", async () => {
  startAttention();
  orbWindow.setAttentionCards([blockedCard({
    options: [{ key: "a", label: "I will run it under my own tenant, please relaunch it there" }, { key: "b", label: "Keep refusing" }],
  })]);
  await orbWindow.attentionTick();
  await wait(1000);
  const whisper = nudgeWin();
  const r = await invoke("desk:nudge-act", whisper, "size", "300");
  assert.equal(r.ok, true);
  assert.equal(whisper.getBounds().height, 300);
  await invoke("desk:nudge-act", whisper, "size", "5000");
  assert.equal(whisper.getBounds().height, 560, "clamped");
  const b = whisper.getBounds();
  assert.ok(b.y + b.height <= 2120, "kept inside the work area");
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  assert.doesNotMatch(html, /#n-acts button \{[^}]*text-overflow: ellipsis/, "no ellipsis on a choice");
  orbWindow.endNudge("seen", { stay: true });
});

// ── generated card UI (A2UI v0.9, card-ui.cjs) in the whisper (2026-11-08) ──

/** A raw stored card with a current, valid ui -> the desk shape main hands the fairy. */
function uiCard(mutateUi = () => {}, id = "d-fair-ui") {
  const cardUi = require("./card-ui.cjs");
  const raw = {
    id, status: "open", kind: "blocked", blocking: true, urgency: "high",
    created_at: Math.floor(Date.now() / 1000) - 600,
    title: "Relaunch the AWS runners?", summary: "16 runners are ghosts.", facts: ["last seen 11-07"],
    options: [
      { key: "relaunch", label: "Relaunch all sixteen under the org runner group, using the owner-tenant env" },
      { key: "hold", label: "Hold" },
    ],
    default_key: "hold",
  };
  const sid = "card-d-fair-ui";
  const ui = {
    a2ui: "v0.9",
    card_hash: cardUi.cardHash(raw),
    messages: [
      { version: "v0.9", createSurface: { surfaceId: sid, catalogId: cardUi.BASIC_CATALOG_ID } },
      { version: "v0.9", updateComponents: { surfaceId: sid, components: [
        { id: "root", component: "Column", align: "stretch", children: ["title", "f0", "b0", "b1"] },
        { id: "title", component: "Text", variant: "h3", text: raw.title },
        { id: "f0", component: "Text", variant: "caption", text: raw.facts[0] },
        { id: "b0", component: "Button", variant: "primary", text: raw.options[0].label,
          action: { event: { name: "answer:relaunch" } } },
        { id: "b1", component: "Button", variant: "borderless", text: "Hold",
          action: { event: { name: "answer:hold" } } },
      ] } },
    ],
  };
  mutateUi(ui);
  return require("./decision-cards.cjs").cardFromRaw({ ...raw, ui });
}

test("a card with a current ui: the whisper gets the tree, and its button answers through nudgeAct", async () => {
  const calls = startAttention();
  orbWindow.setAttentionCards([uiCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const whisper = nudgeWin();
  const view = whisper.webContents.sent.filter(([c]) => c === "orb:nudge-view").pop()[1];
  assert.ok(view.ui && view.ui.type === "column", "the render tree rides the whisper view");
  assert.deepEqual(view.uiKeys, ["relaunch", "hold"]);
  const button = view.ui.children.find((n) => n.type === "button" && n.variant === "primary");
  assert.match(button.text, /owner-tenant env$/, "the full label, not cut");
  const bad = await invoke("desk:nudge-act", whisper, "answer", "rm -rf");
  assert.equal(bad.ok, false, "main still re-checks the key");
  const r = await invoke("desk:nudge-act", whisper, "answer", button.key);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.answer, [["d-fair-ui", "relaunch"]]);
  await wait(1500);
  assert.equal(orbWindow.nudging(), null);
});

test("a stale or invalid ui falls back to the card's own options in the whisper", async () => {
  const cases = [
    (ui) => { ui.card_hash = "0".repeat(64); },
    (ui) => { ui.messages[1].updateComponents.components[3].action.event.name = "answer:nope"; },
  ];
  for (const [i, mutate] of cases.entries()) {
    orbWindow.__reset();
    FakeWindow.all.length = 0;
    startAttention();
    orbWindow.setAttentionCards([uiCard(mutate, `d-fair-ui-bad${i}`)]);
    await orbWindow.attentionTick();
    await wait(1000);
    const view = nudgeWin().webContents.sent.filter(([c]) => c === "orb:nudge-view").pop()[1];
    assert.equal(view.ui, null);
    assert.deepEqual(view.options.map((o) => o.key), ["relaunch", "hold"]);
    orbWindow.endNudge("seen", { stay: true });
  }
});

test("the whisper page draws the ui with DOM APIs only and answers via nudgeAct", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const start = html.indexOf("function uiNode(");
  const end = html.indexOf("function render(v)", start);
  assert.ok(start > 0 && end > start);
  const body = html.slice(start, end);
  assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(body, /textContent = n\.text/);
  assert.match(body, /api\.nudgeAct\("answer", n\.key\)/);
  assert.doesNotMatch(html, /#n-ui button \{[^}]*text-overflow: ellipsis/, "no ellipsis on a choice");
});

// ── the agent fairy (agent-fairy.cjs, owner 2026-11-09) ─────────────────────

function lastSent(win, channel) {
  const hits = win.webContents.sent.filter(([c]) => c === channel);
  return hits.length ? hits[hits.length - 1][1] : undefined;
}

test("the fairy wears the colour of the agent whose card it carries, and Aither again after", async () => {
  startAttention();
  orbWindow.setAttentionCards([blockedCard({ agent: "Atlas" })]);
  assert.equal(orbWindow.fairy().agent, "aither", "idle: the owner's white-gold fairy");
  await orbWindow.attentionTick();
  const worn = lastSent(orbWin(), "orb:fairy");
  assert.equal(worn.agent, "atlas");
  assert.equal(worn.color, "#a3a3a3", "an Atlas card makes it grey");
  await wait(1000);
  const view = lastSent(nudgeWin(), "orb:nudge-view");
  assert.equal(view.agent.agent, "atlas", "the whisper is signed by the Atlas fairy");
  orbWindow.endNudge("seen", { stay: true });
  assert.equal(lastSent(orbWin(), "orb:fairy").agent, "aither", "back to Aither when the card goes");
});

test("cards from several agents: companions orbit (every agent, not the one worn), a hover peeks without touching the ladder", async () => {
  startAttention();
  const now = Math.floor(Date.now() / 1000) - 600;
  orbWindow.setAttentionCards([
    blockedCard({ id: "d-a1", agent: "atlas", createdAt: now }),
    blockedCard({ id: "d-l1", agent: "lyra", createdAt: now }),
    blockedCard({ id: "d-d1", agent: "demi", createdAt: now }),
    blockedCard({ id: "d-i1", agent: "iris", createdAt: now }),
    blockedCard({ id: "d-s1", agent: "saga", createdAt: now }),
    blockedCard({ id: "d-v1", agent: "vera", createdAt: now }),
  ]);
  const mates = lastSent(orbWin(), "orb:companions");
  assert.equal(mates.length, 6, "one fairy per decision, at the cap");
  assert.deepEqual(mates.map((m) => m.agent), ["atlas", "lyra", "demiurge", "iris", "saga", "vera"]);
  assert.ok(mates.every((m) => m.kind === "decision" && m.cardId), "each carries its own card");
  const peek = orbWindow.peekCard("d-l1");
  assert.equal(peek.ok, true);
  assert.equal(orbWindow.nudging().id, "d-l1");
  assert.equal(lastSent(orbWin(), "orb:fairy").color, "#8b5cf6", "a Lyra card is violet");
  const view = lastSent(nudgeWin(), "orb:nudge-view");
  assert.equal(view.lead, "From Lyra");
  assert.equal(orbWindow.attentionMems()["d-l1"], undefined, "a peek is not a nudge: no ladder memory");
  assert.equal(
    orbWin().webContents.sent.some(([c, p]) => c === "orb:nudge" && p && p.level > 0), false,
    "a peek does not chime or glow",
  );
  // 2026-11-16: every decision keeps its own fairy, the worn one included (the cluster
  // counts the queue; a fairy that vanished while its card was open read as "answered").
  const worn = lastSent(orbWin(), "orb:companions");
  assert.equal(worn.some((m) => m.cardId === "d-l1"), true, "the open card's fairy stays in the cluster");
  orbWindow.endNudge("timeout", { stay: true });
  assert.equal(orbWindow.attentionMems()["d-l1"], undefined, "an ignored peek is not an ignored nudge");
  const missing = orbWindow.peekCard("d-nope");
  assert.equal(missing.ok, false);
});

test("a peek never steals a real nudge's whisper", async () => {
  startAttention();
  orbWindow.setAttentionCards([
    blockedCard({ id: "d-a1", agent: "atlas" }),
    blockedCard({ id: "d-l1", agent: "lyra" }),
  ]);
  await orbWindow.attentionTick();
  const real = orbWindow.nudging().id;
  const peek = orbWindow.peekCard(real === "d-a1" ? "d-l1" : "d-a1");
  assert.equal(peek.ok, false);
  assert.equal(orbWindow.nudging().id, real);
  orbWindow.endNudge("seen", { stay: true });
});

test("a hover on another fairy never swaps out a card the owner clicked open, or one the pointer is on", async () => {
  // Owner, 2026-11-10: "I click but I can't get to the card because it changes when
  // I hover over a different fairy" -- the pointer crosses companions on its way.
  startAttention();
  const now = Math.floor(Date.now() / 1000);
  orbWindow.setAttentionCards([
    blockedCard({ id: "d-a1", agent: "atlas", createdAt: now }),
    blockedCard({ id: "d-l1", agent: "lyra", createdAt: now }),
    blockedCard({ id: "d-d1", agent: "demi", createdAt: now }),
  ]);
  assert.equal(orbWindow.openFairyCard("d-a1").ok, true, "a click opens it");
  const hover = orbWindow.peekCard("d-l1");
  assert.equal(hover.ok, false, "the hover is refused");
  assert.equal(orbWindow.nudging().id, "d-a1", "the clicked card stays");
  orbWindow.endNudge("seen", { stay: true });
  // A hover-opened card the pointer is ON is also held.
  assert.equal((orbWindow.peekCard("d-l1")).ok, true);
  await invoke("desk:nudge-act", nudgeWin(), "hover", true);
  assert.equal((orbWindow.peekCard("d-d1")).ok, false);
  assert.equal(orbWindow.nudging().id, "d-l1");
  await invoke("desk:nudge-act", nudgeWin(), "hover", false);
  // A hover-opened card the pointer has left: the next hover may still replace it.
  assert.equal((orbWindow.peekCard("d-d1")).ok, true);
  assert.equal(orbWindow.nudging().id, "d-d1");
  orbWindow.endNudge("seen", { stay: true });
});

test("whoever is talking: the fairy wears that agent for about the line, a character changes nothing", () => {
  start();
  orbWindow.showOrb();
  assert.equal(orbWindow.setSpeaker("Some VRM character", "hello").ok, false);
  assert.equal(orbWindow.fairy().agent, "aither");
  const r = orbWindow.setSpeaker("demi", "PR is up");
  assert.equal(r.ok, true);
  assert.equal(r.ms, 3000);
  assert.equal(lastSent(orbWin(), "orb:fairy").color, "#06b6d4", "a Demiurge line is cyan");
});

test("twelve agents waiting: the cluster shows five and a bead of seven, centred on the fairy, click-through, the orb unchanged", async () => {
  startAttention();
  const agents = ["atlas", "demi", "lyra", "iris", "saga", "vera", "hera", "gargbot", "plutus", "chaos", "viviane", "aeon-crew"];
  const old = Math.floor(Date.now() / 1000) - 600;
  orbWindow.setAttentionCards(agents.map((a, i) => blockedCard({ id: `d-x${i}`, agent: a, createdAt: old })));
  const swarm = orbWindow.swarmWindow();
  assert.ok(swarm && swarm.isVisible(), "the swarm is up");
  assert.equal(swarm.opts.focusable, false);
  assert.equal(swarm.ignoreMouse, true, "click-through until a companion is under the pointer");
  const list = lastSent(swarm, "orb:companions");
  assert.equal(list.length, 6, "capped: five fairies and one counted bead");
  const bead = list[list.length - 1];
  assert.equal(bead.kind, "more");
  assert.equal(bead.count, 7);
  assert.equal(orbWindow.clusterState().total, 12, "the count is every fairy");
  const o = orbWin().getBounds();
  assert.equal(o.width, 72, "the orb window never grows");
  const b = swarm.getBounds();
  assert.equal(b.x + b.width / 2, o.x + 36, "centred on the fairy");
  assert.ok(b.width >= 2 * 40, "sized for the second ring");
  await invoke("desk:swarm-hit", swarm, true);
  assert.equal(swarm.ignoreMouse, false);
  orbWindow.setAttentionCards([blockedCard({ id: "d-x0", agent: "atlas" })]);
  assert.equal(lastSent(swarm, "orb:companions").length, 1, "one card left: one fairy");
  orbWindow.setAttentionCards([]);
  assert.equal(swarm.isVisible(), false, "nothing live: no swarm");
});

test("the swarm page draws companions with DOM APIs and hit-tests them click-through", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  assert.match(html, /api\.onFairy\(wearFairy\)/);
  assert.match(html, /api\.onCompanions\(setMates\)/);
  assert.doesNotMatch(html, /api\.peek\(/, "a hover never asks for a card (owner 2026-11-12)");
  assert.match(html, /setInside\(Boolean\(m\)\)/, "a companion is hit only under the pointer");
  const swarmView = html.slice(html.indexOf('if (view === "swarm")'), html.indexOf("// ── the whisper"));
  assert.ok(swarmView.length > 500, "the swarm view exists");
  assert.doesNotMatch(swarmView, /slice\(0, \d+\)/, "no cap on companions");
  const mates = html.slice(html.indexOf("function setMates"), html.indexOf("function mateAt"));
  assert.doesNotMatch(mates, /innerHTML|insertAdjacentHTML|outerHTML/);
  const preload = fs.readFileSync(path.join(__dirname, "orb-preload.cjs"), "utf8");
  assert.match(preload, /onFairy: \(fn\) => on\("orb:fairy", fn\)/);
  assert.match(preload, /peek: \(id\) => ipcRenderer\.invoke\("desk:orb-peek"/);
  assert.match(preload, /swarmHit: \(inside\) => ipcRenderer\.invoke\("desk:swarm-hit"/);
});

test("the fairy stays ABOVE its swarm in z-order after every companion update (live: dimmed under it)", () => {
  startAttention();
  orbWindow.state().swarm = true; // the swarm is opt-in since 2026-11-13
  const old = Math.floor(Date.now() / 1000) - 600;
  const cards = (agents) => agents.map((a, i) => blockedCard({ id: `d-z${i}`, agent: a, createdAt: old }));
  const above = () => {
    const orb = FakeWindow.z.indexOf(orbWin());
    const swarm = FakeWindow.z.indexOf(orbWindow.swarmWindow());
    return orb >= 0 && swarm >= 0 && orb < swarm;
  };
  orbWindow.setAttentionCards(cards(["atlas", "lyra", "iris"]));
  assert.ok(orbWindow.swarmWindow().isVisible());
  assert.ok(above(), "first show: the fairy is over its swarm");
  // something else raises the swarm (a re-show, the OS): the next update puts the fairy back on top
  orbWindow.swarmWindow().moveTop();
  assert.equal(above(), false);
  orbWindow.setAttentionCards(cards(["atlas", "lyra", "iris", "saga", "vera"]));
  assert.ok(above(), "a companion update raises the fairy again");
});

test("the resting fairy is Aither white-gold at full brightness, with a contrast rim", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  assert.match(html, /orb\.classList\.toggle\("aither", resting\)/);
  assert.match(html, /#orb\.aither \.halo \{[^}]*rgba\(255,200,87/, "a gold bloom, not the pale blue-white one");
  assert.match(html, /#orb \.core \{ filter: drop-shadow/, "a rim that reads on a white page");
  assert.doesNotMatch(html, /\.mate[^{]*\{[^}]*box-shadow: 0 0 (1\d|[2-9]\d)px/, "companion glows stay small: no fog");
});

// ── owner screenshots 2026-11-09: stale whispers, empty chat, tooltips ─────

test("hovering a fairy whose card is days old shows nothing; CLICKING it opens it, marked old", async () => {
  startAttention();
  const old = Math.floor(Date.now() / 1000) - 22 * 24 * 3600;
  const now = Math.floor(Date.now() / 1000) - 600;
  orbWindow.setAttentionCards([
    blockedCard({ id: "d-pix8", agent: "atlas", title: "Approve the Pixel 8", createdAt: old }),
    blockedCard({ id: "d-l1", agent: "lyra", createdAt: now }),
  ]);
  const hover = orbWindow.peekCard("d-pix8");
  assert.equal(hover.ok, false, "an old card does not pop on a hover");
  assert.equal(orbWindow.nudging(), null);
  const click = await invoke("desk:orb-open-card", orbWin(), "d-pix8", "atlas");
  assert.equal(click.ok, true);
  assert.equal(orbWindow.nudging().id, "d-pix8");
  const view = lastSent(nudgeWin(), "orb:nudge-view");
  assert.equal(view.old, "Old — still relevant?");
  assert.match(view.lead, /22 d old$/);
  assert.equal(orbWindow.attentionMems()["d-pix8"], undefined, "a click is not a nudge on the ladder");
  orbWindow.endNudge("timeout", { stay: true });
});

test("clicking an agent's fairy opens that agent's NEWEST card, even over a running nudge", async () => {
  startAttention();
  const t = Math.floor(Date.now() / 1000);
  orbWindow.setAttentionCards([
    blockedCard({ id: "d-a1", agent: "atlas", createdAt: t - 3000 }),
    blockedCard({ id: "d-a2", agent: "atlas", createdAt: t - 60 }),
    blockedCard({ id: "d-l1", agent: "lyra", createdAt: t - 600 }),
  ]);
  const mates = lastSent(orbWin(), "orb:companions");
  const atlas = mates.find((m) => m.agent === "atlas");
  assert.equal(atlas.cardId, "d-a2", "the companion carries the newest card");
  // A card id that has gone (answered elsewhere) falls back to the agent's newest.
  const r = await invoke("desk:orb-open-card", orbWin(), "d-gone", "atlas");
  assert.equal(r.ok, true);
  assert.equal(orbWindow.nudging().id, "d-a2");
  const other = await invoke("desk:orb-open-card", orbWin(), "d-l1", "lyra");
  assert.equal(other.ok, true, "a click outranks the whisper already up");
  assert.equal(orbWindow.nudging().id, "d-l1");
  const none = await invoke("desk:orb-open-card", orbWin(), "", "vera");
  assert.equal(none.ok, false);
  orbWindow.endNudge("timeout", { stay: true });
});

test("a card or panel up: the orb and swarm pages are told to drop their hover tooltips, and told again after", async () => {
  startAttention();
  orbWindow.setAttentionCards([blockedCard({ id: "d-a1", agent: "atlas" })]);
  orbWindow.peekCard("d-a1");
  assert.deepEqual(lastSent(orbWin(), "orb:panel"), { open: true });
  orbWindow.endNudge("timeout", { stay: true });
  assert.deepEqual(lastSent(orbWin(), "orb:panel"), { open: false });
});

test("chat about a card: the header names the agent in plain words, never the sprite line", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const bubble = html.slice(html.indexOf('if (view === "bubble")'));
  assert.doesNotMatch(bubble, /sp\.line/, "the sprite id/stage/tier line is not a header");
  assert.match(bubble, /about this card/);
  const src = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.match(src, /send\("orb:mode", \{ mode: "card", title: cardChat\.title, who: cardChat\.who \}\)/);
  // The swarm draws no native tooltip and asks for no card on a hover (2026-11-12).
  const swarm = html.slice(html.indexOf('if (view === "swarm")'), html.indexOf("// ── the right-click menu"));
  assert.doesNotMatch(swarm, /document\.body\.title = /);
  assert.match(swarm, /api\.openCard\(hotMate\.id, hotMate\.agent\)/);
  const orb = html.slice(html.indexOf('if (view === "orb")'), html.indexOf('if (view === "swarm")'));
  assert.match(orb, /api\.openCard\(m\.cardId, m\.agent\)/, "a companion under the disc opens its card");
  assert.doesNotMatch(html, /`\+\$\{v\.more\} more`/, "no '+99 more'");
});

// ── presence + click to talk (owner 2026-11-09: one agent = one presence) ────

test("presence: active agents with NO cards fly in the swarm; a post flashes one; a click opens THAT agent's chat", async () => {
  const chats = [];
  startAttention({ chat: (agent, links) => { chats.push([agent, links]); return true; } });
  orbWindow.setPresence([
    { agent: "atlas", state: "working", work: [{ title: "tick", url: "" }], discord: { bot: true, dm_url: "https://discord.com/users/1" },
      thread_url: "https://discord.com/channels/1/2/3" },
    { agent: "lyra", state: "idle" },
  ]);
  const swarm = orbWindow.swarmWindow();
  assert.ok(swarm && swarm.isVisible(), "presence alone raises the swarm");
  let list = lastSent(swarm, "orb:companions");
  // An idle platform agent is not an active one (2026-11-16): only working agents fly.
  assert.deepEqual(list.map((c) => [c.agent, c.state]), [["atlas", "working"]]);
  orbWindow.noteAgentPosted("Atlas");
  list = lastSent(swarm, "orb:companions");
  assert.equal(list.find((c) => c.agent === "atlas").state, "speaking", "its Discord/relay post flashes it");
  assert.equal(orbWindow.fairy().agent, "aither", "a post does not re-colour the main fairy");
  const r = await invoke("desk:orb-chat-agent", swarm, "atlas");
  assert.equal(r.ok, true);
  assert.deepEqual(chats, [["atlas", { threadUrl: "https://discord.com/channels/1/2/3", dmUrl: "https://discord.com/users/1" }]]);
  const generic = await invoke("desk:orb-chat-agent", swarm, "claude-code");
  assert.equal(generic.ok, false);
});

test("click to talk with no chat wired says so, never pretends", async () => {
  startAttention();
  orbWindow.setPresence([{ agent: "atlas", state: "idle" }]);
  const r = orbWindow.chatWithAgent("atlas");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not wired/);
});

test("the swarm page draws presence states and a click asks for that agent's chat; main + deck carry it through", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  for (const st of ["idle", "working", "speaking", "waiting"]) assert.ok(html.includes(`.mate.st-${st} {`), st);
  // A click SELECTS a companion (2026-11-16, fairy-control.cjs) and opens its newest card when it
  // carries one; a double click (or the menu's Chat row) opens the chat with that agent.
  assert.match(html, /api\.select\(hotMate\.agent\);\s*if \(hotMate\.id\) api\.openCard\(hotMate\.id, hotMate\.agent\);/);
  assert.match(html, /dblclick[\s\S]*?api\.chatAgent\(hotMate\.agent\)/);
  const preload = fs.readFileSync(path.join(__dirname, "orb-preload.cjs"), "utf8");
  assert.match(preload, /chatAgent: \(agent\) => ipcRenderer\.invoke\("desk:orb-chat-agent"/);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /chat: \(agent, links\) => \{[\s\S]*?getSwarmHost\(\)\.talkTo\(agent\)[\s\S]*?return openAgentChat\(agent, links\);/);
  assert.match(main, /type: "deck:open-chat"/);
  assert.match(main, /platformPresence = snap\.presence\.agents/);
  // The live Claude sessions ride beside the platform agents, one companion each.
  assert.match(main, /host\.withBase\(\[\.\.\.platformPresence, \.\.\.sessions\]\)/);
  assert.match(main, /orbWindow\.noteAgentPosted\(agent\)/);
  const deck = fs.readFileSync(path.join(__dirname, "..", "src", "components", "Deck.tsx"), "utf8");
  assert.match(deck, /event\.type !== 'deck:open-chat'/);
  assert.match(deck, /Continue thread/);
  assert.match(deck, /Discord DM/);
});

// ── owner 2026-11-12: no card on hover; left click opens, right click is a menu ──

function menuWin() { return FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Aither menu") || null; }
function tipWin() { return FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Aither tip") || null; }

test("a hover never opens a card: the peek IPC is refused, the tip is one line in a never-focused window", async () => {
  startAttention();
  orbWindow.setAttentionCards([
    blockedCard({ id: "d-a1", agent: "atlas" }),
    blockedCard({ id: "d-l1", agent: "lyra" }),
  ]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  const hover = await invoke("desk:orb-peek", orbWin(), "d-l1");
  assert.equal(hover.ok, false, "the old hover-peek is refused");
  assert.equal(orbWindow.nudging(), null, "no card came up");
  const tip = await invoke("desk:fairy-tip", orbWin(), "Lyra: Approve the deploy", { x: 500, y: 400 });
  assert.equal(tip.ok, true);
  const tw = tipWin();
  assert.ok(tw && tw.isVisible());
  assert.equal(tw.opts.focusable, false, "the tip never takes the keyboard");
  assert.equal(tw.ignoreMouse, true, "the tip never takes a click");
  assert.deepEqual(lastSent(tw, "orb:tip"), { text: "Lyra: Approve the deploy", side: "right" });
  assert.equal(orbWindow.nudging(), null, "still no card");
  await invoke("desk:fairy-tip", orbWin(), "");
  assert.equal(tw.isVisible(), false);
});

test("a left click on a companion pins its card: no timer, no hover replaces it, no tip over it", async () => {
  startAttention();
  orbWindow.setAttentionCards([
    blockedCard({ id: "d-a1", agent: "atlas" }),
    blockedCard({ id: "d-l1", agent: "lyra" }),
  ]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  const r = await invoke("desk:orb-open-card", orbWin(), "d-l1", "lyra");
  assert.equal(r.ok, true);
  assert.equal(orbWindow.nudging().id, "d-l1");
  const src = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.match(src, /showMs: explicit \? fairyMenu\.PINNED_MS/, "a clicked card is pinned, not timed");
  assert.ok(require("./fairy-menu.cjs").PINNED_MS >= 10 * 60_000);
  assert.equal(orbWindow.peekCard("d-a1").ok, false, "a hover-peek cannot replace it");
  await invoke("desk:fairy-tip", orbWin(), "Atlas: something", { x: 10, y: 10 });
  assert.ok(!tipWin() || !tipWin().isVisible(), "no tooltip over a card the owner opened");
  orbWindow.endNudge("seen", { stay: true });
});

test("right click on a companion: the pill menu with every action, focused, beside the pointer", async () => {
  startAttention();
  const sessionCard = blockedCard({
    id: "d-s1", agent: "lyra", sessionId: "abcd1234-0000", title: "Approve the deploy",
    options: [{ key: "yes", label: "Ship it", recommended: true }, { key: "no", label: "Hold" }],
  });
  orbWindow.setAttentionCards([sessionCard, blockedCard({ id: "d-a1", agent: "atlas" })]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  cursor = { x: 800, y: 600 };
  const r = await invoke("desk:fairy-menu", orbWin(), "d-s1", "lyra");
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, ["open", "answer:yes", "snooze:1h", "snooze:4h", "snooze:tomorrow",
    "mute", "dismiss", "session", "link:open-aither", "link:open-system", "copy",
    "fc:chat", "fc:grow", "fc:mute", "fc:pin", "fc:hide", "fc:session", "sv:menu"]);
  const mw = menuWin();
  assert.ok(mw.isVisible());
  assert.equal(mw.focused, true, "focused, so arrows / Enter / Esc work");
  assert.notEqual(mw.opts.focusable, false);
  const b = mw.getBounds();
  assert.equal(b.x, 808);
  assert.equal(b.y, 604);
  const shown = lastSent(mw, "orb:menu");
  assert.match(shown.header, /^Lyra · Approve the deploy/);
  assert.equal(shown.items.find((i) => i.id === "answer:yes").label, "Answer: Ship it", "names the recommended option");
  assert.equal(orbWindow.nudging(), null, "a right click opens no card by itself");
  // Losing focus closes it, like a native menu.
  mw.emit("blur");
  assert.equal(mw.isVisible(), false);
  assert.equal(orbWindow.menuState(), null);
});

test("menu picks: answer recommended, snooze, stop nudging, dismiss, session, copy -- each through its one path", async () => {
  const cancels = [];
  const sessions = [];
  const calls = startAttention({
    cancel: (id, note) => { cancels.push([id, note]); return true; },
    focusSession: async (id) => { sessions.push(id); return { ok: true, via: "tab" }; },
  });
  const card = blockedCard({
    id: "d-p1", agent: "lyra", sessionId: "s-1",
    options: [{ key: "yes", label: "Ship it", recommended: true }, { key: "no", label: "Hold" }],
  });
  orbWindow.setAttentionCards([card]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  const pick = async (id) => {
    await invoke("desk:fairy-menu", orbWin(), "d-p1", "lyra");
    return invoke("desk:menu-pick", menuWin(), id);
  };
  assert.equal((await pick("answer:no")).ok, false, "only the item the menu showed");
  assert.deepEqual(calls.answer, []);
  assert.equal((await pick("answer:yes")).ok, true);
  assert.deepEqual(calls.answer, [["d-p1", "yes"]]);
  const before = Date.now();
  const s4 = await pick("snooze:4h");
  assert.equal(s4.ok, true);
  assert.ok(orbWindow.attentionMems()["d-p1"].snoozeUntil >= before + 4 * 3600_000 - 1000);
  assert.equal((await orbWindow.attentionTick()).act, "none", "a snoozed card is not nudged");
  const st = await pick("snooze:tomorrow");
  assert.equal(new Date(st.snoozeUntil).getHours(), 9);
  assert.equal((await pick("mute")).ok, true);
  assert.equal(orbWindow.attentionMems()["d-p1"].muted, true);
  assert.equal((await pick("dismiss")).ok, true);
  assert.deepEqual(cancels, [["d-p1", "owner dismissed it from the desk fairy"]]);
  assert.equal((await pick("session")).ok, true);
  assert.deepEqual(sessions, ["d-p1"]);
  let copied = "";
  const realWrite = fakeElectron.clipboard.writeText;
  fakeElectron.clipboard.writeText = (t) => { copied = t; };
  try {
    const c = await pick("copy");
    assert.equal(c.ok, true);
    assert.equal(copied, "https://aitherium.com/decide?id=d-p1");
  } finally {
    fakeElectron.clipboard.writeText = realWrite;
  }
  // Esc (a pick of nothing) just closes.
  await invoke("desk:fairy-menu", orbWin(), "d-p1", "lyra");
  assert.deepEqual(await invoke("desk:menu-pick", menuWin(), ""), { ok: true, closed: true });
  assert.equal(menuWin().isVisible(), false);
});

test("a credential card shows Answer disabled; no session = Go to session disabled", async () => {
  const calls = startAttention();
  orbWindow.setAttentionCards([blockedCard({
    id: "d-c1", agent: "atlas", kind: "credential", options: [{ key: "ok", label: "Enter", recommended: true }],
  })]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  const r = await invoke("desk:fairy-menu", orbWin(), "d-c1", "atlas");
  assert.ok(r.items.includes("answer"));
  const items = lastSent(menuWin(), "orb:menu").items;
  assert.equal(items.find((i) => i.id === "answer").disabled, true);
  assert.equal(items.find((i) => i.id === "session").disabled, true);
  assert.equal((await invoke("desk:menu-pick", menuWin(), "answer")).ok, false);
  assert.deepEqual(calls.answer, [], "a credential is never answered from a menu");
});

test("right click on the orb: inbox, answer window, quiet 1 h (nudges held), settings, more, hide fairies", async () => {
  let listed = 0;
  const doors = [];
  const calls = startAttention({ openList: () => { listed += 1; return true; }, door: (name) => { doors.push(name); return true; } });
  orbWindow.setAttentionCards([blockedCard({ id: "d-o1", createdAt: Math.floor(Date.now() / 1000) })]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  const r = await invoke("desk:orb-menu", orbWin());
  assert.deepEqual(r.items, ["inbox", "queue", "hide-this", "hide-all", "show-all", "open-desktop", "open-spaces",
    "open-chat", "settings", "quiet-1h", "quiet-4h", "quit", "sv:menu", "more"]); // the card's fairy is in the cluster
  assert.match(lastSent(menuWin(), "orb:menu").header, /1 waiting on you/);
  assert.equal((await invoke("desk:menu-pick", menuWin(), "inbox")).ok, true);
  assert.deepEqual(calls.open, [null], "the Inbox, on no card in particular");
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "queue");
  assert.equal(listed, 1);
  await invoke("desk:orb-menu", orbWin());
  const m = await invoke("desk:menu-pick", menuWin(), "quiet-1h");
  assert.ok(m.quietUntil > Date.now() + 59 * 60_000);
  assert.match((await orbWindow.attentionTick()).reason, /muted/);
  const again = await invoke("desk:orb-menu", orbWin());
  assert.ok(again.items.includes("quiet-off"), "quiet: the row offers to end it");
  await invoke("desk:menu-pick", menuWin(), "quiet-off");
  assert.equal(orbWindow.quietUntil(), 0);
  await invoke("desk:orb-menu", orbWin());
  assert.equal((await invoke("desk:menu-pick", menuWin(), "settings")).ok, true);
  assert.deepEqual(doors, ["settings"]);
  await invoke("desk:orb-menu", orbWin());
  // "More..." is the SECOND PAGE of the one pill menu, not a second (native, dark) menu
  // (owner 2026-11-16: two fairy menus, two looks).
  assert.equal((await invoke("desk:menu-pick", menuWin(), "more")).ok, true, "the old full menu is one row away");
  const more = lastSent(menuWin(), "orb:menu");
  const moreIds = more.items.filter((i) => !i.sep).map((i) => i.id);
  assert.match(more.header, /more/);
  for (const id of ["spirit:web", "spirit:ask", "spirit:find", "spirit:attach", "spirit:home", "spirit:sounds", "spirit:sprite", "spirit:teach", "less"]) {
    assert.ok(moreIds.includes(id), `the second page lost ${id}: ${moreIds.join(", ")}`);
  }
  assert.equal(nativeMenuPopups, 0, "no native menu was popped: the fairy has ONE menu");
  assert.equal((await invoke("desk:menu-pick", menuWin(), "spirit:sounds")).ok, true, "a row on the second page runs");
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "more");
  assert.equal((await invoke("desk:menu-pick", menuWin(), "spirit:nonsense")).ok, false, "a row the page did not show is refused");
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "more");
  assert.equal((await invoke("desk:menu-pick", menuWin(), "less")).ok, true);
  assert.ok(lastSent(menuWin(), "orb:menu").items.some((i) => i.id === "more"), "Back returns to the short menu");
  const viaPage = await invoke("desk:spirit-menu", orbWin());
  assert.equal(viaPage.ok, true, "the page's own right click (api.menu) opens the same pill menu");
  assert.equal(nativeMenuPopups, 0);
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "hide-this");
  assert.equal(orbWin().isVisible(), false, "Hide the fairies hides the fairy and its swarm");
});

// -- companions hidden by default (owner 2026-11-13, companion-menu.cjs) ----------

test("a fresh install shows no fairy; the choice to show it persists per user", () => {
  // beforeEach removed orb.json: this is a fresh profile.
  const r = start();
  assert.equal(r.visible, false, "fresh: hidden");
  assert.ok(!orbWin() || !orbWin().isVisible(), "no fairy window on screen");
  assert.equal(orbWindow.tenantCompanionVisible(), false, "the workspace companion is hidden too");
  orbWindow.companionAction("show-all");
  assert.equal(orbWin().isVisible(), true);
  const saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
  assert.equal(saved.visible, true);
  assert.equal(saved.tenantCompanion, true);
  orbWindow.__reset();
  FakeWindow.all.length = 0;
  assert.equal(start().visible, true, "the next launch keeps what the person chose");
});

test("an installed build hides an older install's fairy ONCE; a dev checkout keeps it", () => {
  writeState({ visible: true, x: 200, y: 200 });
  assert.equal(start({ hideByDefault: true }).visible, false, "packaged: moved to hidden");
  orbWindow.companionAction("show-all");
  orbWindow.__reset();
  FakeWindow.all.length = 0;
  assert.equal(start({ hideByDefault: true }).visible, true, "the migration never runs twice");
  orbWindow.__reset();
  FakeWindow.all.length = 0;
  writeState({ visible: true, x: 200, y: 200 });
  assert.equal(start({ hideByDefault: false }).visible, true, "dev checkout: unchanged");
});

test("the hidden-by-default move keeps a fresh install's first-run spot (bottom-right, never 0,0)", () => {
  start({ hideByDefault: true });
  orbWindow.companionAction("show-all");
  const b = orbWin().getBounds();
  assert.ok(b.x > 1000 && b.y > 1000, `first-run spot is bottom-right, got ${b.x},${b.y}`);
  const saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
  assert.equal(saved.x, null, "no remembered spot was invented");
});

test("every companion row does what it says: hide this, hide all, show all, doors, quiet, quit", async () => {
  const doors = [];
  startAttention({ door: (name) => { doors.push(name); return true; } });
  const changes = [];
  orbWindow.onCompanionsChange((snap) => changes.push(snap));
  assert.equal(orbWin().isVisible(), true);
  assert.deepEqual(orbWindow.companionAction("hide-this", { target: "fairy" }), { ok: true, visible: false });
  assert.equal(orbWin().isVisible(), false);
  orbWindow.companionAction("show-all");
  assert.equal(orbWin().isVisible(), true);
  assert.equal(orbWindow.tenantCompanionVisible(), true);
  assert.deepEqual(orbWindow.companionAction("hide-this", { target: "tenant" }), { ok: true, tenant: false });
  assert.equal(orbWin().isVisible(), true, "hiding the workspace companion leaves the fairies");
  const all = orbWindow.companionAction("hide-all");
  assert.equal(all.fairy, false);
  assert.equal(all.tenant, false);
  assert.equal(orbWin().isVisible(), false);
  for (const id of ["open-desktop", "open-spaces", "open-chat", "settings", "quit"]) {
    assert.equal(orbWindow.companionAction(id).ok, true, id);
  }
  assert.deepEqual(doors, ["desktop", "spaces", "chat", "settings", "quit"]);
  const q4 = orbWindow.companionAction("quiet-4h");
  assert.ok(q4.quietUntil >= Date.now() + 4 * 3600_000 - 1000);
  assert.ok(orbWindow.quietUntil() > Date.now());
  orbWindow.companionAction("quiet-off");
  assert.equal(orbWindow.quietUntil(), 0);
  assert.equal(orbWindow.companionAction("nope").ok, false);
  assert.ok(changes.length >= 5, "the tray and the overlay hear every change");
  // Without main's door hook a door runs its registry id.
  const ran = [];
  orbWindow.__setAttentionHooks({});
  orbWindow.__reset();
  FakeWindow.all.length = 0;
  start({ runCommand: (id) => { ran.push(id); } });
  orbWindow.companionAction("open-spaces");
  orbWindow.companionAction("quit");
  assert.deepEqual(ran, ["osapp.spaces", "quit"]);
});

test("the workspace companion's own right-click menu: its rows, picks through the same path", async () => {
  startAttention({ door: () => true });
  orbWindow.companionAction("show-all");
  const r = orbWindow.openCompanionMenu("tenant");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "tenant");
  assert.deepEqual(r.items, ["hide-this", "hide-all", "open-desktop", "open-spaces", "open-chat", "settings",
    "quiet-1h", "quiet-4h", "quit"]);
  assert.equal(menuWin().focused, true, "focused: arrows, Enter and Esc work");
  const pick = await invoke("desk:menu-pick", menuWin(), "hide-this");
  assert.deepEqual(pick, { ok: true, tenant: false });
  assert.equal(orbWin().isVisible(), true, "Hide this hid the companion, not the fairies");
  // The tray: Show/Hide all, desktop, Spaces, quiet. Chat, Settings and Quit are its own rows.
  const tray = orbWindow.companionTrayItems().filter((i) => !i.sep).map((i) => i.id);
  assert.deepEqual(tray, ["hide-all", "show-all", "open-desktop", "open-spaces", "quiet-1h", "quiet-4h"]);
});

test("the companion's menu opens AT the companion, even beside the box the fairy avoids", async () => {
  startAttention({ door: () => true });
  orbWindow.companionAction("show-all");
  // The goblin's box, bottom-right of the primary work area (3840x2120).
  orbWindow.setReservedBox({ x: 3500, y: 1760, width: 300, height: 320 });
  const r = orbWindow.openCompanionMenu("tenant", { at: { x: 3600, y: 1900 } });
  assert.equal(r.ok, true);
  const b = menuWin().getBounds();
  assert.ok(Math.abs(b.x + b.width - 3600) <= 16 || Math.abs(b.x - 3608) <= 16, `beside the click, got x=${b.x}`);
  assert.ok(b.y + b.height <= 2120 && b.y >= 0, "on the screen");
  assert.ok(Math.abs((b.y + b.height) - 1896) <= 16, `flipped up from the click, got y=${b.y}+${b.height}`);
  orbWindow.setReservedBox(null);
});

test("a menu taller than the screen fits it: the window is clamped, the page scrolls", () => {
  const fm = require("./fairy-menu.cjs");
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }));
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = fm.menuSize(many, area);
  assert.ok(size.height <= 1040 - 16);
  const pos = fm.menuPlacement({ x: 900, y: 500 }, area, size);
  assert.ok(pos.y >= 0 && pos.y + size.height <= 1040);
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  assert.match(html, /#m-items \{[^}]*overflow-y: auto/);
});

test("a hidden fairy never docks itself onto the AitherOS window", async () => {
  start();
  const host = new FakeWindow({ title: "AitherDesktop", x: 100, y: 100, width: 1200, height: 800 });
  host.visible = true;
  host.isMinimized = () => false;
  const r = await orbWindow.setDockWindow(host);
  assert.equal(r.docked, false);
  assert.equal(orbWindow.attach(), null);
  assert.ok(!orbWin().isVisible());
});

test("the orb and swarm pages: right click opens the pill menu, hover only dwells a tip, the menu page handles keys", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const orb = html.slice(html.indexOf('if (view === "orb")'), html.indexOf('if (view === "swarm")'));
  assert.match(orb, /api\.fairyMenu\(m\.cardId, m\.agent\)/);
  assert.match(orb, /api\.orbMenu\(\)/);
  const swarm = html.slice(html.indexOf('if (view === "swarm")'), html.indexOf("// ── the right-click menu"));
  assert.match(swarm, /addEventListener\("contextmenu"[\s\S]*api\.fairyMenu\(hotMate\.id, hotMate\.agent\)/);
  assert.match(swarm, /dwell\.on\(/, "the hover is a dwell, not a peek");
  assert.match(html, /const TIP_DWELL_MS = 400;/);
  assert.equal(require("./fairy-menu.cjs").TIP_DWELL_MS, 400, "the page and the module agree");
  const menu = html.slice(html.indexOf('if (view === "menu")'), html.indexOf('if (view === "tip")'));
  for (const key of ["Escape", "ArrowDown", "ArrowUp", "Home", "End"]) assert.match(menu, new RegExp(`"${key}"`));
  assert.match(menu, /"role", "menuitem"/);
  assert.doesNotMatch(menu.slice(menu.indexOf("function render")), /innerHTML/, "items are DOM nodes, never HTML");
  const preload = fs.readFileSync(path.join(__dirname, "orb-preload.cjs"), "utf8");
  assert.match(preload, /fairyMenu: \(id, agent\) => ipcRenderer\.invoke\("desk:fairy-menu"/);
  assert.match(preload, /menuPick: \(id\) => ipcRenderer\.invoke\("desk:menu-pick"/);
});

test("fairy.menu (palette / bridge): the orb's menu opens beside the fairy, focused, from the keyboard", async () => {
  startAttention();
  orbWindow.setAttentionCards([]);
  cursor = { x: 5, y: 5 };
  const r = orbWindow.run("menu");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "orb");
  const mw = menuWin();
  assert.ok(mw.isVisible() && mw.focused);
  const o = orbWin().getBounds();
  const b = mw.getBounds();
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  const near = (b.x === cx + 8 || b.x === cx - b.width - 8) && (b.y === cy + 4 || b.y === cy - b.height - 4);
  assert.ok(near, `beside the fairy (flipped at the screen edge), not at the pointer: ${JSON.stringify({ b, cx, cy })}`);
  const reg = require("./command-registry.cjs");
  const row = reg.byId("fairy.menu");
  assert.equal(row.orb, "menu");
  assert.ok(row.surfaces.includes("palette"));
});

test("a menu Windows refused the keyboard (no blur will come) closes itself once nothing touches it", async () => {
  startAttention();
  orbWindow.setAttentionCards([]);
  orbWindow.__setMenuIdleMs(300);
  orbWindow.run("menu");
  const mw = menuWin();
  // Live 2026-11-12: Electron still called it focused while Windows kept the keyboard
  // elsewhere, so focus cannot be the test -- the pointer and the keys are.
  assert.equal(mw.focused, true);
  await invoke("desk:menu-hover", mw, true);
  await wait(900);
  assert.ok(mw.isVisible(), "the pointer is on it: it stays");
  await invoke("desk:menu-hover", mw, false);
  await wait(150);
  await invoke("desk:menu-hover", mw, "key");
  await wait(200);
  assert.ok(mw.isVisible(), "a key a moment ago: it stays");
  await wait(1200);
  assert.equal(mw.isVisible(), false, "off it and unfocused: it closes, never stuck on screen");
  assert.equal(orbWindow.menuState(), null);
});

// ── owner 2026-11-14: "these little tooltips get stuck and stay in the way" ──

test("a tip never sticks: it hides when the pointer leaves the fairy, with no word from the page", async () => {
  startAttention();
  cursor = { x: 500, y: 400 };
  await invoke("desk:fairy-tip", orbWin(), "support-loop: support repro: needs-info", { x: 500, y: 400 });
  const tw = tipWin();
  assert.ok(tw && tw.isVisible());
  assert.ok(orbWindow.hoverGuard().state().polling, "watched while it is up");
  cursor = { x: 1400, y: 900 }; // the pointer went to Explorer; no mouseleave reached the page
  await wait(450);
  assert.equal(tw.isVisible(), false, "the tip hid itself");
  assert.equal(orbWindow.hoverGuard().state().polling, false, "idle again: no timer");
});

test("the orb is click-through while no fairy is hovered, even when the leave is never reported", async () => {
  startAttention();
  const orb = orbWin();
  const b = orb.getBounds();
  cursor = { x: b.x + 36, y: b.y + 36 };
  await invoke("desk:orb-hit", orb, true);
  assert.equal(orb.ignoreMouse, false, "the pointer on the fairy: it takes the click");
  cursor = { x: b.x + 400, y: b.y + 400 };
  await wait(450);
  assert.equal(orb.ignoreMouse, true, "back to click-through on its own");
  assert.equal(lastSent(orb, "orb:hit-reset"), true, "the page is told to re-arm its hover");
});

test("a new companion list drops the tip and hands the swarm back to click-through", async () => {
  startAttention();
  orbWindow.state().swarm = true;
  const old = Math.floor(Date.now() / 1000) - 600;
  orbWindow.setAttentionCards(["atlas", "lyra", "iris"].map((a, i) => blockedCard({ id: `d-h${i}`, agent: a, createdAt: old })));
  const swarm = orbWindow.swarmWindow();
  const b = swarm.getBounds();
  cursor = { x: b.x + 5, y: b.y + 5 };
  await invoke("desk:swarm-hit", swarm, true);
  await invoke("desk:fairy-tip", swarm, "atlas: a card", { x: cursor.x, y: cursor.y });
  assert.equal(swarm.ignoreMouse, false);
  assert.ok(tipWin().isVisible());
  orbWindow.setAttentionCards(["atlas", "lyra", "iris", "saga"].map((a, i) => blockedCard({ id: `d-h${i}`, agent: a, createdAt: old })));
  assert.equal(tipWin().isVisible(), false, "the fairies moved: the tip is gone");
  assert.equal(swarm.ignoreMouse, true, "and the swarm passes clicks through again");
});

test("the orb page draws no native tooltip; its own line rides the guarded tip window", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const orb = html.slice(html.indexOf('if (view === "orb")'), html.indexOf('if (view === "swarm")'));
  assert.doesNotMatch(orb, /<div id="orb" title=/, "no native title on the disc");
  assert.doesNotMatch(orb, /orb\.title = (?!"")/, "the title is only ever cleared");
  assert.match(orb, /api\.onHitReset/);
  const swarm = html.slice(html.indexOf('if (view === "swarm")'), html.indexOf("// ── the right-click menu"));
  assert.match(swarm, /api\.onHitReset/);
  assert.match(swarm, /orbited out from under a still pointer/);
});

// ── owner 2026-11-14: the Aither panel, one box, one button, every action works ──

function lastPanel() { return lastSent(bubbleWin(), "orb:panel-view"); }

test("panel: every quick action returns content (screen, region, file, web) and lands in the history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-"));
  const shot = path.join(dir, "region.png");
  fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let snipped = false;
  const capture = captureFake();
  capture.lastScreenshot = () => (snipped ? shot : null);
  capture.startSnip = async () => { snipped = true; return { ok: true }; };
  start({
    capture,
    askVision: async (_img, prompt) => ({ ok: true, text: /region/i.test(prompt) ? "A chart of GPU memory." : "A terminal running tests.", via: "test" }),
  });
  orbWindow.__setOps({
    async findFiles() {
      return { ok: true, rows: [
        { kind: "file", title: "notes.md", subtitle: dir, target: path.join(dir, "notes.md") },
        { kind: "file", title: "notes2.md", subtitle: dir, target: path.join(dir, "notes2.md") },
      ], more: 0, total: 2 };
    },
    async webSearch() { return { ok: true, rows: [{ title: "Electron docs", url: "https://www.electronjs.org/docs" }], more: 0, total: 1, answer: null }; },
    async readFile() { return { ok: true, answer: "" }; },
    async listFolder() { return { ok: true, rows: [], more: 0, total: 0 }; },
  });
  orbWindow.openBubble({ focus: true });
  const bubble = bubbleWin();
  const screen = await invoke("desk:orb-ask", bubble, "screen", "");
  assert.equal(screen.ok, true);
  assert.match(screen.text, /terminal running tests/);
  const region = await invoke("desk:orb-ask", bubble, "region", "");
  assert.equal(region.ok, true, JSON.stringify(region));
  assert.match(region.text, /GPU memory/);
  const file = await invoke("desk:orb-ask", bubble, "find", "notes");
  assert.notEqual(file && file.ok, false, JSON.stringify(file));
  assert.ok(orbWindow.results() && orbWindow.results().rows.length >= 1, "file results are on the panel");
  const web = await invoke("desk:orb-ask", bubble, "web", "electron docs");
  assert.notEqual(web && web.ok, false, JSON.stringify(web));
  assert.equal(orbWindow.results().mode, "web");
  const hist = lastPanel().history;
  const qs = hist.map((h) => h.q);
  for (const q of ["What's on my screen?", "Find notes", "Search electron docs"]) assert.ok(qs.includes(q), `${q} in ${JSON.stringify(qs)}`);
  // The region answer is either in the history or the answer still on screen (never both).
  assert.ok(qs.includes("Explain this region") || /GPU memory/.test(String(orbWindow.queue().cur && orbWindow.queue().cur.text)));
  assert.ok(hist.every((h) => h.a), "every exchange has content");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("panel: the session line follows a pick, shows that session's cards, and answers one in place", async () => {
  const calls = startAttention({
    sessions: async () => ({ ok: true, sessions: [
      { id: "s-1", title: "Discord workflow launch", status: "working", last_activity_summary: "running the bot tests" },
      { id: "s-2", title: "AitherOS-Fresh", status: "idle" },
    ] }),
  });
  orbWindow.setAttentionCards([blockedCard({ id: "d-s1", sessionId: "s-1" })]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  orbWindow.openBubble({ focus: true });
  await wait(30);
  const bubble = bubbleWin();
  await invoke("desk:panel-session", bubble, "s-1");
  let v = lastPanel();
  assert.equal(v.line.kind, "session");
  assert.equal(v.line.title, "Discord workflow launch");
  assert.match(`${v.line.statusText} ${v.line.last}`, /running the bot tests/);
  assert.deepEqual(v.cards.map((c) => c.id), ["d-s1"]);
  const r = await invoke("desk:panel-answer", bubble, "d-s1", "ack");
  assert.equal(r.ok, true);
  assert.deepEqual(calls.answer.pop(), ["d-s1", "ack"], "the ONE desk answer path");
  const bad = await invoke("desk:panel-answer", bubble, "d-s1", "nope");
  assert.equal(bad.ok, false);
  await invoke("desk:panel-session", bubble, "s-2");
  v = lastPanel();
  assert.equal(v.line.id, "s-2");
  assert.deepEqual(v.cards, [], "another session's cards are not this one's");
});

test("panel: the window fits its content, and clicking elsewhere with the pointer off it closes it", async () => {
  start();
  orbWindow.openBubble({ focus: true });
  const bubble = bubbleWin();
  await invoke("desk:orb-ask", bubble, "screen", ""); // something on it worth keeping
  await invoke("desk:panel-size", bubble, 150);
  assert.equal(bubble.getBounds().height, 150, "no fixed 480 px of air");
  await invoke("desk:panel-size", bubble, 5000);
  assert.equal(bubble.getBounds().height, orbWindow.BUBBLE_SIZE.height);
  const b = bubble.getBounds();
  cursor = { x: b.x + 10, y: b.y + 10 };
  bubble.emit("blur");
  assert.equal(bubble.isVisible(), true, "the pointer is still on it: it stays");
  cursor = { x: b.x + b.width + 300, y: b.y };
  bubble.emit("blur");
  assert.equal(bubble.isVisible(), false, "left and clicked elsewhere: it closes");
});

test("panel markup: input on top, four small chips, one session line, no empty box", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const bubble = html.slice(html.indexOf('if (view === "bubble")'));
  const markup = bubble.slice(0, bubble.indexOf("</div>`;"));
  assert.ok(markup.indexOf('id="ask"') < markup.indexOf('id="actions"'), "the input comes first");
  assert.ok(markup.indexOf('id="actions"') < markup.indexOf('id="stage"'));
  assert.equal((markup.match(/<button data-(ask|mode)=/g) || []).length, 4);
  assert.doesNotMatch(markup, /id="empty"/, "no empty box");
  assert.doesNotMatch(markup, /What's on my screen\?<\/button>/, "chips are small labels, not sentences");
  assert.match(markup, /id="session"/);
  assert.match(bubble, /\^attached to \/i/, "a status that repeats the session line is dropped");
});

// ── owner 2026-11-14: a dismissed whisper froze at ~30% over the page ──────

test("a dismissed whisper is click-through at once, fades, then its window hides; a new one cancels the hide", async () => {
  startAttention();
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const whisper = nudgeWin();
  assert.ok(whisper && whisper.isVisible());
  assert.equal(whisper.opts.webPreferences.backgroundThrottling, false, "an occluded whisper still finishes its fade");
  await invoke("desk:nudge-act", whisper, "hover", true);
  assert.equal(whisper.ignoreMouse, false);
  orbWindow.endNudge("later", { stay: true });
  assert.equal(whisper.ignoreMouse, true, "click-through during the fade");
  assert.equal(lastSent(whisper, "orb:nudge-view"), null, "the page is told to fade and unmount");
  await wait(350);
  assert.equal(whisper.isVisible(), false, "and the window is gone after the fade, never left up");
});

test("the whisper page always finishes its fade and unmounts the card, and is short", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const nudge = html.slice(html.indexOf('if (view === "nudge")'), html.indexOf('if (view === "bubble")'));
  assert.match(nudge, /transitionend/);
  assert.match(nudge, /setTimeout\(finishFade, 320\)/, "a timer finishes it when no transition event comes");
  assert.match(nudge, /classList\.add\("gone"\)/);
  assert.match(html, /#nudge\.gone \{ display: none; \}/);
  assert.match(html, /#nudge:not\(\.on\) \{ pointer-events: none; \}/);
  assert.match(nudge, /id="n-need"/, "one line of what is needed");
  assert.match(nudge, /Card \$\{v\.id\} needs you/);
  assert.match(nudge, /o === main \? " primary"/, "one primary (recommended) button");
  assert.match(nudge, /i < 3 \? actsEl : altEl/, "2-3 answer buttons on the bubble, a 4th behind more");
  assert.match(nudge, /button\("Later", "link"/, "a Later link");
  assert.match(nudge, /button\("Show details", "link"/, "the old card window only behind Show details");
  assert.doesNotMatch(html, /#nudge\.lv[23] \{[^}]*infinite/, "the whisper glow never animates forever");
  assert.match(nudge, /id="n-extra"/, "the transcript and the rest sit behind more");
});

// ── the fairy grows into Aither (owner 2026-11-15) ─────────────────────────

test("no avatar hook: the menu offers no Show Aither and a click still opens the chat", async () => {
  startAttention();
  orbWindow.setAttentionCards([]);
  assert.equal(orbWindow.avatarMode(), null);
  const r = orbWindow.orbMenu();
  assert.ok(!r.items.includes("expand") && !r.items.includes("collapse"), "never a dead item");
  await invoke("desk:menu-pick", menuWin(), "");
});

test("click the fairy with nothing waiting: the ask box; Show Aither grows the body and it comes back", async () => {
  const grows = [];
  const shrinks = [];
  startAttention({
    expand: async (opts) => { grows.push(opts); return { ok: true, character: "aither-v2" }; },
    collapse: async (opts) => { shrinks.push(opts); return { ok: true }; },
  });
  orbWindow.setAttentionCards([]);
  const b = bubbleWin();
  if (b && b.isVisible()) b.hide();
  assert.equal(orbWindow.avatarMode(), "fairy");
  const click = await invoke("desk:orb-click", orbWin());
  assert.deepEqual(click, { ok: true, visible: true }, "a click is the ask box (owner 2026-11-18)");
  assert.equal(grows.length, 0, "a click never grows the body");
  bubbleWin().hide();
  orbWindow.orbMenu();                        // the menu window exists once it has opened
  const r = await invoke("desk:menu-pick", menuWin(), "expand");
  assert.deepEqual(r, { ok: true, expanded: true, character: "aither-v2" });
  assert.equal(grows.length, 1);
  assert.ok(grows[0].from && Number.isFinite(grows[0].from.x), "it grows FROM where the fairy is");
  assert.equal(orbWin().isVisible(), false, "one cluster: the body stands where the fairy was");
  assert.equal(orbWindow.state().visible, true, "transient: the saved switch still says shown");
  // showOrb while grown keeps the orb down.
  orbWindow.showOrb();
  assert.equal(orbWin().isVisible(), false);
  // The right-click menu now offers the way back, and it works.
  assert.equal(orbWindow.avatarMode(), "expanded");
  const menu = orbWindow.orbMenu();
  assert.equal(menu.items[0], "collapse");
  const back = await invoke("desk:menu-pick", menuWin(), "collapse");
  assert.deepEqual(back, { ok: true, expanded: false });
  assert.equal(shrinks.length, 1);
  assert.equal(orbWin().isVisible(), true, "the fairy is back");
  // And from the menu again: Show Aither.
  const again = orbWindow.orbMenu();
  assert.equal(again.items[0], "expand");
  const pick = await invoke("desk:menu-pick", menuWin(), "expand");
  assert.equal(pick.expanded, true);
  assert.equal(grows.length, 2);
  // The body hidden some other way (tray): only the fairy comes back, no second shrink.
  await orbWindow.collapseToFairy({ fromAvatar: true });
  assert.equal(shrinks.length, 1);
  assert.equal(orbWin().isVisible(), true);
});

// ── ONE companion surface (owner 2026-11-20) ──────────────────────────────────
test("the body's own window stands the fairy down and brings her back -- one surface", () => {
  writeState({ visible: true, x: 200, y: 200 });
  start();
  assert.equal(orbWin().isVisible(), true);
  orbWindow.standDownForAvatar();
  assert.equal(orbWin().isVisible(), false, "no fairy beside the body");
  assert.equal(orbWindow.state().visible, true, "the owner's switch is remembered");
  assert.equal(orbWindow.stoodDown(), true);
  // 'Show all companions' while the body is up cannot put a second surface on screen.
  const shown = orbWindow.showOrb();
  assert.deepEqual([shown.ok, shown.visible, shown.body], [true, true, true]);
  assert.equal(orbWin().isVisible(), false, "she stays down while the body is up");
  // The body leaves: she comes back where she rests.
  orbWindow.returnFromAvatar();
  assert.equal(orbWin().isVisible(), true);
  assert.equal(orbWindow.stoodDown(), false);
});

test("an automatic hide while the body is up cannot let the next card float the fairy again", async () => {
  writeState({ visible: true, x: 200, y: 200 });
  start();
  orbWindow.standDownForAvatar();
  // A card auto-surfaced the fairy, then was answered: the auto-hide runs while the
  // body is still up. It must not clear the stand-down (review 2026-11-20).
  orbWindow.hideOrb({ auto: true });
  assert.equal(orbWindow.stoodDown(), true, "the body still owns the surface");
  const shown = orbWindow.showOrb({ auto: true });
  assert.equal(shown.body, true, "a new card does not put the fairy beside the body");
  assert.equal(orbWin().isVisible(), false);
  // A collapse with nothing grown (a dock/palette verb) must not clear it either.
  await orbWindow.collapseToFairy();
  assert.equal(orbWindow.stoodDown(), true);
  assert.equal(orbWindow.showOrb().body, true);
  assert.equal(orbWin().isVisible(), false);
  orbWindow.returnFromAvatar();
});

test("the ask panel cannot pop beside the body", () => {
  writeState({ visible: true, x: 200, y: 200 });
  start();
  orbWindow.standDownForAvatar();
  orbWindow.openBubble({ focus: false });
  assert.equal(bubbleWin(), null, "no bubble window was raised");
  orbWindow.returnFromAvatar();
});

test("a fairy the owner had hidden is not resurrected when the body leaves", () => {
  writeState({ visible: false, x: 200, y: 200 });
  start();
  orbWindow.standDownForAvatar();
  orbWindow.returnFromAvatar();
  assert.equal(orbWin() ? orbWin().isVisible() : false, false);
  assert.equal(orbWindow.state().visible, false);
});

test("a body that will not open leaves the fairy where it was", async () => {  startAttention({ expand: async () => ({ ok: false, error: "no Aither model" }) });
  orbWindow.setAttentionCards([]);
  const r = await orbWindow.expandToAvatar();
  assert.deepEqual(r, { ok: false, error: "no Aither model" });
  assert.equal(orbWindow.expanded(), false);
  assert.equal(orbWin().isVisible(), true);
});

test("cards waiting: the click is the ask box, never the body and never the Inbox", async () => {
  const grows = [];
  const calls = startAttention({ expand: async () => { grows.push(1); return { ok: true }; } });
  orbWindow.setAttentionCards([blockedCard({ id: "d-g1", agent: "atlas" })]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  await wait(2600);
  const r = await invoke("desk:orb-click", orbWin());
  assert.equal(r.visible, true);
  assert.equal(grows.length, 0);
  assert.deepEqual(calls.open, []);
  bubbleWin().hide();
  orbWindow.setAttentionCards([]);
});

// -- the fairy stays off what a person clicks (free-space.cjs; owner 2026-11-16: it sat on
//    CertTrack's "Review" tab) -----------------------------------------------------------

function pageWindow(bounds, rects) {
  const w = new FakeWindow({ title: "CertTrack", ...bounds });
  w.visible = true;
  w.isMinimized = () => false;
  w.getContentBounds = () => ({ ...w.bounds });
  w.webContents.getZoomFactor = () => 1;
  w.webContents.executeJavaScript = async (src) => {
    w.probed = (w.probed || 0) + 1;
    assert.match(src, /querySelectorAll/, "the page is asked for its clickable elements");
    return rects;
  };
  return w;
}

test("docked on a window, the fairy stands on the first spot that covers no button or tab", async () => {
  start();
  orbWindow.companionAction("show-all");
  const free = require("./free-space.cjs");
  const b = { x: 100, y: 100, width: 1200, height: 800 };
  // Nothing is known about the page yet: the dock is the old spot. Cover exactly that
  // spot (a bar of buttons, in PAGE coordinates: the window sits at 100,100) plus a tab.
  const probe = pageWindow(b, []);
  const target = { kind: "desk", windowId: probe.id, title: "CertTrack", bounds: b, auto: true };
  const before = orbWindow.__dockSpot(target);
  const orbSize = orbWindow.ORB_SIZE || { width: 72, height: 72 };
  const covered = [[before.x - 100 - 30, before.y - 100 - 30, orbSize.width + 60, orbSize.height + 60], [600, 60, 160, 58]];
  probe.webContents.executeJavaScript = async (src) => {
    probe.probed = (probe.probed || 0) + 1;
    assert.match(src, /querySelectorAll/, "the page is asked for its clickable elements");
    return covered;
  };
  await orbWindow.__refreshObstacles();
  assert.equal(probe.probed, 1, "the desk window was asked what is clickable");
  const spot = orbWindow.__dockSpot(target);
  const rects = free.toScreenRects(covered, b, 1);
  assert.equal(free.coverage(spot, orbSize, rects, 8), 0, `the fairy docked on a control at ${JSON.stringify(spot)}`);
  assert.notDeepEqual([spot.x, spot.y], [before.x, before.y], "it moved off the covered corner");
  assert.ok(spot.x >= b.x && spot.x + orbSize.width <= b.x + b.width && spot.y >= b.y && spot.y + orbSize.height <= b.y + b.height, "still inside the window");
  await orbWindow.__refreshObstacles();
  assert.equal(probe.probed, 1, "a second look inside the cache window does not ask the page again");
});

test("a window we cannot read keeps the fairy out of its title bar (the old dock was the close button)", () => {
  start();
  const b = { x: 0, y: 0, width: 1000, height: 800 };
  const spot = orbWindow.__dockSpot({ kind: "window", hwnd: 42, title: "Notepad", bounds: b });
  assert.ok(spot.y >= 56, `docked in the title bar at y=${spot.y}`);
  assert.ok(spot.x + 72 <= b.x + b.width && spot.y + 72 <= b.y + b.height);
});

// ── the fairy cluster (fairy-cluster.cjs, owner 2026-11-16) ─────────────────

test("decisions ride the fairy: a hidden orb comes up for a card and goes back down when the queue empties", () => {
  fs.rmSync(ATTENTION_FILE, { force: true });
  start({ hideByDefault: true });
  orbWindow.hideOrb({ auto: true });
  orbWindow.__setAttentionHooks({ quiet: () => "", idleMs: () => 0, fullScreen: async () => "" });
  assert.equal(orbWindow.state().visible, false, "hidden to begin with");
  assert.equal(orbWindow.carriesCards(), true, "hidden or not, the desk carries the cards (the Tk window stays down)");
  orbWindow.setAttentionCards([blockedCard({ id: "d-up1" })]);
  assert.equal(orbWindow.state().visible, true, "a waiting card surfaces the fairy");
  assert.equal(orbWindow.autoSurfaced(), true);
  const saved = JSON.parse(fs.readFileSync(orbWindow.stateFile(), "utf8"));
  assert.equal(saved.visible, false, "a cluster-surfaced orb is not saved as the owner's choice");
  orbWindow.setAttentionCards([]);
  assert.equal(orbWindow.state().visible, false, "queue empty: back down");
});

test("the owner hides the fairy with cards waiting: those cards do not bring it back, a NEW card does", () => {
  startAttention();
  orbWindow.setAttentionCards([blockedCard({ id: "d-h1" })]);
  orbWindow.hideOrb();
  orbWindow.setAttentionCards([blockedCard({ id: "d-h1" })]);
  assert.equal(orbWindow.state().visible, false, "his hide holds for the cards he saw");
  orbWindow.setAttentionCards([blockedCard({ id: "d-h1" }), blockedCard({ id: "d-h2" })]);
  assert.equal(orbWindow.state().visible, true, "a new card surfaces it");
});

test("the cluster grows with sessions and decisions, shrinks when they end, and reaps an unreadable source after 30 s", () => {
  startAttention();
  const sessions = (ids) => new Map(ids.map((id) => [id, { name: id, status: "busy", cwd: "" }]));
  orbWindow.setAttentionCards([blockedCard({ id: "d-g1" }), blockedCard({ id: "d-g2" })]);
  orbWindow.setClusterSessions([sessions(["aaaa1111", "bbbb2222", "cccc3333"])]);
  assert.equal(orbWindow.clusterState().total, 5, "two decisions + three sessions");
  const swarm = orbWindow.swarmWindow();
  assert.ok(swarm && swarm.isVisible());
  // A session ends and a card is answered: both fairies leave on the next update.
  orbWindow.setClusterSessions([sessions(["aaaa1111", "bbbb2222"])]);
  orbWindow.setAttentionCards([blockedCard({ id: "d-g2" })]);
  assert.equal(orbWindow.clusterState().total, 3);
  // The session read fails: the fairies stay (a dead daemon never empties the cluster)...
  orbWindow.setClusterSessions([], { ok: false });
  assert.equal(orbWindow.clusterState().total, 3, "held while unreadable");
  // ...but not forever: 30 s on, the reconcile clock reaps them.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    assert.equal(orbWindow.clusterState().total, 1, "only the live decision is left");
  } finally {
    Date.now = realNow;
  }
});

test("the counted bead opens the whole waiting list, never a chat", async () => {
  let listed = 0;
  startAttention({ openList: () => { listed += 1; return true; } });
  const r = orbWindow.chatWithAgent("more");
  assert.equal(r.ok, true);
  assert.equal(listed, 1);
});

test("the swarm page shows the cluster count and draws the bead as +N", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  assert.match(html, /id="cluster-count"/);
  assert.match(html, /c\.kind === "more" \? `\+\$\{Number\(c\.count\) \|\| 0\}`/);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /claim: \(\) => \(orbWindow\.carriesCards\(\) \? \{ attention: "fairy" \} : null\)/,
    "the heartbeat claim no longer needs the fairy companion mode or an on-screen fairy");
  assert.doesNotMatch(main, /return "the avatar carries the cards"/);
  assert.match(main, /setInterval\(\(\) => \{ void refreshClusterSessions\(\); \}, 6_000\)/,
    "the session feed is fast enough to catch a running tool call (the daemon refreshes at 2 s)");
});

test("the card's 'Open in AitherBrowser' opens its aitherium.com page through the desk's browser, not the system one", async () => {
  const opened = [];
  fs.rmSync(ATTENTION_FILE, { force: true });
  orbWindow.startOrb({ capture: captureFake(), openUrl: (u) => { opened.push(u); return { ok: true, url: u }; } });
  orbWindow.showOrb();
  orbWindow.__setAttentionHooks({ quiet: () => "", idleMs: () => 0, fullScreen: async () => "" });
  orbWindow.setAttentionCards([blockedCard({ id: "d-br1" })]);
  assert.equal(orbWindow.openFairyCard("d-br1").ok, true);
  const r = await orbWindow.nudgeAct("browser");
  assert.equal(r.ok, true);
  assert.equal(r.via, "aither");
  assert.deepEqual(opened, ["https://aitherium.com/decide?id=d-br1"]);
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  assert.match(html, /button\("Open in AitherBrowser", "link", \(\) => api\.nudgeAct\("browser"\)/);
});

// ── follow the focused window (plan A4) ────────────────────────────────────
// The rule is asserted pure in follow-focus.test.cjs; here it is that the window layer
// ACTS on it -- attaches, lets go on toggle-off, and never steals a hand attach.

const NOTEPAD = { hwnd: 90210, pid: 777, cls: "Notepad", title: "Untitled - Notepad", x: 100, y: 120, width: 900, height: 700, quiet: "" };

test("follow is on by default and a settled foreground change attaches the cluster", async () => {
  start();
  orbWindow.showOrb();
  assert.equal(orbWindow.followState(), true, "default on");

  orbWindow.__feedForeground(NOTEPAD);
  orbWindow.__setFollowChangedAt(0); // the focus has held
  const r = await orbWindow.__applyFollow();
  assert.equal(r.act, "attach", JSON.stringify(r));
  const a = orbWindow.attach();
  assert.ok(a, "the cluster attached");
  assert.equal(a.kind, "window");
  assert.equal(a.title, "Untitled - Notepad");
});

test("turning the toggle off lets go of an attach follow made", async () => {
  start();
  orbWindow.showOrb();
  orbWindow.__feedForeground(NOTEPAD);
  orbWindow.__setFollowChangedAt(0);
  assert.equal((await orbWindow.__applyFollow()).act, "attach");

  const off = orbWindow.setFollow(false);
  assert.equal(off.follow, false);
  assert.equal(orbWindow.state().follow, false, "the switch is remembered in orb.json");
  assert.equal(orbWindow.attach(), null, "nothing keeps following the window");
});

test("turning the toggle off leaves a fairy the owner placed by hand where it is", async () => {
  start();
  orbWindow.showOrb();
  await orbWindow.attachTo({ kind: "window", hwnd: 42, title: "Pinned by hand", bounds: { x: 10, y: 10, width: 500, height: 400 } });
  assert.ok(orbWindow.attach());
  orbWindow.setFollow(false);
  assert.ok(orbWindow.attach(), "a hand attach is not released by the follow switch");
});

// Owner 2026-11-12 (one cluster) vs plan A4 (follow), owner screenshots 2026-11-19: with
// the AitherOS window open, focusing ANY other app (Discord in Edge) pulled the one
// cluster off the AitherOS window onto that app, and focusing the desk again let it go
// SILENTLY -- stranded where it was, the veil's trail/tether still painted across the
// screen. The AitherOS window outranks "follow my window".
function openAitherOS() {
  const host = new FakeWindow({ title: "AitherOS", x: 200, y: 150, width: 1400, height: 900 });
  host.visible = true;
  host.isMinimized = () => false;
  return host;
}
function veilWin() { return FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Aither spirit trail") || null; }

test("one cluster: an open AitherOS window keeps the cluster when another app takes the focus", async () => {
  start();
  orbWindow.showOrb();
  const host = openAitherOS();
  const docked = await orbWindow.setDockWindow(host);
  assert.equal(docked.docked, true, JSON.stringify(docked));

  orbWindow.__feedForeground(NOTEPAD);
  orbWindow.__setFollowChangedAt(0);
  const r = await orbWindow.__applyFollow();
  assert.equal(r.act, "none", `follow must not steal the AitherOS dock: ${JSON.stringify(r)}`);
  const a = orbWindow.attach();
  assert.ok(a, "still attached");
  assert.equal(a.kind, "desk");
  assert.equal(a.title, "AitherOS", "the cluster stays on the AitherOS window, not on Notepad");
});

test("follow lets go: the cluster flies home and the trail/tether is not left painted", async () => {
  start();
  orbWindow.showOrb();
  orbWindow.__feedForeground(NOTEPAD);
  orbWindow.__setFollowChangedAt(0);
  assert.equal((await orbWindow.__applyFollow()).act, "attach");
  const onNotepad = orbWin().getBounds();
  assert.ok(veilWin() && veilWin().isVisible(), "attached: the tether is drawn");

  // The owner clicks back into the desk's own window: follow releases.
  orbWindow.__feedForeground({ ...NOTEPAD, hwnd: 5, pid: process.pid, title: "Aither Browser" });
  orbWindow.__setFollowChangedAt(0);
  assert.equal((await orbWindow.__applyFollow()).act, "release");
  assert.equal(orbWindow.attach(), null);
  await orbWindow.__homeFlight(); // the flight home has landed and its .then has run
  const after = orbWin().getBounds();
  assert.notDeepEqual({ x: after.x, y: after.y }, { x: onNotepad.x, y: onNotepad.y }, "not stranded on the window it left");
  assert.ok(!veilWin() || !veilWin().isVisible(), "no stale trail/tether left across other windows");
});

test("the AitherOS window opening takes the cluster from a follow attach", async () => {
  start();
  orbWindow.showOrb();
  orbWindow.__feedForeground(NOTEPAD);
  orbWindow.__setFollowChangedAt(0);
  assert.equal((await orbWindow.__applyFollow()).act, "attach");
  const host = openAitherOS();
  const r = await orbWindow.setDockWindow(host);
  assert.equal(r.docked, true, `a follow attach is not a hand attach: ${JSON.stringify(r)}`);
  const a = orbWindow.attach();
  assert.ok(a && a.kind === "desk" && a.title === "AitherOS", `rides the AitherOS window: ${JSON.stringify(a)}`);
});

test("the desk's own window is never followed", async () => {
  start();
  orbWindow.showOrb();
  orbWindow.__feedForeground({ ...NOTEPAD, hwnd: 5, pid: process.pid, title: "Aither desk" });
  orbWindow.__setFollowChangedAt(0);
  const r = await orbWindow.__applyFollow();
  assert.equal(r.act, "none");
  assert.equal(r.reason, "the desk's own window");
  assert.equal(orbWindow.attach(), null);
});

// The taskbar IS a Windows shell object (Shell_TrayWnd / Shell_SecondaryTrayWnd,
// read by spirit-probe's PowerShell oracle): off Windows there is no bar to publish
// and refreshTaskbar() must say so rather than invent one. The pure placement rule
// (fairy-control.taskbarForDisplay) is exercised on every platform in
// fairy-control.test.cjs; these two assert the WIRING through the real probe.
const windowsOnly = { skip: process.platform !== "win32" ? "no Windows taskbar on this runner" : false };

test("dock mode publishes no taskbar where the platform has none", { skip: process.platform === "win32" ? "Windows has a taskbar" : false }, async () => {
  start();
  orbWindow.showOrb();
  orbWindow.setView({ mode: "dock" });
  orbWindow.__setProbe({ taskbars: async () => ({ primary: { className: "Shell_TrayWnd", hwnd: 11, x: 0, y: 2120, width: 3840, height: 40 }, secondaries: [] }) });
  assert.equal(await orbWindow.__refreshTaskbar(), null, "a non-Windows desk must not dock on an invented bar");
  assert.equal(orbWindow.__taskbar(), null);
});

test("dock mode sits on the taskbar once its rect is published", windowsOnly, async () => {
  // Resting at the bottom of the first display (work area ends at y=2120): the saved
  // spot is read by startOrb, which places the orb there.
  writeState({ visible: false, x: 100, y: 2000 });
  start();
  orbWindow.showOrb();
  orbWindow.setView({ mode: "dock" });
  assert.equal(orbWindow.__swarmBounds(0), null, "no companions: no strip");

  orbWindow.__setProbe({ taskbars: async () => ({ primary: { className: "Shell_TrayWnd", hwnd: 11, x: 0, y: 2120, width: 3840, height: 40 }, secondaries: [] }) });
  const bar = await orbWindow.__refreshTaskbar();
  assert.deepEqual(bar, { x: 0, y: 2120, width: 3840, height: 40 });

  const strip = orbWindow.__swarmBounds(3);
  assert.ok(strip, "a docked strip exists");
  assert.equal(strip.edge, "bottom");
  assert.equal(strip.onTaskbar, true);
  assert.ok(strip.y >= 2120 && strip.y + strip.height <= 2160, `on the taskbar: ${JSON.stringify(strip)}`);
});

test("dock mode on the second monitor uses ITS taskbar, never the first monitor's", windowsOnly, async () => {
  // Display 2: bounds y 2160..3240, work area to 3200, its own bar at 3200..3240.
  writeState({ visible: false, x: 2500, y: 2900 });
  start();
  orbWindow.showOrb();
  orbWindow.setView({ mode: "dock" });
  orbWindow.__setProbe({
    taskbars: async () => ({
      primary: { className: "Shell_TrayWnd", hwnd: 11, x: 0, y: 2120, width: 3840, height: 40 },
      secondaries: [{ className: "Shell_SecondaryTrayWnd", hwnd: 12, x: 1920, y: 3200, width: 1920, height: 40 }],
    }),
  });
  const bar = await orbWindow.__refreshTaskbar();
  assert.deepEqual(bar, { x: 1920, y: 3200, width: 1920, height: 40 }, "the bar on the cluster's own display");

  const strip = orbWindow.__swarmBounds(3);
  assert.ok(strip, "a docked strip exists");
  assert.equal(strip.onTaskbar, true);
  assert.ok(strip.x >= 1920 && strip.x + strip.width <= 3840, `on the second monitor: ${JSON.stringify(strip)}`);
  assert.ok(strip.y >= 3200 && strip.y + strip.height <= 3240, `on its taskbar: ${JSON.stringify(strip)}`);
});

test("the whisper card shows Read it to me and Answer by voice without opening 'more'", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "orb.html"), "utf8");
  const voice = html.slice(html.indexOf('<div id="n-voice">'), html.indexOf('<div id="n-extra">'));
  assert.ok(voice.length > 0, "the voice row sits OUTSIDE the hidden extra block");
  assert.match(voice, /data-act="read"/);
  assert.match(voice, /data-act="talk"/);
  assert.match(html, /#n-foot button, #n-voice button/);
});

test("a flash re-measures the whisper so an error line is never cut off", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "orb.html"), "utf8");
  const flash = html.slice(html.indexOf("api.onNudgeFlash"), html.indexOf("api.init().then((s) => { if (s && s.nudge)"));
  assert.match(flash, /nudgeAct\("size"/);
});

// ── tool flights: the fairy GOES DO the work (fairy-flight.cjs, 2026-11-18) ────

test("a session's running tool flies its fairy to that window and home when it ends", () => {
  startAttention();
  const files = new FakeWindow({ title: "Aither Files", x: 100, y: 100, width: 800, height: 600 });
  files.loadFile(path.join(__dirname, "files.html"));
  files.showInactive();
  const rows = [[{ session_id: "abcdef12-3456", status: "working", harness: "claude", last_activity_summary: "running Read" }]];
  orbWindow.setClusterSessions(rows);

  const surf = orbWindow.surfaceRects();
  assert.deepEqual(surf.files, { x: 100, y: 100, width: 800, height: 600 }, "the Files window is found by title / page");
  const plan = orbWindow.flightPlan();
  assert.equal(plan.flights.length, 1, "one call, one sub-fairy");
  assert.equal(plan.flights[0].surface, "files");
  assert.equal(plan.flights[0].tool, "Read");
  assert.equal(plan.flights[0].mode, "fly");
  assert.deepEqual(plan.flights[0].to, { x: 500, y: 280 }, "it lands in the File Explorer window");

  const veil = FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Aither spirit trail");
  assert.ok(veil && veil.isVisible(), "the trail overlay is up for the flight");
  const payload = lastSent(veil, "orb:veil");
  assert.equal(payload.flights.length, 1, "the renderer is handed the leg once, not per frame");
  assert.equal(payload.flights[0].tool, "Read");
  assert.equal(payload.flights[0].state, "out");

  // The tool call ends: the sub-fairy turns around and merges back at the cluster.
  orbWindow.setClusterSessions([[]]);
  const home = orbWindow.flightPlan();
  assert.equal(home.flights.length, 0);
  assert.equal(home.returning.length, 1, "a finished call flies home");
  const orb = orbWindow.fairyBounds();
  assert.deepEqual(home.returning[0].to, { x: Math.round(orb.x + orb.width / 2), y: Math.round(orb.y + orb.height / 2) },
    "home is the fairy cluster's centre");
  assert.notDeepEqual(home.returning[0].from, home.returning[0].to, "it moves, it does not teleport");

  // Reduced motion: same live call, no flight at all.
  orbWindow.setClusterSessions(rows);
  const r = orbWindow.setReducedMotion(true);
  assert.equal(r.reducedMotion, true);
  assert.deepEqual(orbWindow.flightPlan().flights, []);
  orbWindow.setReducedMotion(false);
  assert.equal(orbWindow.flightPlan().flights.length, 1, "motion back on: the fairy works again");
});

test("the veil page eases the tool flights itself and honours reduced motion", () => {
  const html = fs.readFileSync(path.join(__dirname, "orb.html"), "utf8");
  const veil = html.slice(html.indexOf('if (view === "veil")'), html.indexOf('if (view === "orb")'));
  assert.match(veil, /function drawFlights\(/, "the sub-fairies are drawn there");
  assert.match(veil, /requestAnimationFrame\(flightTick\)/, "each leg is eased in the page, not by IPC per frame");
  assert.match(veil, /prefers-reduced-motion: reduce/, "the OS setting is respected inside the page too");
  assert.match(veil, /state\.flights = Array\.isArray\(s\.flights\)/, "main hands over the legs once");
});

test("hiding the fairy takes its working sub-fairies off the screen at once", () => {
  startAttention();
  const files = new FakeWindow({ title: "Aither Files", x: 100, y: 100, width: 800, height: 600 });
  files.loadFile(path.join(__dirname, "files.html"));
  files.showInactive();
  orbWindow.setClusterSessions([[{ session_id: "abcdef12-3456", status: "working", harness: "claude", last_activity_summary: "running Read" }]]);
  const veil = FakeWindow.all.find((w) => !w.destroyed && w.opts.title === "Aither spirit trail");
  assert.ok(veil && veil.isVisible(), "the flight is on screen");
  orbWindow.hideOrb();
  assert.equal(veil.isVisible(), false, "no frozen sub-fairy outlives the fairy it came from");
});

test("Fairy flights (reduced motion) is a row on the fairy's own menu and it is remembered", async () => {
  startAttention();
  assert.equal(orbWindow.setReducedMotion(false).reducedMotion, false);
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "more");
  const rows = lastSent(menuWin(), "orb:menu").items.filter((i) => !i.sep).map((i) => i.id);
  assert.ok(rows.includes("spirit:flights"), `the setting is reachable: ${rows.join(", ")}`);
  assert.equal((await invoke("desk:menu-pick", menuWin(), "spirit:flights")).ok, true, "the row runs");
  assert.equal(orbWindow.flightPlan().reducedMotion, true, "reduced motion on: no flight");
  assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).reducedMotion, true, "remembered in orb.json");
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "more");
  assert.match(lastSent(menuWin(), "orb:menu").items.find((i) => i.id === "spirit:flights").label,
    /off \(reduced motion\)/, "the row says what it now does");
});

// ── 2026-11-19: d-ennp sat 2 h un-nagged across two desk restarts ──────────────

const ATTENTION_LOG = path.join(os.tmpdir(), `fairy-attention-${process.pid}.log`);
process.env.DESK_FAIRY_ATTENTION_LOG = ATTENTION_LOG;

test("a desk restart resumes the ladder: main's empty first feed no longer resets it, and the card climbs", async () => {
  fs.rmSync(ATTENTION_LOG, { force: true });
  startAttention();
  const c = blockedCard({ id: "d-ennp" }); // blocked high, a real default: a flutter that climbs
  orbWindow.setAttentionCards([c]);
  const first = await orbWindow.attentionTick();
  assert.equal(first.act, "nudge");
  assert.equal(first.level, 2);
  orbWindow.endNudge("timeout", { stay: true });
  assert.equal(orbWindow.attentionMems()["d-ennp"].ignored, 1);
  // Age the memory file as if that nudge ran 6 min ago, then restart the way main does:
  // the orb loads the file, the first feed is EMPTY (no store read yet), then the queue.
  const disk = JSON.parse(fs.readFileSync(ATTENTION_FILE, "utf8"));
  disk.cards["d-ennp"].lastNudgeAt -= 6 * 60_000;
  disk.lastNudgeAt -= 6 * 60_000;
  fs.writeFileSync(ATTENTION_FILE, JSON.stringify(disk));
  orbWindow.__reset();
  start();
  orbWindow.showOrb();
  orbWindow.__setAttentionHooks({ quiet: () => "", idleMs: () => 0, fullScreen: async () => "", speak: () => true });
  orbWindow.setAttentionCards([]);
  orbWindow.setAttentionCards([c]);
  const mem = orbWindow.attentionMems()["d-ennp"];
  assert.ok(mem, "the card's memory survived the empty start-up feed");
  assert.equal(mem.nudges, 1);
  assert.equal(mem.ignored, 1);
  const again = await orbWindow.attentionTick();
  assert.equal(again.act, "nudge", "nudged again: its 5 min interval is up");
  assert.equal(again.level, 3, "one level louder than before the restart");
  assert.equal(again.lead, "Still waiting on you");
  orbWindow.endNudge("seen", { stay: true });
});

test("the whisper's X on stopped work puts it off 20 min, not an hour; every nudge and hold is in the log", async () => {
  fs.rmSync(ATTENTION_LOG, { force: true });
  startAttention();
  const c = blockedCard({ id: "d-ennp", options: [{ key: "grant", label: "Grant" }, { key: "deny", label: "Deny" }], defaultKey: "deny" });
  orbWindow.setAttentionCards([c]);
  const d = await orbWindow.attentionTick();
  assert.equal(d.act, "nudge");
  await wait(900);
  const r = await invoke("desk:nudge-act", nudgeWin(), "close");
  assert.equal(r.ok, true);
  const mem = orbWindow.attentionMems()["d-ennp"];
  const left = mem.snoozeUntil - Date.now();
  assert.ok(left > 19 * 60_000 && left <= 20 * 60_000, `put off ${Math.round(left / 60_000)} min`);
  const held = await orbWindow.attentionTick();
  assert.equal(held.act, "none");
  const log = fs.readFileSync(ATTENTION_LOG, "utf8").trim().split("\n");
  assert.ok(log.some((l) => / nudge \{"id":"d-ennp","level":3/.test(l)), "the nudge is logged");
  assert.ok(log.some((l) => / end \{"id":"d-ennp","outcome":"close"/.test(l)), "its outcome is logged");
  assert.ok(log.some((l) => / hold \{"reason":"/.test(l)), "the hold after it is logged, with its reason");
  // GET /attention's source: the card, its level, its snooze, and why it is not nagging.
  const s = orbWindow.attentionState();
  assert.equal(s.ok, true);
  assert.equal(s.quiet, "");
  const row = s.cards.find((x) => x.id === "d-ennp");
  assert.equal(row.level, 3);
  assert.equal(row.nudges, 1);
  assert.equal(row.nextDueAt, mem.snoozeUntil);
  assert.match(row.reason, /put off/);
  assert.equal(s.lastPlan.act, "none");
  assert.equal(s.log, ATTENTION_LOG);
  // A quiet reason from main is reported as such.
  orbWindow.__setAttentionHooks({ quiet: () => "game on", idleMs: () => 0, fullScreen: async () => "" });
  assert.equal(orbWindow.attentionState().quiet, "game on");
});

test("seeing the fairy (an orb click) is not answering: the ignored count stays, the next nudge is louder", async () => {
  startAttention();
  const c = blockedCard({ id: "d-seen" });
  orbWindow.setAttentionCards([c]);
  assert.equal((await orbWindow.attentionTick()).level, 2);
  await wait(1000); // the flight to the pointer lands
  orbWindow.endNudge("timeout", { stay: true });
  assert.equal(orbWindow.attentionMems()["d-seen"].ignored, 1);
  // Its interval is up; the second nudge, then the owner clicks the orb to ask something else.
  orbWindow.attentionMems()["d-seen"].lastNudgeAt -= 6 * 60_000;
  orbWindow.__resetAttentionClock();
  const second = await orbWindow.attentionTick();
  assert.equal(second.act, "nudge");
  assert.equal(second.level, 3, "climbed once");
  await invoke("desk:orb-click", orbWin());
  assert.equal(orbWindow.nudging(), null, "the click ended the nudge");
  const b = bubbleWin();
  if (b && b.isVisible()) b.hide();
  assert.equal(orbWindow.attentionMems()["d-seen"].ignored, 1, "a click on the orb did not reset the ladder");
});

test("a nudge still up when the desk quits counts as ignored after the restart", async () => {
  startAttention();
  const c = blockedCard({ id: "d-quit" });
  orbWindow.setAttentionCards([c]);
  assert.equal((await orbWindow.attentionTick()).act, "nudge");
  assert.ok(orbWindow.nudging(), "the whisper is up");
  // The desk quits mid-nudge (it restarted at 06:47 and 07:01 on 2026-11-19): no outcome is recorded.
  orbWindow.__reset();
  start();
  const mem = orbWindow.attentionMems()["d-quit"];
  assert.equal(mem.nudges, 1);
  assert.equal(mem.ignored, 1, "the unanswered nudge counts");
  assert.equal(mem.openAt, undefined);
});
