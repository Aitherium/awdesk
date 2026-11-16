"use strict";

/** assist-salt + assist-identity: the per-install log salt and the desk key the extension pins. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { loadOrCreateSalt } = require("./assist-salt.cjs");
const { createAssistIdentity, verifyHello, HELLO_PREFIX } = require("./assist-identity.cjs");
const { createAssistMain } = require("./assist-main.cjs");
const { createBridgeServer } = require("./bridge-server.cjs");
const core = require("./assist-core.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "assist-id-"));
const winEnv = { USERNAME: "me", USERDOMAIN: "PC", SystemRoot: "C:\\Windows" };

// ---- the log salt --------------------------------------------------------------------------

test("salt: minted once beside the pairing file, behind a user-only ACL, then reused", () => {
  const dir = tmp();
  const acl = [];
  const execFileSync = (exe, args) => { acl.push([exe, args]); };
  const a = loadOrCreateSalt({ dir, platform: "win32", env: winEnv, execFileSync });
  assert.ok(a.ok && a.created && a.salt.length === 32);
  assert.equal(path.basename(a.file), "assist-salt.json");
  assert.equal(path.dirname(a.file), dir);
  assert.deepEqual(acl[0], ["C:\\Windows\\System32\\icacls.exe", [a.file, "/inheritance:r", "/grant:r", "PC\\me:(F)"]]);
  const b = loadOrCreateSalt({ dir, platform: "win32", env: winEnv, execFileSync });
  assert.ok(b.ok && !b.created);
  assert.deepEqual(b.salt, a.salt, "the same salt every start");
  assert.equal(acl.length, 1, "the ACL is applied when minted");
  assert.notDeepEqual(loadOrCreateSalt({ dir: tmp(), platform: "win32", env: winEnv, execFileSync }).salt, a.salt, "another install, another salt");
});

test("salt: if the file cannot be locked down it is deleted and refused, never used unprotected", () => {
  const dir = tmp();
  const r = loadOrCreateSalt({ dir, platform: "win32", env: winEnv, execFileSync: () => { throw new Error("access denied"); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /restrict the log salt/);
  assert.equal(fs.existsSync(path.join(dir, "assist-salt.json")), false);
  assert.equal(loadOrCreateSalt({ dir: tmp(), platform: "win32", env: {}, execFileSync() {} }).ok, false, "no user name, no lock, no salt");
  const junk = tmp();
  fs.writeFileSync(path.join(junk, "assist-salt.json"), JSON.stringify({ salt: "short" }));
  assert.equal(loadOrCreateSalt({ dir: junk, platform: "linux" }).created, true, "a malformed salt is replaced, not trusted");
});

test("the desk wires the salt into the log: hashes appear, and differ from a bare sha256", () => {
  const dir = tmp();
  const m = createAssistMain({ electron: { clipboard: {}, BrowserWindow: class {}, ipcMain: { handle() {} }, screen: {} }, userDataDir: dir, spawn: () => { throw new Error("no worker"); }, filesOverride: {}, utilsOverride: { list: () => [], stop() {} }, identityOverride: { info: () => ({ ok: false, error: "n/a" }), hello: () => ({}) }, saltOverride: { ok: true, salt: Buffer.alloc(32, 7) }, post: async () => ({ status: 500, body: "{}" }) });
  assert.ok(m);
  const rec = core.logRecord({ id: "x", verb: "rewrite", ctx: { selection: "1234" }, outcome: "ok", settings: {} });
  assert.match(rec.selectionHash, /^[0-9a-f]{12}$/);
  assert.notEqual(rec.selectionHash, require("node:crypto").createHash("sha256").update("1234").digest("hex").slice(0, 12));
  const unsalted = createAssistMain({ electron: { clipboard: {}, BrowserWindow: class {}, ipcMain: { handle() {} }, screen: {} }, userDataDir: dir, spawn: () => { throw new Error("no worker"); }, filesOverride: {}, utilsOverride: { list: () => [], stop() {} }, identityOverride: { info: () => ({ ok: false }), hello: () => ({}) }, saltOverride: { ok: false, error: "no acl" }, post: async () => ({ status: 500, body: "{}" }) });
  assert.ok(unsalted);
  assert.equal("selectionHash" in core.logRecord({ id: "x", verb: "rewrite", ctx: { selection: "1234" }, outcome: "ok", settings: {} }), false, "no salt: the hash is omitted, not unsalted");
  core.useLogSalt(Buffer.alloc(32, 1));
});

// ---- the desk identity ---------------------------------------------------------------------

test("identity: a P-256 key minted once behind a user-only ACL, stable across restarts, fingerprint readable", () => {
  const dir = tmp();
  const acl = [];
  const execFileSync = (exe, args) => { acl.push(args); };
  const a = createAssistIdentity({ dir, platform: "win32", env: winEnv, execFileSync });
  const info = a.info();
  assert.ok(info.ok);
  assert.equal(Buffer.from(info.key, "base64url").length, 65, "raw uncompressed P-256 point");
  assert.match(info.fingerprint, /^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);
  assert.equal(acl.length, 1);
  assert.equal(acl[0][0], path.join(dir, "assist-desk-key.json"));
  assert.deepEqual(acl[0].slice(1), ["/inheritance:r", "/grant:r", "PC\\me:(F)"]);
  const again = createAssistIdentity({ dir, platform: "win32", env: winEnv, execFileSync }).info();
  assert.deepEqual(again, info, "the same identity after a restart");
  assert.equal(acl.length, 1);
  assert.notEqual(createAssistIdentity({ dir: tmp(), platform: "win32", env: winEnv, execFileSync }).info().fingerprint, info.fingerprint);
});

test("identity: no user-only ACL, no identity: the key file is removed and nothing is signed", () => {
  const dir = tmp();
  const id = createAssistIdentity({ dir, platform: "win32", env: winEnv, execFileSync: () => { throw new Error("denied"); } });
  assert.equal(id.info().ok, false);
  assert.equal(id.hello("n".repeat(24)).ok, false);
  assert.equal(id.hello("n".repeat(24)).status, 503);
  assert.equal(fs.existsSync(path.join(dir, "assist-desk-key.json")), false);
});

test("hello: signs the fixed prefix + the nonce; verifies only with the pinned key, the same nonce and the right bytes", () => {
  const dir = tmp();
  const desk = createAssistIdentity({ dir, platform: "linux" });
  const nonce = "AbCdEfGhIjKlMnOpQrStUv";
  const h = desk.hello(nonce);
  assert.ok(h.ok);
  assert.equal(verifyHello({ key: h.key, nonce, sig: h.sig }), true);
  assert.equal(verifyHello({ key: h.key, nonce: `${nonce}x`, sig: h.sig }), false, "a replayed signature does not answer another nonce");
  const flipped = Buffer.from(h.sig, "base64url"); flipped[5] ^= 1;
  assert.equal(verifyHello({ key: h.key, nonce, sig: flipped.toString("base64url") }), false);
  const impostor = createAssistIdentity({ dir: tmp(), platform: "linux" }).hello(nonce);
  assert.equal(verifyHello({ key: h.key, nonce, sig: impostor.sig }), false, "an impostor's signature fails against the PINNED key");
  assert.equal(verifyHello({ key: impostor.key, nonce, sig: impostor.sig }), true, "(it would pass against its own key: which is why the key is pinned at pairing)");
  assert.notEqual(impostor.fingerprint, h.fingerprint, "and its fingerprint differs");
  assert.ok(HELLO_PREFIX.endsWith("\n"));
  for (const bad of ["short", "", "has spaces and !!! chars here", "x".repeat(200), 12345, null, undefined, { a: 1 }]) assert.equal(desk.hello(bad).ok, false, String(bad));
});

// ---- end to end through the bridge: pin at pairing, refuse a changed desk -------------------

const EXT = "chrome-extension://hlmfknhcfhjjngckfpacgleffckpmphe";
function post(address, route, body = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: address.port, path: route, method: "POST", headers: { "content-type": "application/json", origin: EXT } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function startDesk(context, dir) {
  const fakeElectron = { clipboard: {}, BrowserWindow: class { constructor() { this.webContents = { send() {}, setWindowOpenHandler() {}, on() {}, isLoading: () => false }; } on() {} loadFile() { return Promise.resolve(); } isDestroyed() { return false; } }, ipcMain: { handle() {} }, screen: {}, dialog: { showMessageBox: async () => ({ response: 1 }) } };
  const m = createAssistMain({ electron: fakeElectron, userDataDir: dir, spawn: () => { throw new Error("no worker"); }, filesOverride: {}, utilsOverride: { list: () => [], stop() {} }, post: async () => ({ status: 500, body: "{}" }) });
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, onEvent: () => {}, assistHandler: (req) => m.bridge(req), assistAuth: (h) => m.pairing.verify(h) });
  context.after(() => bridge.close());
  return { m, bridge };
}

test("end to end: the key is handed over at pairing and an impostor desk on the same port fails the pinned check", async (context) => {
  const real = startDesk(context, tmp());
  const addr = await real.bridge.listen();
  // 1. hello needs only the pinned Origin; a forged Origin is refused like every /assist route.
  const nonce = "n0nceN0nceN0nceN0nce12";
  const hello = await post(addr, "/assist/hello", { nonce });
  assert.equal(hello.status, 200);
  assert.equal(verifyHello({ key: hello.json.key, nonce, sig: hello.json.sig }), true);
  // 2. pairing: the owner clicks Allow (the fake dialog), the extension finishes and PINS the key.
  const start = await post(addr, "/assist/pair/start");
  assert.equal(start.json.ok, true);
  let done;
  for (let i = 0; i < 100; i += 1) { // minting runs the real ACL tool on Windows: poll, do not guess a delay
    await new Promise((r) => setTimeout(r, 50));
    done = await post(addr, "/assist/pair/finish", { id: start.json.id });
    if (!done.json.pending) break;
  }
  assert.equal(done.json.ok, true);
  assert.ok(done.json.token);
  const pinned = { key: done.json.deskKey, fingerprint: done.json.fingerprint };
  assert.equal(pinned.key, hello.json.key, "the key handed over at pairing is the key hello proves");
  assert.match(pinned.fingerprint, /^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);
  // 3. the genuine desk keeps passing the pinned check on a fresh nonce.
  const n2 = "freshFreshFreshFresh99";
  const again = await post(addr, "/assist/hello", { nonce: n2 });
  assert.equal(verifyHello({ key: pinned.key, nonce: n2, sig: again.json.sig }), true);
  // 4. a different desk on the port (reinstall, or an impostor): its answer fails against the pin.
  const other = startDesk(context, tmp());
  const otherAddr = await other.bridge.listen();
  const impostor = await post(otherAddr, "/assist/hello", { nonce: n2 });
  assert.equal(impostor.status, 200);
  assert.equal(verifyHello({ key: pinned.key, nonce: n2, sig: impostor.json.sig }), false, "signature does not verify under the pinned key");
  assert.notEqual(impostor.json.fingerprint, pinned.fingerprint, "and the fingerprint changed: refuse until the owner pairs again");
  // 5. a bad nonce is a 400, and a forged Origin never reaches hello.
  assert.equal((await post(addr, "/assist/hello", { nonce: "x" })).status, 400);
  const forged = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: addr.port, path: "/assist/hello", method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify({ nonce: n2 }));
  });
  assert.equal(forged, 403);
});

test("pair/finish refuses to hand out a token from a desk that cannot prove its identity", async () => {
  const dir = tmp();
  const m = createAssistMain({
    electron: { clipboard: {}, BrowserWindow: class {}, ipcMain: { handle() {} }, screen: {} }, userDataDir: dir, spawn: () => { throw new Error("no worker"); },
    filesOverride: {}, utilsOverride: { list: () => [], stop() {} }, post: async () => ({ status: 500, body: "{}" }),
    identityOverride: { info: () => ({ ok: false, error: "key not protected" }), hello: () => ({ ok: false }) },
    pairingOverride: { finish: () => { throw new Error("must not be reached"); }, verify: () => false },
  });
  const r = await m.bridge({ route: "pair/finish", body: { id: "abc" }, origin: EXT });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.match(r.error, /cannot prove its identity/);
});
