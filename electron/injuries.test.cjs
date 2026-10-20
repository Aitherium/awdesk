"use strict";

/**
 * injuries.cjs — a character's injuries and the tier this desk may show them at.
 *
 * The property that matters: blood is shown ONLY when the platform gate mirror says visible, and
 * every other limit can only lower the tier. Each gate case asserts both arms (closed -> pg, open ->
 * more), so a function that always answers pg, or always gore, fails.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const MIRROR = path.join(os.tmpdir(), `desk-injury-gate-${process.pid}.json`);
const ROSTER = path.join(os.tmpdir(), `desk-injury-roster-${process.pid}`);
process.env.DESK_ADULT_CONTENT_MIRROR = MIRROR;
process.env.DESK_ADULT_CONTENT_LOG = path.join(os.tmpdir(), `desk-injury-audit-${process.pid}.log`);
process.env.DESK_ROSTER_DIR = ROSTER;

const injuries = require("./injuries.cjs");
const rating = require("./content-rating.cjs");

after(() => {
  fs.rmSync(ROSTER, { recursive: true, force: true });
  fs.rmSync(MIRROR, { force: true });
});

const GORE = {
  tier: "gore",
  wounds: [{ region: "torso", kind: "stab", severity: 3, bleeding: true, bandaged: false, healed: 0, heal_days: 12 }],
  severed: ["leftForearm"],
  broken: [],
  scars: [],
  blood: 80,
  grime: 0,
  limp: "",
  signature: "s",
  descriptors: ["grievous stab wound on the torso, gaping open and bleeding freely"],
  descriptors_by_tier: { pg: ["a grievous stab wound on the torso, untended"] },
  as_of: "2026-10-19T12:00:00.000Z",
};

function character(name, body) {
  fs.mkdirSync(path.join(ROSTER, name), { recursive: true });
  fs.writeFileSync(path.join(ROSTER, name, "character.json"), JSON.stringify(body));
}

function gate(visible) {
  if (visible === null) fs.rmSync(MIRROR, { force: true });
  else fs.writeFileSync(MIRROR, JSON.stringify({ visible }));
  rating.invalidateGate();
}

test("viewerTierFrom: closed gate is pg whatever else says; an open gate is tightened by ceiling + plane", () => {
  assert.equal(injuries.viewerTierFrom({ adultContentVisible: false, maxRating: "r18", explicitAllowed: true }), "pg");
  assert.equal(injuries.viewerTierFrom({ adultContentVisible: "true", maxRating: "r18" }), "pg");
  assert.equal(injuries.viewerTierFrom({ adultContentVisible: true, maxRating: "r18", explicitAllowed: null }), "gore");
  assert.equal(injuries.viewerTierFrom({ adultContentVisible: true, maxRating: "r15" }), "blood");
  assert.equal(injuries.viewerTierFrom({ adultContentVisible: true, maxRating: "general" }), "pg");
  assert.equal(injuries.viewerTierFrom({ adultContentVisible: true, maxRating: "r18", explicitAllowed: false }), "blood");
});

test("viewerTierNow reads the REAL mirror: missing / closed = pg, open = above pg", () => {
  gate(null);
  assert.equal(injuries.viewerTierNow(), "pg", "a missing mirror is locked");
  gate(false);
  assert.equal(injuries.viewerTierNow(), "pg", "a closed mirror is locked");
  fs.writeFileSync(MIRROR, "{not json");
  rating.invalidateGate();
  assert.equal(injuries.viewerTierNow(), "pg", "an unreadable mirror is locked");
  gate(true);
  assert.notEqual(injuries.viewerTierNow(), "pg", "the open gate is honoured (mutation guard)");
  rating.setSafetyExplicitAllowed(false);
  assert.equal(injuries.viewerTierNow(), "blood", "the safety plane saying no explicit caps at blood");
  rating.setSafetyExplicitAllowed(null);
  gate(false);
});

test("viewerTierNow fails closed when the rating module throws", () => {
  const broken = { isAdultContentVisible: () => { throw new Error("boom"); } };
  assert.equal(injuries.viewerTierNow(broken), "pg");
});

test("injuriesOf: own record, then the fork chain; bad shapes are null", () => {
  character("hurt", { rating: "general", source: "dark-matters", injuries: GORE });
  character("hurt-variant", { rating: "general", source: "manual", base: "hurt", customise: {} });
  character("whole", { rating: "general", source: "manual" });
  character("weird", { rating: "general", injuries: { tier: "splatter", wounds: [] } });
  character("huge", { rating: "general", injuries: { ...GORE, descriptors: Array(2000).fill("a very long line of text") } });
  character("imported", { rating: "general", base: { id: "sample" }, injuries: GORE });
  assert.equal(injuries.injuriesOf("hurt").tier, "gore");
  assert.equal(injuries.injuriesOf("hurt-variant").tier, "gore", "a fork inherits its base's body");
  assert.equal(injuries.injuriesOf("whole"), null);
  assert.equal(injuries.injuriesOf("weird"), null, "unknown tier");
  assert.equal(injuries.injuriesOf("huge"), null, "over the byte cap");
  assert.equal(injuries.injuriesOf("imported").tier, "gore", "an object base (a VRM base id) is not a fork");
  assert.equal(injuries.injuriesOf("../etc"), null, "never a path");
  assert.equal(injuries.injuriesOf("nobody"), null);
});

test("injuriesEvent + changed: one event per change, a gate flip re-sends", () => {
  injuries.resetSent();
  gate(false);
  const closed = injuries.injuriesEvent("slot0", "hurt");
  assert.deepEqual([closed.type, closed.slotId, closed.viewerTier], ["injuries-avatar", "slot0", "pg"]);
  assert.equal(closed.injuries.tier, "gore", "the export travels intact; the renderer clamps to viewerTier");
  assert.equal(injuries.changed(closed), true);
  assert.equal(injuries.changed(injuries.injuriesEvent("slot0", "hurt")), false, "same state: no resend");
  gate(true);
  const open = injuries.injuriesEvent("slot0", "hurt");
  assert.notEqual(open.viewerTier, "pg");
  assert.equal(injuries.changed(open), true, "a gate change is a change");
  const cleared = injuries.injuriesEvent("slot0", "whole");
  assert.equal(cleared.injuries, null);
  assert.equal(injuries.changed(cleared), true, "switching to an unhurt body clears the overlay");
  gate(false);
});
