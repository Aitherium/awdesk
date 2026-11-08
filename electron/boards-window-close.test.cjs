"use strict";

/**
 * Closing a board window keeps everything done in it (2026-11-07).
 *
 * The bug: the window's "closed" handler persisted the board object the window was
 * CREATED with. Every save replaces entry.board (applySave returns a new object), so
 * closing wrote the board back as it was at open -- the drawing, the pinned cards and
 * the pan made since were gone from the file. This drives a real boards-window over a
 * small fake Electron (the orb-window.test.cjs pattern): open a board, draw + pin +
 * pan through the SAME IPC the page uses (board:save, board:pin-op), close the
 * window, and read the board FILE.
 */

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

// ── a small, honest fake Electron ──────────────────────────────────────────────
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

function fakeWebContents() {
  const events = new EventEmitter();
  return {
    sent: [],
    send(channel, payload) { this.sent.push([channel, payload]); },
    on(name, fn) { events.on(name, fn); },
    once(name, fn) { events.once(name, fn); },
    setWindowOpenHandler() {},
    isDestroyed: () => false,
    // An empty capture: the thumbnail/sync path runs and stores nothing.
    capturePage: async () => ({ isEmpty: () => true }),
  };
}

class FakeWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 0, height: opts.height || 0 };
    this.destroyed = false;
    this.visible = false;
    this.webContents = fakeWebContents();
    FakeWindow.all.push(this);
  }
  loadFile(file, { query } = {}) { this.query = query; return Promise.resolve(); }
  getBounds() { return { ...this.bounds }; }
  setBounds(b) { Object.assign(this.bounds, b); }
  setTitle(t) { this.title = t; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  isVisible() { return this.visible && !this.destroyed; }
  isMinimized() { return false; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
  static all = [];
}

const ipcHandlers = new Map();
const fakeElectron = {
  BrowserWindow: FakeWindow,
  screen: {
    getCursorScreenPoint: () => ({ x: 400, y: 300 }),
    getDisplayNearestPoint: () => display,
    getAllDisplays: () => [display],
  },
  ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
  app: { getPath: () => os.tmpdir(), on() {} },
  clipboard: { readImage: () => ({ isEmpty: () => true }), readText: () => "" },
};

// The board window's pin door is the canvas host (browser-window.cjs pinHost). The real
// browser-window pulls the whole browser in, so the door is the REAL browser-canvas host
// over the REAL boards store -- exactly what pinHost() returns -- with no live views.
let canvasHost = null;
const originalLoad = Module._load;
Module._load = function patchedElectron(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  if (request === "./browser-window.cjs" && parent && /boards-window\.cjs$/.test(parent.filename)) {
    return { pinHost: () => canvasHost.boardWindow };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const boards = require("./boards-window.cjs");
const { createCanvasHost } = require("./browser-canvas.cjs");
const { createRegistry } = require("./canvas-widgets.cjs");

canvasHost = createCanvasHost({
  store: boards,
  getActive: () => null,
  setActive: () => {},
  makeView: () => ({ ok: false, error: "no live views in a unit test" }),
  hostOf: () => null,
  registry: createRegistry([]),
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-board-close-"));
boards.setBoardsDir(dir);
boards.setEnqueue(() => ({ ok: true }));
boards.ensureIpc();

const call = (channel, win, ...args) => ipcHandlers.get(channel)({ sender: win.webContents }, ...args);
const readFile = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));

test("closing a board window keeps the drawing, the pinned card and the pan made in it", async () => {
  const opened = boards.createBoard();
  assert.equal(opened.ok, true);
  const id = opened.board.id;
  const win = FakeWindow.all.at(-1);
  assert.equal(readFile(id).items.length, 0, "the file starts empty");

  // Draw + pan: what board.html's payload() sends on a save.
  const stroke = { id: "s1", type: "stroke", x: 10, y: 10, w: 40, h: 40, color: "#1f6feb", width: 3,
    points: [{ x: 10, y: 10 }, { x: 50, y: 50 }] };
  const saved = await call("board:save", win, { title: opened.board.title, items: [stroke], windowView: { x: 150, y: -20 } });
  assert.equal(saved.ok, true);
  // Pin: what pin-cards.js sends from the board window.
  const pinned = await call("board:pin-op", win, { op: "pin.add", url: "https://example.com/" });
  assert.equal(pinned.ok, true, pinned.error);

  win.destroy(); // the owner closes the window

  const after = readFile(id);
  assert.equal(after.open, false, "closed = off the Boards list");
  assert.deepEqual(after.items.map((i) => i.id), ["s1"], "the drawing survives the close");
  assert.equal(after.pins.length, 1, "the pinned card survives the close");
  assert.equal(after.pins[0].src, "https://example.com/");
  assert.deepEqual(after.windowView, { x: 150, y: -20 }, "the pan survives the close");
});

test("moving the window after edits saves the bounds onto the CURRENT board, not the opening copy", async () => {
  const opened = boards.createBoard();
  const id = opened.board.id;
  const win = FakeWindow.all.at(-1);
  await call("board:save", win, { items: [{ id: "n1", type: "note", x: 0, y: 0, w: 100, h: 80, text: "keep me" }] });
  win.bounds = { x: 222, y: 111, width: 700, height: 500 };
  win.emit("moved");
  await new Promise((r) => setTimeout(r, 400)); // queueBoundsSave waits 300 ms
  const after = readFile(id);
  assert.deepEqual([after.bounds.x, after.bounds.y], [222, 111]);
  assert.deepEqual(after.items.map((i) => i.id), ["n1"], "a move never rolls the drawing back");
  win.destroy();
});
