"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const {
  createSpaceClient, veilUniverseFetcher, localSkeleton, normaliseUniverse, CACHE_KEY,
  FLEET_VERDICT_MAX_AGE_MS,
} = require("./space-client.cjs");
const { createLastGoodCache } = require("./last-good-cache.cjs");
const { DESTRUCTIVE } = require("./fleet-control.cjs");

function universe(extraNodes = [], etag = "e1") {
  const at = "2026-10-15T00:00:00Z";
  const node = (id, parent, level, verbs = []) => ({
    id, title: id, level, parent, cluster: parent || "platform", status: "open", createdAt: at,
    health: { state: "ok", reason: "fine" }, verbs, explore: [],
  });
  return {
    universe_version: 1, generated_at: at, etag,
    nodes: [node("platform", null, "universe"), node("galaxy:fleet", "platform", "galaxy"), ...extraNodes],
    links: [], meta: { ttl_s: 15 },
  };
}

function tmpStore() {
  return createLastGoodCache({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "space-client-")) });
}

const UP = { fleet: { running: 140, masked: 0, units: 200 } };
const DOWN = { fleet: { running: 0, masked: 200, units: 200 } };

test("a 304 keeps the snapshot and sends the etag it was given", async () => {
  let t = 0;
  const seen = [];
  const fetchUniverse = async ({ etag }) => {
    seen.push(etag);
    return seen.length === 1 ? { universe: universe([], "W/1"), etag: "W/1" } : { notModified: true };
  };
  const client = createSpaceClient({ fetchUniverse, now: () => t, ttlMs: 15000 });
  const first = await client.get();
  assert.equal(first.source, "remote");
  t = 20000; // past the TTL
  const second = await client.get();
  assert.deepEqual(seen, [null, "W/1"]);
  assert.equal(second.source, "remote");
  assert.equal(second.stale, false);
  assert.deepEqual(second.universe.nodes.map((n) => n.id), first.universe.nodes.map((n) => n.id));
});

test("the main-side cache answers inside the TTL without a fetch", async () => {
  let calls = 0;
  let t = 0;
  const client = createSpaceClient({ fetchUniverse: async () => { calls += 1; return { universe: universe() }; }, now: () => t });
  await client.get();
  t = 14000;
  await client.get();
  assert.equal(calls, 1);
});

test("a failure returns the last good universe, marked stale", async () => {
  const store = tmpStore();
  let fail = false;
  let t = 0;
  const fetchUniverse = async () => {
    if (fail) throw new Error("HTTP 502");
    return { universe: universe([{ id: "svc:Secrets", title: "Secrets", level: "system", parent: "galaxy:fleet",
      cluster: "galaxy:fleet", status: "open", createdAt: "x", health: { state: "ok" } }]) };
  };
  const client = createSpaceClient({ fetchUniverse, store, now: () => t });
  await client.get();
  assert.ok(store.recall(CACHE_KEY), "a good answer is saved");
  // A NEW client (a desk restart) with a failing route still has it, from disk.
  fail = true;
  t = 100000;
  const reborn = createSpaceClient({ fetchUniverse, store: createLastGoodCache({ dir: path.dirname(store.fileFor(CACHE_KEY)) }), now: () => t });
  const r = await reborn.get();
  assert.equal(r.ok, true);
  assert.equal(r.source, "last-good");
  assert.equal(r.stale, true);
  assert.match(r.error, /502/);
  assert.ok(r.universe.nodes.some((n) => n.id === "svc:Secrets"));
});

test("nothing at all returns the local skeleton, never an empty universe", async () => {
  const client = createSpaceClient({
    fetchUniverse: async () => { throw new Error("signed out"); },
    fleetStatus: () => ({ verdict: UP, at: Date.now(), changedAt: 0 }),
  });
  const r = await client.get();
  assert.equal(r.ok, true);
  assert.equal(r.source, "local");
  assert.equal(r.stale, true);
  const ids = r.universe.nodes.map((n) => n.id);
  for (const id of ["platform", "galaxy:fleet", "galaxy:dgx", "galaxy:mesh", "galaxy:cloud", "galaxy:agents", "galaxy:data", "gpu:fleet/0"]) {
    assert.ok(ids.includes(id), `skeleton has ${id}`);
  }
  const fleet = r.universe.nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(fleet.health.state, "ok");
  assert.equal(r.universe.nodes.find((n) => n.id === "galaxy:dgx").health.state, "unknown");
  assert.ok(fleet.verbs.some((v) => v.primary), "the fleet galaxy has one obvious verb");
  assert.ok(r.universe.nodes.find((n) => n.id === "gpu:fleet/0").verbs.some((v) => v.id === "gpu-wake"));
  assert.equal(client.current(), r.universe, "main keeps what it handed out");
});

