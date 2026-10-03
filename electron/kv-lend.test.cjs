"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { KvLend, normalize, whyNot } = require("./kv-lend.cjs");

const on = normalize({});
const idle = { enrolled: true, onBattery: false, idle: true, gaming: false };

test("lends only enrolled, on AC, idle and with no game, unless the owner relaxes it", () => {
  assert.equal(whyNot(on, idle), "");
  assert.match(whyNot(on, { ...idle, onBattery: true }), /battery/);
  assert.match(whyNot(on, { ...idle, idle: false }), /in use/);
  assert.match(whyNot(on, { ...idle, gaming: true }), /game/);
  assert.match(whyNot(on, { ...idle, enrolled: false }), /not connected/);
  assert.match(whyNot(normalize({ enabled: false }), idle), /off/);
  assert.equal(whyNot(normalize({ onlyOnAc: false, onlyIdle: false }), { ...idle, onBattery: true, idle: false }), "");
  assert.match(whyNot(normalize({ onlyOnAc: false }), { ...idle, gaming: true }), /game/);
});

test("amounts snap to the offered choices", () => {
  assert.equal(normalize({ maxMb: 4096 }).maxMb, 4096);
  assert.equal(normalize({ maxMb: 99999 }).maxMb, 2048);
});

test("the engine window opens when policy allows and closes when it stops", () => {
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kvl-")), "kv-lend.json");
  let env = { ...idle };
  const made = [];
  const lend = new KvLend({
    identity: { enrolled: () => ({ deviceId: "fdev_1" }), hello: (h) => ({ relay: h }) },
    settingsFile,
    makeWindow: () => { const w = { destroyed: false, destroy() { this.destroyed = true; } }; made.push(w); return w; },
    probe: () => env,
  });
  assert.equal(lend.evaluate(), "");
  assert.equal(made.length, 1);
  assert.deepEqual(lend.pageConfig(), { relay: "wss://kv.aitherium.com/holder", deviceId: "fdev_1", mb: 2048, gpu: "high-performance" });
  assert.deepEqual(lend.hello(), { relay: "kv.aitherium.com" });
  env = { ...idle, onBattery: true };
  assert.match(lend.evaluate(), /battery/);
  assert.equal(made[0].destroyed, true);
  env = { ...idle };
  lend.setSettings({ enabled: false });
  assert.equal(made.length, 1);
  assert.match(lend.summary(), /switched off/);
  lend.onStatus({ state: "retrying", error: "the owner has not turned on lending for this device" });
  assert.match(lend.reason, /switched off|not let/);
});

test("the vendored holder.js is byte-identical to awdk's (in the monorepo)", (t) => {
  const { holderJsPath } = require("./kv-lend.cjs");
  const upstream = path.join(__dirname, "..", "..", "..", "awdk", "adk", "webui", "kvholder", "holder.js");
  if (!fs.existsSync(upstream)) return t.skip("awdk is not beside this tree (the public mirror)");
  assert.equal(fs.readFileSync(holderJsPath(), "utf8"), fs.readFileSync(upstream, "utf8"),
    "refresh it: cp awdk/adk/webui/kvholder/holder.js .DEPLOYMENT/awdesk/electron/kvholder/holder.js");
});

test("the lender gets its own process unless the owner chose the integrated GPU", () => {
  const { isLendProcess, lendProcessSpawner } = require("./kv-lend-electron.cjs");
  assert.equal(isLendProcess(["electron", ".", "--kv-lend-process=C:/x"]), true);
  assert.equal(isLendProcess(["electron", "."]), false);
  const spawnFor = lendProcessSpawner({ app: { isPackaged: true, getAppPath: () => "." }, dataDir: "x" });
  assert.equal(spawnFor({ gpu: "low-power" }), null);
  assert.equal(normalize({ gpu: "nonsense" }).gpu, "high-performance");
  assert.equal(normalize({ gpu: "battery" }).gpu, "battery");
});
