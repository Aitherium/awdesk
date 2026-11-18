"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const panes = require("./browser-panes.cjs");

const area = { x: 100, y: 50, width: 1200, height: 800 };

test("two panes split the page area down the middle, one divider between them", () => {
  const geo = panes.layoutPanes(area, panes.defaultSizes(2));
  assert.equal(geo.axis, "horizontal");
  assert.equal(geo.panes.length, 2);
  assert.equal(geo.dividers.length, 1);
  const [a, b] = geo.panes;
  assert.equal(a.x, 100);
  assert.equal(a.y, 50);
  assert.equal(a.height, 800);
  assert.equal(b.y, 50);
  assert.equal(b.height, 800);
  // The two panes and the divider fill the area exactly.
  assert.equal(a.width + panes.DIVIDER + b.width, 1200);
  assert.equal(b.x, a.x + a.width + panes.DIVIDER);
  assert.deepEqual(geo.dividers[0], { index: 0, x: a.x + a.width, y: 50, width: panes.DIVIDER, height: 800 });
});

test("three panes: two dividers, every pane at least the minimum width, the row fills the area", () => {
  const geo = panes.layoutPanes(area, panes.defaultSizes(3));
  assert.equal(geo.panes.length, 3);
  assert.equal(geo.dividers.length, 2);
  assert.equal(geo.dividers[0].index, 0);
  assert.equal(geo.dividers[1].index, 1);
  assert.equal(geo.panes[1].x, geo.panes[0].x + geo.panes[0].width + panes.DIVIDER);
  assert.equal(geo.panes[2].x, geo.panes[1].x + geo.panes[1].width + panes.DIVIDER);
  const end = geo.panes[2].x + geo.panes[2].width;
  assert.equal(end, area.x + area.width, "the row ends exactly at the page area's right edge");
  for (const pane of geo.panes) assert.ok(pane.width >= panes.PANE_MIN, `pane ${pane.width} keeps its floor`);
});

test("sizes are honoured as fractions of the whole page area, and rounding never leaves a stray pixel", () => {
  const geo = panes.layoutPanes(area, [0.25, 0.75]);
  const [a, b] = geo.panes;
  const room = area.width - panes.DIVIDER;
  assert.ok(Math.abs(a.width - room / 4) <= 1, `a quarter is ${a.width}`);
  assert.ok(Math.abs(b.width - (room * 3) / 4) <= 1);
  assert.equal(a.width + b.width + panes.DIVIDER, 1200);
});

test("fractions survive a pixels round trip: a resize does not make the panes drift", () => {
  const room = area.width - panes.DIVIDER;
  const sizes = [0.2, 0.3, 0.5];
  const widths = panes.fitSpan(room, sizes);
  const again = panes.fitSpan(room, widths.map((w) => w / room));
  assert.deepEqual(again, widths);
});

test("a page area too narrow for every floor splits the room equally instead of vanishing", () => {
  const geo = panes.layoutPanes({ x: 0, y: 0, width: 300, height: 400 }, panes.defaultSizes(3));
  for (const pane of geo.panes) assert.ok(pane.width > 0);
  const total = geo.panes.reduce((sum, p) => sum + p.width, 0);
  assert.equal(total, 300 - panes.DIVIDER * 2);
});

test("a vertical split stacks the panes and the divider runs across", () => {
  const geo = panes.layoutPanes(area, panes.defaultSizes(2), "vertical");
  assert.equal(geo.axis, "vertical");
  const [a, b] = geo.panes;
  assert.equal(a.width, 1200);
  assert.equal(b.y, a.y + a.height + panes.DIVIDER);
  assert.equal(a.height + panes.DIVIDER + b.height, 800);
  assert.deepEqual(geo.dividers[0], { index: 0, x: 100, y: a.y + a.height, width: 1200, height: panes.DIVIDER });
});

test("no panes at all is an empty layout, not a crash", () => {
  assert.deepEqual(panes.layoutPanes(area, []), { axis: "horizontal", panes: [], dividers: [] });
  assert.deepEqual(panes.layoutPanes(area, null), { axis: "horizontal", panes: [], dividers: [] });
  assert.equal(panes.layoutPanes(area, [1]).panes.length, 1, "one fraction is one pane, not none");
});

test("one pane is the whole page area (the unsplit window)", () => {
  const geo = panes.layoutPanes(area, [1]);
  assert.deepEqual(geo.panes, [{ x: 100, y: 50, width: 1200, height: 800 }]);
  assert.deepEqual(geo.dividers, []);
});