test("the skeleton's fleet verbs flip with the desk's own verdict", () => {
  const asleep = localSkeleton(DOWN).nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(asleep.health.state, "down");
  assert.equal(asleep.verbs.find((v) => v.primary).id, "fleet-wake");
  const awake = localSkeleton(UP).nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(awake.verbs.find((v) => v.primary).id, "verbs-status");
  assert.equal(localSkeleton(null).nodes.find((n) => n.id === "galaxy:fleet").health.state, "unknown");
});

test("galaxy:fleet health is the desk's when it has a verdict, whatever the server said", () => {
  const u = normaliseUniverse(universe(), DOWN);
  const fleet = u.nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(fleet.health.state, "down");
  assert.equal(fleet.health.source, "desk");
  assert.equal(fleet.status, "blocked");
  // No verdict yet: the server's word stands.
  assert.equal(normaliseUniverse(universe(), null).nodes.find((n) => n.id === "galaxy:fleet").health.state, "ok");
});

test("the desk's own running count rides on galaxy:fleet, stamped when it was measured", () => {
  const at = Date.parse("2026-10-17T03:40:00Z");
  const fleet = normaliseUniverse(universe(), { ...UP, fleet: { ...(UP.fleet || {}), running: 78 } }, at)
    .nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(fleet.meta.desk_running, 78);
  assert.equal(fleet.meta.desk_running_at, "2026-10-17T03:40:00.000Z");
  // No desk verdict (or one without a count): nothing is invented.
  assert.equal((normaliseUniverse(universe(), null).nodes.find((n) => n.id === "galaxy:fleet").meta || {}).desk_running,
    undefined);
  assert.equal((normaliseUniverse(universe(), { fleet: {} }).nodes.find((n) => n.id === "galaxy:fleet").meta || {})
    .desk_running, undefined);
});

test("danger is the desk's: DESTRUCTIVE -> confirm, everything else none", () => {
  const verbs = [
    { id: "fleet-sleep", label: "Sleep fleet", danger: "none", transport: "fleet" }, // server under-claimed
    { id: "verbs-status", label: "Fleet status", danger: "confirm", transport: "fleet" }, // over-claimed
  ];
  const u = normaliseUniverse(universe([{ id: "gpu:x/0", title: "g", level: "system", parent: "galaxy:fleet",
    cluster: "galaxy:fleet", status: "open", createdAt: "x", health: { state: "ok" }, verbs }]), null);
  const out = u.nodes.find((n) => n.id === "gpu:x/0").verbs;
  assert.ok(DESTRUCTIVE.has("fleet-sleep"));
  assert.equal(out.find((v) => v.id === "fleet-sleep").danger, "confirm");
  assert.equal(out.find((v) => v.id === "verbs-status").danger, "none");
});

test("fleet verbs the desk cannot run are dropped, and so are unknown planes and transports", () => {
  const verbs = [
    { id: "rm-rf-everything", label: "Nope", danger: "none", transport: "fleet" },
    { id: "services-sick", label: "Sick services", danger: "none", transport: "fleet" },
    { id: "open-plane:strata", label: "Open Strata", danger: "none", transport: "open" },
    { id: "open-plane:bogus", label: "Open bogus", danger: "none", transport: "open" },
    { id: "status", label: "Status", danger: "none", transport: "shell" },
  ];
  const u = normaliseUniverse(universe([{ id: "svc:Strata", title: "Strata", level: "system", parent: "galaxy:fleet",
    cluster: "galaxy:fleet", status: "open", createdAt: "x", health: { state: "ok" }, verbs }]), null);
  assert.deepEqual(u.nodes.find((n) => n.id === "svc:Strata").verbs.map((v) => v.id), ["services-sick", "open-plane:strata"]);
});

