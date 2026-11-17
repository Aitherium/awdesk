"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("./character-pool.cjs");
const { stableCharacter } = require("./cast-config.cjs");

// The library as measured on the owner's desk 2026-11-16 (the automatic pick's old pool).
const LIBRARY = [
  "aiko-droid-base-model", "aither-90044575", "aither-m", "aither-v2", "asuka-yujitomoto", "atlas",
  "blue_union", "celisia-arcroid-e97fbc35", "charlie-5e48d775", "clara-hsr-vrm-0-0-f0070392",
  "demiurge", "fu-xuan-vrm-0-0", "hera", "herta-hsr-vrm-0-0-6076f3b1", "himeko-hsr-vrm-0-0", "iris",
  "kafka-hsr-vrm-0-0", "kato-straight-title-robot-anime", "kunoichi-100-triangle-meshes", "lyra",
  "mpm-1-0-vrm0---downloadable", "orion", "orion-1fd9645d", "saga", "sample", "siren-head",
  "smg-3-0-vrm0---downloadable", "synth-android", "themis", "uchuujin", "vera", "vivi_blackandwhite",
  "vrm-1-0", "vrm-1-0-9c0a87fc", "vrm0-0",
];

test("the robots, droids, golem, test mesh and stock samples are not bodies an automatic pick may hand out", () => {
  for (const name of [
    "aiko-droid-base-model", "kato-straight-title-robot-anime", "synth-android", "orion", "orion-1fd9645d",
    "siren-head", "kunoichi-100-triangle-meshes", "mpm-1-0-vrm0---downloadable", "sample", "vrm-1-0",
    "vrm-1-0-9c0a87fc", "avatarsample_q_vrm10", "future-robot-9000", "some-droid", "a-mecha",
  ]) assert.equal(pool.isProperBody(name), false, name);
  for (const name of ["aither-v2", "charlie-5e48d775", "himeko-hsr-vrm-0-0", "hera", "vrm0-0", "celisia-arcroid-e97fbc35"]) {
    assert.equal(pool.isProperBody(name), true, name);
  }
  assert.equal(pool.isProperBody(""), false);
  assert.equal(pool.isProperBody(null), false);
});

test("stableCharacter never hands a seed a robot, whichever seed", () => {
  const bad = new Set(LIBRARY.filter((n) => !pool.isProperBody(n)));
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const pick = stableCharacter(`claude_code:repo${i}:${i % 7}`, LIBRARY);
    assert.ok(pick, "a body is found");
    assert.ok(!bad.has(pick), `${pick} is not a body`);
    seen.add(pick);
  }
  assert.ok(seen.size > 10, "the pick still spreads across the proper bodies");
});

test("the pick is stable, and skips the resident and the bodies already on stage", () => {
  const a = stableCharacter("seed-a", LIBRARY);
  assert.equal(stableCharacter("seed-a", LIBRARY), a);
  const next = stableCharacter("seed-a", LIBRARY, { taken: [a] });
  assert.notEqual(next, a);
  assert.ok(pool.isProperBody(next));
});

test("with nothing proper free the pick is no body, never a robot as a last resort", () => {
  assert.equal(stableCharacter("seed", ["aiko-droid-base-model", "synth-android", "vrm-1-0"]), null);
  assert.equal(stableCharacter("seed", ["hera"], { taken: ["hera"] }), null);
});
