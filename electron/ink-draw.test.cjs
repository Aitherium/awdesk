"use strict";

// Regression guard for the ink stroke hot path (2026-11-22, owner: "Draw on screen
// lags badly while drawing on a 2880x1652 high-DPI screen").
//
// The bug: every pointermove called drawMarks(), which cleared the WHOLE #ink canvas
// and re-outlined every committed mark plus the whole in-flight stroke. On a high-DPI
// display that is a full-surface repaint per sample. The fix paints the committed
// scene only when the document changes, and the one in-flight mark once per animation
// frame on the effects canvas.
//
// These assertions are the fix stated as invariants: a change that puts the scene
// redraw back on the pointer-move path (or drops coalesced/DPR handling) fails here.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "ink.html"), "utf8");

/** The source text of `function <name>(...) { ... }`, by brace matching. */
function functionBody(name) {
  const head = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = head.exec(SOURCE);
  assert.ok(m, `ink.html declares ${name}()`);
  const open = SOURCE.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(open + 1, i);
    }
  }
  assert.fail(`unbalanced braces after ${name}()`);
}

test("a pointer move never repaints the committed scene", () => {
  const onMove = functionBody("onMove");
  assert.ok(!/\bdrawMarks\s*\(/.test(onMove),
    "onMove must not call drawMarks(): the committed scene is not redrawn per sample");
  assert.ok(/\bscheduleFrame\s*\(/.test(onMove),
    "onMove must hand the paint to the one rAF tick with scheduleFrame()");
});

test("the in-flight mark is painted once per frame on the effects canvas", () => {
  const frame = functionBody("frame");
  assert.ok(/drawOne\(\s*fxCtx\s*,\s*current\s*,/.test(frame),
    "frame() must paint the in-flight mark on fxCtx (not the committed #ink canvas)");
  assert.ok(!/\bdrawMarks\s*\(/.test(frame), "frame() must not repaint the committed scene");
});

test("drawMarks() paints committed marks only", () => {
  const drawMarks = functionBody("drawMarks");
  assert.ok(!/\bcurrent\b/.test(drawMarks),
    "drawMarks() must not reference the in-flight mark; it lives on the effects layer");
  assert.ok(/inkCtx\.clearRect/.test(drawMarks),
    "drawMarks() still clears #ink exactly once per document change");
});

test("the one repaint tick coalesces rAF and idle timers", () => {
  const schedule = functionBody("scheduleFrame");
  const tick = functionBody("frameTick");
  assert.ok(/requestAnimationFrame\s*\(\s*frameTick\s*\)/.test(schedule),
    "scheduleFrame() drives frameTick() from a rAF while drawing");
  assert.ok(/frameHandle\s*!=\s*null/.test(schedule),
    "scheduleFrame() never stacks two pending ticks");
  assert.ok(/scheduleFrame\s*\(/.test(tick),
    "frameTick() reschedules the next tick itself");
});

test("coalesced samples and device-pixel-ratio sizing are preserved", () => {
  assert.ok(/getCoalescedEvents/.test(SOURCE),
    "a high-rate pen's coalesced samples still feed the stroke");
  assert.ok(/devicePixelRatio/.test(SOURCE) && /setTransform\(\s*dpr\s*,/.test(SOURCE),
    "canvases are still sized in device pixels and drawn in CSS pixels");
});
