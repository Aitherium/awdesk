"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("./boards-core.cjs");

test("B1 a new note/board is a valid document with its size", () => {
  const note = core.newBoard({ kind: "note", date: new Date("2026-11-02T09:30:00"), bounds: { x: 10, y: 20, width: 360, height: 300 } });
  assert.equal(note.kind, "note");
  assert.match(note.title, /^Note 2026-11-02 0930$/);
  assert.equal(note.open, true);
  assert.equal(note.visible, true);
  assert.deepEqual(note.items, []);
  assert.equal(note.text, "");
  const board = core.newBoard({ kind: "board" });
  assert.equal(board.kind, "board");
  assert.match(board.title, /^Whiteboard /);
});

test("B2 titles are unique per board and ids never collide", () => {
  const a = core.newBoard({ kind: "note", date: new Date("2026-11-02T09:30:00") });
  assert.equal(core.uniqueTitle(a.title, []), a.title);
  assert.equal(core.uniqueTitle(a.title, [a]), `${a.title} (2)`);
  assert.notEqual(core.newId("note", new Date(), "aaaaaa"), core.newId("note", new Date(), "bbbbbb"));
});

test("B3 placeAt opens AT the cursor, flips at the edge, clamps into the work area", () => {
  const work = { x: 0, y: 0, width: 3840, height: 2112 };
  assert.deepEqual(core.placeAt({ x: 500, y: 400 }, { width: 760, height: 560 }, work),
    { x: 500, y: 400, width: 760, height: 560 });
  // Near the right/bottom edge: the window opens up-left of the cursor.
  assert.deepEqual(core.placeAt({ x: 3800, y: 2100 }, { width: 760, height: 560 }, work),
    { x: 3040, y: 1540, width: 760, height: 560 });
  // A second display at y=2160.
  const second = { x: 1920, y: 2160, width: 1920, height: 1032 };
  assert.deepEqual(core.placeAt({ x: 2000, y: 2200 }, { width: 360, height: 300 }, second),
    { x: 2000, y: 2200, width: 360, height: 300 });
  // A size bigger than the work area is shrunk, never placed off-screen.
  const tiny = core.placeAt({ x: 10, y: 10 }, { width: 9000, height: 9000 }, { x: 0, y: 0, width: 800, height: 600 });
  assert.ok(tiny.width <= 800 && tiny.height <= 600);
  assert.ok(tiny.x >= 8 && tiny.y >= 8);
});

test("B4 usableBounds rejects a restore that is no longer on a display", () => {
  const displays = [{ bounds: { x: 0, y: 0, width: 3840, height: 2160 } }, { bounds: { x: 1920, y: 2160, width: 1920, height: 1080 } }];
  assert.deepEqual(core.usableBounds({ x: 100, y: 100, width: 400, height: 300 }, displays),
    { x: 100, y: 100, width: 400, height: 300 });
  assert.equal(core.usableBounds({ x: 5000, y: 5000, width: 400, height: 300 }, displays), null);
  assert.equal(core.usableBounds({ x: 0, y: 0, width: 20, height: 20 }, displays), null);
  assert.equal(core.usableBounds(null, displays), null);
});

