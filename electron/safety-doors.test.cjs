"use strict";

/**
 * EVERY DOOR asks the same rule (owner 2026-11-17: "respect aithersafety content settings").
 * A body the AitherSafety plane hides -- it said no-explicit, or it has not answered -- must be
 * absent from the gallery list, the persona rows, set_character, spawn_avatar, rotation, VRoid
 * Hub browse and download, whatever the profile says. Each case drives the REAL content-rating
 * (no fake isHidden), so a door that stopped asking it fails here, and each carries a mutation
 * guard: the same door with the plane saying yes lets the body through.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "safety-doors-"));
const ROSTER = path.join(TMP, "characters");
const CAST = path.join(TMP, "cast.json");
process.env.DESK_ROSTER_DIR = ROSTER;
process.env.DESK_ADULT_CONTENT_MIRROR = path.join(TMP, "adult_content.json");
process.env.DESK_ADULT_CONTENT_LOG = path.join(TMP, "adult_content.log");
process.env.DESK_CAST_FILE = CAST;
process.env.DESK_PARTY_FILE = path.join(TMP, "party.json");
fs.mkdirSync(ROSTER, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const rating = require("./content-rating.cjs");
const roster = require("./character-roster.cjs");
const cast = require("./cast-config.cjs");
const gallery = require("./avatar-gallery.cjs");
const host = require("./gallery-host.cjs");
const sync = require("./avatar-library-sync.cjs");

function character(name, record) {
  fs.mkdirSync(path.join(ROSTER, name), { recursive: true });
  fs.writeFileSync(path.join(ROSTER, name, "model.vrm"), Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]));
  fs.writeFileSync(path.join(ROSTER, name, "character.json"), JSON.stringify(record));
}
character("kid", { rating: "general", source: "manual" });
character("spicy", { rating: "r18", source: "vroid", rating_source: "vroid-hub", rating_signal: "R18" });
fs.writeFileSync(process.env.DESK_ADULT_CONTENT_MIRROR, JSON.stringify({ visible: true }));
const r = cast.write((d) => {
  d.gallery = { profile: "personal", rotation: { aither: { set: ["spicy", "kid"], every: "daily" } } };
  d.authors = { aither: { character: "spicy" } };
  return d;
}, { file: CAST });
assert.equal(r.ok, true, r.error || "");
rating.invalidateGate();

/** Run each door twice: plane closed (null and false) must hide, plane open must not. */
const CLOSED = [null, false];

function hostDeps(extra = {}) {
  return {
    rosterDir: ROSTER,
    proposalsDir: TMP,
    allNames: () => roster.listAllCharacters(),
    ratingOf: (n) => rating.getRating(n),
    isHidden: (n) => rating.isHidden(n),
    castRaw: () => cast.load({ file: CAST }).snapshot,
    ...extra,
  };
}

test("door: the gallery list", () => {
  for (const plane of CLOSED) {
    rating.setSafetyExplicitAllowed(plane);
    const state = host.buildState(hostDeps());
    assert.deepEqual(state.avatars.map((a) => a.name), ["kid"], `plane=${plane}`);
    assert.ok(!JSON.stringify(state.avatars).includes("spicy"));
  }
  rating.setSafetyExplicitAllowed(true);
  const open = host.buildState(hostDeps());
  assert.deepEqual(open.avatars.map((a) => a.name).sort(), ["kid", "spicy"]);
  assert.equal(open.avatars.find((a) => a.name === "spicy").ratingSource, "VRoid Hub R18", "the badge names its source");
});

test("door: personas (a hidden body on a persona row is never named)", () => {
  rating.setSafetyExplicitAllowed(null);
  const row = host.buildState(hostDeps()).personas.find((p) => p.id === "aither");
  assert.equal(row.character, "");
  assert.equal(row.hiddenBody, true);
  rating.setSafetyExplicitAllowed(true);
  assert.equal(host.buildState(hostDeps()).personas.find((p) => p.id === "aither").character, "spicy");
});

test("door: set_character (installCharacter) and its MCP refusal text", () => {
  for (const plane of CLOSED) {
    rating.setSafetyExplicitAllowed(plane);
    assert.equal(roster.installCharacter("spicy"), false, `plane=${plane}`);
    assert.equal(roster.listCharacters().includes("spicy"), false);
    assert.ok(rating.refusalFor("spicy"), "the refusal names the safety cause, not 'not installed'");
  }
  rating.setSafetyExplicitAllowed(true);
  assert.equal(rating.isHidden("spicy"), false, "mutation guard");
  assert.ok(roster.listCharacters().includes("spicy"));
});

