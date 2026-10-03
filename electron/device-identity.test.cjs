"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DeviceIdentity, HELLO_DOMAIN, parseEnrollUrl } = require("./device-identity.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "desk-dev-"));

test("an enroll link from the owner's identity parses; anything else is refused", () => {
  const ok = parseEnrollUrl("desk://enroll?c=ab3k9q2z&d=fdev_1a2b&i=https://idp.aitherium.com", {});
  assert.deepEqual(ok, { code: "AB3K9Q2Z", deviceId: "fdev_1a2b", identity: "https://idp.aitherium.com" });
  for (const bad of [
    "desk://enroll?c=AB3K9Q2Z&i=https://idp.evil.example",          // someone else's identity
    "desk://enroll?c=AB3K9Q2Z&i=http://idp.aitherium.com",          // not https
    "desk://enroll?c=AB3K9Q2Z&i=https://aitherium.com.evil.example", // suffix trick
    "desk://enroll?c=ab&i=https://idp.aitherium.com",               // no real code
    "desk://enroll?c=AB3K9Q2Z&d=../../x",                           // bad device id
    "desk://show",
  ]) assert.equal(parseEnrollUrl(bad, {}), null, bad);
  assert.match(parseEnrollUrl("desk://enroll?c=AB3K9Q2Z", {}).deviceId, /^desk-/);
});

test("enroll confirms the code with this machine's public key and keeps the answer private", async () => {
  const dir = tmp();
  const id = new DeviceIdentity(dir);
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { status: 200, text: async () => JSON.stringify({ node_id: "fdev_1", command_key: "k" }) };
  };
  const r = await id.enroll({ code: "AB3K9Q2Z", deviceId: "fdev_1", identity: "https://idp.aitherium.com" }, { fetchImpl });
  assert.deepEqual(r, { ok: true, deviceId: "fdev_1" });
  assert.equal(sent.url, "https://idp.aitherium.com/v1/nodes/pairing/confirm");
  assert.equal(sent.body.seal_pubkey, id.publicHex());
  assert.match(sent.body.seal_pubkey, /^[0-9a-f]{64}$/);
  assert.equal(id.enrolled().deviceId, "fdev_1");
  assert.ok(!JSON.stringify(sent.body).includes("PRIVATE"));
  if (process.platform !== "win32") assert.equal(fs.statSync(id.keyFile).mode & 0o077, 0);
});

test("a refused or expired code leaves the computer unenrolled", async () => {
  const id = new DeviceIdentity(tmp());
  const fetchImpl = async () => ({ status: 400, text: async () => '{"detail":"Invalid or expired pairing code"}' });
  const r = await id.enroll({ code: "AB3K9Q2Z", deviceId: "d1", identity: "https://idp.aitherium.com" }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(id.enrolled(), null);
});

test("the hello is the relay's format and verifies with the enrolled key; the key persists", () => {
  const dir = tmp();
  const id = new DeviceIdentity(dir);
  const h = id.hello("KV.aitherium.com", "fdev_1");
  const msg = [HELLO_DOMAIN, "kv.aitherium.com", "fdev_1", String(h.ts), h.nonce].join("\n");
  const pub = nodeCrypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(id.publicHex(), "hex")]),
    format: "der", type: "spki",
  });
  assert.ok(nodeCrypto.verify(null, Buffer.from(msg), pub, Buffer.from(h.sig, "base64")));
  assert.equal(h.auth, "device");
  assert.equal(new DeviceIdentity(dir).publicHex(), id.publicHex());
});
