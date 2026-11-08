"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("./ink-mode.cjs");
const g = require("./middle-drag-load.cjs").middleDrag();

const run = (events, from = m.initial()) => events.reduce((s, e) => m.reduce(s, e), from);

test("toggle: interact <-> draw; capture flips between none and all", () => {
  let s = m.initial();
  assert.equal(m.capture(s), "none");
  s = m.reduce(s, { type: "toggle" });
  assert.equal(s.mode, "draw");
  assert.equal(m.capture(s), "all");
  assert.equal(m.view(s).palette, true);
  assert.equal(m.view(s).glow, true);
  s = m.reduce(s, { type: "toggle" });
  assert.equal(s.mode, "interact");
  assert.equal(m.view(s).palette, false, "the palette auto-hides in interact");
});

test("hold: interact -> draw-held -> interact on release; a toggle while held latches draw", () => {
  assert.equal(run([{ type: "hold-down" }]).mode, "draw-held");
  assert.equal(run([{ type: "hold-down" }, { type: "hold-up" }]).mode, "interact");
  const latched = run([{ type: "hold-down" }, { type: "toggle" }, { type: "hold-up" }]);
  assert.equal(latched.mode, "draw", "Ctrl+Alt held then D latches drawing; releasing keeps it");
  assert.equal(run([{ type: "toggle" }, { type: "hold-down" }]).mode, "draw", "holding in latched draw changes nothing");
  assert.equal(run([{ type: "hold-up" }]).mode, "interact", "a stray release is harmless");
});

test("Esc and right-click leave every drawing mode; nothing else does", () => {
  for (const start of [[{ type: "toggle" }], [{ type: "hold-down" }], [{ type: "pen-enter" }]]) {
    assert.equal(run([...start, { type: "escape" }]).mode, "interact");
    assert.equal(run([...start, { type: "right-click" }]).mode, "interact");
  }
  assert.equal(run([{ type: "escape" }]).mode, "interact");
});

test("pen: a pen draws from interact; the mouse moving (or the pen leaving) hands the desktop back", () => {
  const pen = run([{ type: "pen-enter" }]);
  assert.equal(pen.mode, "pen");
  assert.equal(m.capture(pen), "all");
  assert.equal(m.reduce(pen, { type: "mouse" }).mode, "interact");
  assert.equal(m.reduce(pen, { type: "pen-leave" }).mode, "interact");
  assert.equal(run([{ type: "toggle" }, { type: "pen-enter" }]).mode, "draw", "a pen in latched draw stays draw");
  assert.equal(run([{ type: "toggle" }, { type: "mouse" }]).mode, "draw", "the mouse never leaves latched draw");
});

test("interact + middle-drag: hover captures only over an object; a grab moves it without entering draw", () => {
  let s = m.initial();
  s = m.reduce(s, { type: "hover", id: "stroke-1" });
  assert.equal(m.capture(s), "object", "over a stroke: the overlay takes the mouse");
  assert.equal(m.view(s).cursor, "grab");
  s = m.reduce(s, { type: "middle-down", hit: { id: "stroke-1" } });
  assert.deepEqual(s.grab, { id: "stroke-1", gesture: "move" });
  assert.equal(s.mode, "interact", "no draw mode for a move");
  s = m.reduce(s, { type: "hover", id: null });
  assert.equal(m.capture(s), "object", "a grab keeps the mouse even off the object");
  s = m.reduce(s, { type: "middle-up" });
  s = m.reduce(s, { type: "hover", id: null });
  assert.equal(m.capture(s), "none", "off the object: click-through again");
});

