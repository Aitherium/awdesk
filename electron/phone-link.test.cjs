"use strict";

// The phone is SIMULATED here: a node Ed25519 key signs the same hello kvdevice.js signs
// (aither-kvholder-hello/1). Identity is a mocked enrollment() answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  adkEnrollment, audienceOf, createFileShelf, createPhoneLink, helloMessage, safeFileName,
} = require("./phone-link.cjs");

const DESK = "desk-pc-1234abcd";

function phoneKey() {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, pub: der.subarray(der.length - 32).toString("hex") };
}

function hello(key, deviceId, { relay = audienceOf(DESK), ts = Math.floor(Date.now() / 1000), nonce } = {}) {
  const n = nonce || nodeCrypto.randomBytes(12).toString("base64url");
  const sig = nodeCrypto.sign(null, helloMessage(relay, deviceId, ts, n), key.privateKey).toString("base64");
  return Buffer.from(JSON.stringify({ auth: "device", device_id: deviceId, relay, ts, nonce: n, sig })).toString("base64url");
}

async function call(port, route, { header, body, method = "POST", origin } = {}) {
  const headers = { "content-type": "application/json" };
  if (header) headers["x-aither-device-hello"] = header;
  if (origin) headers.origin = origin;
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers, body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function setup({ enrolled = {}, approveAnswer = true, actions } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-link-"));
  const approvals = [];
  const link = createPhoneLink({
    dataDir,
    deskId: () => DESK,
    deskName: "PC",
    enrollment: async (id) => (enrolled[id] === "removed" ? { status: "removed" }
      : enrolled[id] ? { status: "enrolled", pub: enrolled[id] } : { status: "unknown", error: "404-less outage" }),
    approve: async (who) => { approvals.push(who); return approveAnswer; },
    actions: actions || { state: async () => ({ ok: true, desktop: "shown" }), "clipboard.set": async (a) => ({ ok: true, got: a.text }) },
  });
  return { link, approvals, dataDir };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("handshake: an unenrolled device is refused and never reaches the approval prompt", async () => {
  const { link, approvals } = setup();
  const port = await link.openFor("R5CT", "Pixel 8");
  const stranger = phoneKey();
  const r = await call(port, "/link/hello", { header: hello(stranger, "phone-stranger") });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /cannot confirm this phone is enrolled/);
  assert.equal(approvals.length, 0);
  const d = await call(port, "/link/do", { header: hello(stranger, "phone-stranger"), body: { action: "state" } });
  assert.equal(d.status, 403);
  link.closeAll();
});

test("handshake: an enrolled phone signed with the WRONG key is refused", async () => {
  const real = phoneKey();
  const thief = phoneKey();
  const { link, approvals } = setup({ enrolled: { "phone-1": real.pub } });
  const port = await link.openFor("R5CT", "Pixel 8");
  const r = await call(port, "/link/hello", { header: hello(thief, "phone-1") });
  assert.equal(r.status, 401);
  assert.equal(approvals.length, 0);
  link.closeAll();
});

test("handshake: a hello for another desk, an old one, or a replay is refused", async () => {
  const k = phoneKey();
  const { link } = setup({ enrolled: { "phone-1": k.pub } });
  const port = await link.openFor("R5CT", "Pixel 8");
  assert.equal((await call(port, "/link/hello", { header: hello(k, "phone-1", { relay: audienceOf("desk-other") }) })).status, 401);
  assert.equal((await call(port, "/link/hello", { header: hello(k, "phone-1", { ts: Math.floor(Date.now() / 1000) - 600 }) })).status, 401);
  const once = hello(k, "phone-1", { nonce: "fixed-nonce-123" });
  assert.equal((await call(port, "/link/hello", { header: once })).status, 200);
  assert.equal((await call(port, "/link/hello", { header: once })).body.error, "replayed hello");
  link.closeAll();
});

test("enrolled phone: pending until the owner approves on the PC, then pinned and allowed", async () => {
  const k = phoneKey();
  const { link, approvals } = setup({ enrolled: { "phone-1": k.pub } });
  const port = await link.openFor("R5CT", "Pixel 8");
  const first = await call(port, "/link/hello", { header: hello(k, "phone-1"), body: { model: "Pixel 8" } });
  assert.equal(first.body.state, "pending");
  assert.equal((await call(port, "/link/do", { header: hello(k, "phone-1"), body: { action: "state" } })).status, 403);
  await settle();
  assert.deepEqual(approvals, [{ deviceId: "phone-1", model: "Pixel 8" }]);
  assert.equal((await call(port, "/link/hello", { header: hello(k, "phone-1") })).body.state, "approved");
  const ok = await call(port, "/link/do", { header: hello(k, "phone-1"), body: { action: "state" } });
  assert.deepEqual(ok.body, { ok: true, desktop: "shown" });
  assert.equal(link.pinned()["phone-1"].pub, k.pub);
  link.closeAll();
});

test("bridge: a non-allowlisted action is a 403, even for an approved phone", async () => {
  const k = phoneKey();
  const ran = [];
  const { link } = setup({
    enrolled: { "phone-1": k.pub },
    // a handler for a name NOT in ACTIONS must still never run
    actions: { state: async () => ({ ok: true }), "shell.exec": async () => { ran.push("shell"); return {}; } },
  });
  const port = await link.openFor("R5CT", "Pixel 8");
  await call(port, "/link/hello", { header: hello(k, "phone-1") });
  await settle();
  await call(port, "/link/hello", { header: hello(k, "phone-1") });
  for (const action of ["shell.exec", "commands/run", "fleet.down", "", "__proto__"]) {
    const r = await call(port, "/link/do", { header: hello(k, "phone-1"), body: { action } });
    assert.equal(r.status, 403, action);
  }
  // an allowlisted name the desk did not wire is refused too
  assert.equal((await call(port, "/link/do", { header: hello(k, "phone-1"), body: { action: "file.get" } })).status, 403);
  assert.deepEqual(ran, []);
  assert.equal((await call(port, "/commands/run", { header: hello(k, "phone-1") })).status, 404);
  link.closeAll();
});

test("a browser page on the phone (it sends an Origin) gets nothing", async () => {
  const { link } = setup();
  const port = await link.openFor("R5CT", "Pixel 8");
  assert.equal((await call(port, "/link/info", { method: "GET", origin: "https://evil.example" })).status, 403);
  assert.equal((await call(port, "/link/info", { method: "GET" })).body.desk, DESK);
  link.closeAll();
});

test("owner says Not now: refused for this cable session, asked again after a replug", async () => {
  const k = phoneKey();
  const { link, approvals } = setup({ enrolled: { "phone-1": k.pub }, approveAnswer: false });
  let port = await link.openFor("R5CT", "Pixel 8");
  await call(port, "/link/hello", { header: hello(k, "phone-1") });
  await settle();
  assert.equal((await call(port, "/link/hello", { header: hello(k, "phone-1") })).body.state, "refused");
  link.closeFor("R5CT");
  port = await link.openFor("R5CT", "Pixel 8");
  assert.equal((await call(port, "/link/hello", { header: hello(k, "phone-1") })).body.state, "pending");
  await settle();
  assert.equal(approvals.length, 2);
  link.closeAll();
});

test("cable pull: the server closes and the phone's next request cannot connect", async () => {
  const k = phoneKey();
  const { link } = setup({ enrolled: { "phone-1": k.pub } });
  const port = await link.openFor("R5CT", "Pixel 8");
  assert.equal((await call(port, "/link/info", { method: "GET" })).status, 200);
  assert.equal(link.closeFor("R5CT"), true);
  await assert.rejects(call(port, "/link/info", { method: "GET" }));
  assert.deepEqual(link.links(), []);
});

test("revocable from both sides: phone /link/revoke and the desk's forget unpin", async () => {
  const k = phoneKey();
  const { link } = setup({ enrolled: { "phone-1": k.pub } });
  const port = await link.openFor("R5CT", "Pixel 8");
  await call(port, "/link/hello", { header: hello(k, "phone-1") });
  await settle();
  assert.ok(link.pinned()["phone-1"]);
  assert.equal((await call(port, "/link/revoke", { header: hello(k, "phone-1") })).body.state, "forgotten");
  assert.equal(link.pinned()["phone-1"], undefined);
  await call(port, "/link/hello", { header: hello(k, "phone-1") });
  await settle();
  assert.equal(link.forget("phone-1"), true);
  assert.equal((await call(port, "/link/do", { header: hello(k, "phone-1"), body: { action: "state" } })).status, 403);
  link.closeAll();
});

test("offline: a pinned phone keeps working without Identity; removed in Devices = unpinned", async () => {
  const k = phoneKey();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-link-"));
  let identity = { status: "enrolled", pub: k.pub };
  const link = createPhoneLink({ dataDir, deskId: () => DESK, enrollment: async () => identity,
    approve: async () => true, actions: { state: async () => ({ ok: true }) } });
  const port = await link.openFor("R5CT", "Pixel 8");
  await call(port, "/link/hello", { header: hello(k, "phone-1") });
  await settle();
  link.closeAll();
  identity = { status: "unknown", error: "offline" };
  const offline = createPhoneLink({ dataDir, deskId: () => DESK, enrollment: async () => identity,
    approve: async () => true, actions: { state: async () => ({ ok: true }) } });
  const p2 = await offline.openFor("R5CT", "Pixel 8");
  assert.equal((await call(p2, "/link/hello", { header: hello(k, "phone-1") })).body.state, "approved");
  assert.equal((await call(p2, "/link/do", { header: hello(k, "phone-1"), body: { action: "state" } })).status, 200);
  offline.closeAll();
  identity = { status: "removed" };
  const removed = createPhoneLink({ dataDir, deskId: () => DESK, enrollment: async () => identity,
    approve: async () => true, actions: {} });
  const p3 = await removed.openFor("R5CT", "Pixel 8");
  assert.equal((await call(p3, "/link/hello", { header: hello(k, "phone-1") })).status, 403);
  assert.deepEqual(removed.pinned(), {});
  removed.closeAll();
});

test("files: names from the phone cannot leave the inbox; the outbox serves only listed names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-files-"));
  const shelf = createFileShelf({ inbox: path.join(root, "in"), outbox: path.join(root, "out") });
  assert.equal(safeFileName("../../evil.exe"), "__.._evil.exe");
  assert.equal(safeFileName(".."), null);
  assert.equal(safeFileName("CON"), null);
  const a = shelf.send({ name: "../photo.jpg", data: Buffer.from("x").toString("base64") });
  assert.equal(a.ok, true);
  assert.ok(fs.existsSync(path.join(root, "in", a.saved)));
  const b = shelf.send({ name: "../photo.jpg", data: Buffer.from("y").toString("base64") });
  assert.notEqual(b.saved, a.saved);
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out", "report.pdf"), "pdf");
  assert.deepEqual(shelf.list().files, [{ name: "report.pdf", bytes: 3 }]);
  assert.equal(Buffer.from(shelf.get({ name: "report.pdf" }).data, "base64").toString(), "pdf");
  assert.equal(shelf.get({ name: "../in/" + a.saved }).ok, false);
});

