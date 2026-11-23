"use strict";

// card-stay.cjs under `node --test`: the asking card stays open by default, an
// idle timeout is opt-in, and a pinned card docks to the nearest screen corner.

const test = require("node:test");
const assert = require("node:assert/strict");
const stay = require("./card-stay.cjs");

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE = { width: 392, height: 480 };

test("the default card never closes on its own", () => {
  const d = stay.decide(stay.normalizeCard(null));
  assert.equal(d.mode, "open");
  assert.equal(d.closeAfterMs, null, "an idle timeout must be OFF unless the owner sets one");
  assert.equal(d.pinned, false);
});

test("an idle mode clamps its seconds and becomes a millisecond delay", () => {
  assert.equal(stay.normalizeCard({ mode: "idle", idleSeconds: 1 }).idleSeconds, stay.MIN_IDLE_SECONDS);
  assert.equal(stay.normalizeCard({ mode: "idle", idleSeconds: 99999 }).idleSeconds, stay.MAX_IDLE_SECONDS);
  assert.equal(stay.decide({ mode: "idle", idleSeconds: 90 }).closeAfterMs, 90_000);
  assert.equal(stay.decide({ mode: "idle", idleSeconds: "45" }).closeAfterMs, 45_000);
  assert.equal(stay.decide({ mode: "bogus" }).mode, "open", "an unknown mode is not a timeout");
});

test("pinning wins over the idle timeout: a pinned card stays until dismissed", () => {
  const d = stay.decide({ pin: true, mode: "idle", idleSeconds: 30 });
  assert.equal(d.closeAfterMs, null);
  assert.equal(d.pinned, true);
});

test("a card docks to the nearest corner of the work area and its saved shape round-trips", () => {
  const nearBottomLeft = { x: 20, y: 900, width: SIZE.width, height: SIZE.height };
  const corner = stay.dockCorner(AREA, nearBottomLeft);
  assert.equal(corner, "sw");
  const pos = stay.dockPosition(AREA, SIZE, corner);
  assert.equal(pos.x, AREA.x + 14);
  assert.equal(pos.y, AREA.y + AREA.height - SIZE.height - 14);
  const saved = stay.normalizeCard({ pin: true, x: pos.x, y: pos.y, corner });
  assert.deepEqual(saved, { pin: true, mode: "open", idleSeconds: 60, x: pos.x, y: pos.y, corner: "sw", width: 420, height: 188, fit: true });
});

test("the card size is remembered and clamped; fit is on unless turned off", () => {
  const def = stay.normalizeCard(null);
  assert.equal(def.width, stay.DEFAULT_WIDTH);
  assert.equal(def.height, stay.DEFAULT_HEIGHT);
  assert.equal(def.fit, true);
  assert.equal(stay.normalizeCard({ width: 100, height: 5 }).width, stay.MIN_WIDTH);
  assert.equal(stay.normalizeCard({ width: 9999, height: 99999 }).width, stay.MAX_WIDTH);
  assert.equal(stay.normalizeCard({ width: 9999, height: 99999 }).height, stay.MAX_HEIGHT);
  assert.equal(stay.normalizeCard({ fit: false }).fit, false);
  assert.equal(stay.normalizeCard({ width: 640, height: 900, fit: false }).width, 640);
});

test("the display cap is 70% of the work area", () => {
  assert.equal(stay.heightCap({ height: 1000 }), 700);
  assert.equal(stay.heightCap({ height: 200 }), stay.MIN_HEIGHT);
});

test("a bad saved corner or position is forgotten, never trusted", () => {
  const bad = stay.normalizeCard({ corner: "middle", x: "nope", y: NaN });
  assert.equal(bad.corner, null);
  assert.equal(bad.x, null);
  assert.equal(bad.y, null);
});

test("the label says what the setting does", () => {
  assert.equal(stay.label({ mode: "open" }), "Stays open until I close it");
  assert.equal(stay.label({ mode: "idle", idleSeconds: 60 }), "Closes after 60 seconds idle");
  assert.equal(stay.label({ pin: true, mode: "idle" }), "Pinned open");
});
