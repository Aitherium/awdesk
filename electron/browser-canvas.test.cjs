"use strict";

// browser-canvas.cjs: the canvas IPC fence, the ONE store (boards-window), the live
// views behind page cards, and the AitherOne verbs -- with fakes (no electron).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./boards-core.cjs");
const { createCanvasHost, isCanvasContents } = require("./browser-canvas.cjs");
const W = require("./canvas-widgets.cjs");

function fakeWc(url, id = 1) {
  const handlers = {};
  return {
    id, sent: [], destroyed: false,
    getURL: () => url, isDestroyed() { return this.destroyed; },
    once: (evt, fn) => { handlers[evt] = fn; }, fire: (evt) => handlers[evt] && handlers[evt](),
    send(channel, payload) { this.sent.push([channel, payload]); },
  };
}
function fakeView(url) {
  return {
    url, bounds: null, visible: null,
    setBounds(b) { this.bounds = b; }, setVisible(v) { this.visible = v; },
    webContents: { isDestroyed() { return false; }, close() {}, setZoomFactor() {} },
  };
}
function fakeWindow() {
  const w = { children: new Set(), isDestroyed: () => false };
  w.contentView = { addChildView: (v) => w.children.add(v), removeChildView: (v) => w.children.delete(v) };
  return w;
}

/** A boards-window stand-in over an in-memory map, applySave and all. */
function fakeStore() {
  const boards = new Map();
  const listeners = new Set();
  let n = 0;
  const store = {
    boards,
    allBoards: () => core.listedBoards([...boards.values()]).filter((b) => b.kind === "board"),
    getBoard: (id) => boards.get(id) || null,
    updateBoard(id, patch) {
      const b = boards.get(id);
      if (!b) return { ok: false, reason: "no such board" };
      const next = core.applySave(b, patch, Date.now() + (n += 1));
      boards.set(id, next);
      return { ok: true, board: next };
    },
    stampLink(id) {
      const b = boards.get(id);
      b.link = { aitherone: { ...b.link.aitherone, localUpdatedAt: b.updatedAt } };
      return { ok: true };
    },
    createCanvasBoard(title) {
      const b = core.newBoard({ kind: "board", id: `board-${(n += 1)}`, title: title || `Board ${n}` });
      b.visible = false;
      boards.set(b.id, b);
      return { ok: true, board: b };
    },
    closeBoard(id) { const b = boards.get(id); b.open = false; return { ok: true }; },
    float: () => ({ ok: true }),
    onBoardsChanged: (fn) => listeners.add(fn),
  };
  return store;
}

function setup({ shown = true, aitherone = null } = {}) {
  const made = [];
  const win = fakeWindow();
  const store = fakeStore();
  let active = null;
  const opened = [];
  const host = createCanvasHost({
    store,
    getActive: () => active,
    setActive: (id) => { active = id; },
    makeView: (url) => { const v = fakeView(url); made.push(v); return { ok: true, view: v }; },
    hostOf: () => ({ window: win, origin: { x: 254, y: 78 }, shown }),
    openTab: (url) => { opened.push(url); return { ok: true }; },
    aitherone: () => aitherone,
    registry: W.createRegistry([]),
  });
  return { host, made, win, store, opened, active: () => active };
}

test("the fence: only the canvas page's own URL passes", () => {
  assert.equal(isCanvasContents(fakeWc("aither://canvas/")), true);
  assert.equal(isCanvasContents(fakeWc("aither://canvasx/")), false);
  assert.equal(isCanvasContents(fakeWc("https://evil.test/aither://canvas/")), false);
  assert.equal(isCanvasContents(fakeWc("aither://fleet/")), false);
  const wc = fakeWc("aither://canvas/");
  wc.destroyed = true;
  assert.equal(isCanvasContents(wc), false);
});

test("every canvas channel is guarded by that fence", () => {
  const { host } = setup();
  const handlers = {};
  host.wire({ handle: (channel, fn) => { handlers[channel] = fn; } });
  assert.deepEqual(Object.keys(handlers).sort(),
    ["desk:canvas-op", "desk:canvas-open", "desk:canvas-state", "desk:canvas-views", "desk:canvas-widget"]);
  for (const fn of Object.values(handlers)) {
    assert.deepEqual(fn({ sender: fakeWc("https://evil.test/") }, { op: "board.create" }), { ok: false, error: "not the canvas page" });
  }
});