test("normalizeSizes refuses garbage: negatives, zeroes and NaN become shares that sum to 1", () => {
  assert.deepEqual(panes.normalizeSizes([0, -5, NaN], 3), [1 / 3, 1 / 3, 1 / 3]);
  const sized = panes.normalizeSizes([2, 2], 2);
  assert.equal(sized.reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(sized, [0.5, 0.5]);
  // A short array gets the average share for the panes it did not describe.
  const filled = panes.normalizeSizes([3], 2);
  assert.equal(filled.length, 2);
  assert.equal(filled.reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(panes.normalizeSizes([], 0), []);
});

test("dragging a divider resizes its two neighbours and leaves the others alone", () => {
  const before = panes.defaultSizes(3);
  const next = panes.resize(before, 0, 120, area);
  assert.ok(next, "the drag moves");
  assert.equal(next.length, 3);
  assert.ok(next[0] > before[0], "the left pane grew");
  assert.ok(next[1] < before[1], "its neighbour shrank");
  assert.ok(Math.abs(next[2] - before[2]) < 1e-9, "the third pane is untouched");
  assert.equal(next.reduce((a, b) => a + b, 0), 1, "subtle floating point is not allowed to drift the sum");
});

test("a divider cannot be dragged through a pane's minimum width", () => {
  const geo = panes.layoutPanes(area, [1, 1]);
  const pair = geo.panes[0].width + geo.panes[1].width;
  // Drag far past the right pane's floor: both panes keep at least PANE_MIN.
  const wide = panes.resize([0.5, 0.5], 0, pair, area);
  assert.ok(wide, "a legal resize");
  const widths = panes.layoutPanes(area, wide).panes.map((p) => p.width);
  assert.ok(widths[0] >= panes.PANE_MIN, `left ${widths[0]}`);
  assert.ok(widths[1] >= panes.PANE_MIN, `right ${widths[1]}`);
  // A drag that would push below the floor sticks at it.
  const stuck = panes.resize([0.5, 0.5], 0, pair * 2, area);
  const stuckWidths = panes.layoutPanes(area, stuck).panes.map((p) => p.width);
  assert.ok(stuckWidths[1] >= panes.PANE_MIN - 1);
  // And nothing moved to begin with is refused, not returned.
  assert.equal(panes.resize([0.5, 0.5], 0, 0, area), null);
  assert.equal(panes.resize([0.5, 0.5], 5, 10, area), null, "no such divider");
});

test("insertPane and removePane keep the shares summing to one", () => {
  const two = panes.defaultSizes(2);
  const three = panes.insertPane(two, 1);
  assert.equal(three.length, 3);
  assert.equal(three.reduce((a, b) => a + b, 0), 1);
  assert.ok(three[1] > 0);
  const back = panes.removePane(three, 1);
  assert.equal(back.length, 2);
  assert.equal(back.reduce((a, b) => a + b, 0), 1);
});

test("the session rebuilds a split from saved pane indexes, and one pane is no split", () => {
  const stage = panes.stageFromSession([
    { id: 9, pane: { group: 1, index: 1 } },
    { id: 4, pane: { group: 1, index: 0 } },
    { id: 7 },
  ]);
  assert.deepEqual(stage.tabs, [4, 9], "pane order, not strip order");
  assert.deepEqual(stage.sizes, [0.5, 0.5]);
  assert.equal(stage.focus, 0);
  assert.equal(panes.stageFromSession([{ id: 4, pane: { group: 1, index: 0 } }]), null);
  assert.equal(panes.stageFromSession([]), null);
  assert.equal(panes.stageFromSession(null), null);
});

test("closing a pane the owner was not in never moves the focus off their pane", () => {
  // Focused on the left pane, a pane to its right closes: they stay on the left.
  assert.equal(panes.focusAfterRemove(0, 1, 2), 0);
  assert.equal(panes.focusAfterRemove(0, 2, 2), 0);
  // A pane to the LEFT closes: the same tab is now one slot further left.
  assert.equal(panes.focusAfterRemove(1, 0, 2), 0);
  assert.equal(panes.focusAfterRemove(2, 0, 2), 1);
  // The focused pane itself closes: the next pane slides into its slot, or the last.
  assert.equal(panes.focusAfterRemove(0, 0, 2), 0);
  assert.equal(panes.focusAfterRemove(1, 1, 2), 1);
  assert.equal(panes.focusAfterRemove(2, 2, 2), 1);
  // Nothing left, or garbage in, is index 0 -- never NaN, never out of range.
  assert.equal(panes.focusAfterRemove(1, 1, 0), 0);
  assert.equal(panes.focusAfterRemove(NaN, 0, 2), 0);
  assert.equal(panes.focusAfterRemove(2, 9, 2), 1);
});

test("fitSpan always fills the span exactly, whatever the fractions", () => {
  for (const sizes of [[0.1, 0.2, 0.7], [1, 1, 1], [0.333, 0.333, 0.334], [0.99, 0.01]]) {
    for (const span of [100, 333, 733, 1919]) {
      const widths = panes.fitSpan(span, sizes);
      assert.equal(widths.reduce((a, b) => a + b, 0), span, `span ${span}`);
    }
  }
});
