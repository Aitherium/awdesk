"use strict";

/**
 * rating-resolve.cjs: one rule from what VRoid Hub and the .vrm itself SAY about a body.
 * Hub record > Hub tags > VRM licence meta > vision guess > unrated; metadata only ever RAISES
 * the verdict already held, and `rating_source` names who decided.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rating-resolve-"));
const ROSTER = path.join(TMP, "characters");
fs.mkdirSync(ROSTER, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const r = require("./rating-resolve.cjs");

/** A real GLB container: 12-byte header, JSON chunk, and a BIN chunk the reader must not need. */
function glb(json) {
  let text = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (text.length % 4)) % 4;
  text = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
  const bin = Buffer.alloc(64, 7);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(text.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, text, bh, bin]);
}
const vrm0 = (meta) => glb({ asset: { version: "2.0" }, extensions: { VRM: { meta } } });
const vrm1 = (meta) => glb({ asset: { version: "2.0" }, extensions: { VRMC_vrm: { specVersion: "1.0", meta } } });

function character(name, record, bytes) {
  const dir = path.join(ROSTER, name);
  fs.mkdirSync(dir, { recursive: true });
  if (record) fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify(record));
  if (bytes) fs.writeFileSync(path.join(dir, "model.vrm"), bytes);
}
const recordOf = (name) => JSON.parse(fs.readFileSync(path.join(ROSTER, name, "character.json"), "utf8"));

// ── signals ─────────────────────────────────────────────────────────────────────────────────

test("Hub record: age_limit and the broker's r18/r15 flags", () => {
  assert.equal(r.ratingFromHub({ age_limit: { is_r18: true, is_r15: false } }).rating, "r18");
  assert.equal(r.ratingFromHub({ age_limit: { is_r18: false, is_r15: true } }).rating, "r15");
  assert.equal(r.ratingFromHub({ age_limit: { is_r18: false, is_r15: false } }).rating, "general");
  assert.equal(r.ratingFromHub({ age_limit: { is_r18: false, is_r15: false }, license: { sexual_expression: "allow" } }).rating, "r15");
  assert.equal(r.ratingFromHub({ r18: true }).rating, "r18");
  assert.equal(r.ratingFromHub({ r18: false, r15: false }).rating, "general");
  assert.equal(r.ratingFromHub({ name: "no flags" }), null, "a record without flags says nothing");
  assert.equal(r.ratingFromHub(null), null);
});

test("Hub tags: case-, width- and dash-insensitive, Japanese variants too", () => {
  for (const tag of ["R18", "r18", "R-18", "R‐18", "Ｒ－１８", "Ｒ18", "r 18", "NSFW", "nsfw", "18+", "18禁", "R-18G", "成人向け"]) {
    assert.equal((r.ratingFromTags([tag]) || {}).rating, "r18", tag);
  }
  for (const tag of ["R15", "R-15", "Ｒ－１５", "15+", "15禁"]) {
    assert.equal((r.ratingFromTags([tag]) || {}).rating, "r15", tag);
  }
  assert.equal(r.ratingFromTags([{ name: "R-18" }]).rating, "r18", "API shape {name}");
  assert.equal(r.ratingFromTags(["R15", "R18"]).rating, "r18", "the strictest tag wins");
  assert.equal(r.ratingFromTags(["cute", "R180mm", "kitsune"]), null, "a tag that only CONTAINS r18 is not one");
  assert.equal(r.ratingFromTags(null), null);
});

test("VRM 0.x meta: sexualUssageName Allow is a TEEN floor; Disallow and violence alone say nothing", () => {
  const read = (meta) => r.ratingFromVrmMeta(r.vrmMetaFromBuffer(vrm0(meta)));
  assert.equal(read({ sexualUssageName: "Allow" }).rating, "r15");
  assert.match(read({ sexualUssageName: "Allow" }).signal, /VRM 0\.x/);
  assert.equal(read({ sexualUssageName: "Disallow", violentUssageName: "Disallow" }), null);
  assert.equal(read({ violentUssageName: "Allow" }), null, "the forge stamps violence on every Aither");
});