test("ONE store: the canvas is a boards-window whiteboard; a first look makes one", async () => {
  const s = setup();
  const state = s.host.stateFor(fakeWc("aither://canvas/"));
  assert.equal(s.store.boards.size, 1, "the canvas made a whiteboard in the boards store");
  assert.equal(state.board.id, s.active(), "and the layout pointer names it");
  await s.host.pin("https://youtu.be/dQw4w9WgXcQ", "Song");
  const stored = s.store.getBoard(s.active());
  assert.equal(stored.pins.length, 1);
  assert.equal(stored.pins[0].kind, "youtube", "pinned as the kind it is");
  const made = await s.host.apply({ op: "board.create", name: "Second" });
  assert.equal(s.active(), made.board);
  assert.equal((await s.host.apply({ op: "board.delete" })).ok, true);
  assert.equal(s.store.allBoards().length, 1);
  assert.equal((await s.host.apply({ op: "board.delete" })).ok, false, "the last board stays");
});

test("a page card's live view sits over the card body, offset to the tab, clipped to the board", async () => {
  const s = setup();
  const wc = fakeWc("aither://canvas/");
  s.host.stateFor(wc);
  const r = await s.host.pin("https://example.com/", "Example");
  s.host.report(wc, { viewport: { x: 0, y: 44, width: 800, height: 600 }, cards: [{ id: r.pin, rect: { x: -40, y: 100, width: 300, height: 200 } }] });
  assert.equal(s.made.length, 1);
  assert.ok(s.win.children.has(s.made[0]));
  assert.deepEqual(s.made[0].bounds, { x: 254, y: 178, width: 260, height: 200 });
  s.host.report(wc, { viewport: { x: 0, y: 44, width: 800, height: 600 }, cards: [{ id: r.pin, rect: { x: 2000, y: 100, width: 300, height: 200 } }] });
  assert.equal(s.made[0].visible, false, "scrolled off: hidden, not reloaded");
  await s.host.apply({ op: "pin.remove", id: r.pin });
  assert.ok(!s.win.children.has(s.made[0]), "removing the card removes its page");
  // Notes and widgets draw in the page itself: no view.
  const note = await s.host.apply({ op: "pin.add", kind: "note", text: "hi" });
  s.host.report(wc, { viewport: { x: 0, y: 0, width: 800, height: 600 }, cards: [{ id: note.pin, rect: { x: 0, y: 0, width: 300, height: 200 } }] });
  assert.equal(s.made.length, 1);
  wc.fire("destroyed");
  assert.equal(s.host.__pages.size, 0);
});

test("a canvas tab nobody is looking at loads no pages", async () => {
  const s = setup({ shown: false });
  const wc = fakeWc("aither://canvas/");
  const r = await s.host.pin("https://example.com/");
  s.host.report(wc, { viewport: { x: 0, y: 0, width: 800, height: 600 }, cards: [{ id: r.pin, rect: { x: 0, y: 0, width: 300, height: 200 } }] });
  assert.equal(s.made.length, 0);
});

/** A fake AitherOne doc service: the routes the client calls, with updated_at moving on save. */
function fakeAitherOne() {
  const docs = new Map();
  let clock = 0;
  const tick = () => `2026-11-07T12:00:${String((clock += 1)).padStart(2, "0")}Z`;
  const client = {
    async create(title, scene) { const id = `d${docs.size + 1}`; docs.set(id, { title, scene, updated_at: tick() }); return { ok: true, docId: id }; },
    async meta(id) { const d = docs.get(id); return d ? { ok: true, updatedAt: d.updated_at } : { ok: false, error: "Document not found" }; },
    async content(id) { const d = docs.get(id); return { ok: true, scene: JSON.parse(JSON.stringify(d.scene)) }; },
    async save(id, scene) { const d = docs.get(id); d.scene = scene; d.updated_at = tick(); return { ok: true }; },
  };
  return { docs, client, editRemote(id, fn) { const d = docs.get(id); fn(d.scene); d.updated_at = tick(); } };
}

