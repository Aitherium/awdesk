"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const boards = require("./boards-window.cjs");
const core = require("./boards-core.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "desk-boards-"));
}

test("W1 loadBoards keeps valid boards, skips a torn file and non-JSON", () => {
  const dir = tempDir();
  const good = core.newBoard({ kind: "note", date: new Date("2026-11-02T12:00:00Z"), title: "Kept" });
  fs.writeFileSync(path.join(dir, `${good.id}.json`), core.boardJson(good));
  fs.writeFileSync(path.join(dir, "torn.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const loaded = boards.loadBoards(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, good.id);
  assert.equal(loaded[0].kind, "note");
  assert.equal(loaded[0].title, "Kept");
});

test("W2 loadBoards on a missing folder or no folder is an empty list, not a throw", () => {
  assert.deepEqual(boards.loadBoards(null), []);
  assert.deepEqual(boards.loadBoards(path.join(tempDir(), "gone")), []);
});

test("W3 the requiring of boards-window never pulls Electron at module load", () => {
  // A plain `node --test` run has no app; every Electron call is lazy, so the
  // module is importable and the pure helpers run here.
  assert.equal(typeof boards.createNote, "function");
  assert.equal(typeof boards.restoreOpenBoards, "function");
  assert.equal(typeof boards.setEnqueue, "function");
  assert.equal(typeof boards.enqueueUpload === "undefined", true, "enqueueUpload stays internal");
});

test("W4 the tray rows list at most five boards, mark put-away ones, then the verbs", () => {
  const map = boards.__entries;
  const saved = new Map(map);
  map.clear();
  try {
    for (let i = 0; i < 7; i += 1) {
      const board = core.newBoard({ kind: i % 2 ? "note" : "board", date: new Date(Date.now() - i * 1000), title: `B${i}` });
      board.open = true;
      board.visible = i !== 0;
      map.set(board.id, { board, win: { isDestroyed: () => true } });
    }
    const rows = boards.traySubmenu();
    const labels = rows.map((r) => r.label).filter(Boolean);
    assert.equal(labels.filter((l) => l.startsWith("Note:") || l.startsWith("Board:")).length, 5);
    assert.ok(labels[0].includes("(put away)"), `the hidden board is marked: ${labels[0]}`);
    assert.ok(labels.includes("+2 more"), "the overflow is ONE row");
    assert.ok(labels.includes("New note"));
    assert.ok(labels.includes("New whiteboard"));
    assert.ok(labels.includes("Board list…"));
  } finally {
    map.clear();
    for (const [key, value] of saved) map.set(key, value);
  }
});
