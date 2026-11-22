"use strict";

// middle-drag.js: the owner's middle-button rule, one copy for every surface. It is a
// page script (window.AitherMiddleDrag), so it runs here in a vm, as the page runs it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "middle-drag.js"), "utf8"), sandbox);
  return sandbox.window.AitherMiddleDrag;
}

function fakeTarget() {
  const handlers = {};
  return {
    captured: null,
    setPointerCapture(id) { this.captured = id; },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    removeEventListener(type, fn) { handlers[type] = (handlers[type] || []).filter((f) => f !== fn); },
    fire(type, ev) { for (const fn of [...(handlers[type] || [])]) fn(ev); },
    count(type) { return (handlers[type] || []).length; },
  };
}

test("the rule: middle moves, Shift resizes, Ctrl (or Cmd) duplicates, empty space pans; other buttons are not ours", () => {
  const MD = load();
  assert.equal(MD.classify({ button: 1 }, true), "move");
  assert.equal(MD.classify({ button: 1, shiftKey: true }, true), "resize");
  assert.equal(MD.classify({ button: 1, ctrlKey: true }, true), "duplicate");
  assert.equal(MD.classify({ button: 1, metaKey: true }, true), "duplicate");
  assert.equal(MD.classify({ button: 1, ctrlKey: true, shiftKey: true }, true), "duplicate", "Ctrl wins: a copy, never a resize of the original");
  assert.equal(MD.classify({ button: 1 }, false), "pan");
  assert.equal(MD.classify({ button: 1, shiftKey: true }, false), "pan");
  assert.equal(MD.classify({ button: 0 }, true), null, "the left button stays the tools'");
  assert.equal(MD.classify({ button: 2 }, true), null, "right-click stays the menu");
});

test("track: total delta in surface units (zoom), one end, listeners removed, autoscroll suppressed", () => {
  const MD = load();
  const t = fakeTarget();
  let prevented = false;
  const moves = [];
  let ended = null;
  MD.track({ clientX: 100, clientY: 100, pointerId: 7, preventDefault: () => { prevented = true; }, stopPropagation() {} }, t, {
    scale: 2, onMove: (d) => moves.push(d), onEnd: (d) => { ended = d; },
  });
  assert.equal(prevented, true, "the browser's middle-click autoscroll never starts");
  assert.equal(t.captured, 7);
  t.fire("pointermove", { clientX: 140, clientY: 120 });
  t.fire("pointermove", { clientX: 160, clientY: 80 });
  assert.deepEqual({ ...moves.at(-1) }, { dx: 30, dy: -10 }, "screen px / zoom, from the START (not per step)");
  t.fire("pointerup", {});
  assert.deepEqual({ ...ended }, { dx: 30, dy: -10, moved: true });
  assert.equal(t.count("pointermove") + t.count("pointerup") + t.count("pointercancel"), 0);
  const still = fakeTarget();
  let end2 = null;
  MD.track({ clientX: 5, clientY: 5, pointerId: 1 }, still, { onEnd: (d) => { end2 = d; } });
  still.fire("pointerup", {});
  assert.equal(end2.moved, false, "a middle CLICK is not a move");
});

test("every surface loads the ONE copy (no second handler)", () => {
  for (const page of ["canvas.html", "board.html", "browser-chrome.html"]) {
    const html = fs.readFileSync(path.join(__dirname, page), "utf8");
    assert.match(html, /<script src="middle-drag\.js"><\/script>/, `${page} does not load middle-drag.js`);
  }
  const cards = fs.readFileSync(path.join(__dirname, "pin-cards.js"), "utf8");
  assert.match(cards, /AitherMiddleDrag\.classify\(e, true\)/, "cards use the shared rule");
  const board = fs.readFileSync(path.join(__dirname, "board.html"), "utf8");
  assert.match(board, /<script src="pin-cards\.js"><\/script>/, "the floating board uses the canvas's card renderer");
});