test("adkEnrollment reads adk devices status: record, 404 (removed), outage", async () => {
  const pub = "ab".repeat(32);
  assert.deepEqual(await adkEnrollment(async () => ({ ok: true, data: { node_id: "p1", seal_pubkey: pub } }), "p1"),
    { status: "enrolled", pub });
  assert.deepEqual(await adkEnrollment(async () => ({ ok: true, data: { detail: "Node not found" },
    stdout: "x HTTP 404 from GET https://idp/v1/nodes/p1\n{\"detail\":\"Node not found\"}" }), "p1"), { status: "removed" });
  assert.equal((await adkEnrollment(async () => ({ ok: false, error: "spawn ENOENT", stdout: "" }), "p1")).status, "unknown");
  // another device's record is not this one's
  assert.equal((await adkEnrollment(async () => ({ ok: true, data: { node_id: "p2", seal_pubkey: pub } }), "p1")).status, "unknown");
});

test("tray: connected offers the one click; linked offers unlink and forget", () => {
  const { trayItems } = require("./phone-link.cjs");
  const used = [];
  const h = { use: (s) => used.push(s), unlink: () => {}, forget: () => {} };
  const rows = trayItems([{ serial: "R5CT", state: "device", model: "Pixel 8" }], [], h);
  assert.equal(rows[1].label, "Phone connected: Pixel 8");
  rows[2].click();
  assert.deepEqual(used, ["R5CT"]);
  const linked = trayItems([{ serial: "R5CT", state: "device", model: "Pixel 8" }], [{ serial: "R5CT", deviceId: "phone-1" }], h);
  assert.deepEqual(linked.slice(1).map((r) => r.label), ["Phone linked: Pixel 8", "Unlink this phone", "Forget this phone"]);
  assert.match(trayItems([{ serial: "X", state: "unauthorized", model: "Android phone" }], [], h)[1].label, /allow USB debugging/);
  assert.deepEqual(trayItems([], [], h), []);
});