test("middle-down modifiers: Shift resizes, Ctrl duplicates (Ctrl beats Shift), empty space passes, locked is blocked", () => {
  const down = (hit, mods = {}) => m.reduce(m.initial(), { type: "middle-down", hit, ...mods }).grab;
  assert.equal(down({ id: "a" }, { shift: true }).gesture, "resize");
  assert.equal(down({ id: "a" }, { ctrl: true, shift: true }).gesture, "duplicate");
  assert.equal(down({ id: "a" }, { meta: true }).gesture, "duplicate");
  assert.equal(down(null), null, "empty space: nothing grabbed (the app underneath gets it)");
  assert.equal(down({ id: "a", locked: true }), null, "locked: no move");
  assert.equal(down({ id: "a", locked: true }, { ctrl: true }).gesture, "duplicate", "locked can be duplicated");
});

test("hover is ignored while drawing, and a mode switch never carries a stale hover into draw", () => {
  const s = run([{ type: "hover", id: "x" }, { type: "toggle" }]);
  assert.equal(s.hover, null);
  assert.equal(m.reduce(s, { type: "hover", id: "y" }).hover, null);
});

test("wheel: in a drawing mode the wheel passes for 350 ms, then the overlay has the mouse again", () => {
  const s = m.reduce(run([{ type: "toggle" }]), { type: "wheel", now: 1000 });
  assert.equal(m.capture(s, 1100), "none");
  assert.equal(m.capture(s, 1400), "all");
  assert.equal(m.reduce(m.initial(), { type: "wheel", now: 1 }).wheelPassUntil, 0, "interact already passes the wheel");
});

test("20 switches through every mode never leave a grab or a hover behind", () => {
  const seq = ["toggle", "hold-down", "hold-up", "pen-enter", "mouse", "escape", "right-click", "toggle"];
  let s = m.initial();
  for (let i = 0; i < 20; i += 1) s = m.reduce(s, { type: seq[i % seq.length] });
  s = m.reduce(s, { type: "set", mode: "interact" });
  assert.equal(m.capture(s), "none");
  assert.equal(s.grab, null);
});

test("middle-drag.js: dragBounds and clampToAreas", () => {
  const b = { x: 10, y: 10, width: 100, height: 80 };
  assert.deepEqual(g.dragBounds("move", b, 5, -5), { x: 15, y: 5, width: 100, height: 80 });
  assert.deepEqual(g.dragBounds("resize", b, -500, 20), { x: 10, y: 10, width: g.MIN_W, height: 100 });
  assert.deepEqual(g.dragBounds("pan", b, 5, 5), b);
  assert.equal(g.decide({ onItem: false, surface: "board" }), "pan");
  assert.equal(g.decide({ onItem: false, surface: "desktop" }), "pass", "the bare desktop passes the press on");
  assert.equal(g.decide({ onItem: true, locked: true }), "blocked");
  assert.equal(g.decide({ onItem: true, locked: true, ctrl: true }), "duplicate", "locked can be duplicated");
  const area = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const off = g.clampToAreas({ x: 5000, y: -300, width: 300, height: 200 }, area);
  assert.ok(off.x <= 1920 - 48 && off.y >= 0, JSON.stringify(off));
  assert.deepEqual(g.clampToAreas({ x: 100, y: 100, width: 300, height: 200 }, area), { x: 100, y: 100, width: 300, height: 200 });
});

test("ONE middle-button rule: classify (pages) and decide (main) are the same function of the press", () => {
  for (const onItem of [false, true]) for (const shift of [false, true]) for (const ctrl of [false, true]) for (const meta of [false, true]) {
    const ev = { button: 1, shiftKey: shift, ctrlKey: ctrl, metaKey: meta };
    assert.equal(g.classify(ev, onItem), g.decide({ onItem, shift, ctrl, meta, surface: "board" }), JSON.stringify({ onItem, shift, ctrl, meta }));
  }
  assert.equal(g.classify({ button: 0 }, true), null, "only the middle button");
  const fs = require("node:fs");
  const path = require("node:path");
  assert.equal(fs.existsSync(path.join(__dirname, "middle-gesture.cjs")), false, "no second copy of the rule");
  for (const html of ["ink.html", "pin.html"]) {
    assert.match(fs.readFileSync(path.join(__dirname, html), "utf8"), /<script src="middle-drag\.js"><\/script>/, html);
  }
});