test("VRM 1.0 meta: allowExcessivelySexualUsage is a TEEN floor", () => {
  const read = (meta) => r.ratingFromVrmMeta(r.vrmMetaFromBuffer(vrm1(meta)));
  assert.equal(read({ allowExcessivelySexualUsage: true }).rating, "r15");
  assert.match(read({ allowExcessivelySexualUsage: true }).signal, /VRM 1\.0/);
  assert.equal(read({ allowExcessivelySexualUsage: false, allowExcessivelyViolentUsage: true }), null);
});

test("readVrmMeta reads only the JSON chunk of a real file; garbage is null", () => {
  character("meta-file", null, vrm1({ allowExcessivelySexualUsage: true, name: "x" }));
  const got = r.readVrmMeta(path.join(ROSTER, "meta-file", "model.vrm"));
  assert.equal(got.version, "1.0");
  assert.equal(got.meta.allowExcessivelySexualUsage, true);
  character("not-glb", null, Buffer.from("this is not a model at all"));
  assert.equal(r.readVrmMeta(path.join(ROSTER, "not-glb", "model.vrm")), null);
  assert.equal(r.readVrmMeta(path.join(ROSTER, "nothing-here", "model.vrm")), null);
  assert.equal(r.vrmMetaFromBuffer(glb({ asset: { version: "2.0" } })), null, "a glTF with no VRM extension");
});

// ── precedence and never-lower ─────────────────────────────────────────────────────────────

test("precedence: the Hub record decides over the VRM licence, tags may only raise the Hub", () => {
  const meta = r.vrmMetaFromBuffer(vrm0({ sexualUssageName: "Allow" }));
  const allAges = { age_limit: { is_r18: false, is_r15: false } };
  assert.deepEqual(r.resolveRating({ hub: allAges, vrmMeta: meta }), { rating: "general", rating_source: "vroid-hub", signal: "all ages" });
  assert.equal(r.resolveRating({ hub: allAges, tags: ["R-18"] }).rating_source, "vroid-tags");
  assert.equal(r.resolveRating({ hub: allAges, tags: ["R-18"] }).rating, "r18");
  assert.equal(r.resolveRating({ hub: { r18: true }, tags: ["R15"] }).rating, "r18", "a teen tag never lowers the Hub's R18");
  assert.equal(r.resolveRating({ hub: { r18: true }, tags: ["R15"] }).rating_source, "vroid-hub");
  assert.equal(r.resolveRating({ vrmMeta: meta }).rating, "unrated",
    "a licence alone is no verdict: unrated (= mature, hidden) stays unrated until someone looks");
  assert.deepEqual(r.resolveRating({}), { rating: "unrated", rating_source: "unrated", signal: "" });
});

test("never lower: metadata only RAISES the vision guess, and relabels it at equal strictness", () => {
  const vision = (rating) => ({ rating, source: "vision" });
  const allAges = { r18: false, r15: false };
  assert.equal(r.resolveRating({ hub: allAges, current: vision("r15") }).rating, "r15", "a Hub 'general' never lowers a vision 'teen'");
  assert.equal(r.resolveRating({ hub: allAges, current: vision("r15") }).rating_source, "vision");
  assert.equal(r.resolveRating({ hub: allAges, current: vision("general") }).rating_source, "vroid-hub", "same strictness, stronger source");
  assert.equal(r.resolveRating({ hub: { r18: true }, current: vision("r15") }).rating, "r18", "raised");
  assert.equal(r.resolveRating({ tags: ["NSFW"], current: vision("general") }).rating, "r18");
  const meta = r.vrmMetaFromBuffer(vrm0({ sexualUssageName: "Allow" }));
  assert.equal(r.resolveRating({ vrmMeta: meta, current: vision("r18") }).rating, "r18", "a teen licence never lowers a mature guess");
  assert.equal(r.resolveRating({ vrmMeta: meta, current: vision("general") }).rating, "r15");
  assert.equal(r.resolveRating({ vrmMeta: meta, current: { rating: "general", source: "vroid" } }).rating, "general",
    "a verdict the Hub already wrote is not overruled by a licence permission");
  assert.equal(r.resolveRating({ vrmMeta: meta, current: { rating: "general", source: "default" } }).rating, "unrated",
    "the rater's 'nobody looked' stamp is no floor, and the licence alone never judges");
});

