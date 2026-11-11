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

test("companions: one per OTHER agent with a card, every one of them, only when two or more agents wait", () => {
  const card = (id, agent, title = `card ${id}`) => ({ id, agent, title });
  assert.deepEqual(agentFairy.companionsFor([card("d-1", "atlas"), card("d-2", "atlas")]), [], "one agent = no companions");
  assert.deepEqual(agentFairy.companionsFor([card("d-1", "atlas"), card("d-2", "")]), [], "an unnamed card is no agent");
  const many = [
    card("d-1", "atlas"), card("d-2", "lyra"), card("d-3", "atlas"), card("d-4", "demi"),
    card("d-5", "iris"), card("d-6", "saga"), card("d-7", "vera"),
  ];
  const all = agentFairy.companionsFor(many);
  assert.equal(all.length, 6, "no cap: one per agent");
  assert.deepEqual(all.map((c) => c.agent), ["atlas", "lyra", "demiurge", "iris", "saga", "vera"], "queue order");
  assert.equal(all[0].cardId, "d-1", "the agent's FIRST card is the one a hover shows");
  assert.equal(all[0].count, 2);
  assert.equal(all[0].color, "#a3a3a3");
  const minusWorn = agentFairy.companionsFor(many, { current: "atlas" });
  assert.equal(minusWorn.some((c) => c.agent === "atlas"), false, "the agent the fairy wears is not also a companion");
});

test("a companion carries its agent's NEWEST card, not the first-ranked old one", () => {
  const cards = [
    { id: "d-old1", agent: "atlas", title: "Pixel 8 approval", createdAt: 1_000 },
    { id: "d-lyr1", agent: "lyra", title: "lyra", createdAt: 5_000 },
    { id: "d-new1", agent: "atlas", title: "Host at 97%", createdAt: 9_000 },
  ];
  const atlas = agentFairy.companionsFor(cards).find((c) => c.agent === "atlas");
  assert.equal(atlas.cardId, "d-new1");
  assert.equal(atlas.title, "Host at 97%");
  assert.equal(atlas.count, 2);
});

test("twelve agents (8 palette + 4 crew): every one is a companion, duplicates merge with a count", () => {
  const named = ["atlas", "demi", "lyra", "iris", "saga", "vera", "hera"];
  const crew = ["gargbot", "Plutus", "chaos", "viviane"];
  const cards = [{ id: "d-aither", agent: "aither", title: "owner" }];
  named.forEach((a, i) => cards.push({ id: `d-n${i}`, agent: a, title: a }));
  crew.forEach((a, i) => cards.push({ id: `d-c${i}`, agent: a, title: a }));
  cards.push({ id: "d-n0b", agent: "Atlas", title: "second atlas card" });
  cards.push({ id: "d-gen", agent: "claude-code", title: "a harness, no agent" });
  const all = agentFairy.companionsFor(cards);
  assert.equal(all.length, 12, "all 12 agents, none hidden");
  assert.equal(new Set(all.map((c) => c.agent)).size, 12, "one fairy per agent");
  assert.equal(all.find((c) => c.agent === "atlas").count, 2, "a second Atlas card is a count, not a second fairy");
  assert.equal(all.some((c) => c.agent === "claude-code"), false, "a generic harness is no agent");
  const garg = all.find((c) => c.agent === "gargbot");
  assert.equal(garg.crew, true);
  assert.match(garg.color, /^#[0-9a-f]{6}$/);
  assert.equal(garg.color, agentFairy.colorForName("gargbot"), "a crew colour is stable");
  assert.notEqual(agentFairy.colorForName("gargbot"), agentFairy.colorForName("chaos"));
});

test("the swarm grows in rings (6, 10, 14 ...), shrinks gently, keeps a usable hit target", () => {
  assert.deepEqual(agentFairy.swarmLayout(0), []);
  const rings = (n) => agentFairy.swarmLayout(n).map((s) => s.ring);
  assert.deepEqual(rings(6), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rings(7), [0, 0, 0, 0, 0, 0, 1]);
  assert.equal(agentFairy.swarmLayout(30).filter((s) => s.ring === 2).length, 14);
  assert.equal(agentFairy.companionSize(4), 14);
  assert.equal(agentFairy.companionSize(12), 12.5);
  assert.equal(agentFairy.companionSize(100), 9, "never smaller than 9 px");
  for (const s of agentFairy.swarmLayout(40)) assert.ok(s.hit >= 16);
  // Owner 2026-11-10, "there is only one": no companion may sit under the 28 px disc
  // (plus glow), where it is invisible and catches the presses meant for the fairy.
  for (const s of agentFairy.swarmLayout(40)) {
    assert.ok(s.radius * 0.82 - s.size / 2 > agentFairy.DISC_RADIUS, `ring ${s.ring} reaches under the disc`);
  }
  assert.ok(agentFairy.swarmExtent(30) > agentFairy.swarmExtent(6), "the swarm window grows with the count");
  // every slot stays inside its own extent, at every point of its lap
  for (const n of [3, 12, 30]) {
    const half = agentFairy.swarmExtent(n);
    for (const slot of agentFairy.swarmLayout(n)) {
      for (let t = 0; t < 12000; t += 900) {
        const o = agentFairy.companionOffset(slot, t);
        assert.ok(Math.abs(o.x) + slot.size / 2 <= half && Math.abs(o.y) + slot.size / 2 <= half, `${n}: ${JSON.stringify(o)}`);
      }
    }
  }
});

test("orb.html's swarmSlots copy is the same layout as swarmLayout", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "orb.html"), "utf8");
  const m = src.match(/function swarmSlots\(n\) \{[\s\S]*?\n {2}\}\n/);
  assert.ok(m, "swarmSlots not found in orb.html");
  const swarmSlots = new Function(`${m[0]}; return swarmSlots;`)();
  for (const n of [1, 6, 7, 12, 30]) assert.deepEqual(swarmSlots(n), agentFairy.swarmLayout(n), `n=${n}`);
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

