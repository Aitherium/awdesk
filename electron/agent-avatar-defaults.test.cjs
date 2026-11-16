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

test("planDefaults: ONLY a missing row is filled; every body the desk already shows is kept, an old default included", () => {
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
  assert.deepEqual(plan.changes, [{ agent: "nova", from: null, to: "nova" }], "owner 2026-11-16: the registry never replaces a body he has seen");
  assert.deepEqual(plan.keep.map((k) => [k.agent, k.why]), [
    ["atlas", "the person's own choice"],
    ["lyra", "the person's own choice"],
    ["saga", "already the registry body"],
    ["vera", "the person's own choice"],
  ]);
  assert.deepEqual(plan.waiting, ["hera"], "no hera build on this desk: decided on a later boot");
  assert.ok(!plan.changes.some((c) => c.agent === "aither"), "aither-body.cjs owns Aither's row");
});

test("planDefaults: an agent already decided is never decided again", () => {
  const plan = defaults.planDefaults({ registry: REGISTRY, names: NAMES, authors: {},
    state: { seen: { atlas: "atlas", lyra: "lyra", nova: "nova", saga: "saga", vera: "vera" } } });
  assert.deepEqual(plan.changes, []);
});

test("runDefaults: backup beside cast.json, empty rows filled with their voice kept, held until the catalog takes them", () => {
  fs.writeFileSync(CAST, JSON.stringify({ version: 1, authors: {
    atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" },
    lyra: { voice: "en-US-AriaNeural" },
    vera: { character: "orion" },
  } }));
  const before = fs.readFileSync(CAST, "utf8");
  const out = defaults.runDefaults({ registry: REGISTRY, names: NAMES, castFile: CAST, now: () => new Date("2026-11-16T18:00:00Z") });
  assert.equal(out.ok, true);
  assert.deepEqual(out.plan.changes.map((c) => c.agent), ["lyra", "nova", "saga"]);
  assert.equal(path.basename(out.backup), "cast.json.bak-agent-avatar-defaults-20261116-180000");
  assert.equal(fs.readFileSync(out.backup, "utf8"), before, "the backup is the cast as it was");
  const cast = JSON.parse(fs.readFileSync(CAST, "utf8"));
  assert.deepEqual(cast.authors.lyra, { character: "lyra", voice: "en-US-AriaNeural" });
  assert.equal(cast.authors.atlas.character, "charlie-5e48d775", "a body the person already shows is never replaced");
  assert.equal(cast.authors.vera.character, "orion", "the person's own choice is kept");
  assert.equal(cast.authors.nova.character, "nova");
  assert.deepEqual([...defaults.heldAgents(TMP)].sort(), ["lyra", "nova", "saga"]);
  // second boot: nothing moves, no second backup
  const again = defaults.runDefaults({ registry: REGISTRY, names: NAMES, castFile: CAST, now: () => new Date("2026-11-16T19:00:00Z") });
  assert.deepEqual(again.plan.changes, []);
  assert.equal(again.backup, null);
});

test("a pending fill survives an older cast emptying it (settings pull); a body the person named is never replaced", () => {
  const cast = JSON.parse(fs.readFileSync(CAST, "utf8"));
  cast.authors.lyra = { voice: "en-US-AriaNeural" }; // another machine's older authors, merged in: no body
  cast.authors.nova.character = "charlie-5e48d775";   // the person picked something since
  fs.writeFileSync(CAST, JSON.stringify(cast));
  const fixed = defaults.reassertPending({ dir: TMP, castFile: CAST, registry: REGISTRY });
  assert.deepEqual(fixed, [{ agent: "lyra", to: "lyra" }]);
  const now = JSON.parse(fs.readFileSync(CAST, "utf8")).authors;
  assert.equal(now.lyra.character, "lyra");
  assert.equal(now.nova.character, "charlie-5e48d775", "even an old default the registry supersedes is the person's once it is on the row");
  now.nova.character = "nova";
  fs.writeFileSync(CAST, JSON.stringify({ ...cast, authors: now }));
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
  assert.deepEqual(puts.sort(), [["lyra", "Lyra-dff26de3"], ["nova", "nova-8d41dc57"], ["saga", "Saga-365cd728"]]);
  assert.equal(defaults.heldAgents(TMP).size, 0, "every agent the catalog took is no longer held");
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
  // A pull still FILLS an empty row.
  const bare = JSON.parse(fs.readFileSync(CAST, "utf8"));
  delete bare.authors.atlas.character;
  fs.writeFileSync(CAST, JSON.stringify(bare));
  const filled = await sync.syncFromCatalog({ client, library, defaultsDir: TMP });
  assert.equal(filled.results[0].changed, true);
  assert.equal(JSON.parse(fs.readFileSync(CAST, "utf8")).authors.atlas.character, "atlas");
  // The person's own manual sync is their OK.
  const cast2 = JSON.parse(fs.readFileSync(CAST, "utf8"));
  cast2.authors.atlas.character = "charlie-5e48d775";
  fs.writeFileSync(CAST, JSON.stringify(cast2));
  const replaced = await sync.syncFromCatalog({ client, library, defaultsDir: TMP, replace: true });
  assert.equal(replaced.results[0].changed, true);
  assert.equal(JSON.parse(fs.readFileSync(CAST, "utf8")).authors.atlas.character, "atlas");
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
