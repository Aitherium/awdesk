"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");

const { FleetControl, brainUrlFromEnv, DEFAULT_BRAIN_URL } = require("./fleet-control.cjs");
const { createBrainFleetAction, createBrainController, resolveBrainToken, startBrain } = require("./brain.cjs");

function fakeChild({ stdout = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  });
  return child;
}

const jsonResponse = (status, body) => ({ status, json: async () => body });

test("brainUrlFromEnv: on for a Windows desk, off inside the brain, off on request", () => {
  assert.equal(brainUrlFromEnv({ env: {}, platform: "win32" }), DEFAULT_BRAIN_URL);
  assert.equal(brainUrlFromEnv({ env: {}, platform: "linux" }), null);
  assert.equal(brainUrlFromEnv({ env: { AWDESK_FLEET_LOCAL: "1" }, platform: "win32" }), null, "the brain never recurses");
  assert.equal(brainUrlFromEnv({ env: { AWDESK_FLEET_BRAIN_URL: "off" }, platform: "win32" }), null);
  assert.equal(brainUrlFromEnv({ env: { AWDESK_FLEET_BRAIN_URL: "http://x:1/" }, platform: "linux" }), "http://x:1");
});

test("a fake-spawn FleetControl gets no brain unless it asks (tests stay hermetic)", () => {
  assert.equal(new FleetControl({ spawnImpl: () => fakeChild() }).brainUrl, null);
});

test("status goes to the brain first; its verdict is tagged via:brain and no child is spawned", async () => {
  let spawned = 0;
  const calls = [];
  const fc = new FleetControl({
    spawnImpl: () => { spawned += 1; return fakeChild({ stdout: '{"ok":true}' }); },
    brainUrl: "http://brain",
    gpuHolders: () => [{ name: "x" }],
    surfaces: () => [],
    fetchImpl: async (url, init) => { calls.push([url, init.method]); return jsonResponse(200, { ok: true, counts: { up: 22 } }); },
  });
  const v = await fc.run("status");
  assert.equal(v.via, "brain");
  assert.equal(v.counts.up, 22);
  assert.deepEqual(calls, [["http://brain/fleet/status?fresh=1", "GET"]]);
  assert.equal(spawned, 0);
  assert.deepEqual(v.gpu_holders, [{ name: "x" }], "the Windows side still enriches VRAM holders");
});

test("an unreachable brain falls back to the local wsl.exe path and says why", async () => {
  let spawned = 0;
  const fc = new FleetControl({
    spawnImpl: () => { spawned += 1; return fakeChild({ stdout: '{"ok":true}' }); },
    brainUrl: "http://brain",
    statusRetries: 0,
    fetchImpl: async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; },
  });
  const v = await fc.run("status");
  assert.equal(spawned, 1);
  assert.equal(v.via, "local");
  assert.match(v.brain_error, /ECONNREFUSED/);
});

test("mutating verbs POST with the bearer; a brain auth refusal falls back, a brain verdict does not", async () => {
  const seen = [];
  let spawned = 0;
  const mk = (response) => new FleetControl({
    spawnImpl: () => { spawned += 1; return fakeChild({ stdout: '{"ok":true}' }); },
    brainUrl: "http://brain",
    brainToken: "tkn",
    fetchImpl: async (url, init) => { seen.push([url, init.method, init.headers.authorization]); return response; },
  });
  const refused = await mk(jsonResponse(503, { ok: false, error: "no bridge token configured" })).run("adopt");
  assert.equal(refused.via, "local");
  assert.equal(spawned, 1);
  const busy = await mk(jsonResponse(409, { ok: false, busy: "down" })).run("adopt");
  assert.equal(busy.via, "brain", "a busy brain is an answer: never race it locally");
  assert.equal(spawned, 1);
  assert.deepEqual(seen[0], ["http://brain/fleet/adopt", "POST", "Bearer tkn"]);
});