test("the desk copy is byte-identical to a canonical copy named by AITHER_FAIRY_CANONICAL", (t) => {
  // Opt-in: the monorepo worktree on this machine may sit on any branch, so its
  // config/ is not a reliable reference. check_agent_fairy_palette.py (monorepo,
  // ci-static) is the authority; point this at origin/develop's copy to run it here.
  const canonical = process.env.AITHER_FAIRY_CANONICAL;
  if (!canonical || !fs.existsSync(canonical)) {
    t.skip("AITHER_FAIRY_CANONICAL not set: check_agent_fairy_palette.py asserts it in the monorepo");
    return;
  }
  const mine = fs.readFileSync(path.join(__dirname, "agent-fairies.json"));
  assert.ok(mine.equals(fs.readFileSync(canonical)), `electron/agent-fairies.json drifted from ${canonical}`);
});

test("crew colours reproduce the shared vectors in agent-fairies.json (the web fairy asserts the same)", () => {
  const vectors = agentFairy.PALETTE.crewColor && agentFairy.PALETTE.crewColor.vectors;
  assert.ok(vectors && Object.keys(vectors).length >= 5, "the palette carries crew-colour vectors");
  for (const [name, color] of Object.entries(vectors)) assert.equal(agentFairy.colorForName(name), color, name);
  assert.equal(agentFairy.colorForName("gargbot"), "#e05254");
  assert.equal(agentFairy.colorForName("chaos"), "#e0c152");
});

test("no cap comes back: 30 agents waiting = 30 companions, each on a ring slot", () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: `d-${i}`, agent: `crew${i}`, title: `card ${i}` }));
  const all = agentFairy.companionsFor(cards);
  assert.equal(all.length, 30, "every agent renders, whatever the count");
  assert.equal(agentFairy.swarmLayout(all.length).length, 30, "every companion has a slot");
});

// ── presence: one agent = one presence everywhere (owner 2026-11-09) ─────────

const PRESENCE = [
  { agent: "atlas", state: "working", work: [{ title: "Board tick", url: "https://github.com/Aitherium/AitherOS/issues/1" }],
    discord: { bot: true, app_id: "1", dm_url: "https://discord.com/users/1" }, thread_url: "https://github.com/Aitherium/AitherOS/issues/1" },
  { agent: "Lyra", state: "idle", work: [], discord: { bot: true, app_id: "2", dm_url: "https://discord.com/users/2" }, thread_url: "" },
  { agent: "demi", state: "waiting", work: [{ title: "PR review", url: "javascript:alert(1)" }], discord: null, thread_url: "" },
  { agent: "claude-code", state: "working", work: [] },
];

