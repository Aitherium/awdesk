"use strict";

// ink-window.cjs owns the overlays and their IPC. Loading it under node is safe:
// electron is required lazily (inside the window functions), so these tests use
// the module's __-prefixed seams and the pure reducers in ink-core.cjs.

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./ink-core.cjs");
const ink = require("./ink-window.cjs");

function strokeItem(id) {
  return core.normalizeItem({
    id, type: "stroke", color: "#ff4d4d", width: 4, createdAt: 1000,
    points: [{ x: 0, y: 0, p: 0.5 }, { x: 10, y: 10, p: 0.5 }],
  });
}

test("clearDrawings keeps history: the clear is one undoable step per display", () => {
  let doc = core.normalizeState();
  doc = core.pushItem(doc, strokeItem("a"));
  doc = core.pushItem(doc, strokeItem("b"));
  ink.__setDoc(31, doc);

  ink.clearDrawings();

  const after = ink.__state().docs.find((d) => d.id === 31);
  assert.equal(after.items, 0, "every mark is gone");
  assert.equal(after.undo, 3, "two adds + one clear are on the undo stack");
  assert.equal(after.redo, 0, "a fresh clear discards the redo branch");

  // The toolbar's Undo runs core.undo on the same doc: the clear must reverse.
  const back = core.undo(ink.__doc(31));
  assert.equal(back.items.length, 2, "one undo restores everything the clear dropped");
});

test("clearDrawings stays per-display (undoing one does not touch another)", () => {
  let one = core.pushItem(core.normalizeState(), strokeItem("x"));
  let two = core.pushItem(core.normalizeState(), strokeItem("y"));
  ink.__setDoc(41, one);
  ink.__setDoc(42, two);

  ink.clearDrawings();

  assert.equal(core.undo(ink.__doc(41)).items.length, 1);
  assert.equal(core.undo(ink.__doc(42)).items.length, 1);
});

test("the mutating ink: handlers refuse a sender that is not one of our overlays", async () => {
  const handlers = ink.handlers();
  const foreign = { sender: { id: "not-an-overlay" } };
  const guarded = ["ink:clear", "ink:exit", "ink:save", "ink:set-tool", "ink:set-color",
    "ink:set-width", "ink:set-fade"];
  for (const channel of guarded) {
    const before = ink.__state();
    const result = handlers[channel](foreign, "pen");
    assert.equal(result, null, `${channel} answers null to a foreign sender`);
    const after = ink.__state();
    assert.equal(after.active, before.active, `${channel} changed no state`);
    assert.equal(after.tool, before.tool, `${channel} changed no tool`);
    assert.equal(after.fadeMs, before.fadeMs, `${channel} changed no fade`);
  }
});
