"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./ink-core.cjs");

const A = { x: 10, y: 10 };
const B = { x: 110, y: 60 };

function stroke(overrides = {}) {
  return core.normalizeItem({
    id: "s1", type: "stroke", tool: "pen", color: "#ff4d4d", width: 4, createdAt: 1000,
    points: [{ x: 0, y: 0, p: 0.5 }, { x: 100, y: 0, p: 0.5 }],
    ...overrides,
  });
}

test("rectFrom normalises a drag in any direction", () => {
  assert.deepEqual(core.rectFrom({ x: 30, y: 40 }, { x: 10, y: 5 }), { x: 10, y: 5, width: 20, height: 35 });
  assert.deepEqual(core.rectFrom(A, B), { x: 10, y: 10, width: 100, height: 50 });
});

test("distanceToSegment measures the perpendicular and clamps past the ends", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  assert.equal(core.distanceToSegment({ x: 50, y: 7 }, a, b), 7);
  assert.equal(core.distanceToSegment({ x: -10, y: 0 }, a, b), 10);
  assert.equal(core.distanceToSegment({ x: 110, y: 10 }, a, b), Math.hypot(10, 10));
});

test("arrowHead puts two barbs behind the tip, symmetric about the shaft", () => {
  const [left, right] = core.arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
  assert.ok(Math.abs(left.x - right.x) < 1e-9);
  assert.ok(left.x < 100 && right.x < 100, "barbs sit behind the tip");
  assert.ok(left.y < 0 && right.y > 0, "one barb each side");
  assert.ok(Math.abs(Math.hypot(left.x - 100, left.y) - 10) < 1e-6);
});

test("normalizeItem rejects nothing drawable and clamps what it keeps", () => {
  assert.equal(core.normalizeItem(null), null);
  assert.equal(core.normalizeItem({ id: "x", type: "stroke", points: [] }), null);
  assert.equal(core.normalizeItem({ id: "x", type: "shape", tool: "line", a: A }), null);
  assert.equal(core.normalizeItem({ id: "x", type: "text", text: "   ", at: A }), null);
  const wide = core.normalizeItem({ id: "x", type: "stroke", width: 900, color: "#bad",
    points: [{ x: 1, y: 2, p: 9 }] });
  assert.equal(wide.width, 24, "width is clamped to the slider's range");
  assert.equal(wide.color, core.COLORS[0], "an unknown swatch falls back, never paints #bad");
  assert.equal(wide.points[0].p, 1, "pressure is clamped into 0..1");
  const dup = core.normalizeItem({ id: "x", type: "stroke", points: [{ x: 1, y: 2 }] });
  assert.equal(dup.tool, "pen");
});

test("normalizeItem caps a runaway stroke at MAX_POINTS", () => {
  const points = Array.from({ length: core.MAX_POINTS + 500 }, (_, i) => ({ x: i, y: i }));
  const item = core.normalizeItem({ id: "long", type: "stroke", points });
  assert.equal(item.points.length, core.MAX_POINTS);
});

test("hitTest sees a stroke, a rect's border, an ellipse's ring and a text box", () => {
  const line = stroke();
  assert.equal(core.hitTest(line, { x: 50, y: 2 }, 2), true);
  assert.equal(core.hitTest(line, { x: 50, y: 40 }, 2), false);

  const rect = core.normalizeItem({ id: "r", type: "shape", tool: "rect", width: 2, a: { x: 0, y: 0 }, b: { x: 100, y: 100 } });
  assert.equal(core.hitTest(rect, { x: 50, y: 1 }, 2), true, "the border is a hit");
  assert.equal(core.hitTest(rect, { x: 50, y: 50 }, 2), false, "the middle is not");

  const ellipse = core.normalizeItem({ id: "e", type: "shape", tool: "ellipse", width: 2, a: { x: 0, y: 0 }, b: { x: 100, y: 100 } });
  assert.equal(core.hitTest(ellipse, { x: 50, y: 2 }, 4), true, "top of the ring");
  assert.equal(core.hitTest(ellipse, { x: 50, y: 50 }, 4), false, "centre is hollow");

  const text = core.normalizeItem({ id: "t", type: "text", text: "hello", size: 20, at: { x: 5, y: 25 } });
  assert.equal(core.hitTest(text, { x: 20, y: 20 }, 2), true);
  assert.equal(core.hitTest(text, { x: 20, y: 200 }, 2), false);
});

