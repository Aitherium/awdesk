"use strict";

// A customer's PC is not the owner's PC (Garg, 2026-10-16: Desk at 31.6 % CPU and 7 GB,
// killed from Task Manager). The tuning measured on the owner's fleet box -- above-normal
// priority, software present, no renderer backgrounding, Lend memory on -- must not ship
// to a workspace install.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { deskPosture } = require("./desk-posture.cjs");
const { wantedPriority } = require("./process-priority.cjs");
const { presentPolicy } = require("./present-policy.cjs");
const { normalize, KvLend } = require("./kv-lend.cjs");

const GARG = { host: "garg.aitherium.com", firstParty: true };

test("a workspace (tenant) install is a customer desk; the apex and no tenant are the owner's", () => {
  assert.equal(deskPosture({ env: {}, tenant: GARG }).customer, true);
  assert.equal(deskPosture({ env: {}, tenant: null }).customer, false);
  assert.equal(deskPosture({ env: {}, tenant: { host: "aitherium.com" } }).customer, false);
  assert.equal(deskPosture({ env: {}, tenant: { host: "app.aitherium.com" } }).customer, false);
});

test("AWDESK_POSTURE overrides the guess both ways", () => {
  assert.equal(deskPosture({ env: { AWDESK_POSTURE: "owner" }, tenant: GARG }).customer, false);
  assert.equal(deskPosture({ env: { AWDESK_POSTURE: "customer" }, tenant: null }).customer, true);
  assert.equal(deskPosture({ env: { AWDESK_POSTURE: "junk" }, tenant: GARG }).customer, true);
});

test("a customer desk: normal priority, Chromium throttling on, Lend memory off, GPU present", () => {
  const p = deskPosture({ env: {}, tenant: GARG });
  assert.equal(p.priority, "normal");
  assert.equal(p.present, "gpu", "nothing polls a customer's adapter: software compositing is a GPU→CPU copy per frame");
  assert.equal(p.throttle, true);
  assert.equal(p.lendByDefault, false);
  const o = deskPosture({ env: {}, tenant: null });
  assert.equal(o.priority, "above");
  assert.equal(o.present, "software", "the owner's fleet box: measured stall-free under the fleet poller");
  assert.equal(o.throttle, false);
  assert.equal(o.lendByDefault, true);
});

test("process priority: a customer desk is left at normal unless DESK_PRIORITY=above asks", () => {
  const customer = deskPosture({ env: {}, tenant: GARG });
  assert.equal(wantedPriority({}, customer), null);
  assert.equal(wantedPriority({ DESK_PRIORITY: "above" }, customer), os.constants.priority.PRIORITY_ABOVE_NORMAL);
  assert.equal(wantedPriority({}), os.constants.priority.PRIORITY_ABOVE_NORMAL, "the owner's box is unchanged");
});

test("present policy: the posture's own ask reaches the GPU branch; DESK_PRESENT still wins", () => {
  const customer = deskPosture({ env: {}, tenant: GARG });
  // S1 (2026-11-18): this assertion is the bug being fixed — desk-posture returned "auto"
  // while present-policy read `posture.present === "gpu"`, so the GPU branch was dead.
  assert.equal(presentPolicy({ env: {}, platform: "win32", posture: customer }).present, "gpu");
  assert.equal(presentPolicy({ env: { DESK_PRESENT: "software" }, platform: "win32", posture: customer }).present, "software",
    "an explicit software override still wins");
  assert.equal(presentPolicy({ env: { DESK_PRESENT: "gpu" }, platform: "win32", posture: customer }).present, "gpu");
  const owner = deskPosture({ env: {}, tenant: null });
  assert.equal(presentPolicy({ env: {}, platform: "win32", posture: owner }).present, "software", "the owner's box is unchanged");
  assert.equal(presentPolicy({ env: { DESK_PRESENT: "gpu" }, platform: "win32", posture: owner }).present, "gpu");
  assert.equal(presentPolicy({ env: {}, platform: "win32" }).present, "gpu", "no posture: auto presents on the GPU");
});

test("main.cjs: a customer desk skips the DX12 info process, keeps an empty avatar stage hidden, and a 2nd launch opens the workspace", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  assert.match(src, /if \(deskPostureState\.customer\) \{\s*app\.commandLine\.appendSwitch\("disable-gpu-process-for-dx12-info-collection"\);/);
  assert.match(src, /if \(!deskPostureState\.customer \|\| listCharacters\(\)\.length > 0\) showOverlay\(\);/);
  assert.match(src, /if \(deskPostureState\.customer\) showLivingDesktop\(\);\s*else showOverlay\(\{ focus: true \}\);/);
  assert.match(src, /if \(!deskPostureState\.throttle\) \{\s*app\.commandLine\.appendSwitch\("disable-renderer-backgrounding"\);/);
});

test("Lend memory: off by default on a customer desk, still on by default for the owner, and a saved choice wins", () => {
  assert.equal(normalize(null).enabled, true);
  assert.equal(normalize(null, { enabled: false }).enabled, false);
  assert.equal(normalize({ enabled: true }, { enabled: false }).enabled, true, "the user turned it on: on");
  const lend = new KvLend({ identity: { enrolled: () => null }, settingsFile: "Z:/nope/kv-lend.json",
    makeWindow: () => ({}), probe: () => ({}), defaults: { enabled: false } });
  assert.equal(lend.settings().enabled, false);
});
