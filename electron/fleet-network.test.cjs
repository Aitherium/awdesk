"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fleetNetwork, readEcosystem, ECOSYSTEM_FILE } = require("./fleet-network.cjs");

const UNIVERSE = {
  universe_version: 1,
  nodes: [
    { id: "platform", level: "universe", parent: null, title: "Aither" },
    { id: "galaxy:fleet", level: "galaxy", parent: "platform", title: "awnix fleet" },
    { id: "galaxy:cloud", level: "galaxy", parent: "platform", title: "Cloud" },
    { id: "solar:fleet/core", level: "solar", parent: "galaxy:fleet", title: "Core" },
    { id: "svc:genesis", level: "system", parent: "solar:fleet/core", title: "Genesis", health: { state: "ok", reason: "" } },
    { id: "svc:veil", level: "system", parent: "solar:fleet/core", title: "Veil", health: { state: "weird" } },
    { id: "moon:genesis/a", level: "moon", parent: "svc:genesis", title: "a" },
    { id: "route:x", level: "system", parent: "galaxy:cloud", title: "x.example" },
  ],
  links: [
    { source: "svc:veil", target: "svc:genesis", rel: "depends" },
    { source: "svc:veil", target: "svc:genesis", rel: "depends" },
    { source: "svc:genesis", target: "svc:veil", rel: "traffic" },
    { source: "route:x", target: "svc:veil", rel: "routes" },
    { source: "svc:genesis", target: "moon:genesis/a", rel: "depends" },
  ],
};

test("fleetNetwork keeps galaxy:fleet's systems, their group, and depends/traffic between kept nodes", () => {
  const net = fleetNetwork({ universe: UNIVERSE, source: "genesis", stale: false });
  assert.equal(net.ok, true);
  assert.deepEqual(net.nodes.map((n) => n.id), ["svc:genesis", "svc:veil"], "moons and other galaxies dropped");
  assert.equal(net.nodes[0].group, "Core");
  assert.equal(net.nodes[1].health.state, "unknown", "an unknown health word is unknown, never ok");
  assert.deepEqual(net.links.map((l) => `${l.source}>${l.target}:${l.rel}`),
    ["svc:veil>svc:genesis:depends", "svc:genesis>svc:veil:traffic"], "deduped; routes and moon links dropped");
  assert.equal(net.source, "genesis");
});

test("fleetNetwork with no universe says why instead of drawing nothing", () => {
  const net = fleetNetwork({ error: "signed out" });
  assert.equal(net.ok, false);
  assert.equal(net.error, "signed out");
  assert.deepEqual(net.nodes, []);
});

test("readEcosystem reads the vendored public registry; a bad file is an error, not an empty map", () => {
  const eco = readEcosystem(ECOSYSTEM_FILE);
  assert.equal(eco.ok, true, eco.error);
  assert.ok(eco.bricks.length > 20, `${eco.bricks.length} bricks`);
  assert.ok(eco.bricks.some((b) => b.id === "awnix"), "awnix, the fleet host's base, is in the registry");
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-eco-")), "e.json");
  fs.writeFileSync(bad, "{}");
  assert.equal(readEcosystem(bad).ok, false);
});

test("fleetNetwork carries the unit the service verbs take, only when it fits the verb grammar", () => {
  const u = {
    universe_version: 1,
    nodes: [
      { id: "galaxy:fleet", level: "galaxy", parent: "platform", title: "fleet" },
      { id: "solar:fleet/p", level: "solar", parent: "galaxy:fleet", title: "Platform" },
      { id: "svc:avatars", level: "system", parent: "solar:fleet/p", title: "AitherAvatars",
        health: { state: "down", reason: "Watch: offline" }, meta: { unit: "aither-avatars", criticality: "optional" } },
      { id: "ctr:aither-leftover", level: "system", parent: "solar:fleet/p", title: "leftover", health: { state: "parked" } },
      { id: "svc:evil", level: "system", parent: "solar:fleet/p", title: "x", meta: { unit: "a; rm -rf /" } },
    ],
    links: [],
  };
  const net = fleetNetwork({ universe: u });
  const by = Object.fromEntries(net.nodes.map((n) => [n.id, n]));
  assert.equal(by["svc:avatars"].unit, "aither-avatars");
  assert.equal(by["svc:avatars"].criticality, "optional");
  assert.equal(by["ctr:aither-leftover"].unit, "aither-leftover", "a bare container is its own name");
  assert.equal(by["svc:evil"].unit, null, "a unit outside the grammar is never passed on");
});