test("a mutating verb that reached the brain and timed out is NOT re-run locally", async () => {
  let spawned = 0;
  const fc = new FleetControl({
    spawnImpl: () => { spawned += 1; return fakeChild(); },
    brainUrl: "http://brain",
    brainToken: "t",
    fetchImpl: async () => { const e = new Error("timeout"); e.name = "TimeoutError"; throw e; },
  });
  // `down` is now an alias of fleet sleep, which runs host-side (fleet_verbs.py) and never
  // reaches the brain; `quiesce` is still a distro verb the brain carries.
  const v = await fc.run("quiesce");
  assert.equal(spawned, 0);
  assert.equal(v.ok, false);
  assert.match(v.error, /not retried locally/);
});

test("the owner's verbs and their aliases never go to the brain (fleet_verbs.py is host-side)", async () => {
  for (const verb of ["gpu-sleep", "gpu-wake", "fleet-sleep", "fleet-wake", "fleet-critical", "down", "gaming"]) {
    let fetched = 0;
    const fc = new FleetControl({
      spawnImpl: () => fakeChild({ stdout: '{"ok":true}' }),
      brainUrl: "http://brain",
      fetchImpl: async () => { fetched += 1; return jsonResponse(200, {}); },
    });
    await fc.run(verb);
    assert.equal(fetched, 0, verb);
  }
});

test("model verbs never go to the brain (awmodels is host-side)", async () => {
  let fetched = 0;
  const fc = new FleetControl({
    spawnImpl: () => fakeChild({ stdout: '{"ok":true}' }),
    brainUrl: "http://brain",
    fetchImpl: async () => { fetched += 1; return jsonResponse(200, {}); },
  });
  await fc.run("models-status");
  assert.equal(fetched, 0);
});

test("brain fleet door: no windows, status summarized, unknown verbs refused", async () => {
  const control = { status: async () => ({ ok: true, counts: {} }), run: async (a) => ({ ok: true, ran: a }), busy: null };
  const door = createBrainFleetAction(control);
  assert.match((await door("open")).error, /headless/);
  assert.equal((await door("nuke")).unknown, true);
  assert.equal((await door("adopt")).ran, "adopt");
  assert.equal(typeof (await door("status")).summary, "string");
  const ctl = createBrainController({ control, fleetAction: door, port: 1 });
  assert.equal((await ctl.getStatus()).headless, true);
  assert.equal(await ctl.onAnimation("wave"), false);
});

test("the brain token can come from the Windows profile file", () => {
  assert.equal(resolveBrainToken({ env: { AITHER_HARNESS_TOKEN: "a" } }), "a");
  // home points nowhere: a real ~/.aither/harness_token on the test machine must not answer.
  const home = "/nonexistent-home-for-test";
  assert.equal(resolveBrainToken({ env: { AWDESK_BRIDGE_TOKEN_FILE: "/f" }, home, readFile: () => "b\n" }), "b");
  assert.equal(resolveBrainToken({ env: { AWDESK_BRIDGE_TOKEN_FILE: "/f" }, home, readFile: () => { throw new Error("x"); } }), null);
});

test("startBrain serves /health and /fleet/status over loopback with no window code loaded", async () => {
  const { bridge, control } = startBrain({ env: { AITHER_HARNESS_TOKEN: "t" }, port: 0 });
  control.run = async () => ({ ok: true, counts: { up: 3 } });
  control.status = async () => ({ ok: true, counts: { up: 3 } });
  const addr = await bridge.listen();
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: addr.port, path: p }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve([res.statusCode, b]));
    }).on("error", reject);
  });
  try {
    assert.equal((await get("/health"))[0], 200);
    const [code, body] = await get("/fleet/status");
    assert.equal(code, 200);
    assert.equal(JSON.parse(body).counts.up, 3);
    assert.equal(require.cache[require.resolve("./main.cjs")], undefined, "main.cjs (windows, cards) never loaded");
  } finally {
    await bridge.close();
  }
});