test("B5 normalizeBoard survives a torn file and drops unusable items", () => {
  assert.equal(core.normalizeBoard(null), null);
  assert.equal(core.normalizeBoard({ id: "x", kind: "nope" }), null);
  const board = core.normalizeBoard({
    id: "note-1", kind: "note", title: 7, open: false, visible: false,
    bounds: { x: "3", y: 4, width: "20", height: 300 },
    items: [
      { id: "s", type: "stroke", points: [{ x: 1, y: 2 }] }, // one point is not a stroke
      { id: "s2", type: "stroke", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
      { id: "i", type: "image", dataUrl: "javascript:alert(1)" },
      null,
    ],
    text: "hello",
  });
  assert.equal(board.title, "7");
  assert.equal(board.open, false);
  assert.equal(board.visible, false);
  assert.equal(board.bounds.width, core.MIN_WIDTH);
  assert.equal(board.items.length, 1);
  assert.equal(board.items[0].type, "stroke");
  assert.equal(board.text, "hello");
});

test("B6 a save takes content but keeps identity and visibility", () => {
  const board = core.newBoard({ kind: "board", id: "board-fixed" });
  board.visible = false;
  const next = core.applySave(board, { title: "Renamed", items: [{ id: "t", type: "text", x: 5, y: 6, w: 100, h: 20, text: "hi" }] }, Date.parse("2026-11-02T10:00:00Z"));
  assert.equal(next.id, "board-fixed");
  assert.equal(next.kind, "board");
  assert.equal(next.title, "Renamed");
  assert.equal(next.visible, false, "a save must not un-hide a put-away board");
  assert.equal(next.items.length, 1);
  assert.equal(next.updatedAt, new Date("2026-11-02T10:00:00Z").toISOString());
});

test("B7 the list shows at most 5 then +N more, newest first, open only", () => {
  const boards = [];
  for (let i = 0; i < 8; i += 1) {
    const b = core.newBoard({ kind: i % 2 ? "note" : "board", id: `b${i}`, date: new Date(2026, 10, 2, 9, i) });
    b.updatedAt = new Date(2026, 10, 2, 9, i).toISOString();
    boards.push(b);
  }
  boards[0].open = false; // a closed board is not in the list
  const summary = core.listSummary(boards);
  assert.equal(summary.rows.length, 5);
  assert.equal(summary.more, 2);
  assert.equal(summary.rows[0].id, "b7", "newest first");
  assert.ok(summary.rows.every((row) => row.id !== "b0"));
  const hidden = { ...boards[1], visible: false };
  assert.equal(core.listSummary([hidden, boards[2]]).rows.find((r) => r.id === "b1").hidden, true);
});

test("B8 paste classification prefers an image, then files, then text", () => {
  assert.equal(core.classifyPaste({ hasImage: true, text: "x" }), "image");
  assert.equal(core.classifyPaste({ files: ["a.png"] }), "files");
  assert.equal(core.classifyPaste({ text: "  hello " }), "text");
  assert.equal(core.classifyPaste({ text: "   " }), null);
  assert.equal(core.classifyPaste({}), null);
  const at = core.centeredItem("image", { width: 800, height: 600 }, { width: 1200, height: 900 });
  assert.ok(at.w <= 640 && at.h <= 480);
  assert.ok(at.x >= 0 && at.y >= 0);
});

test("B9 markdown + sync items name the board id in the existing `files` folder", () => {
  const note = core.newBoard({ kind: "note", id: "note-abc" });
  note.text = "buy milk\ncall Sam";
  const md = core.markdownFor(note);
  assert.match(md, /^# Note /);
  assert.match(md, /buy milk/);
  const items = core.syncItems(note, { png: Buffer.from("89504e47", "hex") });
  assert.deepEqual(items.map((i) => [i.folder, i.name]), [["files", "note-abc.png"], ["files", "note-abc.md"]]);
  assert.equal(items[1].contentType, "text/markdown");
  const board = core.newBoard({ kind: "board", id: "board-abc" });
  assert.deepEqual(core.syncItems(board, { png: null }), []);
  const pngOnly = core.syncItems(board, { png: Buffer.from([1]) });
  assert.deepEqual(pngOnly.map((i) => i.name), ["board-abc.png"]);
});

test("B10 dirCandidates never names Documents, Pictures or Videos", () => {
  for (const dir of core.dirCandidates({ homeDir: "C:\\Users\\ex" })) {
    assert.ok(!/[\\/](Documents|Pictures|Videos)([\\/]|$)/i.test(dir), `protected folder in ${dir}`);
    assert.match(dir, /Aither/);
  }
});

test("B11 block is JSON-serialisable and round-trips", () => {
  const board = core.newBoard({ kind: "board", id: "round" });
  board.items = [{ id: "t", type: "text", x: 1, y: 2, w: 30, h: 40, text: "a", color: "#fff", size: 16 }];
  const back = core.normalizeBoard(JSON.parse(core.boardJson(board)));
  assert.deepEqual(back.items, board.items);
  assert.equal(back.id, "round");
});
