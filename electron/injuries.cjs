"use strict";

/**
 * injuries.cjs — a roster character's injuries, and the tier THIS desk's viewer may see them at.
 *
 * Where they come from: characters/<name>/character.json `injuries`, written by a Dark Matters
 * export (.dmchar -> engine deskInstall, or AitherOS/dev/tools/import_character_agent.py --desk).
 * The shape is the awavatar character_spec `injuries` object: the TRUE wound kinds and severities,
 * worded at the export's tier, with `descriptors_by_tier` and the `as_of` / `heal_days` timestamps
 * the renderer heals them with (src/injuries/injury-view.ts).
 *
 * The tier is decided HERE, in main, from the same three limits content-rating.cjs ANDs together
 * for the roster -- and it can only come out lower than they allow:
 *   1. the platform gate mirror (~/.aither/adult_content.json): closed / missing / unreadable = pg
 *   2. the live safety plane: "no explicit" caps at the blood tier
 *   3. the desk's own ceiling (cast.json content.maxRating): general = pg, r15 = blood
 * The renderer receives `{ injuries, viewerTier }` and clamps the drawing to that tier and to the
 * export's own tier, whichever is lower. Nothing here can open the gate.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 16 * 1024;
const TIERS = ["pg", "blood", "gore"];

function rosterDir() {
  return process.env.DESK_ROSTER_DIR || path.join(__dirname, "..", "characters");
}

function record(name, dir = rosterDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name, "character.json"), "utf8")) || {};
  } catch {
    return {};
  }
}

/** The character's injuries object, or null. Own record first, then up the fork chain (a variant of
 *  an injured body is still that body). Bounded, structurally an object with a known tier. */
function injuriesOf(name, { dir = rosterDir(), depth = 8 } = {}) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(name)) return null;
  const seen = new Set();
  let node = name;
  for (let i = 0; node && i < depth && !seen.has(node); i++) {
    seen.add(node);
    const rec = record(node, dir);
    const inj = rec.injuries;
    if (inj && typeof inj === "object" && !Array.isArray(inj)) {
      try {
        if (JSON.stringify(inj).length > MAX_BYTES) return null;
      } catch {
        return null;
      }
      return TIERS.includes(inj.tier) ? inj : null;
    }
    // A fork's `base` is a roster name (content-rating.cjs baseOf); an imported body's `base` object
    // names a VRM base model, not a roster character, so the chain stops there.
    node = typeof rec.base === "string" && rec.base !== node ? rec.base : null;
  }
  return null;
}

/** The tier this desk's viewer may see. Mirrors src/injuries/injury-view.ts viewerInjuryTier. */
function viewerTierFrom({ adultContentVisible, maxRating, explicitAllowed }) {
  if (adultContentVisible !== true) return "pg";
  const max = String(maxRating == null ? "r18" : maxRating).toLowerCase();
  if (max === "general" || max === "g" || max === "pg") return "pg";
  if (max === "r15" || explicitAllowed === false) return "blood";
  return "gore";
}

/** The live tier, read through content-rating.cjs (fails closed to pg on any error). */
function viewerTierNow(rating = require("./content-rating.cjs")) {
  try {
    return viewerTierFrom({
      adultContentVisible: rating.isAdultContentVisible(),
      maxRating: rating.contentCeiling().maxRating,
      explicitAllowed: rating.getSafetyExplicitAllowed(),
    });
  } catch {
    return "pg";
  }
}

/** The event main sends the avatar window for one body (null injuries clears its overlay). */
function injuriesEvent(slotId, name, opts = {}) {
  const injuries = injuriesOf(name, opts);
  return { type: "injuries-avatar", slotId, injuries, viewerTier: opts.viewerTier || viewerTierNow() };
}

// De-dup: the tray refresh (every gate re-read) replays these; only a CHANGE is worth a send.
const lastSent = new Map();
function changed(event) {
  const key = JSON.stringify([event.injuries, event.viewerTier]);
  if (lastSent.get(event.slotId) === key) return false;
  lastSent.set(event.slotId, key);
  return true;
}
/** Forget what was sent (a renderer reload starts empty). */
function resetSent() {
  lastSent.clear();
}

module.exports = { injuriesOf, viewerTierFrom, viewerTierNow, injuriesEvent, changed, resetSent, MAX_BYTES };