test("the Veil fetcher sends the bearer and If-None-Match, and reads a 304", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (init.headers["If-None-Match"]) return { status: 304, ok: false, text: async () => "" };
    return { status: 200, ok: true, headers: { get: () => "W/9" }, text: async () => JSON.stringify(universe()) };
  };
  const f = veilUniverseFetcher({ token: async () => "tok", fetchImpl });
  const first = await f({ etag: null });
  assert.equal(first.etag, "W/9");
  assert.equal(calls[0].url, "https://api.aitherium.com/api/beadspace/universe");
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  assert.deepEqual(await f({ etag: "W/9" }), { notModified: true });
  await assert.rejects(veilUniverseFetcher({ token: async () => null, fetchImpl })({}), /signed out/);
  const empty = veilUniverseFetcher({ token: async () => "t", fetchImpl: async () => ({ status: 200, ok: true, text: async () => "{\"nodes\":[]}" }) });
  await assert.rejects(empty({}), /not a U1 universe/);
});

test("an OLD desk fleet verdict never outranks the server, and carries its real time", async () => {
  // The owner opened Fleet once (UP), then the fleet went to sleep; nothing re-probed.
  let t = 1_000_000;
  const measuredAt = t;
  const server = universe();
  server.nodes.find((n) => n.id === "galaxy:fleet").health = { state: "down", reason: "server: 0 running" };
  const client = createSpaceClient({
    fetchUniverse: async () => ({ universe: server }),
    fleetStatus: () => ({ verdict: UP, at: measuredAt, changedAt: 0 }),
    now: () => t,
  });
  // Fresh: the desk's word wins, stamped when it was MEASURED, not when it was read.
  t = measuredAt + 30_000;
  let fleet = (await client.get({ fresh: true })).universe.nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(fleet.health.state, "ok");
  assert.equal(fleet.health.at, new Date(measuredAt).toISOString());
  // Past the max age: the server's "down" stands and the primary verb is the server's.
  t = measuredAt + FLEET_VERDICT_MAX_AGE_MS + 1;
  fleet = (await client.get({ fresh: true })).universe.nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(fleet.health.state, "down");
  assert.equal(fleet.health.reason, "server: 0 running");
});

test("a fleet verb run after the desk's probe invalidates the verdict at once", async () => {
  const t = 5_000_000;
  const server = universe();
  server.nodes.find((n) => n.id === "galaxy:fleet").health = { state: "down", reason: "asleep" };
  const client = createSpaceClient({
    fetchUniverse: async () => ({ universe: server }),
    // UP measured 10 s ago, then fleet-sleep finished 2 s ago.
    fleetStatus: () => ({ verdict: UP, at: t - 10_000, changedAt: t - 2_000 }),
    now: () => t,
  });
  const fleet = (await client.get()).universe.nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(fleet.health.state, "down");
  // With no platform either, the skeleton says unknown and why -- never the old UP.
  const local = createSpaceClient({
    fetchUniverse: async () => { throw new Error("offline"); },
    fleetStatus: () => ({ verdict: UP, at: t - 10_000, changedAt: t - 2_000 }),
    now: () => t,
  });
  const lf = (await local.get()).universe.nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(lf.health.state, "unknown");
  assert.match(lf.health.reason, /fleet verb ran after/);
  assert.equal(lf.verbs.find((v) => v.primary).id, "verbs-status");
});

test("a bare verdict with no time is not trusted", async () => {
  const client = createSpaceClient({
    fetchUniverse: async () => { throw new Error("offline"); },
    fleetStatus: () => UP,
  });
  const fleet = (await client.get()).universe.nodes.find((n) => n.id === "galaxy:fleet");
  assert.equal(fleet.health.state, "unknown");
});

test("FleetControl records when a state-changing verb finished, and status reads do not", () => {
  const src = fs.readFileSync(path.join(__dirname, "fleet-control.cjs"), "utf8");
  assert.match(src, /this\.lastChangeAt = 0;/);
  assert.match(src, /if \(!\/\(\^\|-\)status\$\/\.test\(action\)\) this\.lastChangeAt = Date\.now\(\);/);
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /verdict: control\.lastStatus, at: control\.lastStatusAt, changedAt: control\.lastChangeAt/);
});