test("presence: an ACTIVE agent with no card still gets its fairy; states and links come through", () => {
  const all = agentFairy.companionsFor([], { presence: PRESENCE });
  const by = Object.fromEntries(all.map((c) => [c.agent, c]));
  assert.deepEqual(Object.keys(by).sort(), ["atlas", "demiurge", "lyra"], "generic claude-code is no agent");
  assert.equal(by.atlas.state, "working");
  assert.equal(by.atlas.title, "Board tick");
  assert.equal(by.atlas.threadUrl, "https://github.com/Aitherium/AitherOS/issues/1");
  assert.equal(by.atlas.dmUrl, "https://discord.com/users/1");
  assert.equal(by.lyra.state, "idle");
  assert.equal(by.demiurge.state, "waiting", "the board says it waits on the owner");
  assert.equal(by.demiurge.work[0].url, "", "only https links survive");
  assert.equal(all[0].agent, "demiurge", "waiting first, then working, then idle");
  assert.equal(all[all.length - 1].agent, "lyra");
});

test("presence: a card makes it waiting with its count; a post makes it speaking; the worn agent leaves the orbit", () => {
  const cards = [{ id: "d-1", agent: "lyra", title: "review" }, { id: "d-2", agent: "lyra", title: "review 2" }];
  const all = agentFairy.companionsFor(cards, { presence: PRESENCE, speaking: ["atlas"], current: "demi" });
  const by = Object.fromEntries(all.map((c) => [c.agent, c]));
  assert.equal(by.lyra.state, "waiting");
  assert.equal(by.lyra.count, 2);
  assert.equal(by.lyra.cardId, "d-1");
  assert.equal(by.atlas.state, "speaking");
  assert.equal(by.demiurge, undefined);
});

test("presence: twelve active agents (8 palette + 4 crew) with no cards at all = twelve fairies", () => {
  const names = ["aither", "atlas", "demiurge", "lyra", "iris", "saga", "vera", "hera", "gargbot", "plutus", "chaos", "viviane"];
  const all = agentFairy.companionsFor([], { presence: names.map((a) => ({ agent: a, state: "idle" })) });
  assert.equal(all.length, 12, "every active agent renders, none hidden, no cap");
});

test("relay posts: the first read only sets the mark; later agent posts name their agents once", () => {
  const rows = [
    { agent: true, author: "atlas+abc", at: 100 }, { agent: true, author: "atlas", at: 101 },
    { agent: false, author: "david", at: 102 }, { agent: true, author: "Lyra", at: 50 },
  ];
  assert.deepEqual(agentFairy.newPosters(rows, 0), [], "a desk start is not a burst of posts");
  assert.deepEqual(agentFairy.newPosters(rows, 99), ["atlas"]);
  assert.equal(agentFairy.latestAt(rows, 0), 102);
  assert.equal(agentFairy.latestAt([], 200), 200, "never moves backwards");
});

test("every Claude session gets its own fairy: its cards, its name, beside the platform agents", () => {
  // Owner, 2026-11-10: "what about discord fairies vs local fairy vs claude/terminal fairies".
  const sessions = new Map([
    ["1143e745-6ceb-4221", { name: "OpenMAIC intake", status: "busy", cwd: "C:/AitherOS-Fresh" }],
    ["be49a0d9-0000-0000", { name: "", status: "idle", cwd: "D:/desk/" }],
  ]);
  const rows = agentFairy.sessionPresence(sessions);
  assert.deepEqual(rows.map((r) => [r.agent, r.label, r.state]), [
    ["session-1143e745", "OpenMAIC intake", "working"],
    ["session-be49a0d9", "desk", "idle"],
  ]);
  const cards = [
    { id: "d-1", agent: "claude-code", sessionId: "1143e745-6ceb-4221", createdAt: 2 },
    { id: "d-2", agent: "claude-code", sessionId: "be49a0d9-0000-0000", createdAt: 1 },
    { id: "d-3", agent: "atlas", createdAt: 3 },
  ];
  assert.equal(agentFairy.cardAgent(cards[0]), "session-1143e745");
  assert.equal(agentFairy.cardAgent(cards[2]), "atlas", "a named agent keeps its own fairy");
  const mates = agentFairy.companionsFor(cards, { presence: [{ agent: "lyra", state: "working" }, ...rows] });
  const byAgent = Object.fromEntries(mates.map((m) => [m.agent, m]));
  assert.equal(byAgent["session-1143e745"].cardId, "d-1");
  assert.equal(byAgent["session-1143e745"].label, "OpenMAIC intake");
  assert.equal(byAgent["session-be49a0d9"].cardId, "d-2");
  assert.ok(byAgent.atlas && byAgent.lyra, "platform and Discord agents stay beside the sessions");
  assert.notEqual(byAgent["session-1143e745"].color, byAgent["session-be49a0d9"].color);
});
