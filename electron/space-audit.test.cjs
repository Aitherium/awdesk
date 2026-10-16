"use strict";

/**
 * The BeadSpace audit lens on the desk side (owner, 2026-10-16: "we were supposed to have
 * this visualization all built into BeadSpace"):
 *
 *   1. The pane does not go stale when Veil is down: the universe is read straight from
 *      Genesis on the fleet host (source "genesis", live), and only when that fails too
 *      does it fall to the last good copy.
 *   2. The local read never goes through a shell and only ever names a Genesis instance.
 *   3. unit-start / unit-park: the unit must be the node's own, core is refused, park
 *      needs confirmed, and the command line is built from a closed grammar.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSpaceClient, localGenesisFetcher, localGenesisArgv, normaliseVerb, defaultLocalFetcher,
} = require("./space-client.cjs");
const { spaceHandlers, unitArgv } = require("./space-window.cjs");
const { buildUnitCommand } = require("./fleet-control.cjs");

function universe(extra = [], etag = "e1") {
  const at = "2026-10-16T09:00:00Z";
  const node = (id, parent, level, more = {}) => ({
    id, title: id, level, parent, cluster: parent || "platform", status: "open", createdAt: at,
    health: { state: "ok", reason: "fine" }, verbs: [], explore: [], meta: {}, ...more,
  });
  return {
    universe_version: 1, generated_at: at, etag,
    nodes: [node("platform", null, "universe"), node("galaxy:fleet", "platform", "galaxy"), ...extra],
    links: [], meta: { ttl_s: 15 },
  };
}

test("Veil down: the universe comes from Genesis on the fleet, live, never stale", async () => {
  const local = universe([], "local-1");
  const client = createSpaceClient({
    fetchUniverse: async () => { throw new Error("universe route unreachable: ECONNREFUSED"); },
    fetchLocal: async () => ({ universe: local, etag: "local-1" }),
  });
  const r = await client.get();
  assert.equal(r.ok, true);
  assert.equal(r.source, "genesis");
  assert.equal(r.stale, false);
  assert.match(r.error, /ECONNREFUSED/); // the badge can still say why Veil was skipped
  assert.equal(r.universe.etag, "local-1");
});

test("Veil AND Genesis down: the last good copy, with both reasons", async () => {
  const saved = universe([], "saved");
  const store = { remember() {}, recall: () => ({ value: saved, savedAt: "2026-10-16T05:00:00Z" }) };
  const client = createSpaceClient({
    fetchUniverse: async () => { throw new Error("HTTP 502"); },
    fetchLocal: async () => { throw new Error("local Genesis: aitheros-genesis-a: no answer"); },
    store,
  });
  const r = await client.get();
  assert.equal(r.source, "last-good");
  assert.equal(r.stale, true);
  assert.match(r.error, /HTTP 502; local Genesis/);
});

test("a remote answer still wins over the local read", async () => {
  let localCalls = 0;
  const client = createSpaceClient({
    fetchUniverse: async () => ({ universe: universe([], "remote"), etag: "remote" }),
    fetchLocal: async () => { localCalls += 1; return { universe: universe() }; },
  });
  const r = await client.get();
  assert.equal(r.source, "remote");
  assert.equal(localCalls, 0);
});

test("the local read: wsl -e (no shell), a Genesis instance only, -a then -b", async () => {
  const cmd = localGenesisArgv("aitheros-genesis-a", { distro: "awnix", local: false });
  assert.equal(cmd.file, "wsl.exe");
  assert.deepEqual(cmd.args.slice(0, 6), ["-d", "awnix", "-u", "root", "-e", "podman"]);
  assert.ok(!cmd.args.includes("sh") && !cmd.args.includes("-c"));
  assert.equal(cmd.args.at(-1), "https://localhost:8001/beadspace/universe");
  assert.throws(() => localGenesisArgv("aitheros-veil"), /not a Genesis instance/);
  const asked = [];
  const fetchLocal = localGenesisFetcher({
    argvOf: (c) => ({ file: "x", args: [c] }),
    execFile: (_f, args, _o, cb) => {
      asked.push(args[0]);
      cb(null, args[0] === "aitheros-genesis-a" ? "" : JSON.stringify(universe([], "from-b")));
    },
  });
  const got = await fetchLocal();
  assert.deepEqual(asked, ["aitheros-genesis-a", "aitheros-genesis-b"]);
  assert.equal(got.universe.etag, "from-b");
  const refuse = localGenesisFetcher({
    argvOf: (c) => ({ file: "x", args: [c] }),
    execFile: (_f, _a, _o, cb) => cb(null, JSON.stringify({ detail: "The universe is for platform operators." })),
  });
  await assert.rejects(refuse(), /platform operators/);
  assert.equal(defaultLocalFetcher({ platform: "linux", env: {} }), null);
  assert.equal(defaultLocalFetcher({ platform: "win32", env: { AWDESK_SPACE_LOCAL: "0" } }), null);
});

test("unit verbs survive normalisation; park is confirm-first; a bad id is dropped", () => {
  assert.deepEqual(normaliseVerb({ id: "unit-park:aither-iris", label: "Park", danger: "none", transport: "unit" }),
    { id: "unit-park:aither-iris", label: "Park", danger: "confirm", transport: "unit" });
  assert.equal(normaliseVerb({ id: "unit-start:aither-shop", label: "Start", transport: "unit", primary: true }).danger, "none");
  assert.equal(normaliseVerb({ id: "unit-start:aither x;reboot", label: "Start", transport: "unit" }), null);
  assert.equal(normaliseVerb({ id: "unit-nuke:aither-shop", label: "Nuke", transport: "unit" }), null);
});

const IRIS = { id: "svc:Iris", title: "Iris", meta: { unit: "aither-iris", verdict: "trim-candidate" },
  verbs: [{ id: "unit-park:aither-iris", label: "Park", danger: "confirm", transport: "unit" }] };
const SHOP = { id: "svc:Shop", title: "Shop", meta: { unit: "aither-shop", verdict: "breaking" },
  verbs: [{ id: "unit-start:aither-shop", label: "Start", danger: "none", transport: "unit", primary: true }] };
const CORE = { id: "ctr:aitheros-postgres", title: "aitheros-postgres",
  meta: { unit: "aither-aitheros-postgres", criticality: "core" },
  verbs: [{ id: "unit-park:aither-aitheros-postgres", label: "Park", danger: "confirm", transport: "unit" }] };
const LIAR = { id: "svc:Liar", title: "Liar", meta: { unit: "aither-liar" },
  verbs: [{ id: "unit-park:aither-genesis", label: "Park", danger: "confirm", transport: "unit" }] };

function rig() {
  const ran = [];
  const u = universe([IRIS, SHOP, CORE, LIAR].map((n) => ({ ...n, level: "system", parent: "galaxy:fleet",
    cluster: "galaxy:fleet", status: "open", createdAt: "x", health: { state: "ok" }, explore: [] })));
  const handlers = spaceHandlers({
    getControl: () => ({ run: async () => ({ ok: true }) }),
    client: { current: () => u, get: async () => ({ ok: true, universe: u }) },
    askAgent: async () => ({ ok: true }),
    openInternal: () => true,
    runUnit: async (verb, unit) => { ran.push([verb, unit]); return { ok: true, verified: `${unit} is active` }; },
  });
  return { ran, verb: (p) => handlers["desk:space-verb"]({}, p) };
}

test("start runs the node's own unit through the script", async () => {
  const { ran, verb } = rig();
  const r = await verb({ nodeId: "svc:Shop", verbId: "unit-start:aither-shop" });
  assert.equal(r.ok, true);
  assert.deepEqual(ran, [["start", "aither-shop.service"]]);
  assert.match(r.text, /is active/);
});

test("park without confirmed is refused and runs nothing; with it, it parks", async () => {
  const { ran, verb } = rig();
  const no = await verb({ nodeId: "svc:Iris", verbId: "unit-park:aither-iris" });
  assert.equal(no.ok, false);
  assert.match(no.error, /confirm it first/);
  assert.deepEqual(ran, []);
  const yes = await verb({ nodeId: "svc:Iris", verbId: "unit-park:aither-iris", confirmed: true });
  assert.equal(yes.ok, true);
  assert.deepEqual(ran, [["park", "aither-iris.service"]]);
});

test("core is never parked, and a verb naming ANOTHER unit is refused", async () => {
  const { ran, verb } = rig();
  const core = await verb({ nodeId: "ctr:aitheros-postgres", verbId: "unit-park:aither-aitheros-postgres", confirmed: true });
  assert.equal(core.ok, false);
  assert.match(core.error, /core/);
  const liar = await verb({ nodeId: "svc:Liar", verbId: "unit-park:aither-genesis", confirmed: true });
  assert.equal(liar.ok, false);
  assert.match(liar.error, /does not run aither-genesis/);
  assert.deepEqual(ran, []);
  assert.equal(unitArgv(IRIS, "unit-park:aither-iris", true).unit, "aither-iris.service");
});

test("the unit command line comes from a closed grammar only", () => {
  const cmd = buildUnitCommand("park", "aither-iris.service", { servicesScript: "C:\\x\\inv.py", distro: "awnix", local: false });
  assert.deepEqual(cmd.args.slice(0, 6), ["-d", "awnix", "-u", "root", "sh", "-c"]);
  assert.equal(cmd.args[6], "python3 '/mnt/c/x/inv.py' park aither-iris.service --json");
  assert.throws(() => buildUnitCommand("park", "aither-iris.service; reboot"), /not a <name>\.service/);
  assert.throws(() => buildUnitCommand("restart", "aither-iris.service"), /start or park/);
});
