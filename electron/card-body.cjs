"use strict";
/**
 * card-body.cjs — a DarkLink character card's `appearance.body` as a desk VRM `customise` recipe.
 *
 * The card body (AitherOS lib/darklink/body.py) is engine-neutral: every scalar is 0..1 with 0.5 the
 * neutral body, so c = (v - 0.5) * 2 reads -1..1. A VRoid-style VRM carries no body blendshapes, so
 * the desk applies a body with what applyCustomise (src/hooks/useVrmLoader.ts) already supports:
 *
 *   boneScale   NORMALIZED humanoid bones, uniform scale, children follow:
 *                 hips                      height (0.85 .. 1.0 .. 1.20, same curve as every target)
 *                 left/rightUpperLeg        leg length; feet get the inverse so they keep their size
 *                 left/rightUpperArm        arm length; hands get the inverse
 *                 left/rightShoulder        shoulder width; the upper arm absorbs the inverse
 *                 spine                     torso length; neck gets the inverse so the head keeps its size
 *   blendshapes the card's `local` keys whose value is positive, by name — a model that authors an
 *               expression of that name responds, any other model ignores it (applyCustomise fails soft)
 *
 * Girth (muscle, weight, waist, hips) has no bone or blendshape on a stock VRM and is NOT faked by
 * scaling; those parameters reach VRM bodies through the Darkmatter rigify bake instead.
 *
 * Pure and dependency-free. cardBodyToCustomise returns null for a body it refuses (bodyError says why).
 */

const BODY_V = 1;
const SCALARS = ["height", "muscle", "weight", "softness", "femininity"];
const PROPORTIONS = ["shoulders", "chest", "waist", "hips", "glutes", "thighs", "calves", "neck",
  "arm_length", "leg_length", "torso_length"];
/** Mirror of lib/darklink/body.py PRESETS for the parameters this recipe reads. */
const PRESET_FRAME = {
  average: {}, lean: {}, soft: {}, heavy: {},
  athletic: { height: 0.65, proportions: { shoulders: 0.62, leg_length: 0.6 } },
  powerlifter: { height: 0.7, proportions: { shoulders: 0.78 } },
  bodybuilder: { height: 0.65, proportions: { shoulders: 0.85 } },
  tall_athletic: { height: 0.9, proportions: { shoulders: 0.65, leg_length: 0.68, arm_length: 0.6 } },
};
const HEIGHT = [[-1, 0.85], [0, 1], [1, 1.2]];
const LOCAL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isUnit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

function curveAt(curve, c) {
  if (c <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i += 1) {
    const [x0, y0] = curve[i - 1];
    const [x1, y1] = curve[i];
    if (c <= x1) return y0 + ((y1 - y0) * (c - x0)) / (x1 - x0);
  }
  return curve[curve.length - 1][1];
}

/** Why a body is refused, or null when this reader can apply it. Checks only what it reads. */
function bodyError(body) {
  if (!isObj(body)) return "appearance.body must be an object";
  if (body.body_v !== BODY_V) return `unsupported body version ${JSON.stringify(body.body_v)}`;
  if ("preset" in body && !Object.hasOwn(PRESET_FRAME, body.preset)) return `unknown preset ${JSON.stringify(body.preset)}`;
  for (const k of SCALARS) if (k in body && !isUnit(body[k])) return `${k} must be a number in 0..1`;
  if ("proportions" in body) {
    if (!isObj(body.proportions)) return "proportions must be an object";
    for (const [k, v] of Object.entries(body.proportions)) {
      if (!PROPORTIONS.includes(k)) return `unknown proportion ${k}`;
      if (!isUnit(v)) return `proportions.${k} must be a number in 0..1`;
    }
  }
  if ("local" in body) {
    if (!isObj(body.local)) return "local must be an object";
    for (const [k, v] of Object.entries(body.local)) {
      if (!LOCAL_KEY.test(k) || typeof v !== "number" || !Number.isFinite(v) || v < -1 || v > 1) return `local.${k} is invalid`;
    }
  }
  return null;
}

/** The desk `customise` recipe ({boneScale, blendshapes}) for a card body at rest, or null if refused. */
function cardBodyToCustomise(body) {
  if (bodyError(body)) return null;
  const preset = PRESET_FRAME[body.preset] || {};
  const prop = (k) => {
    if (body.proportions && k in body.proportions) return body.proportions[k];
    if (preset.proportions && k in preset.proportions) return preset.proportions[k];
    return 0.5;
  };
  const height = "height" in body ? body.height : ("height" in preset ? preset.height : 0.5);
  const c = (v) => (v - 0.5) * 2;
  const leg = 1 + c(prop("leg_length")) * 0.1;
  const arm = 1 + c(prop("arm_length")) * 0.1;
  const torso = 1 + c(prop("torso_length")) * 0.06;
  const shoulder = 1 + c(prop("shoulders")) * 0.15;
  const boneScale = {
    hips: r4(curveAt(HEIGHT, c(height))),
    leftUpperLeg: r4(leg), rightUpperLeg: r4(leg), leftFoot: r4(1 / leg), rightFoot: r4(1 / leg),
    leftShoulder: r4(shoulder), rightShoulder: r4(shoulder),
    leftUpperArm: r4(arm / shoulder), rightUpperArm: r4(arm / shoulder), leftHand: r4(1 / arm), rightHand: r4(1 / arm),
    spine: r4(torso), neck: r4(1 / torso),
  };
  const blendshapes = {};
  for (const [k, v] of Object.entries(body.local || {})) if (v > 0) blendshapes[k] = r4(v);
  return Object.keys(blendshapes).length ? { boneScale, blendshapes } : { boneScale };
}

module.exports = { cardBodyToCustomise, bodyError };
