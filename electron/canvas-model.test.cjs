"use strict";

// canvas-model.cjs: every pin edit aither://canvas makes to ONE board (boards-core).

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./canvas-model.cjs");
const core = require("./boards-core.cjs");

let seq = 0;
const rand = () => ((seq += 1) * 0.0137) % 1;
const freshBoard = () => core.newBoard({ kind: "board", id: "board-1", date: new Date("2026-11-07T12:00:00Z") });
/** Apply an op and fold its patch back the way boards-window.updateBoard does (applySave). */
const run = (board, op) => {
  const r = M.applyPinOp(board, op, { rand });
  assert.equal(r.ok, true, `${op.op}: ${r.error}`);
  return { board: core.applySave(board, r.patch), pin: r.pin };
};

test("pin.add picks the card kind from the URL (pin-item) and lands on the grid", () => {
  let b = freshBoard();
  for (const [url, kind] of [["https://youtu.be/dQw4w9WgXcQ", "youtube"], ["https://x.test/cat.gif", "gif"],
    ["https://x.test/a.png", "image"], ["aither://fleet/", "app"], ["https://example.com", "url"]]) {
    const r = run(b, { op: "pin.add", url });
    b = r.board;
    const pin = b.pins.find((p) => p.id === r.pin);
    assert.equal(pin.kind, kind, url);
    assert.equal(pin.bounds.x % 16, 0);
  }
  assert.equal(b.pins.length, 5);
  assert.equal(M.applyPinOp(b, { op: "pin.add", url: "file:///C:/x" }).ok, false);
  assert.equal(M.applyPinOp(b, { op: "pin.add", url: "aither://canvas/" }).ok, false, "never the canvas itself");
  assert.equal(M.applyPinOp(b, { op: "pin.add", kind: "widget", widget: "Bad Id" }).ok, false);
});

test("new cards do not overlap the ones already there; z climbs", () => {
  let b = freshBoard();
  for (let i = 0; i < 6; i += 1) b = run(b, { op: "pin.add", kind: "widget", widget: "clock", w: 240, h: 128 }).board;
  const ps = b.pins;
  for (let i = 0; i < ps.length; i += 1) {
    for (let j = i + 1; j < ps.length; j += 1) {
      const [a, c] = [ps[i].bounds, ps[j].bounds];
      assert.ok(!(a.x < c.x + c.width && a.x + a.width > c.x && a.y < c.y + c.height && a.y + a.height > c.y), `${i} overlaps ${j}`);
    }
  }
  assert.deepEqual(ps.map((p) => p.z), [1, 2, 3, 4, 5, 6]);
});

test("move and resize snap when snap is on, clamp, and are exact when it is off", () => {
  let { board: b, pin } = run(freshBoard(), { op: "pin.add", url: "https://example.com", x: 0, y: 0 });
  b = run(b, { op: "pin.move", id: pin, x: 37, y: 9 }).board;
  assert.deepEqual([b.pins[0].bounds.x, b.pins[0].bounds.y], [32, 16]);
  b = run(b, { op: "pin.resize", id: pin, w: 5, h: 99999 }).board;
  assert.deepEqual([b.pins[0].bounds.width, b.pins[0].bounds.height], [128, M.LIMITS.maxH]);
  b = run(b, { op: "grid", snap: false }).board;
  b = run(b, { op: "pin.move", id: pin, x: 37, y: 9 }).board;
  assert.deepEqual([b.pins[0].bounds.x, b.pins[0].bounds.y], [37, 9]);
});

test("a locked card refuses move and resize, but can be unlocked, edited and removed", () => {
  let { board: b, pin } = run(freshBoard(), { op: "pin.add", kind: "note", text: "hello" });
  b = run(b, { op: "pin.lock", id: pin, locked: true }).board;
  assert.match(M.applyPinOp(b, { op: "pin.move", id: pin, x: 100, y: 100 }).error, /locked/);
  assert.match(M.applyPinOp(b, { op: "pin.resize", id: pin, w: 400, h: 400 }).error, /locked/);
  b = run(b, { op: "pin.update", id: pin, title: "Todo", text: "buy milk", opacity: 0.5 }).board;
  assert.deepEqual([b.pins[0].title, b.pins[0].src, b.pins[0].opacity], ["Todo", "buy milk", 0.5]);
  b = run(b, { op: "pin.lock", id: pin }).board;
  assert.equal(b.pins[0].locked, false, "lock with no value toggles");
  b = run(b, { op: "pin.remove", id: pin }).board;
  assert.equal(b.pins.length, 0);
});

