"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const body = require("./aither-body.cjs");
const menu = require("./fairy-menu.cjs");
const registry = require("./command-registry.cjs");

const BOTH = ["aither", "aither-m", "aither-v2", "mermaid-13b7ffd0"];

test("the two bodies are the avatar-factory builds: female = aither-v2, male = aither-m", () => {
  assert.deepEqual(body.BODIES.map((b) => [b.id, b.label, b.character]), [
    ["female", "Aither (female)", "aither-v2"],
    ["male", "Aither (male)", "aither-m"],
  ]);
  assert.equal(body.DEFAULT_BODY, "female");
});

test("a character is matched to a body by roster name, or by the spec its record carries", () => {
  assert.equal(body.bodyOfCharacter("aither-v2"), "female");
  assert.equal(body.bodyOfCharacter("aither-m"), "male");
  // The catalog's canonical name for an uploaded build: the record still says the spec.
  assert.equal(body.bodyOfCharacter("aither-90044575", { spec: "aither-v2" }), "female");
  assert.equal(body.bodyOfCharacter("aither-m-573ecf39", { spec: "aither-m" }), "male");
  assert.equal(body.bodyOfCharacter("mermaid-13b7ffd0", { source: "library" }), null);
  assert.equal(body.bodyOfCharacter("aither"), null, "the older model is not one of the two");
  assert.equal(body.bodyOfCharacter(null), null);
});

test("the body in force: the row's body, else female; never one this desk lacks", () => {
  assert.equal(body.chosen({ assigned: "aither-m", names: BOTH }), "male");
  assert.equal(body.chosen({ assigned: "aither-v2", names: BOTH }), "female");
  assert.equal(body.chosen({ assigned: "mermaid-13b7ffd0", names: BOTH }), "female", "an old row: the default");
  assert.equal(body.chosen({ assigned: null, names: BOTH }), "female");
  assert.equal(body.chosen({ assigned: "aither-m", names: ["aither-v2"] }), "female", "male is not on this desk");
  assert.equal(body.chosen({ assigned: "aither-v2", names: ["aither-m"] }), "male", "only the male build is here");
  assert.equal(body.chosen({ assigned: "aither-m", names: ["aither"] }), null);
});

test("a choice the catalog has not been told yet wins over the row a pull wrote back", () => {
  assert.equal(body.chosen({ assigned: "mermaid-13b7ffd0", names: BOTH, pending: "male" }), "male");
  assert.equal(body.chosen({ assigned: "aither-v2", names: BOTH, pending: "bogus" }), "female", "a bad pending is ignored");
});

test("the fairy grows into the chosen body; a desk with neither build keeps its older Aither", () => {
  assert.equal(body.characterToShow({ assigned: "aither-m", names: BOTH, fallback: "aither" }), "aither-m");
  assert.equal(body.characterToShow({ assigned: "mermaid-13b7ffd0", names: BOTH, fallback: "aither" }), "aither-v2");
  assert.equal(body.characterToShow({ assigned: "aither-90044575", record: { spec: "aither-v2" }, names: BOTH }), "aither-v2",
    "the canonical copy resolves to the build's own folder");
  assert.equal(body.characterToShow({ assigned: "mermaid", names: ["aither", "mermaid"], fallback: "aither" }), "aither");
  assert.equal(body.characterToShow({ names: [] }), null);
});

test("the menu rows: both bodies, one checked; no rows when there is no choice", () => {
  assert.deepEqual(body.rows({ assigned: "aither-m", names: BOTH }).map((r) => [r.id, r.label, r.checked]), [
    ["female", "Aither (female)", false],
    ["male", "Aither (male)", true],
  ]);
  assert.deepEqual(body.rows({ assigned: "aither-v2", names: ["aither-v2"] }), [], "one build: never a choice of one");
  assert.deepEqual(body.rows({ names: [] }), []);
});

test("the one-time move: an old Aither row goes to the default body once and says what it replaced", () => {
  assert.deepEqual(body.planMigration({ assigned: "mermaid-13b7ffd0", names: BOTH, state: {} }),
    { mark: true, from: "mermaid-13b7ffd0", to: "aither-v2", body: "female" });
  assert.deepEqual(body.planMigration({ assigned: null, names: BOTH, state: {} }),
    { mark: true, from: null, to: "aither-v2", body: "female" });
  // Already one of the bodies (the person chose male): marked, never changed.
  assert.deepEqual(body.planMigration({ assigned: "aither-m", names: BOTH, state: {} }), { mark: true });
  // Done before: the row is the person's own from then on, whatever it says.
  assert.equal(body.planMigration({ assigned: "mermaid-13b7ffd0", names: BOTH, state: { migratedAt: "2026-11-16T00:00:00Z" } }), null);
  // No build on this desk yet: nothing is marked, so a later boot looks again.
  assert.equal(body.planMigration({ assigned: "mermaid", names: ["aither", "mermaid"], state: {} }), null);
});