test("door: spawn_avatar (planSlotInstall)", () => {
  for (const plane of CLOSED) {
    rating.setSafetyExplicitAllowed(plane);
    assert.equal(roster.planSlotInstall("spicy", "slot1"), null, `plane=${plane}`);
  }
  rating.setSafetyExplicitAllowed(true);
  assert.ok(roster.planSlotInstall("spicy", "slot1"), "mutation guard: the open plane plans the copy");
});

test("door: rotation picks only what the plane allows", () => {
  const raw = cast.load({ file: CAST }).snapshot;
  const allowed = (n) => !rating.isHidden(n);
  // A day whose index puts "spicy" first in the set (rotation is dated, never random).
  let date = new Date(2026, 10, 17, 12);
  while (gallery.rotationPick({ set: ["spicy", "kid"], every: "daily" }, { date }) !== "spicy") date = new Date(date.getTime() + 86400000);
  rating.setSafetyExplicitAllowed(null);
  const closed = gallery.planRotation(raw, { date, allowed });
  assert.deepEqual(closed.map((s) => s.name), ["kid"]);
  rating.setSafetyExplicitAllowed(true);
  assert.deepEqual(gallery.planRotation(raw, { date, allowed }).map((s) => s.name), ["spicy"], "mutation guard");
});

test("door: VRoid Hub browse (no ratingHidden injected = the real rule)", async () => {
  const models = [{ id: "1", name: "Kid", r18: false, r15: false }, { id: "2", name: "Spicy", r18: true }, { id: "3", name: "Tagged", r18: false, r15: false, tags: ["R-18"] }];
  const h = host.galleryHandlers(() => hostDeps({ vroidBrowse: async () => ({ ok: true, models }) }));
  for (const plane of CLOSED) {
    rating.setSafetyExplicitAllowed(plane);
    const page = await h.vroidBrowse({ source: "hearts" });
    assert.deepEqual(page.models.map((m) => m.name), ["Kid"], `plane=${plane}`);
    assert.equal(page.hidden, 2);
  }
  rating.setSafetyExplicitAllowed(true);
  assert.equal((await h.vroidBrowse({ source: "hearts" })).models.length, 3, "mutation guard");
});

test("door: VRoid Hub download (installVroidModel, default rule)", async () => {
  let fetched = 0;
  const client = { async vroidModel() { fetched += 1; return { ok: false, reason: "stop here" }; } };
  const model = { id: "424242", downloadable: true, r18: true };
  for (const plane of CLOSED) {
    rating.setSafetyExplicitAllowed(plane);
    const res = await sync.installVroidModel(model, { client, apply: () => false, exportParty: () => ({ ok: true }) });
    assert.equal(res.ok, false, `plane=${plane}`);
    assert.equal(fetched, 0, "nothing is fetched for a body this desk would hide");
  }
  rating.setSafetyExplicitAllowed(true);
  await sync.installVroidModel(model, { client, apply: () => false, exportParty: () => ({ ok: true }) });
  assert.equal(fetched, 1, "mutation guard: the open plane reaches the download");
});

test("main.cjs wires every door to the same content-rating rule", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /const \{ invalidateGate, isHidden \} = require\("\.\/content-rating\.cjs"\)/);
  assert.match(main, /isHidden: \(name\) => isHidden\(name\)/, "the gallery's isHidden is content-rating's");
  assert.match(main, /planRotation\(galleryCastRaw\(\), \{ allowed: \(n\) => names\.has\(n\) && !isHidden\(n\) \}\)/, "rotation");
  assert.match(main, /rating\.ratingHiddenReason\(require\("\.\/vroid-link\.cjs"\)\.ratingOfModel\(model\)\)/, "the gallery's VRoid install");
  assert.match(main, /function applyCharacter\(name\) \{\s*if \(!installCharacter\(name\)\) return false;/, "set_character");
  assert.match(main, /const plan = planSlotInstall\(name, slotId\);/, "spawn_avatar");
  assert.match(main, /setInterval\(refreshSafetyPosture, SAFETY_POLL_MS\)/, "the plane is re-asked, so a silent one ages out");
  assert.match(main, /rederiveRatingsAtStart\(\);/, "the re-derive pass runs at desk start");
  assert.doesNotMatch(main, /ratingHidden: \(\) => null/, "no production door switches the rule off");
});
