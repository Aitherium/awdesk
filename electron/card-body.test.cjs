"use strict";
// card-body.cjs — a DarkLink card body as a desk customise recipe, and customiseOf merging it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

// The roster resolves its directory at require time; keep fixtures out of the real roster.
const ROSTER = path.join(os.tmpdir(), `desk-card-body-roster-${process.pid}`);
process.env.DESK_ROSTER_DIR = ROSTER;
after(() => fs.rmSync(ROSTER, { recursive: true, force: true }));

const { cardBodyToCustomise, bodyError } = require("./card-body.cjs");

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} != ${b}`);

test("a neutral body is the authored model (every bone scale 1, no blendshapes)", () => {
  const r = cardBodyToCustomise({ body_v: 1 });
  for (const [bone, v] of Object.entries(r.boneScale)) assert.equal(v, 1, bone);
  assert.equal(r.blendshapes, undefined);
});

test("height scales the hips on the shared 0.85..1.0..1.20 curve", () => {
  close(cardBodyToCustomise({ body_v: 1, height: 1 }).boneScale.hips, 1.2);
  close(cardBodyToCustomise({ body_v: 1, height: 0 }).boneScale.hips, 0.85);
  close(cardBodyToCustomise({ body_v: 1, height: 0.75 }).boneScale.hips, 1.1);
});

test("limb length keeps the feet and hands their own size", () => {
  const b = cardBodyToCustomise({ body_v: 1, proportions: { leg_length: 1, arm_length: 1, shoulders: 1 } }).boneScale;
  close(b.leftUpperLeg, 1.1);
  close(b.leftUpperLeg * b.leftFoot, 1);
  close(b.leftShoulder, 1.15);
  close(b.leftShoulder * b.leftUpperArm, 1.1);              // the arm is 10% longer, whatever the shoulder
  close(b.leftShoulder * b.leftUpperArm * b.leftHand, 1);
  close(b.leftUpperLeg, b.rightUpperLeg);
});

test("presets fill what the body leaves out; explicit values win", () => {
  const tall = cardBodyToCustomise({ body_v: 1, preset: "tall_athletic" }).boneScale;
  close(tall.hips, 1.16);
  close(tall.leftUpperLeg, 1.036);
  const mine = cardBodyToCustomise({ body_v: 1, preset: "tall_athletic", height: 0.5 }).boneScale;
  close(mine.hips, 1);
});

test("positive local keys become blendshapes by name", () => {
  const r = cardBodyToCustomise({ body_v: 1, local: { jawWidth: 0.4, noseSize: -0.2 } });
  assert.deepEqual(r.blendshapes, { jawWidth: 0.4 });
});

test("a body this reader cannot apply is refused, never guessed at", () => {
  for (const bad of [null, [], { body_v: 2 }, { body_v: 1, height: 1.5 }, { body_v: 1, preset: "giant" },
    { body_v: 1, proportions: { wingspan: 0.5 } }, { body_v: 1, proportions: { waist: "wide" } },
    { body_v: 1, local: { "bad key": 0.1 } }, { body_v: 1, muscle: Number.NaN }]) {
    assert.ok(bodyError(bad), JSON.stringify(bad));
    assert.equal(cardBodyToCustomise(bad), null);
  }
});

test("customiseOf layers the card body under the character's own recipe", () => {
  const roster = require("./character-roster.cjs");
  const name = "zz-card-body";
  const dir = path.join(ROSTER, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify({
    source: "darklink", rating: "general",
    appearance: { body: { body_v: 1, height: 1, proportions: { leg_length: 1 } } },
    customise: { boneScale: { hips: 1.05 }, blendshapes: { happy: 0.2 } },
  }));
  const recipe = roster.customiseOf(name);
  assert.equal(recipe.boneScale.hips, 1.05, "a hand-tuned recipe wins over the card");
  close(recipe.boneScale.leftUpperLeg, 1.1);
  assert.equal(recipe.blendshapes.happy, 0.2);

  fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify({
    source: "darklink", rating: "general", appearance: { body: { body_v: 9 } },
  }));
  assert.deepEqual(roster.customiseOf(name), {}, "a refused body contributes nothing");
});
