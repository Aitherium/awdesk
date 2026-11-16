"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRosterReader } = require("./agent-roster-live.cjs");

const PODMAN = "aitheros-awdiscord-atlas|Up 2 hours (healthy)\naitheros-awdiscord|Up 2 hours (healthy)\n";
const TOOLS = {
  active_agents: JSON.stringify({ agents: [{ agent_id: "atlas", status: "working" }, { agent_id: "system", status: "waiting" }] }),
  agent_roster: "Capability roster\n  iris -> images\n  lyra -> research\n",
  deploy_remote_list: JSON.stringify([{ name: "dgx-spark", status: "running" }]),
};

function reader(over = {}) {
  let t = 1000;
  const calls = [];
  const r = createRosterReader({
    podman: async () => PODMAN,
    callTool: async (name) => { calls.push(name); return TOOLS[name]; },
    listSessions: async () => ({ ok: true, sessions: [{ id: "06d04c2d-aaaa", name: "Terminal", status: "working", cwd: "C:/x" }] }),
    readAuthors: () => ({ atlas: { character: "charlie-5e48d775", voice: "en-US-MichelleNeural" } }),
    listCharacters: () => ["aither-v2", "aither-m", "charlie-5e48d775"],
    aitherBody: () => "aither-v2",
    now: () => t,
    gatewayTtlMs: 0,
    ...over,
  });
  return { r, calls, tick: (ms) => { t += ms; } };
}

test("the roster is every source, merged: bots, fleet agents, sessions, remotes and the goblin", async () => {
  const { r } = reader();
  const out = await r.read();
  const ids = out.roster.map((x) => x.id);
  for (const id of ["aither", "atlas", "session-06d04c2d", "remote-dgx-spark", "gargbot"]) assert.ok(ids.includes(id), `missing ${id}`);
  assert.ok(!ids.includes("system"));
  const atlas = out.roster.find((x) => x.id === "atlas");
  assert.equal(atlas.kind, "persona");
  assert.equal(atlas.state, "working");
  assert.equal(atlas.voice, "en-US-MichelleNeural");
  assert.deepEqual(atlas.sources.sort(), ["discord", "genesis"]);
  assert.equal(out.roster[0].id, "aither");
  assert.ok(Object.values(out.sources).every((s) => s.ok));
});

test("a dead source empties only itself and says why; the rest of the roster stands", async () => {
  const { r } = reader({
    podman: async () => { throw new Error("wsl: distro not running"); },
    callTool: async () => { throw new Error("gateway refused"); },
  });
  const out = await r.read();
  assert.equal(out.sources.discord.ok, false);
  assert.match(out.sources.discord.error, /distro not running/);
  assert.equal(out.sources["genesis.active"].ok, false);
  assert.equal(out.sources.sessions.ok, true);
  assert.ok(out.roster.some((x) => x.id === "session-06d04c2d"));
  assert.ok(out.roster.some((x) => x.id === "gargbot"));
});

test("reads are cached for the ttl, and force re-reads", async () => {
  const { r, calls, tick } = reader({ ttlMs: 5000 });
  await r.read();
  const n = calls.length;
  await r.read();
  assert.equal(calls.length, n);
  tick(6000);
  await r.read();
  assert.equal(calls.length, n * 2);
  await r.read({ force: true });
  assert.equal(calls.length, n * 3);
});

test("a source that goes dark keeps its last good rows, flagged stale, instead of making the agents vanish", async () => {
  const store = new Map();
  const cache = { remember: (k, v) => store.set(k, { value: v, savedAt: "2026-11-16T00:00:00Z" }), recall: (k) => store.get(k) || null };
  let up = true;
  const { r } = reader({
    cache,
    ttlMs: 0,
    podman: async () => { if (!up) throw new Error("wsl wedged"); return PODMAN; },
  });
  const first = await r.read();
  assert.ok(first.roster.some((x) => x.id === "hera" || x.id === "aither"));
  up = false;
  const second = await r.read({ force: true });
  assert.equal(second.sources.discord.ok, false);
  assert.equal(second.sources.discord.stale, true);
  assert.ok(second.roster.some((x) => x.id === "aither" && x.bot), "the bot is still on the roster");
});

test("gateway sources are read at most every gatewayTtlMs and a slow call is cut off, not awaited", async () => {
  let t = 0;
  const calls = [];
  const { r } = reader({
    now: () => t,
    gatewayTtlMs: 120000,
    gatewayTimeoutMs: 30,
    ttlMs: 0,
    callTool: async (name) => { calls.push(name); await new Promise((resolve) => setTimeout(resolve, 500)); return TOOLS[name]; },
  });
  const first = await r.read();
  assert.equal(first.sources["genesis.active"].ok, false);
  assert.match(first.sources["genesis.active"].error, /timed out/);
  const n = calls.length;
  t += 5000;
  await r.read();
  assert.equal(calls.length, n, "no new gateway call inside the ttl");
  t += 130000;
  await r.read();
  assert.ok(calls.length > n, "due again after the ttl");
});
