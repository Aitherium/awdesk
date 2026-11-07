"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("./launcher-core.cjs");

test("L1 the threshold: released before 280 ms is a tap, at/after is a hold", () => {
  assert.equal(core.classifyRelease(1000, 1279), "tap");
  assert.equal(core.classifyRelease(1000, 1280), "hold");
  assert.equal(core.classifyRelease(1000, 2000), "hold");
  // A release clock that never arrived (or a broken clock) is a tap, never a hold.
  assert.equal(core.classifyRelease(1000, NaN), "tap");
  assert.equal(core.classifyRelease(1000, 900), "tap");
});

test("L2 four slices: top/right/bottom/left map to 0/1/2/3", () => {
  const center = { x: 100, y: 100 };
  assert.equal(core.sliceIndexAt({ x: 100, y: 0 }, center, 4), 0);
  assert.equal(core.sliceIndexAt({ x: 200, y: 100 }, center, 4), 1);
  assert.equal(core.sliceIndexAt({ x: 100, y: 200 }, center, 4), 2);
  assert.equal(core.sliceIndexAt({ x: 0, y: 100 }, center, 4), 3);
});

test("L3 eight slices, diagonals, and the dead zone cancels", () => {
  const center = { x: 500, y: 500 };
  const at = (deg, r = 120) => ({
    x: center.x + r * Math.cos((deg * Math.PI) / 180),
    y: center.y + r * Math.sin((deg * Math.PI) / 180),
  });
  // index 0 is top (-90 deg), clockwise.
  assert.equal(core.sliceIndexAt(at(-90), center, 8), 0);
  assert.equal(core.sliceIndexAt(at(-45), center, 8), 1);
  assert.equal(core.sliceIndexAt(at(0), center, 8), 2);
  assert.equal(core.sliceIndexAt(at(45), center, 8), 3);
  assert.equal(core.sliceIndexAt(at(90), center, 8), 4);
  assert.equal(core.sliceIndexAt(at(135), center, 8), 5);
  assert.equal(core.sliceIndexAt(at(180), center, 8), 6);
  assert.equal(core.sliceIndexAt(at(-135), center, 8), 7);
  // The middle is a cancel, not the nearest slice.
  assert.equal(core.sliceIndexAt({ x: 505, y: 500 }, center, 8), null);
  assert.equal(core.sliceIndexAt(center, center, 8), null);
});

test("L4 ten slices keep the top at 0 and every wedge reachable", () => {
  const center = { x: 0, y: 0 };
  assert.equal(core.sliceIndexAt({ x: 0, y: -100 }, center, 10), 0);
  for (let i = 0; i < 10; i += 1) {
    const deg = core.sliceAngle(i, 10);
    const rad = (deg * Math.PI) / 180;
    assert.equal(core.sliceIndexAt({ x: 100 * Math.cos(rad), y: 100 * Math.sin(rad) }, center, 10), i);
  }
  // A zero-slice ring has no answer rather than a crash.
  assert.equal(core.sliceIndexAt({ x: 0, y: -100 }, center, 0), null);
});

test("L5 auto-repeat is ignored while the window is up; a later press closes", () => {
  const base = { phase: "pending", now: 2000, lastPressAt: 1000 };
  assert.equal(core.pressDecision(base), "ignore", "held key repeating");
  assert.equal(core.pressDecision({ ...base, phase: "radial-hold" }), "ignore", "held key repeating on the ring");
  // A tap released 40 ms ago: the OS may still repeat it.
  assert.equal(core.pressDecision({ phase: "launcher", now: 2000, lastPressAt: 1000, releasedAt: 1960 }), "ignore");
  // Deliberate second press: close.
  assert.equal(core.pressDecision({ phase: "launcher", now: 3000, lastPressAt: 1000, releasedAt: 1960 }), "close");
  // Focus-locked fallback: never saw a release, so a quick repeat is not a close.
  assert.equal(core.pressDecision({ phase: "launcher", now: 1100, lastPressAt: 1000, releasedAt: 0 }), "ignore");
  assert.equal(core.pressDecision({ phase: "launcher", now: 2000, lastPressAt: 1000, releasedAt: 0 }), "close");
  assert.equal(core.pressDecision({ phase: "idle", now: 2000 }), "open");
  assert.equal(core.pressDecision({ phase: "launcher", now: 100, ignoreUntil: 500 }), "ignore");
});