test("AitherOne: link creates a doc, push and pull follow last-writer-wins, both-changed is a reported conflict", async () => {
  const ao = fakeAitherOne();
  const s = setup({ aitherone: { base: "https://app.aitherium.com", client: ao.client } });
  await s.host.pin("https://example.com/", "Example");
  const linked = await s.host.apply({ op: "aitherone.sync" });
  assert.equal(linked.action, "linked");
  const docId = s.store.getBoard(s.active()).link.aitherone.docId;
  assert.deepEqual([ao.docs.get(docId).scene.items[0].kind, ao.docs.get(docId).scene.items[0].provider], ["embed", "web"],
    "the pin went up as an AitherOne web embed (the agreed mapping)");
  assert.equal((await s.host.apply({ op: "aitherone.sync" })).action, "in-sync");
  // Desk edit -> push.
  await s.host.pin("https://x.test/cat.gif");
  assert.equal((await s.host.apply({ op: "aitherone.sync" })).action, "pushed");
  assert.equal(ao.docs.get(docId).scene.items.length, 2);
  // AitherOne edit (a file node the desk cannot show + a sticky) -> pull; the file is KEPT.
  ao.editRemote(docId, (scene) => {
    scene.items.push({ id: "f1", kind: "file", node: "/a.pdf", x: 0, y: 0, w: 220, h: 92, z: 9 });
    scene.items.push({ id: "st1", kind: "sticky", text: "from AitherOne", x: 0, y: 0, w: 200, h: 160, z: 10 });
  });
  const pulled = await s.host.apply({ op: "aitherone.sync" });
  assert.equal(pulled.action, "pulled");
  assert.deepEqual(pulled.report, { drawing: 0, cards: 3, kept: 1 });
  assert.equal((await s.host.apply({ op: "aitherone.sync" })).action, "in-sync", "a pull is the new agreed version");
  // Both change -> conflict, nothing written either side.
  await s.host.apply({ op: "pin.add", kind: "note", text: "desk side" });
  ao.editRemote(docId, (scene) => { scene.items.pop(); });
  const before = JSON.stringify(ao.docs.get(docId).scene);
  const pinsBefore = s.store.getBoard(s.active()).pins.length;
  const clash = await s.host.apply({ op: "aitherone.sync" });
  assert.equal(clash.action, "conflict");
  assert.equal(clash.ok, false);
  assert.equal(JSON.stringify(ao.docs.get(docId).scene), before, "AitherOne untouched");
  assert.equal(s.store.getBoard(s.active()).pins.length, pinsBefore, "the desk untouched");
  // The owner picks the desk: push, and the kept file node goes back up with it.
  const forced = await s.host.apply({ op: "aitherone.sync", prefer: "desk" });
  assert.deepEqual([forced.action, forced.forced], ["pushed", true]);
  assert.ok(ao.docs.get(docId).scene.items.some((i) => i.id === "f1"), "an AitherOne-only node is never dropped");
  // Open goes to the canvas section of AitherOne, on that doc.
  await s.host.apply({ op: "aitherone.open" });
  assert.equal(s.opened.at(-1), `https://app.aitherium.com/workspace/one?tab=canvas&doc=${docId}`);
});

test("AitherOne offline: the board stays usable, sync says why", async () => {
  const s = setup({ aitherone: null });
  await s.host.pin("https://example.com/");
  const r = await s.host.apply({ op: "aitherone.sync" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
  assert.equal(s.store.getBoard(s.active()).pins.length, 1);
});

test("the canvas page loads only its own script, and the pane is registered as aither://canvas", () => {
  const html = fs.readFileSync(path.join(__dirname, "canvas.html"), "utf8");
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
    ["middle-drag.js", "pin-cards.js", "canvas-page.js"], "the shared gesture + card modules, then the page");
  assert.match(html, /script-src file:;/, "no inline script, no remote script");
  assert.ok(!/<iframe|<webview/i.test(html), "a live page is a main-process view, never a frame");
  const { PANES } = require("./console-window.cjs");
  const pane = PANES.find((p) => p.id === "canvas");
  assert.deepEqual([pane.kind, pane.file], ["file", "canvas.html"]);
  assert.equal(require("./browser-internal.cjs").preloadFor(pane), "canvas-preload.cjs");
  const page = fs.readFileSync(path.join(__dirname, "canvas-page.js"), "utf8");
  assert.ok(!/innerHTML/.test(page), "the canvas page writes text, never markup");
});
