"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const free = require("./free-space.cjs");
const attention = require("./fairy-attention.cjs");

const ORB = { width: 72, height: 72 };

test("the probe is one self-contained script that returns visible clickable rects", () => {
  const src = free.probeSource();
  assert.match(src, /querySelectorAll/);
  for (const needle of ["button", "role=tab", "a[href]", "input"]) assert.ok(src.includes(needle), `${needle} is not probed`);
  assert.match(src, /pointerEvents === "none"/, "a click-through element is not an obstacle");
  new Function(`return ${src};`); // it parses
});

test("page rects become screen rects (offset by the content box, scaled by zoom), and bad rows are dropped", () => {
  const rows = [[10, 20, 100, 30], [0, 0, 0, 5], ["x", 1, 2, 3], [5, 5]];
  assert.deepEqual(free.toScreenRects(rows, { x: 200, y: 100 }, 1), [{ x: 210, y: 120, width: 100, height: 30 }]);
  assert.deepEqual(free.toScreenRects([[10, 20, 100, 30]], { x: 0, y: 0 }, 1.5), [{ x: 15, y: 30, width: 150, height: 45 }]);
  assert.deepEqual(free.toScreenRects(null, {}, 1), []);
});

// The 2026-11-16 screenshot: a header row of tabs, the fairy parked on "Review".
const WINDOW = { x: 0, y: 0, width: 1850, height: 1300 };
const TABS = [
  { x: 1230, y: 94, width: 120, height: 58 }, // Review
  { x: 1360, y: 94, width: 100, height: 58 }, // Audit
  { x: 580, y: 94, width: 160, height: 58 },  // Dashboard
];

test("the fairy standing on a tab is NOT free; the spot it takes covers nothing", () => {
  const onReview = { x: 1260, y: 100 };
  assert.ok(free.coverage(onReview, ORB, TABS, 8) > 0, "the screenshot's spot covers the Review tab");
  const spots = free.dockCandidates(WINDOW, ORB, { first: onReview });
  const pick = free.pickFree(spots, ORB, TABS, { pad: 8, area: WINDOW });
  assert.equal(pick.free, true);
  assert.equal(free.coverage(pick, ORB, TABS, 8), 0);
  assert.notDeepEqual([pick.x, pick.y], [onReview.x, onReview.y]);
});

test("dock candidates sit inside the window, above its bottom bar, bottom-right first", () => {
  const spots = free.dockCandidates(WINDOW, ORB);
  assert.deepEqual(spots[0], { x: 1850 - 72 - 18, y: 1300 - 64 - 72 - 18 });
  for (const s of spots) {
    assert.ok(s.x >= WINDOW.x && s.x + ORB.width <= WINDOW.x + WINDOW.width, `x out of the window: ${JSON.stringify(s)}`);
    assert.ok(s.y >= WINDOW.y && s.y + ORB.height <= WINDOW.y + WINDOW.height - 64, `y outside the body: ${JSON.stringify(s)}`);
  }
});

test("when every spot is covered, the one that covers LEAST wins (a tie keeps the preferred one)", () => {
  const wall = [{ x: 0, y: 0, width: 5000, height: 5000 }];
  const a = { x: 100, y: 100 };
  const b = { x: 4990, y: 4990 }; // mostly off the wall
  const pick = free.pickFree([a, b], ORB, wall, { pad: 0 });
  assert.equal(pick.free, false);
  assert.deepEqual([pick.x, pick.y], [4990, 4990]);
  const tie = free.pickFree([a, { x: 300, y: 300 }], ORB, wall, { pad: 0 });
  assert.deepEqual([tie.x, tie.y], [100, 100]);
  assert.equal(free.pickFree([], ORB, wall), null);
});

test("a window we cannot read: its title bar and tab strip are one obstacle, so the fairy stays low", () => {
  const chrome = free.chromeObstacle({ x: 0, y: 0, width: 1000, height: 800 });
  assert.deepEqual(chrome, { x: 0, y: 0, width: 1000, height: 56 });
  const topRight = { x: 1000 - 72 - 14, y: 14 }; // spirit-core's old corner: on the close button
  assert.ok(free.coverage(topRight, ORB, [chrome], 8) > 0);
  const pick = free.pickFree(free.dockCandidates({ x: 0, y: 0, width: 1000, height: 800 }, ORB, { first: topRight }), ORB, [chrome], { pad: 8 });
  assert.equal(pick.free, true);
  assert.ok(pick.y > 56, `the fairy docked at y=${pick.y}, still in the chrome`);
});

test("nudgePlacement keeps the flutter and its whisper off clickable elements, and is unchanged with none", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const cursor = { x: 960, y: 540 };
  const WHISPER = { width: 340, height: 130 };
  const plain = attention.nudgePlacement(cursor, area, ORB, WHISPER);
  assert.deepEqual(attention.nudgePlacement(cursor, area, ORB, WHISPER, { obstacles: [] }), plain, "no obstacles: byte-for-byte the old answer");
  // A toolbar exactly where the first candidate lands.
  const wall = [{ x: plain.orb.x - 60, y: plain.orb.y - 60, width: 520, height: 140 }];
  const moved = attention.nudgePlacement(cursor, area, ORB, WHISPER, { obstacles: wall });
  assert.notDeepEqual(moved.orb, plain.orb);
  const box = {
    x: Math.min(moved.orb.x - ORB.width / 2, moved.whisper.x),
    y: Math.min(moved.orb.y - ORB.height / 2, moved.whisper.y),
    width: ORB.width + WHISPER.width + 4,
    height: Math.max(ORB.height, WHISPER.height),
  };
  assert.equal(free.overlapArea(box, wall[0]), 0, "the moved flutter+whisper box still touches the toolbar");
});
