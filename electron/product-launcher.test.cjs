"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  PRODUCTS, findInstalled, planFor, registryRecords, runProductCommand, byProductId,
} = require("./product-launcher.cjs");
const registry = require("./command-registry.cjs");

const env = { AITHER_APPS_DIR: path.join("/apps"), PATH: "" };

test("the four products, ids matching the shop slugs", () => {
  assert.deepEqual(PRODUCTS.map((p) => p.id), ["deep-research", "saga", "agent-home", "iris"]);
});

test("an exe under apps/<id>/ is installed; Windows looks for .exe first", () => {
  const saga = byProductId("saga");
  const want = path.join("/apps", "saga", "saga.exe");
  const exists = (p) => p === want;
  assert.equal(findInstalled(saga, { env, platform: "win32", exists, which: () => null }), want);
  assert.equal(findInstalled(saga, { env, platform: "linux", exists, which: () => null }), null);
  assert.equal(findInstalled(saga, { env, platform: "linux", exists, which: (n) => `/usr/bin/${n}` }), "/usr/bin/saga");
  assert.equal(findInstalled(byProductId("iris"), { env, exists: () => true }), null, "hosted is never installed");
});

test("plan: hosted opens, installed launches, missing opens the shop", () => {
  const none = { env, exists: () => false, which: () => null };
  assert.deepEqual(planFor(byProductId("iris"), none), { action: "open", url: "https://aitherium.com/iris" });
  assert.deepEqual(planFor(byProductId("saga"), none), { action: "shop", url: "https://aitherium.com/shop/saga" });
  assert.equal(planFor(byProductId("saga"), { ...none, which: () => "/bin/saga" }).action, "launch");
});

test("runProductCommand spawns an installed app detached, or opens a page", () => {
  const spawned = [];
  const opened = [];
  const shell = { openExternal: (u) => { opened.push(u); return Promise.resolve(); } };
  const spawn = (cmd, args, opts) => { spawned.push({ cmd, opts }); return { unref() {}, on() {} }; };
  const r1 = runProductCommand({ product: "saga" }, { shell, spawn, env, exists: () => false, which: () => "/bin/saga" });
  assert.equal(r1.ok, true);
  assert.deepEqual(spawned, [{ cmd: "/bin/saga", opts: { detached: true, stdio: "ignore" } }]);
  const r2 = runProductCommand({ product: "agent-home" }, { shell, spawn, env, exists: () => false, which: () => null });
  assert.equal(r2.action, "shop");
  assert.deepEqual(opened, ["https://aitherium.com/shop/agent-home"]);
  assert.equal(runProductCommand({ product: "nope" }, { shell, spawn }).ok, false);
});

test("registry records are conformant (ready for COMMANDS once main routes command.product)", () => {
  const records = registryRecords();
  assert.deepEqual(registry.conformance(records), []);
  assert.deepEqual(records.map((r) => r.product), PRODUCTS.map((p) => p.id));
  for (const r of records) assert.ok(r.surfaces.includes("palette") && r.surfaces.includes("tray"));
});
