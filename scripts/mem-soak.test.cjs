"use strict";

// The verdict half of scripts/mem-soak.cjs: the gate that would have caught
// "loses itself at 400 MB" (2026-11-20).

const test = require("node:test");
const assert = require("node:assert/strict");
const { verdict, parseArgs } = require("./mem-soak.cjs");

const t0 = 1_800_000_000_000;
const at = (sec) => t0 + sec * 1000;
const samples = (seq) => seq.map(([sec, mainMb, totalMb]) => ({ at: at(sec), mainMb, totalMb }));

test("a steady desk passes", () => {
  const r = verdict(samples([[0, 160, 500], [30, 230, 560], [90, 235, 570], [180, 240, 580]]));
  assert.equal(r.ok, true, r.reasons.join("; "));
  assert.equal(r.baseline.mainMb, 235);
  assert.equal(r.peak.mainMb, 240);
});

test("the 2026-11-20 shape fails: main 150 -> 655 MB on a running desk", () => {
  const r = verdict(samples([[0, 150, 460], [30, 160, 470], [75, 655, 990], [120, 640, 980], [180, 150, 460]]));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /runaway|main grew/.test(x)), r.reasons.join("; "));
});

test("a runaway inside one minute fails even if the peak is under the growth bound", () => {
  const r = verdict(samples([[0, 800, 1600], [20, 820, 1620], [50, 1250, 2050], [80, 1240, 2040]]),
    { maxGrowthMb: 1000 });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /runaway/.test(x)), r.reasons.join("; "));
});

test("a gap longer than the limit is a restart and fails", () => {
  const r = verdict(samples([[0, 200, 600], [30, 210, 610], [240, 180, 590]]));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /stopped answering/.test(x)), r.reasons.join("; "));
});

test("growth during the settle window is not measured", () => {
  const r = verdict(samples([[0, 120, 400], [20, 400, 900], [40, 650, 1200], [80, 655, 1210], [140, 650, 1200]]),
    { settleSec: 60 });
  // baseline is the first sample >= 60 s (655) so no growth remains; no 60 s runaway.
  assert.equal(r.ok, true, r.reasons.join("; "));
});

test("arguments parse and unknown ones are refused", () => {
  assert.deepEqual(
    (({ port, minutes, maxGrowthMb }) => ({ port, minutes, maxGrowthMb }))(parseArgs(["--port", "47931", "--minutes", "2", "--max-growth-mb", "80"])),
    { port: 47931, minutes: 2, maxGrowthMb: 80 },
  );
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});
