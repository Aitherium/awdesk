"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createPlaneClient, parseToolJson, pickServiceRow, PLANES, PLANE_IDS } = require("./plane-client.cjs");
const { planeHandlers, planeFile } = require("./plane-window.cjs");

function recorder(answers) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    let a = answers[name];
    if (typeof a === "function") a = a(name, args);
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`unexpected tool ${name}`);
    return typeof a === "string" ? a : JSON.stringify(a);
  };
  return { call, calls };
}

test("the planes exist, each with a service read first", () => {
  assert.deepEqual(PLANE_IDS, ["strata", "pulse", "watch", "flux", "nexus", "mesh"]);
  for (const id of PLANE_IDS) {
    const first = PLANES[id].reads[0];
    assert.equal(first.tool, "get_service_status", `${id} starts with its service row`);
    assert.equal(first.args.services.toLowerCase(), id);
  }
});

test("no plane can run a mutating tool -- the read table is the whole surface", () => {
  const all = PLANE_IDS.flatMap((id) => PLANES[id].reads.map((r) => r.tool));
  for (const tool of all) {
    assert.doesNotMatch(tool, /restart|reclaim|delete|save|share|publish|import|create|set_|remediate/,
      `${tool} is not a read`);
  }
});

test("snapshot calls exactly that plane's tools with their args and keeps each answer", async () => {
  const { call, calls } = recorder({
    get_service_status: { services: { Watch: { status: "running", port: 8082 } } },
    watch_plugin_alerts: { alerts: [] },
    watch_startup_status: { components: { a: "ready" } },
    watch_list_plugins: [{ name: "disk", loaded: true }],
  });
  const snap = await createPlaneClient({ call }).snapshot("watch");
  assert.deepEqual(calls.map((c) => c.name).sort(),
    ["get_service_status", "watch_list_plugins", "watch_plugin_alerts", "watch_startup_status"]);
  assert.deepEqual(calls.find((c) => c.name === "get_service_status").args, { services: "Watch" });
  assert.equal(snap.ok, true);
  assert.equal(snap.failed, 0);
  assert.equal(snap.reads.length, 4);
  assert.deepEqual(snap.reads.find((r) => r.id === "plugins").data, [{ name: "disk", loaded: true }]);
});

test("one dead service costs its own read, never the page -- and never reads as empty", async () => {
  const { call } = recorder({
    get_service_status: { services: { Pulse: { status: "running" } } },
    pulse_disk_status: { error: "HTTP 503", detail: "pulse is restarting", path: "/disk/status" },
  });
  const snap = await createPlaneClient({ call }).snapshot("pulse");
  assert.equal(snap.ok, false);
  assert.equal(snap.failed, 1);
  const disk = snap.reads.find((r) => r.id === "disk");
  assert.equal(disk.ok, false);
  assert.match(disk.error, /pulse_disk_status: HTTP 503 -- pulse is restarting/);
  assert.equal(disk.data, undefined, "a failed read carries no data to render as 'nothing'");
  assert.equal(snap.reads.find((r) => r.id === "service").ok, true);
});

test("a gateway exception and prose answers are failed reads too", async () => {
  const gone = createPlaneClient({ call: async () => { throw new Error("HTTP 401: bad bearer"); } });
  const snap = await gone.snapshot("nexus");
  assert.equal(snap.failed, snap.reads.length);
  for (const r of snap.reads) assert.match(r.error, /HTTP 401: bad bearer/);

  assert.throws(() => parseToolJson("flux_context", "Flux is offline"), /unparseable answer: Flux is offline/);
  assert.throws(() => parseToolJson("flux_context", ""), /unparseable answer \(empty\)/);
  assert.throws(() => parseToolJson("x", "42"), /expected JSON, got number/);
  assert.throws(() => parseToolJson("x", '{"detail":"forbidden"}'), /x: forbidden/);
  assert.deepEqual(parseToolJson("x", "[1,2]"), [1, 2]);
});

test("an unknown plane is refused before any call", async () => {
  const { call, calls } = recorder({});
  await assert.rejects(createPlaneClient({ call }).snapshot("secrets"), /unknown plane secrets/);
  assert.equal(calls.length, 0);
});

test("IPC: snapshot answers {ok,data}, a bad plane id answers {ok:false} and never throws", async () => {
  const { call } = recorder({
    get_service_status: { services: {} },
    list_knowledge_bases: { knowledge_bases: [{ collection: "docs", pages: 3 }] },
  });
  const handlers = planeHandlers(createPlaneClient({ call }));
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

test("every tool a plane reads is a real gateway tool (when the MCP tree is checked out)", (t) => {
  const dir = path.join(__dirname, "..", "..", "..", "AitherOS", "apps", "awnode", "tools", "mcp");
  if (!fs.existsSync(dir)) {
    t.skip("AitherOS/apps/awnode/tools/mcp not in this checkout");
    return;
  }
  const source = fs.readdirSync(dir).filter((f) => f.endsWith(".py"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const tools = new Set(PLANE_IDS.flatMap((id) => PLANES[id].reads.map((r) => r.tool)));
  for (const tool of tools) {
    assert.match(source, new RegExp(`^(async )?def ${tool}\\(`, "m"), `${tool} is not defined in tools/mcp`);
  }
});

test("Genesis /services answers the WHOLE fleet: each plane keeps only its own row", async () => {
  // GET /services ignores ?services= -- a real answer is the full inventory.
  const fleet = { services: {
    Genesis: { status: "running", port: 8001 },
    Strata: { status: "running", port: 8136 },
    Pulse: { status: "stopped", port: 8081 },
    Chronicle: { status: "unknown" },
  } };
  const { call } = recorder({
    get_service_status: fleet,
    get_strata_stats: { tiers: {} },
    list_artifacts: { artifacts: [] },
  });
  const snap = await createPlaneClient({ call }).snapshot("strata");
  const svc = snap.reads.find((r) => r.id === "service");
  assert.equal(svc.ok, true);
  assert.deepEqual(Object.keys(svc.data.services), ["Strata"], "no other fleet row reaches the page");
  assert.equal(svc.data.listed, true);
  assert.equal(svc.data.services.Strata.status, "running");

  const nexus = pickServiceRow("Nexus", fleet);
  assert.deepEqual(nexus, { service: "Nexus", listed: false, services: {} }, "missing row is 'not listed'");
  assert.deepEqual(Object.keys(pickServiceRow("pulse", fleet).services), ["Pulse"], "case-insensitive");
  const listShape = pickServiceRow("Flux", { services: [{ name: "Genesis", status: "dead" },
    { name: "Flux", status: "running" }] });
  assert.deepEqual(listShape.services, { Flux: { name: "Flux", status: "running" } });
  assert.deepEqual(pickServiceRow("Flux", { status: "healthy" }), { status: "healthy" }, "non-inventory passes");
  for (const id of PLANE_IDS) assert.equal(PLANES[id].reads[0].service.toLowerCase(), id);
});
