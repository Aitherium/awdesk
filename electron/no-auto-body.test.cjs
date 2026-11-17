"use strict";

/**
 * no-auto-body.test.cjs -- owner P0, 2026-11-17: "I can't have Aither/bots randomly selecting
 * avatars ... I can't let my mom, kids or strangers see this." A Claude Code session actor was
 * handed a mature model by an automatic pick. This file proves no code path assigns a body
 * without an owner action:
 *
 *   1. the resolver gives a body ONLY from an owner-written row (actors[...] / authors.*);
 *   2. no source file carries an automatic pick (the hash, the proper pool, a default body
 *      for a session);
 *   3. every call site that WRITES a body into cast.json is on a reviewed list of owner
 *      actions -- a new writer fails here until it is reviewed and listed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cast = require("./cast-config.cjs");

const ROOT = __dirname;
const sources = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith(".cjs") && !f.endsWith(".test.cjs") && f !== "no-auto-body.test.cjs");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("resolveActor: no owner row = no body, for every kind of actor and every fallback", () => {
  const roster = ["gold-kitsune", "aither-v2", "charlie-5e48d775"];
  const snapshot = {
    defaults: { character: "gold-kitsune", voice: "en-US-JennyNeural" },
    authors: { atlas: { character: "charlie-5e48d775" } },
  };
  const agentRoster = { lyra: { character: "aither-v2" } };
  const contexts = [
    { author: "room-custom-name-server-butto-bf1f", kind: "claude_code", id: "bf1f" },
    { kind: "claude_code", id: "x" },
    { kind: "subagent", id: "y" },
    { kind: "relay", channel: "#agents", nick: "someone" },
    { author: "lyra" }, // a platform-declared body is a proposal, not an assignment
    { author: "nobody", seat: 3 },
  ];
  for (const ctx of contexts) {
    const r = cast.resolveActor(snapshot, { ...ctx, roster, agentRoster, taken: [], resident: null });
    assert.equal(r.character, null, `${JSON.stringify(ctx)} must have no body`);
    assert.equal(r.characterFrom, "none");
  }
  const owned = cast.resolveActor(snapshot, { author: "atlas", roster, agentRoster });
  assert.equal(owned.character, "charlie-5e48d775", "the owner's own row is honoured");
  const hidden = cast.resolveActor(snapshot, { author: "atlas", roster: ["aither-v2"], agentRoster });
  assert.equal(hidden.character, null, "an owner row whose body the rating hides renders nothing");
});

test("no source file carries an automatic body pick", () => {
  const forbidden = [
    [/\bstableCharacter\s*\(/, "the rendezvous-hash body pick"],
    [/\bcharacterOrder\s*\(/, "the hash's preference order"],
    [/\bproperPool\s*\(/, "the automatic-pick pool"],
    [/\bpickCharacter\s*\(/, "room-stage's pick wrapper"],
  ];
  const hits = [];
  for (const f of sources) {
    const text = read(f);
    for (const [re, why] of forbidden) if (re.test(text)) hits.push(`${f}: ${why}`);
  }
  assert.deepEqual(hits, []);
});

test("every cast.json body writer is a reviewed owner action", () => {
  // file -> number of setAgentAvatar( call sites, each one reviewed as an owner action:
  //   agent-avatars.cjs       the definition itself
  //   avatar-catalog-sync.cjs a pull only under `replace` (his own "sync now"); a push renames
  //                           the body HE assigned to its canonical name
  //   main.cjs                his Aither female/male choice (x3: pick, apply, the one-time move of
  //                           Aither's own row) and the tray's "Assign current character" click
  const reviewed = { "agent-avatars.cjs": 1, "avatar-catalog-sync.cjs": 2, "main.cjs": 4 };
  const found = {};
  for (const f of sources) {
    const n = (read(f).match(/\bsetAgentAvatar\s*\(/g) || []).length;
    if (n) found[f] = n;
  }
  assert.deepEqual(found, reviewed, "a new body writer must be reviewed as an owner action and listed here");
  // And the automatic pull writes only under `replace`.
  const pull = read("avatar-catalog-sync.cjs");
  assert.match(pull, /if \(changed && deps\.replace !== true\) \{/);
});

test("the swarm never dresses a session or an undressed agent", () => {
  const swarm = require("./agent-swarm.cjs");
  const rows = swarm.withIdentity([
    { id: "aither", kind: "persona", source: "discord" },
    { id: "session-bf1f", kind: "session", source: "sessions" },
    { id: "apollo", kind: "persona", source: "discord" },
  ], { authors: {}, characters: new Set(["aither-v2", "session-bf1f", "apollo", "gold-kitsune"]) });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by["session-bf1f"].character, "");
  assert.equal(by.apollo.character, "", "not even a model that happens to share the agent's name");
});