// ── on disk: the re-derive pass ─────────────────────────────────────────────────────────────

test("deriveCharacter writes rating + rating_source when stricter, keeps every other key, never lowers", () => {
  character("kitsune", { rating: "r15", source: "vision", note: "keep me" }, vrm0({ sexualUssageName: "Allow", title: "Gold Fox" }));
  const row = r.deriveCharacter(ROSTER, "kitsune");
  assert.equal(row.changed, true, "same strictness, stronger source: relabelled");
  const rec = recordOf("kitsune");
  assert.equal(rec.rating, "r15");
  assert.equal(rec.rating_source, "vrm-meta");
  assert.equal(rec.source, "vision", "the original source is kept");
  assert.equal(rec.note, "keep me");
  assert.equal(r.deriveCharacter(ROSTER, "kitsune").changed, false, "idempotent");

  character("guessed-mature", { rating: "r18", source: "vision" }, vrm0({ sexualUssageName: "Allow" }));
  assert.equal(r.deriveCharacter(ROSTER, "guessed-mature").changed, false);
  assert.equal(recordOf("guessed-mature").rating, "r18", "never lowered");

  character("hub-tagged", { rating: "general", source: "vision", vroid_hub: { r18: false, r15: false, tags: ["Ｒ－１８"] } }, vrm1({}));
  r.deriveCharacter(ROSTER, "hub-tagged");
  assert.equal(recordOf("hub-tagged").rating, "r18");
  assert.equal(recordOf("hub-tagged").rating_source, "vroid-tags");

  character("no-file-yet", null, vrm1({ allowExcessivelySexualUsage: true }));
  assert.equal(r.deriveCharacter(ROSTER, "no-file-yet").changed, false, "never judged: left for the rater, still hidden");
  assert.equal(fs.existsSync(path.join(ROSTER, "no-file-yet", "character.json")), false);
});

test("rederiveRoster returns only what changed; a dry run writes nothing", () => {
  character("dry", { rating: "general", source: "vision" }, vrm0({ sexualUssageName: "Allow" }));
  const before = fs.readFileSync(path.join(ROSTER, "dry", "character.json"), "utf8");
  const dry = r.rederiveRoster(ROSTER, { write: false });
  assert.ok(dry.some((x) => x.name === "dry" && x.rating === "r15"));
  assert.equal(fs.readFileSync(path.join(ROSTER, "dry", "character.json"), "utf8"), before);
  r.rederiveRoster(ROSTER);
  assert.equal(r.rederiveRoster(ROSTER).length, 0, "a second pass changes nothing");
});

test("content-rating reads a derived verdict as JUDGED even over the rater's 'default' stamp", () => {
  process.env.DESK_ROSTER_DIR = ROSTER;
  delete require.cache[require.resolve("./content-rating.cjs")];
  const rating = require("./content-rating.cjs");
  character("stamped", { rating: "general", source: "default", vroid_hub: { tags: ["NSFW"] } }, vrm0({}));
  assert.equal(rating.getRating("stamped"), "unrated");
  r.deriveCharacter(ROSTER, "stamped");
  assert.equal(rating.getRating("stamped"), "r18");
  character("licence-only", { rating: "general", source: "default" }, vrm0({ sexualUssageName: "Allow" }));
  r.deriveCharacter(ROSTER, "licence-only");
  assert.equal(rating.getRating("licence-only"), "unrated", "a licence alone never un-hides a body");
});

test("the badge says who decided", () => {
  assert.equal(r.sourceLabel({ rating: "r18", rating_source: "vroid-hub", rating_signal: "R18" }), "VRoid Hub R18");
  assert.equal(r.sourceLabel({ rating: "r18", rating_source: "vroid-tags", rating_signal: "tag R-18" }), "VRoid Hub tag R-18");
  assert.equal(r.sourceLabel({ rating: "r15", source: "vision" }), "vision guess");
  assert.equal(r.sourceLabel({ rating: "r15", rating_source: "vrm-meta", rating_signal: "sexual use allowed (VRM 0.x)" }), "VRM licence: sexual use allowed (VRM 0.x)");
  assert.equal(r.sourceLabel({ rating: "general", source: "default" }), "not rated");
  assert.equal(r.sourceLabel({}), "not rated");
});
