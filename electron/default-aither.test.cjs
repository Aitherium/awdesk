"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const roster = require("./character-roster.cjs");

test("the default Aither is the new body (aither-v2), the older one only when v2 is absent", () => {
  assert.deepEqual([...roster.DEFAULT_AITHER], ["aither-v2", "aither"]);
  assert.equal(roster.defaultAitherCharacter(["aither", "aither-v2", "kato"]), "aither-v2");
  assert.equal(roster.defaultAitherCharacter(["aither", "kato"]), "aither");
  assert.equal(roster.defaultAitherCharacter(["kato"]), null);
  assert.equal(roster.defaultAitherCharacter([]), null);
});

test("the old models are never the default while v2 is installed", () => {
  assert.equal(roster.defaultAitherCharacter(["aither-classic", "aither-ninja", "aither-v2"]), "aither-v2");
  assert.equal(roster.defaultAitherCharacter(["aither-classic"]), null, "classic is a roster copy, not a default");
});