test("aither-body.json round-trips and reads garbage as empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aither-body-"));
  try {
    assert.deepEqual(body.readState(dir), {});
    assert.equal(body.writeState(dir, { migratedAt: "2026-11-16T00:00:00Z", from: "mermaid-13b7ffd0", pending: "male" }), true);
    assert.deepEqual(body.readState(dir), { migratedAt: "2026-11-16T00:00:00Z", from: "mermaid-13b7ffd0", pending: "male" });
    fs.writeFileSync(path.join(dir, body.STATE_FILE), JSON.stringify({ pending: "robot", migratedAt: 7 }));
    assert.deepEqual(body.readState(dir), {}, "unknown body and a non-string marker are dropped");
    fs.writeFileSync(path.join(dir, body.STATE_FILE), "{not json");
    assert.deepEqual(body.readState(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the fairy's menu offers both bodies under Show Aither, the one in force marked", () => {
  const rows = body.rows({ assigned: "aither-v2", names: BOTH });
  const items = menu.orbItems({ nowMs: 1_000_000, avatar: "fairy", bodies: rows }).items;
  assert.deepEqual(items.slice(0, 3).map((i) => i.id), ["expand", "body:female", "body:male"]);
  assert.equal(items[1].label, "Aither (female) ✓");
  assert.equal(items[1].checked, true);
  assert.equal(items[2].label, "Aither (male)");
  assert.equal(items[2].checked, false);
  // No body to grow into, or one build only: no dead rows.
  const none = menu.orbItems({ nowMs: 1_000_000, bodies: rows }).items.map((i) => String(i.id || ""));
  assert.ok(!none.some((id) => id.startsWith("body:")));
  const one = menu.orbItems({ nowMs: 1_000_000, avatar: "fairy", bodies: [] }).items.map((i) => String(i.id || ""));
  assert.ok(!one.some((id) => id.startsWith("body:")));
});

test("the registry carries the same choice on the tray, a body's menu and the palette", () => {
  const byId = new Map(registry.COMMANDS.map((c) => [c.id, c]));
  for (const id of ["aither.body.female", "aither.body.male"]) {
    const row = byId.get(id);
    assert.ok(row, `${id} is declared`);
    assert.deepEqual([...row.surfaces], ["tray", "avatar-menu", "palette"]);
    assert.equal(row.type, "radio");
  }
  const ctx = { aitherBodies: body.rows({ assigned: "aither-m", names: BOTH }) };
  assert.equal(byId.get("aither.body.female").when(ctx), true);
  assert.equal(byId.get("aither.body.female").checked(ctx), false);
  assert.equal(byId.get("aither.body.male").checked(ctx), true);
  assert.equal(byId.get("aither.body.male").when({ aitherBodies: [] }), false, "one build: the rows are absent");
  // Show Aither from the tray / palette / POST /commands/run, only while she is the fairy.
  const show = byId.get("avatar.from-fairy");
  assert.equal(show.when({ fairyAvatar: "fairy" }), true);
  assert.equal(show.when({ fairyAvatar: "expanded" }), false);
  assert.equal(show.when({}), false);
});

test("main grows into the chosen body and wires the choice to every surface", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /const want = aitherCharacterToShow\(\);/);
  assert.match(main, /case "aither\.body\.female": return void setAitherBody\("female"\);/);
  assert.match(main, /case "aither\.body\.male": return void setAitherBody\("male"\);/);
  assert.match(main, /case "avatar\.from-fairy": return void orbWindow\.expandToAvatar\(\);/);
  assert.match(main, /pickAitherBody: \(id\) => setAitherBody\(id\),/);
  assert.match(main, /startAitherBody\(\);\r?\n\s+avatarCatalogSync\.startCatalogSync/);
  const orb = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.match(orb, /if \(what\.startsWith\("body:"\)\) return pickBody\(what\.slice\(5\)\);/);
  assert.match(orb, /bodies: hookValue\("aitherBodies"\) \|\| \[\],/);
});
