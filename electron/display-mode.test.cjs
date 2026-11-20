"use strict";

// Display mode (owner 2026-11-20): a fairy AND the docked avatar at the same time.
// The screenshot showed them adjacent; today a mode picks one. These tests pin the
// pure rules: persistence, `both` never overlaps, `swarm` badges stay distinct, a
// released fairy returns to its SLOT (not home), and the one-cluster rule holds in
// `avatar` mode.

const test = require("node:test");
const assert = require("node:assert/strict");
const dm = require("./display-mode.cjs");

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };
/** A docked VRM slot, tall like the browser rail's. */
const AVATAR = { x: 120, y: 90, width: 430, height: 680 };
const HOME = { x: 1700, y: 900 };

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(rect, area) {
  return rect.x >= area.x && rect.y >= area.y
    && rect.x + rect.width <= area.x + area.width
    && rect.y + rect.height <= area.y + area.height;
}

test("mode persistence: defaults to today's fairy; the store round-trips and keeps `docked`", () => {
  assert.deepEqual(dm.normalize(null), { mode: "fairy", swarm: dm.DEFAULT_SWARM });
  assert.equal(dm.normalize({ mode: "both" }).mode, "both");
  assert.equal(dm.normalize({ mode: "nonsense" }).mode, "fairy", "a bad mode falls back, never throws");
  assert.equal(dm.normalize({ swarm: 99 }).swarm, dm.SWARM_MAX);
  assert.equal(dm.normalize({ swarm: 0 }).swarm, 1);

  const stored = '{"docked":false,"unrelated":{"keep":true}}';
  assert.deepEqual(dm.readStore(stored), { mode: "fairy", swarm: dm.DEFAULT_SWARM });
  const written = dm.writeStore(stored, { mode: "both", swarm: 3 });
  assert.deepEqual(JSON.parse(written), {
    docked: false,
    unrelated: { keep: true },
    displayMode: "both",
    displaySwarm: 3,
  });
  assert.deepEqual(dm.readStore(written), { mode: "both", swarm: 3 });
  assert.deepEqual(dm.readStore("not json"), { mode: "fairy", swarm: dm.DEFAULT_SWARM });
});

test("both: the cluster sits beside the avatar and the rects never intersect", () => {
  const rect = dm.clusterRect("both", { avatarRect: AVATAR, clusterHalf: 120, orbCenter: { x: 335, y: 430 }, area: AREA });
  assert.ok(rect, "both mode draws the cluster");
  assert.equal(intersects(rect, AVATAR), false, "the cluster never sits on the avatar");
  assert.ok(inside(rect, AREA), "the cluster stays on the work area");
  // Next to it, sharing the avatar's vertical middle, not on top of it.
  assert.ok(Math.abs((rect.y + rect.height / 2) - (AVATAR.y + AVATAR.height / 2)) <= 2);
  assert.ok(rect.x + rect.width <= AVATAR.x || rect.x >= AVATAR.x + AVATAR.width);
});

test("both: an avatar hugging the left edge puts the cluster on its right", () => {
  const left = { x: 0, y: 90, width: 430, height: 680 };
  const rect = dm.clusterRect("both", { avatarRect: left, clusterHalf: 120, area: AREA });
  assert.equal(intersects(rect, left), false);
  assert.ok(rect.x >= left.x + left.width, "goes right when there is no room on the left");
});

test("swarm: N=3 makes 3 orbs, each with a distinct badge, none on the avatar or each other", () => {
  const mates = [
    { agent: "lyra", label: "Lyra", count: 2 },
    { agent: "atlas", label: "Atlas", count: 1 },
    { agent: "hera", label: "Hera", count: 0 },
    { agent: "apollo", label: "Apollo", count: 0 },
  ];
  const orbs = dm.swarmOrbs(AVATAR, mates, { max: 3, area: AREA });
  assert.equal(orbs.length, 3, "up to N, and N here is 3");
  assert.equal(new Set(orbs.map((o) => o.badge)).size, 3, "each orb carries a distinct agent badge");
  assert.deepEqual(orbs.map((o) => o.agent), ["lyra", "atlas", "hera"], "roster order decides the orbs shown");
  for (const orb of orbs) {
    assert.equal(intersects(orb.rect, AVATAR), false, `${orb.agent} does not sit on the avatar`);
    assert.ok(inside(orb.rect, AREA), `${orb.agent} stays on the work area`);
    assert.equal(orb.rect.width, dm.ORB_SIZE.width);
  }
  for (let i = 0; i < orbs.length; i += 1) {
    for (let j = i + 1; j < orbs.length; j += 1) {
      assert.equal(intersects(orbs[i].rect, orbs[j].rect), false, `${orbs[i].agent} and ${orbs[j].agent} never overlap`);
    }
  }
});

