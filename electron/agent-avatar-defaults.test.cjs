"use strict";

/**
 * The registry's agent avatars reach an existing desk once (agent-avatar-defaults.cjs).
 *
 * Pinned: an inherited old default (or its library copy) moves to the registry body, a
 * missing row is added (nova, chaos), the person's own choice and a library copy of the
 * registry build are kept, Aither is left to aither-body.cjs, an agent is decided once, a
 * backup is written beside cast.json before the first write, a moved agent is held from
 * catalog pulls until the catalog takes it, and the committed mirror matches the desk's
 * own Aither body table.
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

test("planDefaults: inherited old bodies and missing rows move; choices and copies stay; Aither is aither-body's", () => {
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
  assert.deepEqual(plan.changes, [
    { agent: "atlas", from: "charlie-5e48d775", to: "atlas" },
    { agent: "lyra", from: "clara-hsr-vrm-0-0", to: "lyra" },
    { agent: "nova", from: null, to: "nova" },
  ]);
  assert.deepEqual(plan.keep.map((k) => [k.agent, k.why]), [
    ["saga", "already the registry body"],
    ["vera", "the person's own choice"],
  ]);
  assert.deepEqual(plan.waiting, ["hera"], "no hera build on this desk: decided on a later boot");
  assert.ok(!plan.changes.some((c) => c.agent === "aither"), "aither-body.cjs owns Aither's row");
});

test("planDefaults: an agent already decided is never decided again", () => {
  const plan = defaults.planDefaults({ registry: REGISTRY, names: NAMES, authors: { atlas: { character: "charlie" } },
    state: { seen: { atlas: "atlas", lyra: "lyra", nova: "nova", saga: "saga", vera: "vera" } } });
  assert.deepEqual(plan.changes, []);
});

test("runDefaults: backup beside cast.json, rows moved with their voice kept, held until the catalog takes them", () => {
  fs.writeFileSync(CAST, JSON.stringify({ version: 1, authors: {
    atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" },
    vera: { character: "orion" },
  } }));
  const before = fs.readFileSync(CAST, "utf8");
  const out = defaults.runDefaults({ registry: REGISTRY, names: NAMES, castFile: CAST, now: () => new Date("2026-11-16T18:00:00Z") });
  assert.equal(out.ok, true);
  assert.deepEqual(out.plan.changes.map((c) => c.agent), ["atlas", "lyra", "nova", "saga"]);
  assert.equal(path.basename(out.backup), "cast.json.bak-agent-avatar-defaults-20261116-180000");
  assert.equal(fs.readFileSync(out.backup, "utf8"), before, "the backup is the cast as it was");
  const cast = JSON.parse(fs.readFileSync(CAST, "utf8"));
  assert.deepEqual(cast.authors.atlas, { character: "atlas", voice: "en-US-MichelleNeural" });
  assert.equal(cast.authors.vera.character, "orion", "the person's own choice is kept");
  assert.equal(cast.authors.nova.character, "nova");
  const state = defaults.readState(TMP);
  assert.equal(state.from.atlas, "charlie-5e48d775");
  assert.deepEqual([...defaults.heldAgents(TMP)].sort(), ["atlas", "lyra", "nova", "saga"]);
  // second boot: nothing moves, no second backup
  const again = defaults.runDefaults({ registry: REGISTRY, names: NAMES, castFile: CAST, now: () => new Date("2026-11-16T19:00:00Z") });
  assert.deepEqual(again.plan.changes, []);
  assert.equal(again.backup, null);
});

test("a catalog pull leaves a held agent alone; the push clears the hold", async () => {
  for (const name of ["atlas", "lyra", "nova", "saga"]) {
    fs.mkdirSync(path.join(ROSTER, name), { recursive: true });
    fs.writeFileSync(path.join(ROSTER, name, "model.vrm"), "glTF");
    fs.writeFileSync(path.join(ROSTER, name, "character.json"), JSON.stringify({
      library_id: REGISTRY.agents[name].bodies.default.library_id, rating: "general" }));
  }
  const puts = [];
  const client = {
    async avatarCatalog() {
      return { ok: true, avatars: [{ id: "charlie-5e48d775", sha256: "" }], starters: [], agents: { atlas: "charlie-5e48d775" }, active: null };
    },
    async putAgentAvatar(agent, id) { puts.push([agent, id]); return { ok: true }; },
    async avatarLibrary() { return { ok: true, avatars: [] }; },
  };
  const library = { async ensureLibraryAvatar() { throw new Error("a held agent must not be downloaded"); } };
  const pulled = await sync.syncFromCatalog({ client, library, defaultsDir: TMP });
  assert.deepEqual(pulled.results, [{ agent: "atlas", ok: true, held: true, reason: "a desk move the catalog has not taken yet" }]);
  assert.equal(JSON.parse(fs.readFileSync(CAST, "utf8")).authors.atlas.character, "atlas");
  const pushed = await sync.pushPendingDefaults({ client, defaultsDir: TMP });
  assert.equal(pushed.ok, true);
  assert.deepEqual(puts.sort(), [["atlas", "atlas-9be08ecb"], ["lyra", "Lyra-dff26de3"], ["nova", "nova-8d41dc57"], ["saga", "Saga-365cd728"]]);
  assert.equal(defaults.heldAgents(TMP).size, 0, "every agent the catalog took is no longer held");
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
