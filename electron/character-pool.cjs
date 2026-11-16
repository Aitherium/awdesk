"use strict";

/**
 * character-pool.cjs -- which roster bodies an AUTOMATIC pick may hand out.
 *
 * Owner, 2026-11-16: "why do I still have these random robot avatars and not my proper
 * fairies/agent avatars" and, with the Aither Browser's docked avatar panel on screen showing a
 * white/pink robot beside Aither: "need to fix avatars here too". A body with no configured
 * row (a Claude Code terminal's room actor, an agent nobody dressed) is picked by
 * cast-config.stableCharacter -- a rendezvous hash over the WHOLE roster. The roster is a
 * library of ~90 models: robots and droids, a stone golem, a low-poly mesh, glitched textures,
 * a pixel goblin, the stock VRM samples. A hash over all of them hands a terminal one of those
 * (the stage in the browser rail, the T-posing session bodies).
 *
 * So the automatic pick draws only from the PROPER bodies: people, creatures and characters
 * made to be looked at, never a robot or a stock sample. Anything the person assigned on
 * purpose is untouched (this module is only the pool of the AUTOMATIC pick; a cast.json row
 * names its body directly). When nothing proper is free the pick is null -- no body -- and
 * never a robot as a last resort.
 *
 * PURE: names only (the roster record is not read here; the explicit list covers the library
 * as measured 2026-11-16 and the pattern covers the next model someone downloads).
 */

/** Models in the library that are robots, droids, stand-ins or stock samples. */
const NOT_A_BODY = Object.freeze(new Set([
  "aiko-droid-base-model",
  "kato-straight-title-robot-anime",
  "orion", "orion-1fd9645d",            // the stone golem
  "synth-android",
  "siren-head",
  "kunoichi-100-triangle-meshes",       // a 100-triangle test mesh
  "mpm-1-0-vrm0---downloadable",         // a glitched-texture export
  "mpm-1-0-vrm1---downloadable",
  "blue_union",
  "vivi_blackandwhite",
  "smg-3-0-vrm0---downloadable",
  "smg-1-0-vrm-1---downloadable",
  "uchuujin",
  "sample", "avatarsample_o", "avatarsample_q_vrm10", "avatarsample_t_vrm10",
  "vrm-0-model", "vrm-1-model", "vrm-0---downloadable", "vrm-1---downloadable",
  "vrm-1-0", "vrm-1-0-9c0a87fc",         // the generic VRM sample
]));

/** The next one nobody has listed yet: robot-ish and stock-sample names. */
const NOT_A_BODY_PATTERN = /(robot|droid|android|synth|mecha|golem|cyborg|automaton|avatarsample|(^|[-_])sample($|[-_])|^vrm-[01]-0(-[0-9a-f]{8})?$)/i;

/** May an automatic pick hand this roster name out? */
function isProperBody(name) {
  const n = String(name == null ? "" : name).trim();
  if (!n) return false;
  if (NOT_A_BODY.has(n)) return false;
  return !NOT_A_BODY_PATTERN.test(n);
}

/** The roster reduced to the bodies an automatic pick may use. */
function properPool(roster) {
  return (Array.isArray(roster) ? roster : []).filter(isProperBody);
}

module.exports = { NOT_A_BODY, NOT_A_BODY_PATTERN, isProperBody, properPool };
