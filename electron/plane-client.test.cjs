"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createPlaneClient, veilPlaneFetcher, parseToolJson, pickServiceRow, PLANES, PLANE_IDS, API_BASE, ROUTE,
} = require("./plane-client.cjs");
const { planeHandlers, planeFile } = require("./plane-window.cjs");

/** A fake Veil plane route: answers[planeId] = {readId: data | Error}. */
function veil(answers) {
  const calls = [];
  const fetchPlane = async (planeId) => {
    calls.push(planeId);
    const a = answers[planeId];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`unexpected plane ${planeId}`);
    const reads = {};
    for (const [id, v] of Object.entries(a)) {
      reads[id] = v instanceof Error ? { ok: false, error: v.message } : { ok: true, data: v };
    }
    return { ok: true, plane: planeId, reads };
  };
  return { fetchPlane, calls };
}

/** A fake fetch recording what the desk sent. */
function fakeFetch(status, body) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, headers: init.headers });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, sent };
}

test("the planes exist, each with a service read first", () => {
  assert.deepEqual(PLANE_IDS, ["strata", "pulse", "watch", "flux", "nexus", "mesh"]);
  for (const id of PLANE_IDS) {
    const first = PLANES[id].reads[0];
    assert.equal(first.id, "service", `${id} starts with its service row`);
    assert.equal(first.service.toLowerCase(), id);
  }
});

test("no plane names a mutating read -- the read table is the whole surface", () => {
  const all = PLANE_IDS.flatMap((id) => PLANES[id].reads.map((r) => `${r.id} ${r.tool}`));
  for (const r of all) {
    assert.doesNotMatch(r, /restart|reclaim|delete|save|share|publish|import|create|set_|remediate/, `${r} is not a read`);
  }
});

test("routing: the default transport is GET api.aitherium.com/api/admin/planes/<id> with the desk bearer", async () => {
  assert.equal(API_BASE, "https://api.aitherium.com");
  assert.equal(ROUTE, "/api/admin/planes/");
  const { fetchImpl, sent } = fakeFetch(200, { ok: true, reads: { service: { ok: true, data: { services: {} } } } });
  const fetchPlane = veilPlaneFetcher({ token: async () => "desk-bearer", fetchImpl });
  const body = await fetchPlane("strata");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.aitherium.com/api/admin/planes/strata");
  assert.equal(sent[0].headers.Authorization, "Bearer desk-bearer");
  assert.equal(Object.keys(sent[0].headers).length, 2, "only the bearer and Accept: no identity headers");
  assert.ok(body.reads.service);
});

test("routing: signed out never calls the network; 401/403 say what to do", async () => {
  const { fetchImpl, sent } = fakeFetch(200, {});
  await assert.rejects(veilPlaneFetcher({ token: async () => null, fetchImpl })("pulse"), /signed out/);
  assert.equal(sent.length, 0);
  await assert.rejects(veilPlaneFetcher({ token: async () => "t", fetchImpl: fakeFetch(401, {}).fetchImpl })("pulse"),
    /HTTP 401: the desk session is not signed in/);
  await assert.rejects(veilPlaneFetcher({ token: async () => "t", fetchImpl: fakeFetch(403, {}).fetchImpl })("pulse"),
    /HTTP 403: platform operator only/);
  await assert.rejects(veilPlaneFetcher({ token: async () => "t", fetchImpl: fakeFetch(200, { ok: true }).fetchImpl })("pulse"),
    /answer has no reads/);
});

test("snapshot asks the route once for that plane and keeps each answer", async () => {
  const { fetchPlane, calls } = veil({ watch: {
    service: { services: { Watch: { status: "running", port: 8082 } } },
    alerts: { alerts: [] },
    startup: { components: { a: "ready" } },
    plugins: [{ name: "disk", loaded: true }],
  } });
  const snap = await createPlaneClient({ fetchPlane }).snapshot("watch");
  assert.deepEqual(calls, ["watch"]);
  assert.equal(snap.ok, true);
  assert.equal(snap.failed, 0);
  assert.equal(snap.reads.length, 4);
  assert.deepEqual(snap.reads.find((r) => r.id === "plugins").data, [{ name: "disk", loaded: true }]);
});

test("one dead service costs its own read, never the page -- and never reads as empty", async () => {
  const { fetchPlane } = veil({ pulse: {
    service: { services: { Pulse: { status: "running" } } },
    disk: new Error("pulse /disk/status: HTTP 503 -- pulse is restarting"),
  } });
  const snap = await createPlaneClient({ fetchPlane }).snapshot("pulse");
  assert.equal(snap.ok, false);
  assert.equal(snap.failed, 1);
  const disk = snap.reads.find((r) => r.id === "disk");
  assert.equal(disk.ok, false);
  assert.match(disk.error, /HTTP 503 -- pulse is restarting/);
  assert.equal(disk.data, undefined, "a failed read carries no data to render as 'nothing'");
  assert.equal(snap.reads.find((r) => r.id === "service").ok, true);
});

