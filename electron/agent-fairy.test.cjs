"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const agentFairy = require("./agent-fairy.cjs");

// The Discord role colours, as the owner set them (2026-11-09). The palette must match.
const DISCORD = {
  aither: "#38bdf8", atlas: "#a3a3a3", demiurge: "#06b6d4", lyra: "#8b5cf6",
  iris: "#f59e0b", saga: "#f472b6", vera: "#10b981", hera: "#38bdf8",
};

test("every agent wears its Discord colour; Aither is white-gold with sparkles; Hera is swept with a ring", () => {
  for (const [agent, color] of Object.entries(DISCORD)) {
    const f = agentFairy.fairyFor(agent);
    assert.equal(f.color, color, agent);
    assert.equal(f.known, true, agent);
  }
  const aither = agentFairy.fairyFor("aither");
  assert.equal(aither.core, "#fff6dc");
  assert.equal(aither.sparkles, true);
  const hera = agentFairy.fairyFor("Hera");
  assert.equal(hera.wings, "swept");
  assert.equal(hera.ring, true);
  assert.equal(agentFairy.fairyFor("lyra").wings, "petal");
});

test("names normalise: aliases, case, and the first word that names an agent", () => {
  assert.equal(agentFairy.normalizeAgent("demi"), "demiurge");
  assert.equal(agentFairy.normalizeAgent("Demiurge"), "demiurge");
  assert.equal(agentFairy.normalizeAgent("Lyra review"), "lyra");
  assert.equal(agentFairy.normalizeAgent("atlas-board"), "atlas");
  assert.equal(agentFairy.normalizeAgent("claude-code"), "");
  assert.equal(agentFairy.normalizeAgent(""), "");
  assert.equal(agentFairy.normalizeAgent(null), "");
});

test("an unknown name is the resting Aither fairy, marked unknown", () => {
  const f = agentFairy.fairyFor("Desktop canvas layout");
  assert.equal(f.known, false);
  assert.equal(f.agent, "aither");
  assert.deepEqual(agentFairy.restingFairy(), { ...agentFairy.fairyFor("aither") });
});

test("companions: one per OTHER agent with a card, at most four, only when two or more agents wait", () => {
  const card = (id, agent, title = `card ${id}`) => ({ id, agent, title });
  assert.deepEqual(agentFairy.companionsFor([card("d-1", "atlas"), card("d-2", "atlas")]), [], "one agent = no companions");
  assert.deepEqual(agentFairy.companionsFor([card("d-1", "atlas"), card("d-2", "")]), [], "an unnamed card is no agent");
  const many = [
    card("d-1", "atlas"), card("d-2", "lyra"), card("d-3", "atlas"), card("d-4", "demi"),
    card("d-5", "iris"), card("d-6", "saga"), card("d-7", "vera"),
  ];
  const all = agentFairy.companionsFor(many);
  assert.equal(all.length, 4, "capped at four");
  assert.deepEqual(all.map((c) => c.agent), ["atlas", "lyra", "demiurge", "iris"], "queue order");
  assert.equal(all[0].cardId, "d-1", "the agent's FIRST card is the one a hover shows");
  assert.equal(all[0].count, 2);
  assert.equal(all[0].color, "#a3a3a3");
  const minusWorn = agentFairy.companionsFor(many, { current: "atlas" });
  assert.equal(minusWorn.some((c) => c.agent === "atlas"), false, "the agent the fairy wears is not also a companion");
});

test("the companion orbit stays inside the 72 px orb window", () => {
  for (let i = 0; i < 4; i += 1) {
    for (let t = 0; t < 9000; t += 700) {
      const o = agentFairy.companionOffset(i, 4, t);
      assert.ok(Math.abs(o.x) + 5 <= 36 && Math.abs(o.y) + 5 <= 36, JSON.stringify(o));
    }
  }
});

test("speakingMs is bounded: a word is 3 s, an essay 20 s", () => {
  assert.equal(agentFairy.speakingMs("hi"), 3000);
  assert.equal(agentFairy.speakingMs("x".repeat(10_000)), 20_000);
});

test("the palette is well formed: hex colours, wings petal|swept, the default exists", () => {
  const p = agentFairy.PALETTE;
  assert.ok(p.agents[p.default], "the default agent has an entry");
  for (const [name, e] of Object.entries(p.agents)) {
    for (const k of ["color", "core", "glow"]) assert.match(e[k], /^#[0-9a-f]{6}$/i, `${name}.${k}`);
    assert.ok(["petal", "swept"].includes(e.wings), `${name}.wings`);
  }
  for (const [alias, target] of Object.entries(p.aliases)) assert.ok(p.agents[target], `${alias} -> ${target}`);
});

test("the desk copy is byte-identical to the canonical AitherOS/config/agent-fairies.json when the monorepo is here", (t) => {
  const root = process.env.AITHEROS_REPO_ROOT || "C:\\AitherOS-Fresh";
  const canonical = path.join(root, "AitherOS", "config", "agent-fairies.json");
  if (!fs.existsSync(canonical)) {
    t.skip(`no monorepo at ${root} (CI): check_agent_fairy_palette.py asserts it there`);
    return;
  }
  const mine = fs.readFileSync(path.join(__dirname, "agent-fairies.json"));
  assert.ok(mine.equals(fs.readFileSync(canonical)), `electron/agent-fairies.json drifted from ${canonical}`);
});
