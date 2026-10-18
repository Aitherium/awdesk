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
  const calls = { libraryModel: [], put: [], upload: [], library: 0 };
  const held = [...avatars];
  return {
    calls,
    held,
    async avatarLibrary() {
      calls.library += 1;
      return { ok: true, avatars: [...held], active: null };
    },
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
      const record = { id, name, sha256: sha(buf), size: buf.length, rating };
      held.push(record);
      return { ok: true, record };
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
  writeCharacter("mermaid", bytes, { rating: "general", source: "manual", display_name: "Mermaid" });
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

test("a first sync seeds an EMPTY catalog from this desk, and never a populated one", async () => {
  const bytes = fakeVrm("helen");
  writeCharacter("helen", bytes, { rating: "general" });
  agents.setAgentAvatar("scribe", "helen");
  const empty = fakeClient();
  const seeded = await sync.seedIfCatalogEmpty({ client: empty });
  assert.equal(seeded.seeded, true);
  assert.ok(empty.calls.put.some(([a]) => a === "scribe"));

  const populated = fakeClient({ map: { aither: "x-1" } });
  const skipped = await sync.seedIfCatalogEmpty({ client: populated });
  assert.equal(skipped.seeded, false);
  assert.equal(populated.calls.upload.length, 0);
  assert.equal(populated.calls.put.length, 0);
});


test("the seed retries when the catalog was unreachable at desk start (2026-10-17)", async () => {
  // The owner's desk started before aither-avatars answered; the one seed attempt saw no
  // catalog and his library stayed empty for good.
  const bytes = fakeVrm("fexa");
  writeCharacter("fexa", bytes, { rating: "general" });
  agents.setAgentAvatar("iris", "fexa");
  const live = fakeClient();
  let up = false;
  const client = {
    ...live,
    async avatarCatalog() {
      return up ? live.avatarCatalog() : { ok: false, reason: "HTTP 502", agents: {}, avatars: [], starters: [] };
    },
  };
  const loop = sync.startCatalogSync({ client, intervalMs: 3600000 });
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(live.calls.put.length, 0);
    up = true;
    await loop.tick();
    assert.ok(live.calls.put.some(([a]) => a === "iris"), "seed landed once the catalog answered");
    const puts = live.calls.put.length;
    await loop.tick();
    assert.equal(live.calls.put.length, puts, "a landed seed is not pushed again");
  } finally {
    loop.stop();
  }
});

test("a partly failed seed retries only the failed agents the catalog still lacks", async () => {
  writeCharacter("ellie", fakeVrm("ellie"), { rating: "general" });
  agents.setAgentAvatar("athena", "ellie");
  const live = fakeClient();
  let fail = true;
  const client = {
    ...live,
    async uploadAvatar(buf, name, rating) {
      if (fail && name === "ellie") return { ok: false, reason: "HTTP 503" };
      return live.uploadAvatar(buf, name, rating);
    },
  };
  const first = await sync.seedIfCatalogEmpty({ client });
  assert.equal(first.ok, false);
  assert.deepEqual(first.failed, ["athena"]);
  fail = false;
  const before = live.calls.put.length;
  const again = await sync.seedIfCatalogEmpty({ client }, first.failed);
  assert.equal(again.ok, true);
  assert.deepEqual(live.calls.put.slice(before).map(([a]) => a), ["athena"]);
});

// ── library seed: every desk character, not only the agents' (owner ask 2026-10-17) ──
function freshRoster() {
  for (const e of fs.readdirSync(ROSTER)) fs.rmSync(path.join(ROSTER, e), { recursive: true, force: true });
}

test("an unjudged character goes up 'unknown', never the raw 'general' stamp", async () => {
  freshRoster();
  writeCharacter("nobodylooked", fakeVrm("nobodylooked"), { rating: "general", source: "default" });
  const client = fakeClient();
  const pushed = await sync.pushAssignment("lyra", "nobodylooked", { client });
  assert.equal(pushed.ok, true);
  assert.deepEqual(client.calls.upload.map((u) => u.rating), ["unknown"]);
});