test("push, undo and redo walk one mark backwards and forwards", () => {
  let s = core.normalizeState();
  const item = stroke();
  s = core.pushItem(s, item);
  assert.equal(s.items.length, 1);
  s = core.undo(s);
  assert.equal(s.items.length, 0);
  assert.equal(s.redo.length, 1);
  s = core.redo(s);
  assert.equal(s.items.length, 1);
  assert.equal(s.undo.length, 1);
  assert.deepEqual(core.undo(core.normalizeState()), core.normalizeState(), "undo on empty is a no-op state");
  assert.deepEqual(core.redo(core.normalizeState()).items, []);
});

test("a new mark clears the redo branch (no time travel into a binned future)", () => {
  let s = core.pushItem(core.normalizeState(), stroke());
  s = core.pushItem(s, stroke({ id: "s2" }));
  s = core.undo(s);
  assert.equal(s.redo.length, 1);
  s = core.pushItem(s, stroke({ id: "s3" }));
  assert.equal(s.redo.length, 0);
});

test("eraseAt removes every mark the brush touches in ONE undo step", () => {
  const a = core.pushItem(core.normalizeState(), stroke({ id: "a" }));
  const b = core.pushItem(a, stroke({ id: "b" }));
  const { state, removed } = core.eraseAt(b, { x: 50, y: 0 }, 6);
  assert.deepEqual(removed.sort(), ["a", "b"]);
  assert.equal(state.items.length, 0);
  const back = core.undo(state);
  assert.equal(back.items.length, 2, "one undo restores the whole erased set");
});

test("clearAll is undoable and does not add an empty step", () => {
  let s = core.pushItem(core.normalizeState(), stroke());
  s = core.clearAll(s);
  assert.equal(s.items.length, 0);
  assert.equal(core.clearAll(s).undo.length, s.undo.length, "clearing nothing adds no undo step");
  s = core.undo(s);
  assert.equal(s.items.length, 1);
});

test("fadeAlpha counts down to 0 and pruneByAge drops the expired", () => {
  const item = stroke({ createdAt: 1000 });
  assert.equal(core.fadeAlpha(item, 1000, 5000), 1);
  assert.ok(Math.abs(core.fadeAlpha(item, 3500, 5000) - 0.5) < 1e-9);
  assert.equal(core.fadeAlpha(item, 6000, 5000), 0);
  assert.equal(core.fadeAlpha(item, 999999, 0), 1, "fade off keeps a mark forever");
  const s = core.pushItem(core.normalizeState(), item);
  assert.deepEqual(core.pruneByAge(s, 6500, 5000).removed, ["s1"]);
  assert.deepEqual(core.pruneByAge(s, 6500, 0).removed, []);
});

test("laserTrail keeps the newest live points and forgets old ones", () => {
  const pts = [
    { x: 0, y: 0, t: 100 },
    { x: 1, y: 1, t: 900 },
    { x: 2, y: 2, t: 1500 },
  ];
  assert.deepEqual(core.laserTrail(pts, 1600, 900).map((p) => p.x), [1, 2]);
  const many = Array.from({ length: 200 }, (_, i) => ({ x: i, y: 0, t: 1000 }));
  assert.equal(core.laserTrail(many, 1000, 900, 120).length, 120);
});

test("marksLine says 1 mark, 3 marks", () => {
  assert.equal(core.marksLine(1, "pen"), "1 mark · pen");
  assert.equal(core.marksLine(3, "arrow"), "3 marks · arrow");
});

