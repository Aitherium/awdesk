"use strict";

/**
 * The agent avatars follow the person to every desk (avatar-catalog-sync.cjs).
 *
 * Pinned: a pull dresses each agent the catalog names, downloading a model ONCE by digest
 * and never again; a model uploaded from this desk is recognised by its stamped library id
 * (no second copy); a push of a library character is one PUT and no upload; a push of a
 * desk-only character uploads it, stamps the folder, then PUTs; a failed download leaves
 * the agent's current character alone; seeding pushes every existing assignment.
 *
 * Fixtures live in a per-process temp dir (DESK_ROSTER_DIR / DESK_CAST_FILE set before the
 * modules load): the real characters/ and cast.json are never touched.
 */

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "desk-catalog-sync-"));
const ROSTER = path.join(TMP, "characters");
process.env.DESK_ROSTER_DIR = ROSTER;
process.env.DESK_ADULT_CONTENT_MIRROR = path.join(TMP, "adult-content.json");
process.env.DESK_ADULT_CONTENT_LOG = path.join(TMP, "adult-content.log");
process.env.DESK_CAST_FILE = path.join(TMP, "cast.json");
process.env.DESK_PARTY_FILE = path.join(TMP, "party.json");
process.env.DESK_AGENT_AVATARS_FILE = path.join(TMP, "legacy-agent-avatars.json");
fs.mkdirSync(ROSTER, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sync = require("./avatar-catalog-sync.cjs");
const agents = require("./agent-avatars.cjs");

function fakeVrm(tag) {
  return Buffer.concat([Buffer.from("glTF", "ascii"), Buffer.alloc(16), Buffer.from(String(tag))]);
}
const sha = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");

const ENROLL = { consultInstall: async () => ({ allow: true, reachable: true }), spawn: () => ({ unref() {} }) };

function fakeClient({ avatars = [], starters = [], map = {}, bytes = {} } = {}) {
  const calls = { libraryModel: [], put: [], upload: [] };
  return {
    calls,
    async avatarCatalog() {
      return { ok: true, avatars, starters, agents: { ...map }, active: null };
    },
    async libraryModel(id) {
      calls.libraryModel.push(id);
      return bytes[id] ? { ok: true, bytes: bytes[id] } : { ok: false, reason: "no such avatar" };
    },
    async vroidModel() {
      return { ok: false, reason: "no ticket" };
    },
    async putAgentAvatar(agent, id) {
      calls.put.push([agent, id]);
      map[agent] = id;
      return { ok: true };
    },
    async uploadAvatar(buf, name, rating) {
      const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sha(buf).slice(0, 8)}`;
      calls.upload.push({ name, rating, size: buf.length });
      return { ok: true, record: { id, name, sha256: sha(buf), size: buf.length, rating } };
    },
  };
}

function writeCharacter(name, buf, record) {
  fs.mkdirSync(path.join(ROSTER, name), { recursive: true });
  fs.writeFileSync(path.join(ROSTER, name, "model.vrm"), buf);
  fs.writeFileSync(path.join(ROSTER, name, "character.json"), JSON.stringify(record));
}

test("a pull installs the agent's avatar once and dresses the agent", async () => {
  const bytes = fakeVrm("mira");
  const rec = { id: "Mira-aaaa1111", name: "Mira", rating: "general", sha256: sha(bytes), source: "upload" };
  const client = fakeClient({ avatars: [rec], map: { lyra: rec.id }, bytes: { [rec.id]: bytes } });
  const first = await sync.syncFromCatalog({ client, enrollOptions: ENROLL });
  assert.equal(first.ok, true);
  assert.deepEqual(first.results.map((r) => [r.agent, r.ok, r.installed]), [["lyra", true, true]]);
  assert.equal(agents.getAgentAvatar("lyra"), "mira-aaaa1111");
  assert.deepEqual(fs.readFileSync(path.join(ROSTER, "mira-aaaa1111", "model.vrm")), bytes);

  const again = await sync.syncFromCatalog({ client, enrollOptions: ENROLL });
  assert.equal(again.results[0].installed, false);
  assert.equal(client.calls.libraryModel.length, 1, "a model is downloaded once, then found by digest");
});

test("a failed download leaves the agent's current character alone", async () => {
  agents.setAgentAvatar("iris", "herta");
  const rec = { id: "Gone-bbbb2222", name: "Gone", rating: "general", sha256: "00", source: "upload" };
  const client = fakeClient({ avatars: [rec], map: { iris: rec.id } });
  const out = await sync.syncFromCatalog({ client, enrollOptions: ENROLL });
  assert.equal(out.results[0].ok, false);
  assert.equal(agents.getAgentAvatar("iris"), "herta");
});

test("pushing a desk-only character uploads it once, stamps it, and a pull reuses the folder", async () => {
  const bytes = fakeVrm("mermaid");
  writeCharacter("mermaid", bytes, { rating: "general", display_name: "Mermaid" });
  const map = {};
  const client = fakeClient({ map });
  const pushed = await sync.pushAssignment("aither", "mermaid", { client });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.uploaded, true);
  assert.deepEqual(client.calls.put, [["aither", pushed.id]]);
  assert.deepEqual(client.calls.upload.map((u) => [u.name, u.rating]), [["Mermaid", "general"]]);
  const stamped = JSON.parse(fs.readFileSync(path.join(ROSTER, "mermaid", "character.json"), "utf8"));
  assert.equal(stamped.library_id, pushed.id);
  assert.equal(stamped.library_sha256, sha(bytes));

  // The model also answers to its canonical name (hard link, same bytes), and the agent
  // is pointed at THAT name -- what every other desk will call it too.
  const canonical = pushed.id.toLowerCase();
  assert.equal(pushed.name, canonical);
  assert.deepEqual(fs.readFileSync(path.join(ROSTER, canonical, "model.vrm")), bytes);
  assert.equal(agents.getAgentAvatar("aither"), canonical);

  // The catalog now names it; the pull finds the canonical folder and downloads nothing.
  const rec = { id: pushed.id, name: "Mermaid", rating: "general", sha256: sha(bytes), source: "upload" };
  const pull = fakeClient({ avatars: [rec], map: { aither: pushed.id } });
  const out = await sync.syncFromCatalog({ client: pull, enrollOptions: ENROLL });
  assert.deepEqual(out.results.map((r) => [r.agent, r.ok, r.name, r.installed]), [["aither", true, canonical, false]]);
  assert.equal(pull.calls.libraryModel.length, 0);

  // A second push of a stamped character is one PUT and no upload.
  const again = await sync.pushAssignment("demiurge", "mermaid", { client });
  assert.equal(again.uploaded, false);
  assert.equal(client.calls.upload.length, 1);
});

test("a character with no model on this desk is refused, not guessed", async () => {
  const out = await sync.pushAssignment("atlas", "nobody-here", { client: fakeClient() });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no model file/);
});

test("seeding pushes every assignment this desk already has", async () => {
  const bytes = fakeVrm("orion");
  writeCharacter("orion", bytes, { rating: "general" });
  agents.setAgentAvatar("gobbonet", "orion");
  const client = fakeClient();
  const out = await sync.seedFromDesk({ client });
  const pushedAgents = out.results.filter((r) => r.ok).map((r) => r.agent);
  assert.ok(pushedAgents.includes("gobbonet"));
  assert.ok(client.calls.put.some(([a]) => a === "gobbonet"));
});

test("a signed-out desk reports why and changes nothing", async () => {
  const client = { async avatarCatalog() { return { ok: false, reason: "Sign in to Aitherium on this desk to see your avatars.", agents: {} }; } };
  const before = agents.getAgentAvatar("lyra");
  const out = await sync.syncFromCatalog({ client });
  assert.equal(out.ok, false);
  assert.match(out.reason, /Sign in/);
  assert.equal(agents.getAgentAvatar("lyra"), before);
});