test("the canvas half never touches the board window's drawing (one document, two owners)", () => {
  let b = freshBoard();
  b = core.applySave(b, { items: [{ id: "s1", type: "stroke", x: 0, y: 0, w: 10, h: 10, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }] });
  b = run(b, { op: "pin.add", url: "https://example.com" }).board;
  b = run(b, { op: "view", zoom: 9, pan: { x: 120, y: -40 } }).board;
  assert.equal(b.items.length, 1, "pin and view edits keep the drawing");
  assert.deepEqual(b.view, { scale: M.LIMITS.zoomMax, x: 120, y: -40 });
  // And a WINDOW save (title/text/items/bounds only) keeps the pins.
  const afterWindow = core.applySave(b, { items: [], title: "Renamed" });
  assert.equal(afterWindow.pins.length, 1);
  assert.equal(afterWindow.view.x, 120);
});

test("applyPinOp never mutates its input; unknown ops are refused; the card limit holds", () => {
  const b = freshBoard();
  const before = JSON.stringify(b);
  M.applyPinOp(b, { op: "pin.add", url: "https://example.com" });
  assert.equal(JSON.stringify(b), before);
  assert.equal(M.applyPinOp(b, { op: "board.explode" }).ok, false);
  let full = b;
  for (let i = 0; i < M.LIMITS.pins; i += 1) full = run(full, { op: "pin.add", kind: "widget", widget: "clock", x: i * 16, y: 0 }).board;
  assert.match(M.applyPinOp(full, { op: "pin.add", kind: "widget", widget: "clock" }).error, /at most/);
});

test("clipRect: a card body clipped to the board viewport; nothing when it is off screen", () => {
  const vp = { x: 0, y: 44, width: 800, height: 600 };
  assert.deepEqual(M.clipRect({ x: 100, y: 100, width: 300, height: 200 }, vp), { x: 100, y: 100, width: 300, height: 200 });
  assert.deepEqual(M.clipRect({ x: -50, y: 20, width: 300, height: 200 }, vp), { x: 0, y: 44, width: 250, height: 176 });
  assert.equal(M.clipRect({ x: 900, y: 100, width: 300, height: 200 }, vp), null);
  assert.equal(M.clipRect({ x: 790, y: 100, width: 300, height: 200 }, vp), null, "a 10 px sliver is not a page");
});

test("boards-core v2: a version-1 file migrates (no pins, default view, unlinked); junk pins drop", () => {
  const v1 = { version: 1, id: "board-old", kind: "board", title: "Old", items: [], text: "" };
  const b = core.normalizeBoard(v1);
  assert.equal(b.version, 2);
  assert.deepEqual([b.pins, b.view, b.grid, b.snap, b.link], [[], { scale: 1, x: 0, y: 0 }, 16, true, null]);
  const junk = core.normalizeBoard({ ...v1, pins: [{ id: "p1", kind: "url", src: "javascript:x" }, { id: "p2", kind: "url", src: "https://ok.test" },
    { id: "p2", kind: "url", src: "https://dupe.test" }], link: { aitherone: { docId: "../x y" } } });
  assert.deepEqual(junk.pins.map((p) => p.src), ["https://ok.test"]);
  assert.equal(junk.link, null, "a link must name a real doc id");
});

test("pin.duplicate (Ctrl+middle-drag): an unlocked copy on top at the drop point, even of a locked card", () => {
  let { board: b, pin } = run(freshBoard(), { op: "pin.add", url: "https://youtu.be/dQw4w9WgXcQ", x: 0, y: 0 });
  b = run(b, { op: "pin.lock", id: pin, locked: true }).board;
  const r = run(b, { op: "pin.duplicate", id: pin, x: 203, y: 97 });
  const copy = r.board.pins.find((p) => p.id === r.pin);
  assert.notEqual(copy.id, pin);
  assert.deepEqual([copy.kind, copy.src, copy.locked], ["youtube", b.pins[0].src, false]);
  assert.deepEqual([copy.bounds.x, copy.bounds.y], [208, 96], "snapped to the grid");
  assert.equal(copy.z, 2);
  assert.equal(M.applyPinOp(b, { op: "pin.duplicate", id: "nope" }).ok, false);
});
