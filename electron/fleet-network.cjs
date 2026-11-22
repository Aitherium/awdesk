"use strict";

/**
 * fleet-network.cjs -- the data behind the Fleet window's living network.
 *
 * The Fleet window draws the fleet as ONE network on the package's own renderer
 * (vendor/bead-space, createBeadSpace -- the engine the Space pane, Explore, Veil and the
 * ARC solver's mind universe use). Two real sources feed it, both read here in main:
 *
 *   services   the U1 universe (space-client.cjs: Veil -> Genesis -> last-good -> local),
 *              cut down to galaxy:fleet -- every service/container with its health, and
 *              the `depends` / `traffic` links between them (lib/beadspace/universe.py);
 *   aw* bricks vendor/ecosystem/ecosystem.json, the PUBLIC registry gen_ecosystem.py
 *              --pages writes (the same file aitherium.com serves). The page maps it with
 *              the package's fromEcosystem, never an inline copy.
 *
 * Nothing here runs a verb: the page's verbs still go through fleet-window's FleetControl.
 */

const fs = require("node:fs");
const path = require("node:path");

const ECOSYSTEM_FILE = path.join(__dirname, "vendor", "ecosystem", "ecosystem.json");
const FLEET_GALAXY = "galaxy:fleet";
/** The relations the network draws; `routes` / `assigned` belong to other galaxies' views. */
const RELS = new Set(["depends", "traffic"]);
const HEALTH = new Set(["ok", "degraded", "down", "starting", "parked", "unknown"]);
const MAX_NODES = 600;

function text(v, max = 240) {
  return String(v == null ? "" : v).slice(0, max);
}

/**
 * The fleet galaxy as a network: system-level nodes under galaxy:fleet (moons dropped --
 * they are a service's internals), clustered by their solar's title, plus the links
 * between two kept nodes. `answer` is space-client's get() result.
 */
function fleetNetwork(answer) {
  const universe = answer && answer.universe;
  if (!universe || !Array.isArray(universe.nodes)) {
    return { ok: false, error: text((answer && answer.error) || "no universe"), nodes: [], links: [] };
  }
  const byId = new Map();
  for (const n of universe.nodes) if (n && typeof n.id === "string") byId.set(n.id, n);
  const inFleet = (n) => {
    let p = n.parent;
    for (let hops = 0; p && hops < 8; hops++) {
      if (p === FLEET_GALAXY) return true;
      p = (byId.get(p) || {}).parent;
    }
    return false;
  };
  const nodes = [];
  for (const n of universe.nodes) {
    if (!n || n.level !== "system" || !inFleet(n)) continue;
    const solar = byId.get(n.parent) || {};
    const h = n.health && typeof n.health === "object" ? n.health : {};
    const state = HEALTH.has(h.state) ? h.state : "unknown";
    const meta = n.meta && typeof n.meta === "object" ? n.meta : {};
    // The name the service verbs (restart / logs) take: the quadlet unit, else a bare
    // container id. Only a name the verb grammar accepts is passed on.
    const unitName = typeof meta.unit === "string" ? meta.unit
      : n.id.startsWith("ctr:") ? n.id.slice(4) : "";
    nodes.push({
      id: n.id,
      title: text(n.title || n.id, 80),
      group: text(solar.title || n.parent || "fleet", 60),
      health: { state, reason: text(h.reason), at: text(h.at, 40) },
      unit: /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,120}$/.test(unitName) ? unitName : null,
      criticality: text(meta.criticality, 20) || null,
    });
    if (nodes.length >= MAX_NODES) break;
  }
  const kept = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  const links = [];
  for (const l of universe.links || []) {
    if (!l || !RELS.has(l.rel) || !kept.has(l.source) || !kept.has(l.target) || l.source === l.target) continue;
    const key = `${l.source}>${l.target}>${l.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: l.source, target: l.target, rel: l.rel });
  }
  return {
    ok: true,
    source: text(answer.source || "remote", 20),
    stale: Boolean(answer.stale),
    error: answer.error ? text(answer.error) : "",
    savedAt: answer.savedAt || null,
    generatedAt: text(universe.generated_at, 40),
    nodes,
    links,
  };
}

/** The public aw* registry the window vendors. {ok, bricks, stacks} or {ok:false, error}. */
function readEcosystem(file = ECOSYSTEM_FILE) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!d || !Array.isArray(d.bricks)) return { ok: false, error: "ecosystem.json carries no bricks" };
    return { ok: true, generatedAt: text(d.generated_at, 40), bricks: d.bricks, stacks: Array.isArray(d.stacks) ? d.stacks : [] };
  } catch (error) {
    return { ok: false, error: text((error && error.message) || error) };
  }
}

module.exports = { fleetNetwork, readEcosystem, ECOSYSTEM_FILE, FLEET_GALAXY };
