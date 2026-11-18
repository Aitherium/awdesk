"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const flight = require("./fairy-flight.cjs");

const NOW = 1_800_000_000_000;
const CLUSTER = { x: 500, y: 400 };
const SURFACES = {
  files: { x: 100, y: 100, width: 800, height: 600 },
  library: null,
  browser: { x: 1200, y: 200, width: 900, height: 700 },
  terminal: { x: 300, y: 900, width: 700, height: 400 },
};

function call(id, tool, surface, extra = {}) {
  return { id, agent: "session-" + id, session: id, label: id, tool, surface, ...extra };
}

test("one call -> one flight to that surface", () => {
  const plan = flight.planFlights({
    calls: [call("a", "Read", "files")], surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW,
  });
  assert.equal(plan.flights.length, 1);
  const f = plan.flights[0];
  assert.equal(f.mode, "fly");
  assert.equal(f.surface, "files");
  assert.deepEqual(f.from, CLUSTER, "the sub-fairy leaves the cluster");
  assert.deepEqual(f.to, { x: 500, y: 280 }, "it lands in the File Explorer window");
  assert.equal(plan.returning.length, 0);
});

test("3 parallel calls split into 3 sub-fairies, one per call, at their own surfaces", () => {
  const plan = flight.planFlights({
    calls: [call("a", "Read", "files"), call("b", "WebSearch", "browser"), call("c", "Bash", "terminal")],
    surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW,
  });
  assert.equal(plan.flights.length, 3);
  assert.deepEqual(plan.flights.map((f) => f.surface), ["files", "browser", "terminal"]);
  assert.equal(new Set(plan.flights.map((f) => f.id)).size, 3, "one id per call");
});

test("a call that finishes sends its sub-fairy home, then merges", () => {
  const planner = flight.createFlightPlanner({ mergeMs: 900 });
  const first = planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW });
  assert.equal(first.flights.length, 1);
  assert.equal(first.returning.length, 0);

  const done = planner.plan([], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW + 1_000 });
  assert.equal(done.flights.length, 0, "nothing is still working");
  assert.equal(done.returning.length, 1, "but the fairy is flying home");
  assert.deepEqual(done.returning[0].from, { x: 500, y: 280 }, "from the window it worked at");
  assert.deepEqual(done.returning[0].to, CLUSTER, "back to the cluster");

  const merged = planner.plan([], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW + 2_500 });
  assert.equal(merged.returning.length, 0, "merged and forgotten after mergeMs");
  assert.deepEqual(planner.size(), { live: 0, returning: 0 });
});

test("a missing target window makes the fairy hover just outside the cluster", () => {
  const plan = flight.planFlights({
    calls: [call("a", "Read", "files")], surfaces: { ...SURFACES, files: null }, cluster: CLUSTER, nowMs: NOW,
  });
  assert.equal(plan.flights.length, 1);
  const f = plan.flights[0];
  assert.equal(f.mode, "hover");
  assert.equal(plan.hover.length, 1);
  const distance = Math.hypot(f.to.x - CLUSTER.x, f.to.y - CLUSTER.y);
  assert.ok(distance > 0 && distance <= flight.HOVER_RADIUS + 1, `hover stays beside the cluster (${distance}px)`);
});

test("throttling: no more than N sub-fairies, the rest are counted", () => {
  const calls = Array.from({ length: 7 }, (_, i) => call(`c${i}`, "Read", "files"));
  const plan = flight.planFlights({ calls, surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW, maxSubFairies: 3 });
  assert.equal(plan.flights.length, 3, "the cap is respected");
  assert.equal(plan.throttled.length, 4, "the overflow is reported, not silently dropped");
  // The cap is a plan rule too, never only the renderer's.
  assert.ok(plan.flights.length <= 3);
});

test("reduced motion: no sub-fairies fly at all", () => {
  const plan = flight.planFlights({
    calls: [call("a", "Read", "files")], surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW, reducedMotion: true,
  });
  assert.deepEqual(plan.flights, []);
  assert.equal(plan.reducedMotion, true);
  const planner = flight.createFlightPlanner();
  const p = planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW, reducedMotion: true });
  assert.deepEqual(p.flights, []);
});

test("a wedged call is released instead of pinning a fairy forever", () => {
  const planner = flight.createFlightPlanner({ maxCallMs: 1_000 });
  planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW });
  const later = planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW + 60_000 });
  assert.equal(later.flights.length, 0);
  assert.equal(later.returning.length, 1, "it goes home");
});

test("positionAt eases from the cluster to the target and reports done", () => {
  const f = flight.planFlights({ calls: [call("a", "Read", "files")], surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW }).flights[0];
  const start = flight.positionAt(f, NOW);
  const middle = flight.positionAt(f, NOW + f.durationMs / 2);
  const end = flight.positionAt(f, NOW + f.durationMs + 10);
  assert.deepEqual([start.x, start.y], [f.from.x, f.from.y]);
  assert.equal(end.done, true);
  assert.deepEqual([end.x, end.y], [f.to.x, f.to.y]);
  assert.ok(middle.t > 0.4 && middle.t < 0.6);
});

test("the cap covers returning legs too, so a burst of finished calls cannot flood the screen", () => {
  const planner = flight.createFlightPlanner();
  const calls = Array.from({ length: 6 }, (_, i) => call(`c${i}`, "Read", "files"));
  planner.plan(calls, { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW });
  const done = planner.plan([], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW + 1_000, maxSubFairies: 4 });
  assert.equal(done.flights.length, 0);
  assert.equal(done.returning.length, 4, "no more than N sub-fairies, counting the ones flying home");
  assert.equal(done.throttled.filter((id) => id.startsWith("return:")).length, 2);
});

test("a re-plan does not restart a fairy already at its window", () => {
  const planner = flight.createFlightPlanner();
  const first = planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW });
  const again = planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW + 6_000 });
  assert.equal(again.flights.length, 1);
  assert.equal(again.flights[0].startedAt, first.flights[0].startedAt, "the same leg, still standing there");
  assert.equal(again.flights[0].to.x, first.flights[0].to.x);
});

test("a call that starts again under the same id cancels its trip home", () => {
  const planner = flight.createFlightPlanner({ mergeMs: 2000 });
  planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW });
  const home = planner.plan([], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW + 500 });
  assert.equal(home.returning.length, 1);
  const again = planner.plan([call("a", "Read", "files")], { surfaces: SURFACES, cluster: CLUSTER, nowMs: NOW + 700 });
  assert.equal(again.flights.length, 1, "back at work");
  assert.equal(again.returning.length, 0, "one fairy, never one leaving and one arriving");
});