test("the fade clock is the epoch clock the marks are stamped with (not performance.now)", () => {
  // Regression: ink.html used to call fadeAlpha/pruneByAge with performance.now()
  // while normalizeItem stamps createdAt with Date.now(). The age was hugely
  // negative, fadeAlpha stayed 1 and nothing was ever pruned.
  const t = core.now();
  assert.ok(t > 1e12, "now() is epoch milliseconds; performance.now() is page-relative");
  assert.ok(Math.abs(t - Date.now()) < 1000);
  const item = core.normalizeItem({ id: "fresh", type: "stroke", points: [{ x: 0, y: 0 }] });
  assert.ok(Math.abs(item.createdAt - t) < 1000, "a mark is stamped on the same clock");
  assert.equal(core.fadeAlpha(item, item.createdAt + 5000, 5000), 0, "a 5 s mark is dead at 5 s");
  const state = { items: [item], undo: [], redo: [] };
  assert.deepEqual(core.pruneByAge(state, item.createdAt + 5000, 5000).removed, ["fresh"]);
  assert.equal(core.fadeAlpha(item, item.createdAt + 1000, 5000), 0.8);
});

test("the overlay fades on core.now(); performance.now() stays in laser/ripples", () => {
  const html = fs.readFileSync(path.join(__dirname, "ink.html"), "utf8");
  assert.match(html, /function drawMarks\(now = core\.now\(\)\)/,
    "drawMarks defaults to the epoch clock");
  const clock = html.slice(html.indexOf("function startFadeClock"));
  assert.match(clock, /const now = core\.now\(\);/, "the fade interval reads the epoch clock");
  assert.ok(!/fadeAlpha\([^)]*performance\.now/.test(html),
    "no fade call is given performance.now()");
});

// ── smooth ink (2026-11-07) ──────────────────────────────────────────────────

const boardsCore = require("./boards-core.cjs");

function zigzag(n = 40, amp = 6) {
  const pts = [];
  for (let i = 0; i < n; i += 1) pts.push({ x: i * 4, y: (i % 2 ? amp : -amp), p: 0.5 });
  return pts;
}

test("streamline absorbs jitter and keeps both ends where the pen was", () => {
  const raw = zigzag();
  const smooth = core.streamline(raw, 0.5);
  assert.equal(smooth.length, raw.length);
  assert.deepEqual([smooth[0].x, smooth[0].y], [raw[0].x, raw[0].y], "start is the pen-down point");
  const last = smooth[smooth.length - 1];
  assert.deepEqual([last.x, last.y], [raw[raw.length - 1].x, raw[raw.length - 1].y], "end is the pen-up point");
  const spread = (pts) => Math.max(...pts.slice(5, -5).map((p) => Math.abs(p.y)));
  assert.ok(spread(smooth) < spread(raw) * 0.6, `jitter shrank (${spread(smooth)} vs ${spread(raw)})`);
  assert.deepEqual(core.streamline(raw, 0).map((p) => p.y), raw.map((p) => p.y), "amount 0 is the raw line");
});