test("swarm: fewer mates than N makes fewer orbs; duplicates collapse", () => {
  assert.equal(dm.swarmOrbs(AVATAR, [{ agent: "lyra" }], { max: 3, area: AREA }).length, 1);
  const dup = dm.swarmOrbs(AVATAR, [{ agent: "lyra" }, { agent: "lyra" }, { agent: "atlas" }], { max: 3, area: AREA });
  assert.deepEqual(dup.map((o) => o.agent), ["lyra", "atlas"]);
});

test("release in both/swarm flies back to the fairy's SLOT, elsewhere home", () => {
  const slot = { x: 640, y: 300 };
  for (const mode of ["both", "swarm"]) {
    assert.deepEqual(dm.releaseTarget({ mode, slot, home: HOME }), { to: "slot", point: slot });
  }
  for (const mode of ["fairy", "avatar"]) {
    assert.deepEqual(dm.releaseTarget({ mode, slot, home: HOME }), { to: "home", point: HOME });
  }
  // A nonsense slot never strands the fairy: it falls back to the resting spot.
  assert.deepEqual(dm.releaseTarget({ mode: "swarm", slot: null, home: HOME }), { to: "home", point: HOME });
});

test("the one-cluster rule still holds in avatar mode", () => {
  const layers = dm.layers("avatar");
  assert.deepEqual(layers, { avatar: true, cluster: false, orb: false });
  assert.equal(dm.capacity("avatar", 7, { swarm: 3 }), 0, "no cluster, no fairies");
  assert.equal(dm.clusterRect("avatar", { avatarRect: AVATAR, clusterHalf: 120, area: AREA }), null);
  assert.equal(dm.clusterAnchor("avatar"), null);
  // fairy = the cluster around the orb, no avatar; both/swarm = avatar + cluster.
  assert.deepEqual(dm.layers("fairy"), { avatar: false, cluster: true, orb: true });
  assert.deepEqual(dm.layers("both"), { avatar: true, cluster: true, orb: false });
  assert.equal(dm.capacity("swarm", 9, { swarm: 3 }), 3);
  assert.equal(dm.capacity("both", 9, { swarm: 3 }), 9, "both shows the whole cluster");
});

test("switching modes settles: no overlay left painted, pins cleared where slots take over", () => {
  const t = dm.settle("both", "fairy");
  assert.equal(t.changed, true);
  assert.equal(t.hideTrail, true, "the tether/trail overlay is put away");
  assert.equal(t.hideMenu, true);
  assert.equal(t.clearPins, false, "leaving a slot layout does not pin anything again");
  assert.equal(dm.settle("fairy", "both").clearPins, true, "a slot layout owns the fairies, so stray pins go");
  assert.equal(t.clearHover, true);
  assert.equal(t.reanchor, "orb");
  assert.equal(dm.settle("fairy", "both").reanchor, "avatar");
  assert.equal(dm.settle("avatar", "fairy").reanchor, "orb");
  assert.equal(dm.settle("fairy", "fairy").changed, false, "a no-op switch repaints nothing");
});

test("the menu offers four modes, exactly one checked; a pick persists; the key cycles", () => {
  const rows = dm.modeItems({ mode: "both" });
  assert.deepEqual(rows.map((r) => r.id), ["dm:avatar", "dm:fairy", "dm:both", "dm:swarm"]);
  assert.equal(rows.filter((r) => r.checked).length, 1);
  assert.equal(rows.find((r) => r.checked).id, "dm:both");
  assert.match(rows.find((r) => r.id === "dm:both").label, /✓/);

  const pick = dm.applyModePick({ mode: "fairy", swarm: 4 }, "dm:swarm");
  assert.deepEqual(pick.settings, { mode: "swarm", swarm: 4 });
  assert.equal(pick.changed, true);
  assert.deepEqual(dm.applyModePick({ mode: "fairy" }, "dm:swarm").settings.mode, "swarm");
  assert.equal(dm.applyModePick({ mode: "fairy" }, "dm:nope").error, "unknown display mode nope");
  assert.equal(dm.applyModePick({ mode: "swarm" }, "dm:swarm").changed, false);

  assert.deepEqual(
    [dm.cycle("fairy"), dm.cycle("both"), dm.cycle("swarm"), dm.cycle("avatar"), dm.cycle("fairy")],
    ["both", "swarm", "avatar", "fairy", "both"],
  );
});