test("the phone app's own kvdevice.js hello verifies here (in the monorepo)", async (t) => {
  const kv = path.join(__dirname, "..", "..", "..", "awdk", "android", "aither", "assets", "kvdevice.js");
  if (!fs.existsSync(kv)) return t.skip("not in the monorepo");
  const D = require(kv);
  const m = new Map();
  const store = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
  await assert.rejects(D.open(store, null, { create: false }), /no-device-key/);
  const dev = await D.open(store);
  const h = await dev.hello(audienceOf("Desk-PC-1"), "phone-1");
  const { verifySig } = require("./phone-link.cjs");
  assert.equal(verifySig(dev.publicHex, helloMessage(h.relay, h.device_id, h.ts, h.nonce), h.sig), true);
});

test("made-up device ids do not spawn an Identity lookup per request", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-link-"));
  let lookups = 0;
  const link = createPhoneLink({ dataDir, deskId: () => DESK, approve: async () => true, actions: {},
    enrollment: async () => { lookups += 1; return { status: "unknown", error: "no record" }; } });
  const port = await link.openFor("R5CT", "Pixel 8");
  const k = phoneKey();
  for (let i = 0; i < 5; i += 1) await call(port, "/link/hello", { header: hello(k, "phone-x") });
  assert.equal(lookups, 1);
  link.closeAll();
});
