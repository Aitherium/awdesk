"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const grow = require("./avatar-grow.cjs");

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const FAIRY = { x: 1500, y: 700, width: 96, height: 96 };
const SIZE = { width: 420, height: 640 };

test("the body stands on the fairy's spot: centred on it, feet at its bottom edge", () => {
  const t = grow.targetBounds(FAIRY, SIZE, AREA);
  assert.equal(t.width, 420);
  assert.equal(t.height, 640);
  assert.equal(t.x + t.width / 2, FAIRY.x + FAIRY.width / 2);
  assert.equal(t.y + t.height, FAIRY.y + FAIRY.height);
});

test("the body never leaves the work area", () => {
  const corner = grow.targetBounds({ x: 1880, y: 10, width: 40, height: 40 }, SIZE, AREA);
  assert.ok(corner.x >= AREA.x && corner.x + corner.width <= AREA.x + AREA.width);
  assert.ok(corner.y >= AREA.y && corner.y + corner.height <= AREA.y + AREA.height);
  const big = grow.targetBounds(FAIRY, { width: 5000, height: 5000 }, AREA);
  assert.deepEqual([big.width, big.height], [AREA.width, AREA.height], "never bigger than the area");
});

test("no fairy on screen: the body takes the bottom-right corner it always stood in", () => {
  const t = grow.targetBounds(null, SIZE, AREA, { margin: 24 });
  assert.equal(t.x, AREA.width - SIZE.width - 24);
  assert.equal(t.y, AREA.height - SIZE.height - 24);
});

test("the grow starts small on the fairy and ends exactly on the body at full opacity", () => {
  const to = grow.targetBounds(FAIRY, SIZE, AREA);
  const frames = grow.growFrames(FAIRY, to);
  assert.equal(frames.length, grow.FRAMES);
  const first = frames[0];
  assert.ok(first.bounds.width < to.width / 2, "the first frame is small");
  assert.ok(first.opacity < 0.6, "and faint");
  assert.deepEqual(frames[frames.length - 1], { bounds: to, opacity: 1 });
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(frames[i].bounds.width >= frames[i - 1].bounds.width, "it only grows");
    assert.ok(frames[i].opacity >= frames[i - 1].opacity, "it only brightens");
  }
});

test("the shrink walks back to the fairy and ends fully clear", () => {
  const body = grow.targetBounds(FAIRY, SIZE, AREA);
  const frames = grow.shrinkFrames(body, FAIRY);
  assert.equal(frames.length, grow.FRAMES);
  assert.ok(frames[0].bounds.width <= body.width, "it never grows on the way out");
  for (let i = 1; i < frames.length; i += 1) assert.ok(frames[i].bounds.width <= frames[i - 1].bounds.width, "it only shrinks");
  const last = frames[frames.length - 1];
  assert.equal(last.opacity, 0);
  assert.ok(last.bounds.width < body.width / 2);
  const cx = last.bounds.x + last.bounds.width / 2;
  assert.ok(Math.abs(cx - (FAIRY.x + FAIRY.width / 2)) <= 2, "it ends on the fairy");
});

test("garbage in is not a crash", () => {
  assert.doesNotThrow(() => grow.growFrames(null, null));
  assert.doesNotThrow(() => grow.targetBounds({ x: "nope" }, null, null));
  assert.equal(grow.growFrames(null, { x: 0, y: 0, width: 10, height: 10 }, { frames: 0 }).length, 1);
});