test("strokeOutline: a closed polygon, wider where a real pen pressed harder", () => {
  const light = [0, 1, 2, 3, 4, 5].map((i) => ({ x: i * 20, y: 0, p: 0.1 + i * 0.001 }));
  const heavy = light.map((p) => ({ ...p, p: 0.95 + p.x * 1e-5 }));
  const width = (outline) => Math.max(...outline.map((p) => p.y)) - Math.min(...outline.map((p) => p.y));
  const a = core.strokeOutline(light, { size: 10, thinning: 0.7, smoothing: 0 });
  const b = core.strokeOutline(heavy, { size: 10, thinning: 0.7, smoothing: 0 });
  assert.ok(a.length > 2 * light.length, "both sides plus two caps");
  assert.ok(width(b) > width(a) * 1.5, `pressure widens the line (${width(b)} vs ${width(a)})`);
  for (const p of [...a, ...b]) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test("a mouse stroke (flat pressure) tapers by speed: a fast flick is thinner than a slow drag", () => {
  const slow = Array.from({ length: 30 }, (_, i) => ({ x: i * 2, y: 0, p: 0.5 }));
  const fast = Array.from({ length: 30 }, (_, i) => ({ x: i * 40, y: 0, p: 0.5 }));
  const mean = (r) => r.reduce((s, n) => s + n, 0) / r.length;
  const rs = core.strokeRadii(slow, { size: 10 });
  const rf = core.strokeRadii(fast, { size: 10 });
  assert.ok(mean(rf) < mean(rs), `fast ${mean(rf)} < slow ${mean(rs)}`);
});

test("strokeOutline survives degenerate input: none, one point, a stack of duplicates", () => {
  assert.deepEqual(core.strokeOutline([]), []);
  const dot = core.strokeOutline([{ x: 5, y: 5, p: 0.5 }], { size: 8 });
  assert.equal(dot.length, 12, "one point is a dot");
  const dupes = core.strokeOutline([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], { size: 8 });
  assert.equal(dupes.length, 12, "duplicates collapse to the dot, no NaN");
  for (const p of dupes) assert.ok(Number.isFinite(p.x));
});

test("outlinePath traces the polygon with quadratics and closes it", () => {
  const cmds = core.outlinePath(core.strokeOutline(zigzag(10), { size: 6 }));
  assert.equal(cmds[0].op, "M");
  assert.equal(cmds[cmds.length - 1].op, "Z");
  assert.ok(cmds.slice(1, -1).every((c) => c.op === "Q"));
  assert.deepEqual(core.outlinePath([{ x: 0, y: 0 }]), [], "fewer than 3 vertices is no path");
});

test("inkToBoardItems: every mark becomes a board item boards-core keeps, origin moved to the pad", () => {
  const items = [
    core.normalizeItem({ id: "s", type: "stroke", color: "#ff4d4d", width: 5,
      points: [{ x: 500, y: 300 }, { x: 520, y: 310 }, { x: 560, y: 330 }] }),
    core.normalizeItem({ id: "a", type: "shape", tool: "arrow", color: "#ffd166", width: 2,
      a: { x: 700, y: 500 }, b: { x: 600, y: 400 } }),
    core.normalizeItem({ id: "r", type: "shape", tool: "rect", color: "#4ade80", width: 2,
      a: { x: 650, y: 450 }, b: { x: 550, y: 350 } }),
    core.normalizeItem({ id: "t", type: "text", text: "look here", color: "#ffffff", at: { x: 560, y: 520 } }),
  ];
  const { items: out, size } = core.inkToBoardItems(items, { pad: 24 });
  // stroke + arrow shaft + 2 barbs + rect + text
  assert.equal(out.length, 6);
  const board = boardsCore.normalizeBoard({ id: "b1", kind: "board", items: out });
  assert.equal(board.items.length, 6, "boards-core keeps every converted item");
  const box = core.boundsOf(items);
  assert.equal(size.width, Math.ceil(box.width + 48));
  const minX = Math.min(...out.flatMap((i) => (i.points ? i.points.map((p) => p.x) : [i.x])));
  assert.ok(minX >= 24 && minX <= 24 + 5, `top-left sits at the pad plus half a stroke width (${minX})`);
  // The arrow points up-left; a 2-point stroke keeps that direction.
  const shaft = out.find((i) => i.type === "stroke" && i.points.length === 2);
  assert.ok(shaft.points[1].x < shaft.points[0].x && shaft.points[1].y < shaft.points[0].y);
  assert.equal(out.find((i) => i.type === "text").color, "#1f2430", "white ink turns dark on a white board");
  assert.deepEqual(core.inkToBoardItems([]).items, []);
});
