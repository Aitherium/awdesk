"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const g = require("./avatar-gallery.cjs");

test("ratings speak the owner's words; no verdict counts as mature", () => {
  assert.equal(g.tierOf("general"), "everyone");
  assert.equal(g.tierOf("r15"), "teen");
  assert.equal(g.tierOf("r18"), "mature");
  assert.equal(g.tierOf(""), "unrated");
  assert.equal(g.tierAllowed("unrated", "teen"), false);
  assert.equal(g.tierAllowed("unrated", "everyone"), false);
  assert.equal(g.tierAllowed("unrated", "mature"), true);
  assert.equal(g.tierAllowed("teen", "everyone"), false);
  assert.equal(g.tierAllowed("everyone", "everyone"), true);
});

test("VRoid Hub fields decide a rating where they speak", () => {
  assert.equal(g.ratingFromVroid({ age_limit: { is_r18: true } }), "r18");
  assert.equal(g.ratingFromVroid({ age_limit: { is_r15: true, is_r18: false } }), "r15");
  assert.equal(g.ratingFromVroid({ age_limit: { is_r15: false, is_r18: false }, license: { sexual_expression: "allow" } }), "r15");
  assert.equal(g.ratingFromVroid({ age_limit: { is_r15: false, is_r18: false }, license: { sexual_expression: "disallow" } }), "general");
  assert.equal(g.ratingFromVroid({}), null, "silence is not 'everyone'");
});

test("audience: Hearth=everyone, Work=teen, Personal=mature; safe mode forces everyone", () => {
  const at = (profile, extra = {}) => g.audienceCap(g.readGallery({ gallery: { profile, ...extra } }));
  assert.equal(at("hearth"), "everyone");
  assert.equal(at("work"), "teen");
  assert.equal(at("personal"), "mature");
  assert.equal(at("personal", { safeMode: true }), "everyone");
  assert.equal(g.audienceCap(g.readGallery({ gallery: { profile: "personal" } }), { autoSafe: true }), "everyone");
  assert.equal(g.ceilingRating("teen"), "r15");
});

test("rotation never leaves his set or the audience, and is the same all day (no randomness)", () => {
  const rotation = { set: ["a", "b", "c"], every: "daily" };
  const day = new Date("2026-11-17T09:00:00");
  const later = new Date("2026-11-17T22:00:00");
  const first = g.rotationPick(rotation, { date: day });
  assert.ok(rotation.set.includes(first));
  assert.equal(g.rotationPick(rotation, { date: later }), first, "the same pick all day");
  const next = g.rotationPick(rotation, { date: new Date("2026-11-18T09:00:00") });
  assert.notEqual(next, first, "a new day moves along his set");
  assert.equal(g.rotationPick(rotation, { date: day, allowed: (n) => n === "c" }), "c", "only what the audience allows");
  assert.equal(g.rotationPick(rotation, { date: day, allowed: () => false }), null, "nothing allowed = no change");
  const plan = g.planRotation({ authors: { aither: { character: "z" } }, gallery: { rotation: { aither: rotation } } }, { date: day });
  assert.deepEqual(plan, { aither: first });
});

test("assign is an owner action; the avatar's voice fills only an empty voice (#104 no-overwrite)", () => {
  const draft = { authors: { iris: { voice: "en-US-AriaNeural" } }, gallery: { avatars: { herta: { voice: "en-US-JennyNeural" } } } };
  g.assignMutation("iris", "herta")(draft);
  assert.equal(draft.authors.iris.character, "herta");
  assert.equal(draft.authors.iris.voice, "en-US-AriaNeural", "his voice is kept");
  g.assignMutation("lyra", "herta")(draft);
  assert.equal(draft.authors.lyra.voice, "en-US-JennyNeural", "an empty voice takes the avatar's linked voice");
  g.assignMutation("iris", "herta", { useAvatarVoice: true })(draft);
  assert.equal(draft.authors.iris.voice, "en-US-JennyNeural", "his explicit choice");
  g.unassignMutation("iris")(draft);
  assert.equal(draft.authors.iris.character, undefined);
  assert.equal(draft.authors.iris.voice, "en-US-JennyNeural", "unassigning a body leaves the voice");
});

test("per-avatar config is validated on read", () => {
  const draft = {};
  g.avatarConfigMutation("herta", { nickname: "Herta", scale: 9, idle: "lively", physics: "bouncy", voice: "v" })(draft);
  const read = g.readGallery(draft).avatars.herta;
  assert.equal(read.nickname, "Herta");
  assert.equal(read.scale, 1, "an out-of-range scale reads as 1, never a giant");
  assert.equal(read.idle, "lively");
  assert.equal(read.physics, "bouncy");
});

test("personas: tools are not personas; chaos is malfoid; aither first", () => {
  const ids = g.personaIds({ authors: { scribe: {}, gobbonet: {}, chaos: {}, atlas: {}, aither: {} }, rosterAgents: ["hera", "awdesk"] });
  assert.deepEqual(ids, ["aither", "atlas", "hera", "malfoid"]);
});

test("proposals never touch cast.json; taking one removes it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-prop-"));
  const p = g.propose(dir, { persona: "Atlas", character: "atlas", by: "atlas", why: "my build landed" });
  assert.equal(p.persona, "atlas");
  assert.equal(fs.existsSync(path.join(dir, "cast.json")), false);
  g.propose(dir, { persona: "atlas", character: "atlas" });
  assert.equal(g.readProposals(dir).length, 1, "the same proposal is not stacked");
  const taken = g.takeProposal(dir, g.readProposals(dir)[0].id);
  assert.equal(taken.character, "atlas");
  assert.deepEqual(g.readProposals(dir), []);
});
