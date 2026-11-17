"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { galleryHandlers } = require("./gallery-host.cjs");
const g = require("./avatar-gallery.cjs");

function world({ cap = "mature" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-host-"));
  const roster = path.join(dir, "characters");
  const ratings = { kid: "general", teen: "r15", spicy: "r18", "きわどい下着": "r18", fresh: "" };
  for (const n of Object.keys(ratings)) {
    fs.mkdirSync(path.join(roster, n), { recursive: true });
    fs.writeFileSync(path.join(roster, n, "character.json"), JSON.stringify({ rating: ratings[n], display_name: n.toUpperCase() }));
  }
  let raw = { version: 1, authors: { aither: { character: "kid", voice: "custom:aither" }, iris: { character: "spicy" }, scribe: {} } };
  const state = { cap, changed: 0 };
  const deps = {
    rosterDir: roster,
    proposalsDir: dir,
    allNames: () => Object.keys(ratings),
    ratingOf: (n) => ratings[n],
    isHidden: (n) => !g.tierAllowed(g.tierOf(ratings[n]), state.cap),
    castRaw: () => raw,
    rosterAgents: () => ["atlas", "gobbonet"],
    writeCast: (m) => { raw = m(JSON.parse(JSON.stringify(raw))) || raw; return { ok: true }; },
    setRating: (n, r) => { ratings[n] = r; return true; },
    onChanged: () => { state.changed += 1; },
    modelUrl: (n) => `file:///${n}/model.vrm`,
  };
  return { h: galleryHandlers(() => deps), state, raw: () => raw, dir };
}

test("Hearth: a hidden body is a counted, NAMELESS locked tile; its persona says 'hidden', never the name", () => {
  const w = world({ cap: "everyone" });
  const s = w.h.state();
  assert.deepEqual(s.avatars.map((a) => a.name), ["kid"]);
  assert.deepEqual(s.hidden, { teen: 1, mature: 2, unrated: 1 });
  assert.ok(!JSON.stringify(s).includes("きわどい下着"), "no hidden name anywhere in the page's state");
  assert.ok(!JSON.stringify(s).includes("spicy"));
  const iris = s.personas.find((p) => p.id === "iris");
  assert.equal(iris.character, "");
  assert.equal(iris.hiddenBody, true);
  assert.deepEqual(s.personas.map((p) => p.id), ["aither", "atlas", "iris"], "scribe and gobbonet are not personas");
  assert.equal(w.h.modelUrl({ name: "spicy" }).ok, false, "no model URL for a hidden body");
});

test("assign is his click, and only for a body this profile shows", () => {
  const w = world({ cap: "teen" });
  assert.equal(w.h.assign({ persona: "atlas", name: "spicy" }).ok, false);
  const s = w.h.assign({ persona: "atlas", name: "teen" });
  assert.equal(s.ok, true);
  assert.equal(w.raw().authors.atlas.character, "teen");
  assert.equal(w.state.changed, 1, "the desk re-enforces what is on screen after every change");
});

test("a hidden body cannot be rated (that would confirm its name), and a proposal of one is nameless", () => {
  const w = world({ cap: "everyone" });
  assert.equal(w.h.rate({ name: "spicy", tier: "everyone" }).ok, false);
  g.propose(w.dir, { persona: "atlas", character: "spicy", by: "atlas", why: "spicy is hot" });
  const s = JSON.stringify(w.h.state());
  assert.ok(!s.includes("spicy"), "neither the id nor the agent's text names it");
});

test("rating a fresh import moves it between tiers; unrated counts as mature", () => {
  const w = world({ cap: "mature" });
  assert.equal(w.h.state().avatars.find((a) => a.name === "fresh").tier, "unrated");
  w.h.rate({ name: "fresh", tier: "everyone" });
  w.state.cap = "everyone";
  assert.ok(w.h.state().avatars.some((a) => a.name === "fresh"));
});

test("a proposal is applied only by his click, and only if the profile shows it", () => {
  const w = world({ cap: "everyone" });
  g.propose(w.dir, { persona: "atlas", character: "spicy", by: "atlas" });
  let s = w.h.state();
  assert.equal(s.proposals[0].character, "", "a hidden proposed body is not named");
  assert.equal(w.h.applyProposal({ id: s.proposals[0].id }).ok, false);
  assert.equal(w.raw().authors.atlas, undefined, "nothing was written");
  g.propose(w.dir, { persona: "atlas", character: "kid", by: "atlas" });
  s = w.h.state();
  const kid = s.proposals.find((p) => p.character === "kid");
  w.h.applyProposal({ id: kid.id });
  assert.equal(w.raw().authors.atlas.character, "kid");
});

test("rotation keeps only bodies he may see -- and never DROPS members a narrower profile hides", () => {
  const w = world({ cap: "mature" });
  w.h.rotation({ persona: "aither", set: ["kid", "spicy", "nope"], every: "weekly" });
  assert.deepEqual(w.raw().gallery.rotation.aither, { set: ["kid", "spicy"], every: "weekly" });
  w.state.cap = "everyone";
  assert.deepEqual(w.h.state().personas.find((p) => p.id === "aither").rotation, { every: "weekly", set: ["kid"], hidden: 1 });
  w.h.rotation({ persona: "aither", set: ["kid"], every: "daily" });
  assert.deepEqual(w.raw().gallery.rotation.aither.set, ["kid", "spicy"], "a save on Hearth kept the hidden member");
  w.h.rotation({ persona: "aither", set: [], every: "daily" });
  assert.equal(w.raw().gallery.rotation.aither, undefined, "an empty set is his explicit stop");
  w.state.cap = "mature";
  assert.equal(w.h.standIn({ name: "teen" }).ok, false);
  w.h.standIn({ name: "kid" });
  assert.equal(w.raw().gallery.standIn, "kid");
});
