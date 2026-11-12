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
    ...(opts.runCommand ? { runCommand: opts.runCommand } : {}),
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

test("the fairy door is labelled Needs you (N) when cards are waiting", () => {
  const src = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.match(src, /`Needs you \(\$\{attention\.count\}\)`/);
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
  // the old card left the queue: its memory is pruned
  assert.equal(orbWindow.attentionMems()["d-fair"], undefined);
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

test("clicking the orb mid-nudge opens the waiting queue; the card it carried counts as seen", async () => {
  // Owner 2026-11-12: a companion's click opens ITS card; the orb is the whole queue.
  let listed = 0;
  startAttention({ openList: () => { listed += 1; return true; } });
  orbWindow.setAttentionCards([blockedCard()]);
  await orbWindow.attentionTick();
  await wait(1000);
  const r = await invoke("desk:orb-click", orbWin());
  assert.equal(r.ok, true);
  assert.equal(r.queue, true);
  assert.equal(listed, 1);
  assert.equal(orbWindow.nudging(), null);
  assert.equal(orbWindow.attentionMems()["d-fair"].ignored || 0, 0, "seen, not ignored");
});

test("clicking the orb with cards waiting opens the queue, even when the card was put off with Later", async () => {
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
  assert.equal(r.queue, true, `the queue opens, not the chat: ${JSON.stringify(r)}`);
  assert.equal(listed, 1);
  assert.deepEqual(calls.open, [], "never the Inbox on an arbitrary card");
  assert.equal(orbWindow.nudging(), null, "no card pops from the orb's click");
  // Nothing waiting: the click still opens the chat.
  orbWindow.setAttentionCards([]);
  const chat = await invoke("desk:orb-click", orbWin());
  assert.equal(chat.visible, true);
  assert.equal(chat.card, undefined);
});

test("a trip that hangs never swallows the click: the queue still opens, and the trip times out", async () => {
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
  assert.equal(r.queue, true, `a click with a card waiting opens the queue, trip or not: ${JSON.stringify(r)}`);
  assert.equal(listed, 1);
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
  assert.equal(mates.length, 6, "no cap");
  assert.deepEqual(mates.map((m) => m.agent), ["atlas", "lyra", "demiurge", "iris", "saga", "vera"]);
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
  const worn = lastSent(orbWin(), "orb:companions");
  assert.equal(worn.some((m) => m.agent === "lyra"), false, "the worn agent leaves the orbit");
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

test("twelve agents waiting: the swarm window shows all twelve, centred on the fairy, click-through, the orb unchanged", async () => {
  startAttention();
  const agents = ["atlas", "demi", "lyra", "iris", "saga", "vera", "hera", "gargbot", "plutus", "chaos", "viviane", "aeon-crew"];
  const old = Math.floor(Date.now() / 1000) - 600;
  orbWindow.setAttentionCards(agents.map((a, i) => blockedCard({ id: `d-x${i}`, agent: a, createdAt: old })));
  const swarm = orbWindow.swarmWindow();
  assert.ok(swarm && swarm.isVisible(), "the swarm is up");
  assert.equal(swarm.opts.focusable, false);
  assert.equal(swarm.ignoreMouse, true, "click-through until a companion is under the pointer");
  const list = lastSent(swarm, "orb:companions");
  assert.equal(list.length, 12, "every agent renders");
  assert.deepEqual(list.map((c) => c.agent).sort(), agents.map((a) => (a === "demi" ? "demiurge" : a)).sort());
  const o = orbWin().getBounds();
  assert.equal(o.width, 72, "the orb window never grows");
  const b = swarm.getBounds();
  assert.equal(b.x + b.width / 2, o.x + 36, "centred on the fairy");
  assert.ok(b.width >= 2 * 40, "sized for the second ring");
  await invoke("desk:swarm-hit", swarm, true);
  assert.equal(swarm.ignoreMouse, false);
  orbWindow.setAttentionCards([blockedCard({ id: "d-x0", agent: "atlas" })]);
  assert.equal(swarm.isVisible(), false, "one agent left: no swarm");
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
  assert.deepEqual(list.map((c) => [c.agent, c.state]), [["atlas", "working"], ["lyra", "idle"]]);
  orbWindow.noteAgentPosted("Lyra");
  list = lastSent(swarm, "orb:companions");
  assert.equal(list.find((c) => c.agent === "lyra").state, "speaking", "its Discord/relay post flashes it");
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
  // #50: a companion WITH a card opens its newest card; one with no card (presence) opens the chat.
  assert.match(html, /if \(hotMate\.id\) api\.openCard\(hotMate\.id, hotMate\.agent\);/);
  assert.match(html, /else if \(hotMate\.agent && api\.chatAgent\) api\.chatAgent\(hotMate\.agent\);/);
  const preload = fs.readFileSync(path.join(__dirname, "orb-preload.cjs"), "utf8");
  assert.match(preload, /chatAgent: \(agent\) => ipcRenderer\.invoke\("desk:orb-chat-agent"/);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /chat: \(agent, links\) => openAgentChat\(agent, links\)/);
  assert.match(main, /type: "deck:open-chat"/);
  assert.match(main, /platformPresence = snap\.presence\.agents/);
  // The live Claude sessions ride beside the platform agents, one companion each.
  assert.match(main, /orbWindow\.setPresence\(\[\.\.\.platformPresence, \.\.\.sessions\]\)/);
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
    "mute", "dismiss", "session", "copy"]);
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

test("right click on the orb: inbox, answer window, mute 1 h (nudges held), settings, more, hide fairies", async () => {
  let listed = 0;
  const calls = startAttention({ openList: () => { listed += 1; return true; } });
  orbWindow.setAttentionCards([blockedCard({ id: "d-o1", createdAt: Math.floor(Date.now() / 1000) })]);
  if (orbWindow.nudging()) orbWindow.endNudge("seen", { stay: true });
  const r = await invoke("desk:orb-menu", orbWin());
  assert.deepEqual(r.items, ["inbox", "queue", "mute-1h", "hide", "settings", "more"]);
  assert.match(lastSent(menuWin(), "orb:menu").header, /1 waiting on you/);
  assert.equal((await invoke("desk:menu-pick", menuWin(), "inbox")).ok, true);
  assert.deepEqual(calls.open, [null], "the Inbox, on no card in particular");
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "queue");
  assert.equal(listed, 1);
  await invoke("desk:orb-menu", orbWin());
  const m = await invoke("desk:menu-pick", menuWin(), "mute-1h");
  assert.ok(m.muteUntil > Date.now() + 59 * 60_000);
  assert.match((await orbWindow.attentionTick()).reason, /muted/);
  const again = await invoke("desk:orb-menu", orbWin());
  assert.ok(again.items.includes("unmute"), "muted: the row offers Unmute");
  await invoke("desk:menu-pick", menuWin(), "unmute");
  await invoke("desk:orb-menu", orbWin());
  assert.equal((await invoke("desk:menu-pick", menuWin(), "settings")).ok, true);
  await invoke("desk:orb-menu", orbWin());
  assert.equal((await invoke("desk:menu-pick", menuWin(), "more")).ok, true, "the old full menu is one row away");
  await invoke("desk:orb-menu", orbWin());
  await invoke("desk:menu-pick", menuWin(), "hide");
  assert.equal(orbWin().isVisible(), false, "Hide fairies hides the fairy and its swarm");
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