test("the library seed uploads every desk character with its own rating, once", async () => {
  freshRoster();
  writeCharacter("kindfox", fakeVrm("kindfox"), { rating: "general", source: "manual", display_name: "Kind Fox" });
  writeCharacter("spicy", fakeVrm("spicy"), { rating: "r18", source: "vroid" });
  writeCharacter("teen", fakeVrm("teen"), { rating: "r15", source: "manual" });
  writeCharacter("unjudged", fakeVrm("unjudged"), { rating: "general", source: "default" });
  writeCharacter("hubref", fakeVrm("hubref"), { rating: "general", source: "vroid", vroid_model_id: "123" });
  const client = fakeClient();
  const gateOpen = { ...require("./content-rating.cjs"), isAdultContentVisible: () => true };
  const first = await sync.seedLibraryFromDesk({ client, contentRating: gateOpen });
  assert.equal(first.ok, true);
  assert.equal(first.uploaded, 4);
  assert.equal(first.skipped, 1, "a VRoid Hub reference is never uploaded");
  const byName = Object.fromEntries(client.calls.upload.map((u) => [u.name, u.rating]));
  assert.deepEqual(byName, { "Kind Fox": "general", spicy: "r18", teen: "r15", unjudged: "unknown" });
  // only the judged General one could ever reach a child's Sprite-body picker
  assert.deepEqual(client.held.filter((r) => r.rating === "general").map((r) => r.name), ["Kind Fox"]);

  const again = await sync.seedLibraryFromDesk({ client, contentRating: gateOpen });
  assert.equal(again.uploaded, 0, "idempotent: stamped folders are skipped");
  assert.equal(again.present, 4);
  assert.equal(client.calls.upload.length, 4);
});

test("r15/r18 are held while the adult-content gate is closed, and land once it opens", async () => {
  freshRoster();
  writeCharacter("plain", fakeVrm("plain"), { rating: "general", source: "manual" });
  writeCharacter("r18one", fakeVrm("r18one"), { rating: "r18", source: "vroid" });
  writeCharacter("r15one", fakeVrm("r15one"), { rating: "r15", source: "manual" });
  const client = fakeClient();
  const closed = { ...require("./content-rating.cjs"), isAdultContentVisible: () => false };
  const out = await sync.seedLibraryFromDesk({ client, contentRating: closed });
  assert.equal(out.ok, true, "held is not a failure");
  assert.equal(out.held, 2);
  assert.deepEqual(client.calls.upload.map((u) => u.name), ["plain"]);
  const open = { ...closed, isAdultContentVisible: () => true };
  const later = await sync.seedLibraryFromDesk({ client, contentRating: open });
  assert.equal(later.uploaded, 2);
  assert.equal(later.held, 0);
});

test("a server content-gate refusal is held, not a failure streak", async () => {
  freshRoster();
  for (const n of ["g1", "g2", "g3", "g4"]) writeCharacter(n, fakeVrm(n), { rating: "r15", source: "manual" });
  const live = fakeClient();
  const client = { ...live, async uploadAvatar() { return { ok: false, reason: "rating r15 needs the content gate open" }; } };
  const open = { ...require("./content-rating.cjs"), isAdultContentVisible: () => true };
  const out = await sync.seedLibraryFromDesk({ client, contentRating: open });
  assert.equal(out.ok, true);
  assert.equal(out.held, 4);
  assert.equal(out.failed, 0);
});

test("a character whose bytes the library already holds is stamped, not uploaded", async () => {
  freshRoster();
  const bytes = fakeVrm("twin");
  writeCharacter("twin", bytes, { rating: "general", source: "manual" });
  const rec = { id: "Twin-cccc3333", name: "Twin", rating: "general", sha256: sha(bytes), source: "upload" };
  const client = fakeClient({ avatars: [rec] });
  const out = await sync.seedLibraryFromDesk({ client });
  assert.equal(out.uploaded, 0);
  assert.equal(out.present, 1);
  assert.equal(client.calls.upload.length, 0);
  const stamped = JSON.parse(fs.readFileSync(path.join(ROSTER, "twin", "character.json"), "utf8"));
  assert.equal(stamped.library_id, rec.id);
});

test("library unavailable: nothing uploads, the next tick does it", async () => {
  freshRoster();
  writeCharacter("later", fakeVrm("later"), { rating: "general", source: "manual" });
  const live = fakeClient();
  let up = false;
  const client = {
    ...live,
    async avatarLibrary() {
      return up ? live.avatarLibrary() : { ok: false, avatars: [], reason: "HTTP 502" };
    },
  };
  const loop = sync.startCatalogSync({ client, intervalMs: 3600000 });
  try {
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(live.calls.upload.length, 0);
    up = true;
    await loop.tick();
    assert.deepEqual(live.calls.upload.map((u) => u.name), ["later"]);
    writeCharacter("newone", fakeVrm("newone"), { rating: "general", source: "manual" });
    await loop.tick();
    assert.deepEqual(live.calls.upload.map((u) => u.name), ["later", "newone"], "new desk characters keep syncing");
  } finally {
    loop.stop();
  }
});

test("a down upload service stops the pass after a short failure streak", async () => {
  freshRoster();
  for (const n of ["a1", "a2", "a3", "a4", "a5"]) writeCharacter(n, fakeVrm(n), { rating: "general", source: "manual" });
  const live = fakeClient();
  let tries = 0;
  const client = { ...live, async uploadAvatar() { tries += 1; return { ok: false, reason: "HTTP 503" }; } };
  const out = await sync.seedLibraryFromDesk({ client });
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.equal(tries, 3);
});
