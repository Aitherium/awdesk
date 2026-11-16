"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const swarm = require("./agent-swarm.cjs");

const PODMAN = [
  "aitheros-awdiscord-atlas|Up 2 hours (healthy)",
  "aitheros-awdiscord-hera|Up 2 hours (healthy)",
  "aitheros-awdiscord|Up 2 hours (healthy)",
  "aitheros-discordrelaybridge|Up 2 hours (healthy)",
  "aitheros-awdiscord-vera|Up 2 hours (unhealthy)",
  "aitheros-awdiscord-iris|Exited (0) 3 hours ago",
  "aitheros-awdiscord-lyra|Up 2 hours (healthy)",
].join("\n");

test("discord containers: one persona per RUNNING bot; the unsuffixed bot is Aither; the relay bridge is not an agent", () => {
  const rows = swarm.parseDiscordContainers(PODMAN);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["aither", "atlas", "hera", "lyra"]);
  assert.ok(rows.every((r) => r.kind === "persona" && r.bot === true));
});

test("active agents: working/waiting rows become fleet rows; 'system' and 'chat' are not agents", () => {
  const rows = swarm.parseActiveAgents({
    agents: [
      { agent_id: "atlas", status: "working", needs_owner: 0 },
      { agent_id: "system", status: "waiting", needs_owner: 22 },
      { agent_id: "demiurge", status: "idle", needs_owner: 3 },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [["atlas", "working"], ["demiurge", "waiting"]]);
  assert.deepEqual(swarm.parseActiveAgents("not json"), []);
});

test("capability roster text: the indented '<agent> ->' lines, never the _internal groups", () => {
  const text = "Capability roster: 8 of 63\n  aither       ->  (0 producers)\n  _assemble_document ->  x\n  iris -> images";
  assert.deepEqual(swarm.parseCapabilityRoster(text).map((r) => r.id), ["aither", "iris"]);
});

test("sessions: one fairy per live session under agent-fairy's session key; exited rows drop; a parent makes a subagent", () => {
  const rows = swarm.parseSessions({
    ok: true,
    sessions: [
      { id: "06d04c2d-6dc4-4db2", name: "Music video", status: "waiting-input", cwd: "C:\\x", harness_label: "Claude Code" },
      { id: "f5a09cbe-fa9d", status: "working", cwd: "C:\\AitherOS-Fresh" },
      { id: "dead0000-1", status: "exited" },
      { id: "abcd1234-9", status: "idle", parent_session_id: "06d04c2d-6dc4-4db2" },
    ],
  });
  assert.deepEqual(rows.map((r) => r.id), ["session-06d04c2d", "session-f5a09cbe", "session-abcd1234"]);
  assert.equal(rows[0].state, "waiting");
  assert.equal(rows[0].kind, "session");
  assert.equal(rows[2].kind, "subagent");
  assert.equal(rows[2].belongsTo, "session-06d04c2d");
  assert.equal(rows[1].label, "AitherOS-Fresh");
  assert.deepEqual(swarm.parseSessions({ ok: false }), []);
});

test("merge: one row per id, the lowest kind wins, the strongest state wins, every source is named", () => {
  const merged = swarm.mergeRoster([
    { id: "atlas", kind: "fleet", state: "idle", source: "genesis" },
    { id: "atlas", kind: "persona", state: "working", bot: true, source: "discord" },
    { id: "aither", kind: "persona", state: "idle", source: "discord" },
    { id: "session-aaaa", kind: "session", state: "waiting", source: "sessions" },
  ]);
  assert.deepEqual(merged.map((r) => r.id), ["aither", "atlas", "session-aaaa"]);
  const atlas = merged[1];
  assert.equal(atlas.kind, "persona");
  assert.equal(atlas.state, "working");
  assert.equal(atlas.bot, true);
  assert.deepEqual(atlas.sources.sort(), ["discord", "genesis"]);
});

const AUTHORS = {
  aither: { character: "aither-90044575", voice: "custom:aither" },
  atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" },
  hera: { character: "hera" },
};
const CHARS = new Set(["aither-v2", "aither-m", "aither-90044575", "charlie-5e48d775", "hera"]);

test("identity: colour from the shared palette, body and voice from cast.json, default body otherwise", () => {
  const roster = swarm.withIdentity(swarm.mergeRoster([
    { id: "aither", kind: "persona", source: "discord" },
    { id: "atlas", kind: "persona", source: "discord" },
    { id: "hera", kind: "persona", source: "discord" },
    { id: "lyra", kind: "persona", source: "discord" },
    { id: "session-aaaa", label: "Music video", kind: "session", source: "sessions" },
  ]), { authors: AUTHORS, characters: CHARS, aitherBody: "aither-m" });
  const by = Object.fromEntries(roster.map((r) => [r.id, r]));
  assert.equal(by.aither.character, "aither-m"); // the resident wears the body the fairy grows into (female/male choice)
  assert.equal(by.aither.voice, "custom:aither");
  assert.equal(by.atlas.character, "charlie-5e48d775");
  assert.equal(by.atlas.color, "#a3a3a3");
  assert.equal(by.hera.voice, null); // no authored voice: voice-resolve gives a stable one at speak time
  assert.equal(by.lyra.character, swarm.DEFAULT_BODY); // not installed -> the default female body
  assert.match(by["session-aaaa"].color, /^#[0-9a-f]{6}$/);
  assert.equal(by["session-aaaa"].belongsTo, "aither");
  assert.equal(by["session-aaaa"].light, true);
  assert.equal(by.atlas.belongsTo, "");
});

test("identity: with no authored row the aither persona wears the chosen Aither body", () => {
  const [row] = swarm.withIdentity([{ id: "aither", kind: "persona", source: "discord" }], { authors: {}, characters: CHARS, aitherBody: "aither-m" });
  assert.equal(row.character, "aither-m");
});

test("goblin: a sprite body, summonable, never a swarm companion", () => {
  const [g] = swarm.withIdentity([swarm.goblinRow()], { authors: {}, characters: CHARS });
  assert.equal(g.bodyKind, "sprite");
  assert.equal(g.character, "goblin");
  assert.deepEqual(swarm.presenceFor([g], new Map()), []);
});

test("light mode: grow-all grows persona / fleet / goblin only; full mode grows everyone; shrink hits whoever is grown", () => {
  const roster = swarm.withIdentity(swarm.mergeRoster([
    { id: "aither", kind: "persona", source: "discord" },
    { id: "atlas", kind: "fleet", source: "genesis" },
    swarm.goblinRow(),
    { id: "session-aaaa", kind: "session", source: "sessions" },
    { id: "remote-box", label: "box", kind: "remote", source: "remote" },
  ]), { authors: {}, characters: null });
  const forms = new Map();
  assert.deepEqual(swarm.targetsFor(roster, forms, "avatar", "light").sort(), ["aither", "atlas", "gargbot"]);
  assert.equal(swarm.targetsFor(roster, forms, "avatar", "full").length, 5);
  forms.set("session-aaaa", "avatar");
  forms.set("atlas", "avatar");
  assert.deepEqual(swarm.targetsFor(roster, forms, "fairy", "light").sort(), ["atlas", "session-aaaa"]);
  assert.ok(!swarm.targetsFor(roster, forms, "avatar", "light").includes("atlas"));
});

test("presence: a grown agent leaves the fairy swarm and comes back when it shrinks; light fairies carry who they orbit", () => {
  const roster = swarm.withIdentity(swarm.mergeRoster([
    { id: "aither", kind: "persona", source: "discord" },
    { id: "atlas", kind: "persona", state: "working", bot: true, source: "discord" },
    { id: "session-aaaa", label: "Terminal", kind: "session", state: "waiting", source: "sessions" },
  ]), { authors: {}, characters: null });
  const forms = new Map([["atlas", "avatar"]]);
  const rows = swarm.presenceFor(roster, forms);
  assert.deepEqual(rows.map((r) => r.agent), ["aither", "session-aaaa"]);
  assert.equal(rows[1].belongsTo, "aither");
  assert.equal(rows[1].state, "waiting");
  forms.delete("atlas");
  assert.ok(swarm.presenceFor(roster, forms).some((r) => r.agent === "atlas" && r.discord.bot === true));
});

test("grow frames: start fairy-sized, overshoot, land exactly on the body; shrink ends fairy-sized and turned", () => {
  const grow = swarm.bodyFrames("grow", { scale: 1 });
  assert.equal(grow.length, swarm.FRAMES);
  assert.ok(grow[0].scale < 0.5);
  assert.deepEqual(grow[grow.length - 1], { scale: 1, yaw: 0 });
  assert.ok(Math.max(...grow.map((f) => f.scale)) > 1, "the grow overshoots a little");
  const shrink = swarm.bodyFrames("shrink", { scale: 1 });
  assert.ok(shrink[0].scale < 1 && shrink[0].scale > shrink[shrink.length - 1].scale);
  assert.ok(Math.abs(shrink[shrink.length - 1].scale - swarm.START_SCALE) < 1e-9);
  assert.ok(grow.every((f) => f.scale >= 0.05) && shrink.every((f) => f.scale >= 0.05), "never below the stage's scale floor");
});

test("stage width: one body is a portrait window; more bodies widen it up to the work area", () => {
  assert.ok(swarm.stageWidthFor(1, 640, 3000) < 500);
  const four = swarm.stageWidthFor(4, 640, 3840);
  assert.ok(four > swarm.stageWidthFor(2, 640, 3840));
  assert.equal(swarm.stageWidthFor(8, 640, 1000), 1000);
});

test("public row: the shape the API, MCP and tray read", () => {
  const [row] = swarm.withIdentity([{ id: "atlas", kind: "persona", source: "discord", bot: true }], { authors: AUTHORS, characters: CHARS });
  const pub = swarm.publicRow(row, new Map([["atlas", "avatar"]]));
  assert.equal(pub.form, "avatar");
  assert.equal(pub.character, "charlie-5e48d775");
  assert.equal(pub.voice, "en-US-MichelleNeural");
  assert.deepEqual(Object.keys(pub).sort(), ["belongsTo", "bodyKind", "bot", "character", "color", "detail", "form", "harness", "id", "kind", "label", "light", "sources", "state", "voice"]);
});

test("row positions: the renderer's spread() -- resident first, symmetric, inside the stage", () => {
  assert.deepEqual(swarm.rowPositions(["slot3"]), { slot3: 0 });
  const two = swarm.rowPositions(["slot2", "slot0"]);
  assert.ok(two.slot0 < two.slot2 && Math.abs(two.slot0 + two.slot2) < 1e-9);
  const five = swarm.rowPositions(["slot0", "slot1", "slot2", "slot3", "slot4"]);
  assert.equal(five.slot0, -2);
  assert.equal(five.slot4, 2);
  assert.equal(five.slot2, 0);
  assert.deepEqual(swarm.rowPositions([]), {});
});

test("row positions match the renderer's arrangements.ts (the constants are copied, so pin them)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const arr = fs.readFileSync(path.join(__dirname, "..", "src", "hooks", "stagePlacement.ts"), "utf8");
  assert.match(arr, new RegExp(`STAGE_STEP = ${swarm.STAGE_STEP}`));
  const layout = fs.readFileSync(path.join(__dirname, "..", "src", "hooks", "useAvatarLayout.ts"), "utf8");
  assert.match(layout, new RegExp(`POSITION_BOUND = ${swarm.STAGE_BOUND}`));
});

test("review of #96: slot10 stands after slot9 (a string sort put it first once ten bodies stood)", () => {
  const ids = ["slot0", "slot10", "slot2", "slot9", "slot1"];
  const row = swarm.rowPositions(ids);
  const order = Object.keys(row).sort((a, b) => row[a] - row[b]);
  assert.deepEqual(order, ["slot0", "slot1", "slot2", "slot9", "slot10"]);
});
