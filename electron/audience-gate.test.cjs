"use strict";

/**
 * The audience gate end to end through content-rating (owner 2026-11-17): the active profile and
 * safe mode decide which bodies may be drawn, AND-ed with the platform gate. Separate process
 * state: every seam (roster, mirror, audit, cast file) points at this file's own temp dir.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "audience-gate-"));
const ROSTER = path.join(TMP, "characters");
const MIRROR = path.join(TMP, "adult_content.json");
const CAST = path.join(TMP, "cast.json");
process.env.DESK_ROSTER_DIR = ROSTER;
process.env.DESK_ADULT_CONTENT_MIRROR = MIRROR;
process.env.DESK_ADULT_CONTENT_LOG = path.join(TMP, "adult_content.log");
process.env.DESK_CAST_FILE = CAST;

const rating = require("./content-rating.cjs");
const cast = require("./cast-config.cjs");

function character(name, record) {
  fs.mkdirSync(path.join(ROSTER, name), { recursive: true });
  fs.writeFileSync(path.join(ROSTER, name, "model.vrm"), "x");
  if (record) fs.writeFileSync(path.join(ROSTER, name, "character.json"), JSON.stringify(record));
}
character("kid-safe", { rating: "general", source: "manual" });
character("teen-one", { rating: "r15", source: "vision" });
character("mature-one", { rating: "r18", source: "vroid" });
character("nobody-looked", null);
fs.writeFileSync(MIRROR, JSON.stringify({ visible: true }));

function setGallery(gallery) {
  const r = cast.write((d) => { d.gallery = gallery; return d; }, { file: CAST });
  assert.equal(r.ok, true, r.error || "");
  rating.invalidateGate();
}
const visible = () => ["kid-safe", "teen-one", "mature-one", "nobody-looked"].filter((n) => !rating.isHidden(n));

test("Personal (mature) with the gate open shows everything, unrated included", () => {
  setGallery({ profile: "personal" });
  rating.setAutoSafe(false);
  assert.deepEqual(visible(), ["kid-safe", "teen-one", "mature-one", "nobody-looked"]);
});

test("Work (teen) hides mature AND unrated", () => {
  setGallery({ profile: "work" });
  assert.deepEqual(visible(), ["kid-safe", "teen-one"]);
  assert.equal(rating.hiddenReason("mature-one"), "audience");
});

test("Hearth (everyone) shows only everyone-rated bodies", () => {
  setGallery({ profile: "hearth" });
  assert.deepEqual(visible(), ["kid-safe"]);
});

test("safe mode (his switch) beats the Personal profile at once", () => {
  setGallery({ profile: "personal", safeMode: true });
  assert.deepEqual(visible(), ["kid-safe"]);
  assert.match(rating.refusalFor("mature-one").reason, /everyone only/);
});

test("a detected share/stream (auto safe) beats the Personal profile until it ends", () => {
  setGallery({ profile: "personal", safeMode: false });
  rating.setAutoSafe(true);
  assert.deepEqual(visible(), ["kid-safe"]);
  assert.match(rating.refusalFor("teen-one").reason, /screen share or stream/);
  rating.setAutoSafe(false);
  assert.equal(visible().length, 4);
});

test("the platform gate still ANDs: closed gate hides teen/mature/unrated even on Personal", () => {
  setGallery({ profile: "personal" });
  fs.writeFileSync(MIRROR, JSON.stringify({ visible: false }));
  rating.invalidateGate();
  assert.deepEqual(visible(), ["kid-safe"]);
  fs.writeFileSync(MIRROR, JSON.stringify({ visible: true }));
  rating.invalidateGate();
});

test("an unreadable cast.json is the family audience, never the last profile it said (review of #122)", () => {
  setGallery({ profile: "personal" });
  fs.writeFileSync(CAST, "{ not json");
  rating.invalidateGate();
  assert.deepEqual(visible(), ["kid-safe"]);
  setGallery({ profile: "personal" });
  assert.equal(visible().length, 4);
});