test("a route failure fails every read; a read the route skipped is failed, not empty", async () => {
  const gone = createPlaneClient({ fetchPlane: async () => { throw new Error("HTTP 401: bad bearer"); } });
  const snap = await gone.snapshot("nexus");
  assert.equal(snap.failed, snap.reads.length);
  for (const r of snap.reads) assert.match(r.error, /HTTP 401: bad bearer/);

  const partial = await createPlaneClient({ fetchPlane: veil({ nexus: { service: { services: {} } } }).fetchPlane })
    .snapshot("nexus");
  assert.match(partial.reads.find((r) => r.id === "collections").error, /did not answer this read/);

  assert.throws(() => parseToolJson("flux_context", "Flux is offline"), /unparseable answer: Flux is offline/);
  assert.throws(() => parseToolJson("x", "42"), /expected JSON, got number/);
  assert.throws(() => parseToolJson("x", '{"detail":"forbidden"}'), /x: forbidden/);
  assert.deepEqual(parseToolJson("x", "[1,2]"), [1, 2]);
});

test("an unknown plane is refused before any call", async () => {
  const { fetchPlane, calls } = veil({});
  await assert.rejects(createPlaneClient({ fetchPlane }).snapshot("secrets"), /unknown plane secrets/);
  assert.equal(calls.length, 0);
});

test("IPC: snapshot answers {ok,data}, a bad plane id answers {ok:false} and never throws", async () => {
  const { fetchPlane } = veil({ nexus: {
    service: { services: {} },
    collections: { collections: [{ name: "docs", count: 3 }] },
  } });
  const handlers = planeHandlers(createPlaneClient({ fetchPlane }));
  const good = await handlers["desk:plane-snapshot"]({}, "nexus");
  assert.equal(good.ok, true);
  assert.equal(good.data.plane, "nexus");
  const bad = await handlers["desk:plane-snapshot"]({}, "../../etc");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown plane/);
  const list = await handlers["desk:plane-list"]();
  assert.deepEqual(list.data.map((p) => p.id), PLANE_IDS);
  assert.equal(planeFile("flux"), "plane-flux.html");
  assert.throws(() => planeFile("ops"), /unknown plane/);
});

test("every plane page exists, names its plane, and loads the shared renderer", () => {
  for (const id of PLANE_IDS) {
    const html = fs.readFileSync(path.join(__dirname, planeFile(id)), "utf8");
    assert.match(html, new RegExp(`<body data-plane="${id}">`));
    assert.match(html, /<script src="plane-page\.js"><\/script>/);
    assert.match(html, /script-src file:/, "the CSP must allow the shared script");
    assert.doesNotMatch(html, /script-src[^;]*unsafe-eval/);
  }
});

test("every read a plane asks for is in Veil's plane table (when the Veil tree is checked out)", (t) => {
  const file = path.join(__dirname, "..", "..", "..", "AitherOS", "apps", "AitherVeil", "src", "lib", "plane-reads.ts");
  if (!fs.existsSync(file)) {
    t.skip("AitherVeil src/lib/plane-reads.ts not in this checkout");
    return;
  }
  const source = fs.readFileSync(file, "utf8");
  for (let i = 0; i < PLANE_IDS.length; i += 1) {
    const start = source.indexOf(`  ${PLANE_IDS[i]}: {`);
    assert.ok(start >= 0, `plane ${PLANE_IDS[i]} is not in plane-reads.ts`);
    const next = i + 1 < PLANE_IDS.length ? source.indexOf(`  ${PLANE_IDS[i + 1]}: {`, start) : source.indexOf("})", start);
    const block = source.slice(start, next);
    for (const r of PLANES[PLANE_IDS[i]].reads) {
      if (r.id === "service") assert.match(block, new RegExp(`serviceRead\\('${r.service}'\\)`));
      else assert.match(block, new RegExp(`id: '${r.id}'`), `${PLANE_IDS[i]}.${r.id} is not served by Veil`);
    }
  }
});

test("Genesis /services answers the WHOLE fleet: each plane keeps only its own row", async () => {
  const fleet = { services: {
    Genesis: { status: "running", port: 8001 },
    Strata: { status: "running", port: 8136 },
    Pulse: { status: "stopped", port: 8081 },
    Chronicle: { status: "unknown" },
  } };
  const { fetchPlane } = veil({ strata: { service: fleet, stats: { tiers: {} }, pools: { pools: {} }, artifacts: { artifacts: [] } } });
  const snap = await createPlaneClient({ fetchPlane }).snapshot("strata");
  const svc = snap.reads.find((r) => r.id === "service");
  assert.equal(svc.ok, true);
  assert.deepEqual(Object.keys(svc.data.services), ["Strata"], "no other fleet row reaches the page");
  assert.equal(svc.data.listed, true);

  const nexus = pickServiceRow("Nexus", fleet);
  assert.deepEqual(nexus, { service: "Nexus", listed: false, services: {} }, "missing row is 'not listed'");
  assert.deepEqual(Object.keys(pickServiceRow("pulse", fleet).services), ["Pulse"], "case-insensitive");
  const listShape = pickServiceRow("Flux", { services: [{ name: "Genesis", status: "dead" },
    { name: "Flux", status: "running" }] });
  assert.deepEqual(listShape.services, { Flux: { name: "Flux", status: "running" } });
  assert.deepEqual(pickServiceRow("Flux", { status: "healthy" }), { status: "healthy" }, "non-inventory passes");
});
