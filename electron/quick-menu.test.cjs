"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ITEM_IDS, availableItems, layout, positionFor, radialBounds, radialSlices } = require("./quick-menu.cjs");

/** A registry stand-in that knows only the ids listed. */
function registryWith(ids) {
  const map = new Map(ids.map((id) => [id, { id, label: id.toUpperCase(), group: "capture" }]));
  return { byId: (id) => map.get(String(id)) || null };
}

test("Q1 only ids in the registry render -- a missing parallel-lane command is hidden", () => {
  const registry = registryWith(["snip.region", "note.new", "board.new"]);
  const items = availableItems(registry);
  // Toolkit order (Create before Capture): board, note, then snip.
  assert.deepEqual(items.map((i) => i.id), ["board.new", "note.new", "snip.region"]);
  assert.ok(!items.some((i) => i.id === "ink.toggle"), "an absent ink.* must not be a dead cell");
});

test("Q2 items keep ITEM_IDS order and a function label is resolved", () => {
  const registry = {
    byId: (id) => (id === "record.region" ? { id, label: (ctx) => `Record (${ctx.n || 0})`, group: "capture" }
      : id === "snip.region" ? { id, label: "Snip a region", group: "capture" } : null),
  };
  const items = availableItems(registry, { ctx: { n: 2 } });
  assert.deepEqual(items.map((i) => i.id), ["snip.region", "record.region"]);
  // A toolkit row shows its SHORT name and its toolkit group as the caption.
  assert.equal(items[1].label, "Record (MP4)");
  assert.equal(items[1].group, "Capture");
});

test("Q3 an empty registry renders nothing (and the menu refuses to open)", () => {
  assert.deepEqual(availableItems(registryWith([])), []);
  assert.deepEqual(availableItems(null), []);
});

test("Q4 the grid is 3 columns to six cells, 4 above", () => {
  assert.equal(layout(0).columns, 3);
  assert.equal(layout(6).columns, 3);
  assert.equal(layout(7).columns, 4);
  assert.equal(layout(12).columns, 4);
  const three = layout(3);
  const six = layout(6);
  const twelve = layout(12);
  assert.equal(six.width, three.width, "3..6 cells keep the same 3-column width");
  assert.ok(layout(7).width > six.width, "the 4th column widens the grid");
  assert.ok(twelve.height > six.height, "more cells add rows");
  assert.equal(layout(12).height, 10 * 2 + 3 * 78 + 2 * 6);
});

test("Q5 the pop-up anchors at the cursor, flips at the edge, clamps in", () => {
  const work = { x: 0, y: 0, width: 3840, height: 2112 };
  assert.deepEqual(positionFor({ x: 300, y: 200 }, work, { width: 420, height: 260 }),
    { x: 300, y: 200, width: 420, height: 260 });
  // Right edge: flip to the LEFT of the cursor.
  assert.deepEqual(positionFor({ x: 3800, y: 200 }, work, { width: 420, height: 260 }),
    { x: 3380, y: 200, width: 420, height: 260 });
  // Bottom edge: flip ABOVE.
  assert.deepEqual(positionFor({ x: 300, y: 2100 }, work, { width: 420, height: 260 }),
    { x: 300, y: 1840, width: 420, height: 260 });
  // Second monitor at y=2160.
  assert.deepEqual(positionFor({ x: 2000, y: 2200 }, { x: 1920, y: 2160, width: 1920, height: 1032 }, { width: 420, height: 260 }),
    { x: 2000, y: 2200, width: 420, height: 260 });
  // Never off-screen even when the work area is tiny.
  const tiny = positionFor({ x: 5000, y: 5000 }, { x: 0, y: 0, width: 600, height: 400 }, { width: 420, height: 260 });
  assert.ok(tiny.x >= 8 && tiny.y >= 8);
  assert.ok(tiny.x + tiny.width <= 592 && tiny.y + tiny.height <= 392);
});

test("Q6 the item list is the one the owner asked for", () => {
  // Owner 2026-11-13: the local toolkit, ONE short grouped menu (Create / Capture / Send).
  // The whole-screen snip/record and the audio rows moved to the tray and the radial.
  for (const id of ["ink.toggle", "sketch.new", "board.new", "note.new", "scratch.new", "piano.open",
    "snip.region", "record.region", "record.region.gif", "region.box", "present.start", "graphics.open",
    "send.last", "interact.toggle"]) {
    assert.ok(ITEM_IDS.includes(id), `${id} missing from the quick menu`);
  }
  assert.ok(ITEM_IDS.length <= 16, "the menu stays short");
});

test("Q7 the radial hides missing commands, uses Ask's fallback, and re-spreads the ring", () => {
  // No ink.* or audio.* in this build; orb.ask is absent but chat.open exists.
  const registry = registryWith(["snip.region", "record.region", "note.new", "board.new",
    "terminal.open", "files.open", "chat.open"]);
  const slices = radialSlices(registry);
  assert.deepEqual(slices.map((s) => s.id),
    ["snip.region", "record.region", "note.new", "board.new", "chat.open", "terminal.open", "files.open"]);
  assert.equal(slices[0].angle, -90, "slice 0 is at the top");
  assert.equal(slices.length, 7);
  assert.ok(Math.abs(slices[1].angle - (-90 + 360 / 7)) < 1e-9, "angles stay evenly spread after the omission");
  assert.equal(slices[0].index, 0);
  assert.equal(slices[6].index, 6);
});

test("Q8 the radial window is centred on the cursor and clamped at an edge", () => {
  const work = { x: 0, y: 0, width: 1920, height: 1080 };
  const mid = radialBounds({ x: 900, y: 500 }, work, 400);
  assert.equal(mid.center.x, 900);
  assert.equal(mid.center.y, 500);
  assert.equal(mid.width, 400);
  // Near the top-left edge the window clamps, and the CENTRE moves with it -- that
  // is the point the release direction must be measured from.
  const edge = radialBounds({ x: 10, y: 10 }, work, 400);
  assert.equal(edge.x, 8);
  assert.equal(edge.y, 8);
  assert.deepEqual(edge.center, { x: 208, y: 208 });
});
