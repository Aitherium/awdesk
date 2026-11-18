"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dockIn = require("./dock-in-model.cjs");

test("move to split: the terminal pane, attached to that session, marked as a pane", () => {
  assert.equal(dockIn.moveToSplitUrl("abc-123_X"), "aither://terminal/?attach=abc-123_X&split=1");
  assert.equal(dockIn.moveToSplitUrl("bad id!"), null);
  assert.equal(dockIn.moveToSplitUrl(""), null);
  assert.equal(dockIn.moveToSplitUrl("x".repeat(81)), null);
  // A files pane gets the flag too, once only.
  assert.equal(dockIn.asSplitUrl("aither://files/?root=C%3A%5Cx"), "aither://files/?root=C%3A%5Cx&split=1");
  assert.equal(dockIn.asSplitUrl("aither://files/?root=x&split=1"), "aither://files/?root=x&split=1");
  assert.equal(dockIn.asSplitUrl("https://example.com"), null);
});

test("picker rows: session kind decides the action (attach vs resume)", () => {
  const rows = dockIn.pickerRows({
    sessions: [
      { id: "s2", harness: "claude", label: "Claude Code", state: "ready", createdAt: 20 },
      { id: "s1", harness: "terminal", label: "Shell", state: "ready", createdAt: 10 },
      { id: "gone", harness: "terminal", label: "Ended", state: "exited", createdAt: 5 },
    ],
    external: [
      { id: "w1", label: "wt-project", cwd: "C:\\work", lastActivityAt: 100 },
      { id: "s1", label: "already daemon", lastActivityAt: 50 },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.action, r.id]),
    [["daemon", "attach", "s1"], ["daemon", "attach", "s2"], ["external", "resume", "w1"]]);
  assert.equal(rows[2].detail, dockIn.RESUME_DETAIL);
  assert.match(rows[2].detail, /keeps running/);
  assert.equal(rows[2].raise, true);
  assert.equal(dockIn.actionFor(rows[0]), "attach");
  assert.equal(dockIn.actionFor(rows[2]), "resume");
  assert.equal(dockIn.actionFor({ kind: "daemon", action: "attach", id: "bad id" }), null);
  // Bounded: the WT list is cut, never unbounded.
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, lastActivityAt: i }));
  assert.equal(dockIn.pickerRows({ external: many }, 3).length, 3);
  assert.deepEqual(dockIn.pickerRows({}).length, 0);
});

test("drop routing: a folder opens itself; a file opens its folder, selected", () => {
  assert.deepEqual(dockIn.dropRouting([{ path: "C:\\work\\site", dir: true }]),
    { kind: "files", root: "C:\\work\\site", select: null });
  // A folder wins over a file in the same drop.
  assert.deepEqual(dockIn.dropRouting([{ path: "C:\\a.txt", dir: false }, { path: "C:\\work", dir: true }]),
    { kind: "files", root: "C:\\work", select: null });
  assert.deepEqual(dockIn.dropRouting([{ path: "C:\\work\\a.txt", dir: false }]),
    { kind: "files", root: "C:\\work", select: "a.txt" });
  // POSIX separators work too (tests on a Linux CI).
  assert.deepEqual(dockIn.dropRouting([{ path: "/tmp/work/a.txt", dir: false }]),
    { kind: "files", root: "/tmp/work", select: "a.txt" });
  // A trailing separator on a folder path is not part of the name.
  assert.deepEqual(dockIn.dropRouting([{ path: "C:\\work\\site\\", dir: true }]),
    { kind: "files", root: "C:\\work\\site", select: null });
});

test("drop routing: text, a URL or nothing is refused without pretending", () => {
  for (const dropped of [[], null, [{}], [{ path: "  " }]]) {
    const out = dockIn.dropRouting(dropped);
    assert.equal(out.kind, "refuse");
    assert.ok(out.reason);
  }
});

test("split rects: side-by-side and stacked, with a divider and a sane clamp", () => {
  const b = { x: 10, y: 20, width: 804, height: 600 };
  const side = dockIn.splitRects(b, { axis: "vertical", ratio: 0.5 });
  assert.deepEqual(side.primary, { x: 10, y: 20, width: 400, height: 600 });
  assert.deepEqual(side.secondary, { x: 414, y: 20, width: 400, height: 600 });
  assert.equal(side.primary.width + side.secondary.width + dockIn.SPLIT_GAP, b.width);
  const stacked = dockIn.splitRects(b, { axis: "horizontal", ratio: 0.25 });
  assert.deepEqual(stacked.primary, { x: 10, y: 20, width: 804, height: 149 });
  assert.deepEqual(stacked.secondary, { x: 10, y: 173, width: 804, height: 447 });
  // Clamped: a pane never collapses to a sliver.
  assert.equal(dockIn.clampRatio(0.01), dockIn.SPLIT_MIN_RATIO);
  assert.equal(dockIn.clampRatio(0.99), dockIn.SPLIT_MAX_RATIO);
  assert.equal(dockIn.clampRatio("nope"), 0.5);
  // Degenerate bounds stay non-negative.
  const tiny = dockIn.splitRects({ x: 0, y: 0, width: 2, height: 1 }, { axis: "vertical" });
  assert.ok(tiny.primary.width >= 0 && tiny.secondary.width >= 0);
});
