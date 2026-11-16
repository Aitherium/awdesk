"use strict";

/**
 * The registry's agent avatars reach an existing desk once (agent-avatar-defaults.cjs).
 *
 * Pinned (owner P0 2026-11-16: a body he has seen is never replaced without his OK): only a
 * MISSING row is filled (nova, chaos); every body already on a row is kept, an old default
 * included; a catalog pull fills empty rows only (`replace` is the person's own sync); a body
 * the owner put back by hand is adopted and told to the catalog; Aither is left to
 * aither-body.cjs, an agent is decided once, a backup is written beside cast.json before the
 * first write, a filled agent is held from catalog pulls until the catalog takes it, and the
 * committed mirror matches the desk's own Aither body table.
 *
 * Fixtures live in a per-process temp dir (DESK_CAST_FILE / DESK_ROSTER_DIR): the real
 * cast.json and characters/ are never touched.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "desk-agent-defaults-"));
const ROSTER = path.join(TMP, "characters");
const CAST = path.join(TMP, "cast.json");
process.env.DESK_ROSTER_DIR = ROSTER;
process.env.DESK_CAST_FILE = CAST;
process.env.DESK_ADULT_CONTENT_MIRROR = path.join(TMP, "adult-content.json");
process.env.DESK_ADULT_CONTENT_LOG = path.join(TMP, "adult-content.log");
process.env.DESK_PARTY_FILE = path.join(TMP, "party.json");
process.env.DESK_AGENT_AVATARS_FILE = path.join(TMP, "legacy-agent-avatars.json");
fs.mkdirSync(ROSTER, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const defaults = require("./agent-avatar-defaults.cjs");
const sync = require("./avatar-catalog-sync.cjs");
const aitherBody = require("./aither-body.cjs");

const REGISTRY = {
  agents: {
    aither: { character: "aither-v2", supersedes: ["mermaid"], bodies: {
      female: { character: "aither-v2", spec: "aither-v2", library_id: "Aither-90044575" },
      male: { character: "aither-m", spec: "aither-m", library_id: "Aither-573ecf39" } } },
    atlas: { character: "atlas", supersedes: ["charlie"], bodies: { default: { character: "atlas", spec: "atlas", library_id: "atlas-9be08ecb" } } },
    lyra: { character: "lyra", supersedes: ["clara-hsr-vrm-0-0"], bodies: { default: { character: "lyra", spec: "lyra", library_id: "Lyra-dff26de3" } } },
    nova: { character: "nova", supersedes: [], bodies: { default: { character: "nova", spec: "nova", library_id: "nova-8d41dc57" } } },
    saga: { character: "saga", supersedes: [], bodies: { default: { character: "saga", spec: "saga", library_id: "Saga-365cd728" } } },
    vera: { character: "vera", supersedes: [], bodies: { default: { character: "vera", spec: "vera", library_id: "Vera-6153efbb" } } },
    hera: { character: "hera", supersedes: [], bodies: { default: { character: "hera", spec: "hera", library_id: "Hera-5c06ab74" } } },
  },
};
const NAMES = ["aither-v2", "aither-m", "atlas", "lyra", "nova", "saga", "vera", "charlie-5e48d775", "orion"];

test("planDefaults: the registry writes NO body onto an existing desk; every row is kept, an empty one too (the automatic pick stands)", () => {
  const records = { "saga-365cd728": { spec: "saga", library_id: "Saga-365cd728" } };
  const plan = defaults.planDefaults({
    registry: REGISTRY,
    names: [...NAMES, "saga-365cd728"],
    recordOf: (n) => records[n] || null,
    authors: {
      aither: { character: "mermaid" },
      atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" },
      lyra: { character: "clara-hsr-vrm-0-0" },
      saga: { character: "saga-365cd728" },
      vera: { character: "orion" },
    },
  });
  assert.deepEqual(plan.changes, [], "owner 2026-11-16: a body he has seen is never replaced, and an empty row is drawn with an automatic pick he has seen too");
  assert.deepEqual(plan.keep.map((k) => [k.agent, k.why]), [
    ["atlas", "the person's own choice"],
    ["lyra", "the person's own choice"],
    ["nova", "no row: the desk's automatic pick stands"],
    ["saga", "already the registry body"],
    ["vera", "the person's own choice"],
  ]);
  assert.deepEqual(plan.waiting, ["hera"], "no hera build on this desk: decided on a later boot");
  assert.ok(!plan.keep.some((k) => k.agent === "aither"), "aither-body.cjs owns Aither's row");
});

test("planDefaults: an agent already decided is never decided again", () => {
  const plan = defaults.planDefaults({ registry: REGISTRY, names: NAMES, authors: {},
    state: { seen: { atlas: "atlas", lyra: "lyra", nova: "nova", saga: "saga", vera: "vera" } } });
  assert.deepEqual(plan.keep, []);
  assert.deepEqual(plan.changes, []);
});

test("runDefaults writes nothing to cast.json: no backup, no change, nothing held", () => {
  fs.writeFileSync(CAST, JSON.stringify({ version: 1, authors: {
    atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" },
    lyra: { voice: "en-US-AriaNeural" },
    vera: { character: "orion" },
  } }));
  const before = fs.readFileSync(CAST, "utf8");
  const out = defaults.runDefaults({ registry: REGISTRY, names: NAMES, castFile: CAST, now: () => new Date("2026-11-16T18:00:00Z") });
  assert.equal(out.ok, true);
  assert.deepEqual(out.plan.changes, []);
  assert.equal(out.backup, null);
  assert.equal(fs.readFileSync(CAST, "utf8"), before, "cast.json is byte for byte what it was");
  assert.equal(defaults.heldAgents(TMP).size, 0);
});

test("a pending body (one the person put back, adopted) survives an older cast emptying the row; a body named since is never replaced", () => {
  defaults.writeState(TMP, { seen: {}, pending: { lyra: "lyra", nova: "nova" }, from: {} });
  fs.writeFileSync(CAST, JSON.stringify({ version: 1, authors: { lyra: { voice: "x" }, nova: { character: "charlie-5e48d775" } } }));
  const fixed = defaults.reassertPending({ dir: TMP, castFile: CAST, registry: REGISTRY });
  assert.deepEqual(fixed, [{ agent: "lyra", to: "lyra" }]);
  const now = JSON.parse(fs.readFileSync(CAST, "utf8")).authors;
  assert.equal(now.lyra.character, "lyra");
  assert.equal(now.nova.character, "charlie-5e48d775", "a row naming any body is the person's");
  defaults.writeState(TMP, { seen: {}, pending: {}, from: {} });
});

function pullFixtures() {
  for (const name of ["atlas", "lyra", "nova", "saga", "charlie-5e48d775"]) {
    fs.mkdirSync(path.join(ROSTER, name), { recursive: true });
    fs.writeFileSync(path.join(ROSTER, name, "model.vrm"), "glTF");
    fs.writeFileSync(path.join(ROSTER, name, "character.json"), JSON.stringify({
      library_id: name === "charlie-5e48d775" ? "charlie-5e48d775" : REGISTRY.agents[name].bodies.default.library_id, rating: "general" }));
  }
}

test("a catalog pull leaves a held agent alone; the push clears the hold", async () => {
  pullFixtures();
  fs.writeFileSync(CAST, JSON.stringify({ version: 1, authors: { lyra: { character: "lyra" } } }));
  defaults.writeState(TMP, { seen: {}, pending: { lyra: "lyra" }, from: {} });
  const puts = [];
  const client = {
    async avatarCatalog() {
      return { ok: true, avatars: [{ id: "charlie-5e48d775", sha256: "" }], starters: [], agents: { lyra: "charlie-5e48d775" }, active: null };
    },
    async putAgentAvatar(agent, id) { puts.push([agent, id]); return { ok: true }; },
    async avatarLibrary() { return { ok: true, avatars: [] }; },
  };
  const library = { async ensureLibraryAvatar() { throw new Error("a held agent must not be downloaded"); } };
  const pulled = await sync.syncFromCatalog({ client, library, defaultsDir: TMP });
  assert.deepEqual(pulled.results, [{ agent: "lyra", ok: true, held: true, reason: "a desk move the catalog has not taken yet" }]);
  assert.equal(JSON.parse(fs.readFileSync(CAST, "utf8")).authors.lyra.character, "lyra");
  const pushed = await sync.pushPendingDefaults({ client, defaultsDir: TMP });
  assert.equal(pushed.ok, true);
  assert.deepEqual(puts, [["lyra", "Lyra-dff26de3"]]);
  assert.equal(defaults.heldAgents(TMP).size, 0, "every agent the catalog took is no longer held");
});

test("a body ANOTHER desk assigned still follows the person here: a row a pull wrote is replaced by the next pull, a row the person made is not", async () => {
  pullFixtures();
  const dir = fs.mkdtempSync(path.join(TMP, "follow-"));
  defaults.writeState(dir, { seen: {}, pending: {}, from: {} });
  fs.writeFileSync(CAST, JSON.stringify({ version: 1, authors: { saga: { character: "saga" }, atlas: { character: "charlie-5e48d775" } } }));
  defaults.markPulled(dir, "saga", "saga"); // the pull put it there: never his choice
  const lib = (name) => ({ async ensureLibraryAvatar() { return { ok: true, name, installed: false }; }, async ensureVroidReference() { return { ok: false }; } });
  const client = {
    async avatarCatalog() {
      return { ok: true, avatars: [{ id: "lyra-1", sha256: "" }, { id: "x", sha256: "" }], starters: [], agents: { saga: "lyra-1", atlas: "x" }, active: null };
    },
  };
  let asked = [];
  const library = { async ensureLibraryAvatar(rec) { asked.push(rec.id); return { ok: true, name: rec.id === "lyra-1" ? "lyra" : "nova", installed: false }; }, async ensureVroidReference() { return { ok: false }; } };
  void lib;
  const out = await sync.syncFromCatalog({ client, library, defaultsDir: dir });
  const by = Object.fromEntries(out.results.map((r) => [r.agent, r]));
  assert.equal(by.saga.changed, true, "a pulled row follows the catalog");
  assert.equal(by.atlas.kept, true, "his own row stays");
  const cast = JSON.parse(fs.readFileSync(CAST, "utf8")).authors;
  assert.equal(cast.saga.character, "lyra");
  assert.equal(cast.atlas.character, "charlie-5e48d775");
  asked = [];
});

test("P0 2026-11-16: a catalog that names a registry body can NOT pull it over a body the desk shows; only 'replace' (the person's own sync) does", async () => {
  pullFixtures();
  const cast = JSON.parse(fs.readFileSync(CAST, "utf8"));
  cast.authors.atlas = { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" }; // the owner's restored body
  fs.writeFileSync(CAST, JSON.stringify(cast));
  const client = {
    async avatarCatalog() {
      return { ok: true, avatars: [{ id: "atlas-9be08ecb", sha256: "" }], starters: [], agents: { atlas: "atlas-9be08ecb" }, active: null };
    },
  };
  const library = {
    async ensureLibraryAvatar() { return { ok: true, name: "atlas", installed: false }; },
    async ensureVroidReference() { return { ok: false }; },
  };
  const pulled = await sync.syncFromCatalog({ client, library, defaultsDir: TMP });
  assert.deepEqual(pulled.results, [{ agent: "atlas", ok: true, name: "charlie-5e48d775", installed: false, changed: false, kept: true, reason: "this desk already shows a body for it" }]);
  assert.equal(JSON.parse(fs.readFileSync(CAST, "utf8")).authors.atlas.character, "charlie-5e48d775", "the restored body survives the pull");
  // A VOICE the owner has heard obeys the same rule: a pull, a fill and even 'replace' write bodies, never voices.
  const voiceOf = () => JSON.parse(fs.readFileSync(CAST, "utf8")).authors.atlas.voice;
  assert.equal(voiceOf(), "en-US-MichelleNeural", "the pull left the voice alone");
  // A pull still FILLS an empty row.
  const bare = JSON.parse(fs.readFileSync(CAST, "utf8"));
  delete bare.authors.atlas.character;
  fs.writeFileSync(CAST, JSON.stringify(bare));
  const filled = await sync.syncFromCatalog({ client, library, defaultsDir: TMP });
  assert.equal(filled.results[0].changed, true);
  assert.equal(JSON.parse(fs.readFileSync(CAST, "utf8")).authors.atlas.character, "atlas");
  assert.equal(voiceOf(), "en-US-MichelleNeural", "filling an empty body row left the voice alone");
  // The person's own manual sync is their OK.
  const cast2 = JSON.parse(fs.readFileSync(CAST, "utf8"));
  cast2.authors.atlas.character = "charlie-5e48d775";
  fs.writeFileSync(CAST, JSON.stringify(cast2));
  const replaced = await sync.syncFromCatalog({ client, library, defaultsDir: TMP, replace: true });
  assert.equal(replaced.results[0].changed, true);
  assert.equal(JSON.parse(fs.readFileSync(CAST, "utf8")).authors.atlas.character, "atlas");
  assert.equal(voiceOf(), "en-US-MichelleNeural", "even the person's own replace never touches a voice");
});

test("owner P0 2026-11-16: neither the registry plan nor a catalog pull can change a voice, whatever the catalog says", async () => {
  pullFixtures();
  const before = JSON.parse(fs.readFileSync(CAST, "utf8"));
  before.authors = {
    atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" },
    lyra: { character: "lyra", voice: "en-US-JennyNeural" },
    aither: { voice: "custom:aither" },
  };
  fs.writeFileSync(CAST, JSON.stringify(before));
  const voices = () => Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(CAST, "utf8")).authors).map(([k, v]) => [k, v.voice]));
  const want = voices();
  const plan = defaults.planDefaults({ registry: REGISTRY, authors: before.authors, names: NAMES });
  assert.deepEqual(plan.changes, [], "the registry plan writes nothing onto an existing desk");
  const client = {
    async avatarCatalog() {
      return { ok: true, avatars: [{ id: "lyra-dff26de3", sha256: "" }], starters: [], agents: { lyra: "lyra-dff26de3", atlas: "atlas-9be08ecb" }, active: null, voices: { lyra: "nova", atlas: "echo" } };
    },
  };
  const library = {
    async ensureLibraryAvatar() { return { ok: true, name: "lyra", installed: false }; },
    async ensureVroidReference() { return { ok: false }; },
  };
  await sync.syncFromCatalog({ client, library, defaultsDir: TMP });
  assert.deepEqual(voices(), want, "a pull leaves every voice as the owner has it");
  await sync.syncFromCatalog({ client, library, defaultsDir: TMP, replace: true });
  assert.deepEqual(voices(), want, "a replace leaves every voice as the owner has it");
});

test("a body the owner put back by hand is adopted: kept, and told to the catalog (the four restored on 2026-11-16)", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "adopt-"));
  const castFile = path.join(dir, "cast.json");
  fs.writeFileSync(castFile, JSON.stringify({ version: 1, authors: {
    atlas: { character: "charlie-5e48d775" }, // restored by hand
    iris: { character: "iris" },              // still the registry body: not a restore
    lyra: { character: "clara-hsr-vrm-0-0-f0070392" },
  } }));
  defaults.writeState(dir, {
    seen: { atlas: "atlas", iris: "iris", lyra: "lyra" }, pending: {},
    from: { atlas: "charlie-5e48d775", iris: "herta-hsr-vrm-0-0-6076f3b1", lyra: "clara-hsr-vrm-0-0-f0070392" },
  });
  const adopted = defaults.adoptRestored({ dir, castFile });
  assert.deepEqual(adopted, [{ agent: "atlas", character: "charlie-5e48d775" }, { agent: "lyra", character: "clara-hsr-vrm-0-0-f0070392" }]);
  const state = defaults.readState(dir);
  assert.deepEqual(state.pending, { atlas: "charlie-5e48d775", lyra: "clara-hsr-vrm-0-0-f0070392" }, "queued for the catalog, and held from a pull meanwhile");
  assert.deepEqual(state.chosen, { atlas: "charlie-5e48d775", lyra: "clara-hsr-vrm-0-0-f0070392" });
  assert.deepEqual(defaults.adoptRestored({ dir, castFile }), [], "adopted once");
  // And the push tells the catalog THIS body.
  const puts = [];
  const client = {
    async putAgentAvatar(agent, id) { puts.push([agent, id]); return { ok: true }; },
  };
  for (const name of ["charlie-5e48d775", "clara-hsr-vrm-0-0-f0070392"]) {
    fs.mkdirSync(path.join(ROSTER, name), { recursive: true });
    fs.writeFileSync(path.join(ROSTER, name, "model.vrm"), "glTF");
    fs.writeFileSync(path.join(ROSTER, name, "character.json"), JSON.stringify({ library_id: name, rating: "general" }));
  }
  const pushed = await sync.pushPendingDefaults({ client, defaultsDir: dir });
  assert.equal(pushed.ok, true);
  assert.deepEqual(puts.sort(), [["atlas", "charlie-5e48d775"], ["lyra", "clara-hsr-vrm-0-0-f0070392"]]);
  assert.equal(defaults.heldAgents(dir).size, 0);
});

test("the committed registry mirror: twelve bodies, and Aither's are aither-body.cjs's", () => {
  const mirror = defaults.loadRegistry();
  const bodies = Object.values(mirror.agents).flatMap((a) => Object.values(a.bodies));
  assert.equal(bodies.length, 12);
  for (const agent of ["atlas", "chaos", "demiurge", "hera", "iris", "lyra", "nova", "saga", "themis", "vera"]) {
    assert.equal(mirror.agents[agent].character, agent);
  }
  const want = Object.fromEntries(aitherBody.BODIES.map((b) => [b.id, [b.character, b.spec]]));
  const got = Object.fromEntries(Object.entries(mirror.agents.aither.bodies).map(([id, b]) => [id, [b.character, b.spec]]));
  assert.deepEqual(got, want);
  assert.equal(mirror.agents.aither.default_body, aitherBody.DEFAULT_BODY);
});

test("review of #104: a row the PERSON made is never marked as pulled, and assigning clears a pulled mark", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "mark-"));
  defaults.writeState(dir, { seen: {}, pending: {}, from: {} });
  // The same body the catalog names, already the person's, model folder missing on this desk -> no mark.
  fs.writeFileSync(CAST, JSON.stringify({ version: 1, authors: { demiurge: { character: "no-model-here" } } }));
  const client = {
    async avatarCatalog() { return { ok: true, avatars: [{ id: "x", sha256: "" }], starters: [], agents: { demiurge: "x" }, active: null }; },
    async putAgentAvatar() { return { ok: true }; },
  };
  const library = { async ensureLibraryAvatar() { return { ok: true, name: "no-model-here", installed: true }; }, async ensureVroidReference() { return { ok: false }; } };
  await sync.syncFromCatalog({ client, library, defaultsDir: dir });
  assert.deepEqual(defaults.pulledMap(dir), {}, "unchanged = nobody's pull wrote it");
  // A pulled mark is forgotten when the person assigns.
  defaults.markPulled(dir, "demiurge", "no-model-here");
  assert.equal(defaults.pulledMap(dir).demiurge, "no-model-here");
  defaults.markPulled(dir, "demiurge", null);
  assert.deepEqual(defaults.pulledMap(dir), {});
});

test("a corrupt state file is kept beside itself, not silently overwritten", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "corrupt-"));
  fs.writeFileSync(path.join(dir, defaults.STATE_FILE), "{ not json");
  defaults.writeState(dir, { seen: { atlas: "atlas" }, pending: {}, from: {} });
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(`${defaults.STATE_FILE}.corrupt-`)));
  assert.equal(defaults.readState(dir).seen.atlas, "atlas");
});