test("L6 groups cap at five with a real +N more, empty groups are absent", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, title: `Row ${i}` }));
  const out = core.capGroups([
    { id: "apps", label: "Apps", total: 8, items },
    { id: "empty", label: "Empty", total: 0, items: [] },
    { id: "files", label: "Files", total: 2, items: items.slice(0, 2) },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].shown.length, 5);
  assert.equal(out[0].more, 3);
  assert.equal(out[0].total, 8);
  assert.equal(out[0].items.length, 8, "nothing is dropped from the data");
  assert.equal(out[1].more, 0);
  assert.deepEqual(out.map((g) => g.id), ["apps", "files"]);
});

test("L7 flatten/top follow the reading order and the expanded groups", () => {
  const items = [{ key: "a", title: "A" }, { key: "b", title: "B" }];
  const groups = [{ id: "one", label: "One", items }];
  assert.equal(core.topRow(groups).item.key, "a");
  const rows = core.flattenGroups(groups);
  assert.deepEqual(rows.map((r) => r.item.key), ["a", "b"]);
});

test("L8 prefixes split at the first character only", () => {
  assert.deepEqual(core.parseQuery("> adk desk status"), { mode: "command", term: "adk desk status", raw: "> adk desk status" });
  assert.deepEqual(core.parseQuery("? what is up"), { mode: "ask", term: "what is up", raw: "? what is up" });
  assert.deepEqual(core.parseQuery("@ hello"), { mode: "spirit", term: "hello", raw: "@ hello" });
  assert.deepEqual(core.parseQuery("notes what?"), { mode: "all", term: "notes what?", raw: "notes what?" });
  assert.deepEqual(core.parseQuery("   "), { mode: "all", term: "", raw: "" });
});

test("L9 only adk desk and read-only awsh run on the first Enter", () => {
  assert.equal(core.commandPlan("adk desk status").ok, true);
  assert.equal(core.commandPlan("adk desk status").needsConfirm, false);
  assert.equal(core.commandPlan("adk desk").needsConfirm, false);
  const adkOther = core.commandPlan("adk discover query notes");
  assert.equal(adkOther.ok, true);
  assert.equal(adkOther.needsConfirm, true);

  assert.equal(core.commandPlan("awsh status").needsConfirm, false);
  assert.equal(core.commandPlan("awsh list").needsConfirm, false);
  assert.equal(core.commandPlan("awsh --version").needsConfirm, false);
  assert.equal(core.commandPlan("awsh restart").needsConfirm, true);
  assert.equal(core.commandPlan("awsh status --json").needsConfirm, false);
});

test("L10 unsafe lines are refused outright, before any confirm", () => {
  for (const line of ["", "   ", "rm -rf /", "powershell -c whoami", "adk desk status; rm -rf /",
    "adk desk status && echo hi", "adk desk `whoami`", "adk desk $(whoami)", "adk desk status | cat",
    "adk desk status > out.txt", "adk desk \"unclosed"]) {
    const plan = core.commandPlan(line);
    assert.equal(plan.ok, false, `${JSON.stringify(line)} must be refused`);
  }
  assert.equal(core.commandPlan("adk desk \"two words\"").ok, true);
  assert.deepEqual(core.commandPlan("adk desk \"two words\"").argv, ["adk", "desk", "two words"]);
});

test("L11 the status line is the desk's error shape", () => {
  assert.equal(core.statusText({}), core.IDLE_STATUS);
  assert.match(core.statusText({ errors: [{ label: "Files", reason: "index down" }] }),
    /^1 source down — Files: index down$/);
  assert.match(core.statusText({ groups: [{ total: 3 }, { total: 2 }] }), /^5 results in 2 groups$/);
  assert.match(core.statusText({ groups: [{ total: 1 }], indexing: true }), /still searching/);
});
