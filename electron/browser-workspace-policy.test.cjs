"use strict";

// The signed workspace policy: a policy is in force only when its signature matches a
// pinned key, its serial has not gone back, it has not expired and it is this tenant's.
// Anything else closes the apps the last good policy named, and decide() never allows on
// an error. The key pair is made here; no private key is in the repository.

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("./browser-workspace-policy.cjs");

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ed25519");
const KEYS = [P.publicKeyRaw(publicKey)];
const other = nodeCrypto.generateKeyPairSync("ed25519");

const WIKI = "http://wiki.corp.test";
const CRM = "https://crm.example.com";
const base = (over = {}) => ({
  v: 1, tenant_id: "acme", serial: 5, not_after: "2099-01-01T00:00:00Z",
  apps: [
    { origin: WIKI, private: { host: "100.64.0.7", port: 8080 }, deny: ["copy", "print", "download"], watermark: true, audit: true },
    { origin: CRM, deny: ["download"] },
  ],
  ...over,
});
const signed = (over, key = privateKey) => P.signPolicy(base(over), key);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-wspolicy-"));
}
function store(dir, opts = {}) {
  return P.createWorkspacePolicy({ dir, keys: KEYS, ...opts });
}
function put(dir, doc) {
  fs.writeFileSync(path.join(dir, P.POLICY_FILE), typeof doc === "string" ? doc : JSON.stringify(doc));
}

test("the canonical form does not depend on key order, and only signs integers", () => {
  assert.equal(P.canonical({ b: 1, a: [true, null, "x"] }), "{\"a\":[true,null,\"x\"],\"b\":1}");
  assert.equal(P.canonical({ a: { d: 1, c: 2 } }), P.canonical({ a: { c: 2, d: 1 } }));
  assert.throws(() => P.canonical({ a: 1.5 }));
  assert.throws(() => P.canonical({ a: undefined }));
  const doc = signed();
  const shuffled = Object.fromEntries(Object.entries(doc).reverse());
  assert.equal(P.signedBytes(doc).toString(), P.signedBytes(shuffled).toString());
  assert.ok(P.signedBytes(doc).toString().startsWith(P.SIGN_DOMAIN));
});

test("no key is pinned in the app yet, so nothing verifies there", () => {
  assert.deepEqual([...P.PINNED_KEYS], []);
  assert.equal(P.verifySignature(signed()).ok, false);
  assert.match(P.verifySignature(signed()).error, /no signing key is pinned/);
});

test("a signature verifies against a pinned key only", () => {
  assert.equal(P.verifySignature(signed(), KEYS).ok, true);
  assert.equal(P.verifySignature(signed({}, other.privateKey), KEYS).ok, false, "another key");
  assert.equal(P.verifySignature({ ...signed(), serial: 6 }, KEYS).ok, false, "a changed field");
  assert.equal(P.verifySignature({ ...base() }, KEYS).ok, false, "unsigned");
  assert.equal(P.verifySignature({ ...base(), sig: "AAAA" }, KEYS).ok, false, "a short signature");
  assert.equal(P.verifySignature(null, KEYS).ok, false);
  assert.equal(P.verifySignature(signed(), ["not-a-key"]).ok, false, "a malformed pinned key matches nothing");
});

test("the schema is strict: an unknown field, action or a non-origin is an error", () => {
  assert.equal(P.normalize(base()).ok, true);
  for (const bad of [
    base({ v: 2 }), base({ tenant_id: "" }), base({ tenant_id: "../x" }), base({ serial: 0 }), base({ serial: 1.5 }),
    base({ not_after: "tomorrow" }), base({ not_after: "2099-01-01" }), base({ apps: "x" }), base({ extra: 1 }),
    base({ apps: [{ origin: "http://wiki.corp.test/path" }] }), base({ apps: [{ origin: "ftp://x" }] }),
    base({ apps: [{ origin: WIKI, deny: ["screenshot"] }] }), base({ apps: [{ origin: WIKI, private: { host: "a b", port: 1 } }] }),
    base({ apps: [{ origin: WIKI, private: { host: "h", port: 70000 } }] }), base({ apps: [{ origin: WIKI, surprise: true }] }),
    base({ apps: [{ origin: WIKI }, { origin: WIKI }] }), base({ apps: [{ origin: WIKI, watermark: "yes" }] }),
  ]) assert.equal(P.normalize(bad).ok, false, JSON.stringify(bad).slice(0, 120));
});

test("with no policy at all, nothing is governed and everything is allowed", () => {
  const s = store(tmp());
  assert.equal(s.load().state, "none");
  for (const action of ["open", ...P.ACTIONS]) assert.deepEqual(s.decide("https://example.com", action), { allow: true, governed: false, reason: "not a workspace app" });
  assert.equal(s.gate({ url: "https://example.com/x" }).verdict, "allow");
  assert.equal(s.partition(), null);
  assert.deepEqual(s.privateHosts(), []);
});

test("a good policy governs its origins: the deny list per app, everything else allowed", () => {
  const dir = tmp();
  put(dir, signed());
  const s = store(dir);
  assert.equal(s.load().state, "ok");
  assert.equal(s.decide(WIKI, "open").allow, true);
  for (const a of ["copy", "print", "download"]) assert.equal(s.decide(`${WIKI}/page?x=1`, a).allow, false, a);
  for (const a of ["paste", "upload", "capture", "devtools"]) assert.equal(s.decide(WIKI, a).allow, true, a);
  assert.equal(s.decide(CRM, "download").allow, false);
  assert.equal(s.decide(CRM, "copy").allow, true, "the deny list is per app");
  assert.equal(s.decide(`blob:${CRM}/1234`, "download").allow, false, "a blob: page of the app is the app");
  assert.equal(s.decide("https://example.com", "copy").allow, true, "ordinary browsing is untouched");
  assert.equal(s.decide("about:blank", "copy").allow, true);
  assert.equal(s.decide("", "copy").allow, true);
  assert.equal(s.decide(WIKI, "teleport").allow, false, "an action nobody knows is not allowed on a governed origin");
  assert.equal(s.partition(), "persist:aither-work-acme");
  assert.deepEqual(s.privateHosts(), ["wiki.corp.test"]);
  assert.deepEqual(s.privateTarget("WIKI.corp.test", 80), { host: "100.64.0.7", port: 8080, origin: WIKI });
  assert.equal(s.privateTarget("wiki.corp.test", 8080), null, "the app's own port only");
  assert.equal(s.privateTarget("crm.example.com", 443), null, "not a private app");
  assert.equal(s.appFor(WIKI).watermark, true);
  assert.deepEqual(s.apps().map((a) => a.origin), [WIKI, CRM]);
});

test("decide never allows on an error", () => {
  const dir = tmp();
  put(dir, signed());
  const s = store(dir);
  s.load();
  assert.equal(s.decide("http://[", "copy").allow, false, "an address that cannot be read");
  assert.equal(s.decide({ toString() { throw new Error("boom"); } }, "open").allow, false);
  assert.equal(s.gate({ url: "http://[" }).verdict, "closed");
  assert.equal(s.governs("http://["), true);
  const broken = P.createWorkspacePolicy({ dir, keys: KEYS, now: () => { throw new Error("clock"); } });
  broken.load();
  assert.equal(broken.decide(WIKI, "open").allow, false, "a failing clock is not 'not expired'");
  assert.equal(broken.gate({ url: WIKI }).verdict, "closed");
});

test("a tampered policy closes the governed apps and leaves ordinary browsing alone", () => {
  const dir = tmp();
  put(dir, signed());
  const s = store(dir);
  s.load();
  const forged = signed();
  forged.apps[0].deny = [];
  put(dir, forged);
  const st = s.load();
  assert.equal(st.state, "invalid");
  assert.match(st.reason, /signature/);
  for (const a of ["open", "copy", "paste"]) assert.equal(s.decide(WIKI, a).allow, false, a);
  assert.equal(s.decide(CRM, "open").allow, false, "every app of the last good policy");
  assert.equal(s.gate({ url: `${WIKI}/` }).verdict, "closed");
  assert.equal(s.decide("https://example.com", "copy").allow, true);
  assert.deepEqual(s.privateHosts(), []);
  assert.equal(s.privateTarget("wiki.corp.test", 80), null);
  // After a restart too: the governed origins were written down.
  const again = store(dir);
  assert.equal(again.load().state, "invalid");
  assert.equal(again.decide(WIKI, "open").allow, false);
  // A policy signed by someone else is the same.
  put(dir, signed({ serial: 9 }, other.privateKey));
  assert.equal(again.load().state, "invalid");
  // Garbage in the file is the same.
  put(dir, "{not json");
  assert.equal(again.load().state, "invalid");
  assert.equal(again.decide(WIKI, "open").allow, false);
});

test("a rolled-back serial is refused, and so is a different policy with the same serial", () => {
  const dir = tmp();
  put(dir, signed({ serial: 7 }));
  const s = store(dir);
  assert.equal(s.load().state, "ok");
  put(dir, signed({ serial: 6, apps: [{ origin: WIKI }] })); // older, validly signed, drops the deny list
  const st = s.load();
  assert.equal(st.state, "invalid");
  assert.match(st.reason, /rolled back/);
  assert.equal(s.decide(WIKI, "open").allow, false);
  assert.equal(s.decide(WIKI, "copy").allow, false);
  // Same serial, other content.
  put(dir, signed({ serial: 7, apps: [{ origin: WIKI }] }));
  assert.match(store(dir).load().reason, /reuses serial 7/);
  // The very same policy again is fine; a higher serial takes over.
  put(dir, signed({ serial: 7 }));
  assert.equal(store(dir).load().state, "ok");
  put(dir, signed({ serial: 8, apps: [{ origin: WIKI }] }));
  const next = store(dir);
  assert.equal(next.load().state, "ok");
  assert.equal(next.decide(WIKI, "copy").allow, true, "the newer policy's rules");
  assert.equal(next.decide(CRM, "download").allow, true, "an app the newer policy dropped is no longer governed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, P.STATE_FILE), "utf8")).serial, 8);
});

test("an expired policy closes the governed apps, at decision time", () => {
  const dir = tmp();
  let clock = Date.parse("2026-11-13T00:00:00Z");
  put(dir, signed({ not_after: "2026-11-14T00:00:00Z" }));
  const s = store(dir, { now: () => clock });
  assert.equal(s.load().state, "ok");
  assert.equal(s.decide(WIKI, "open").allow, true);
  clock = Date.parse("2026-11-14T00:00:00Z");
  assert.equal(s.status().state, "expired");
  assert.equal(s.decide(WIKI, "open").allow, false);
  assert.equal(s.decide(WIKI, "paste").allow, false);
  assert.match(s.decide(WIKI, "open").reason, /expired/);
  assert.equal(s.gate({ url: WIKI }).verdict, "closed");
  assert.deepEqual(s.privateHosts(), []);
  assert.deepEqual(s.apps(), [], "no app is in force");
  assert.equal(s.appFor(WIKI), null);
  assert.equal(s.privateTarget("wiki.corp.test", 80), null);
  assert.equal(s.decide("https://example.com", "copy").allow, true);
  // Loaded already expired: the same.
  assert.equal(store(dir, { now: () => clock }).load().state, "expired");
});

test("a policy file that disappears keeps its apps closed; a state file that is unreadable trusts nothing", () => {
  const dir = tmp();
  put(dir, signed());
  const s = store(dir);
  s.load();
  fs.rmSync(path.join(dir, P.POLICY_FILE));
  assert.equal(s.load().state, "missing");
  assert.equal(s.decide(WIKI, "open").allow, false);
  put(dir, signed());
  fs.writeFileSync(path.join(dir, P.STATE_FILE), "{broken");
  const t = store(dir);
  assert.equal(t.load().state, "invalid");
  assert.deepEqual(t.privateHosts(), []);
});

test("another tenant's policy is refused once a tenant is bound", () => {
  const dir = tmp();
  put(dir, signed());
  const s = store(dir);
  s.load();
  put(dir, signed({ tenant_id: "evil", serial: 99, apps: [] }));
  const st = s.load();
  assert.equal(st.state, "invalid");
  assert.match(st.reason, /another workspace/);
  assert.equal(s.decide(WIKI, "open").allow, false);
});

test("the gate: owner tabs go to the work partition; agent and InPrivate never get a private app", () => {
  const dir = tmp();
  put(dir, signed());
  const s = store(dir);
  s.load();
  const work = "persist:aither-work-acme";
  assert.deepEqual(s.gate({ url: `${WIKI}/a`, by: "you", partition: "persist:aither-browser" }), { verdict: "work", partition: work });
  assert.deepEqual(s.gate({ url: `${WIKI}/a`, by: "you", partition: work }), { verdict: "allow" });
  assert.equal(s.gate({ url: `${CRM}/a`, by: "you", partition: null }).verdict, "work", "a public governed app too");
  assert.equal(s.gate({ url: `${WIKI}/a`, by: "agent", partition: "persist:aither-browser-agent" }).verdict, "refuse");
  assert.equal(s.gate({ url: `${WIKI}/a`, by: "agent", partition: work }).verdict, "refuse", "not even on the work partition");
  assert.equal(s.gate({ url: `${WIKI}/a`, by: "you", private: true, partition: "aither-inprivate" }).verdict, "refuse");
  assert.equal(s.gate({ url: `${CRM}/a`, by: "agent" }).verdict, "allow", "a public app is the open web for an agent's own session");
  assert.equal(s.gate({ url: "https://example.com", by: "you", partition: work }).verdict, "allow", "a sign-in redirect stays in the work tab");
});

test("the listeners hear a change, and only a change", () => {
  const dir = tmp();
  const s = store(dir);
  const heard = [];
  s.onChange((st) => heard.push(st.state));
  s.load();
  put(dir, signed());
  s.load();
  s.load();
  put(dir, "{");
  s.load();
  assert.deepEqual(heard, ["ok", "invalid"]);
});

test("the fetch seam: 404 is 'no policy', nothing is invented, the bearer goes to https only", async () => {
  const calls = [];
  const answer = (status, body) => async (url, init) => { calls.push({ url, init }); return { status, text: async () => body }; };
  const token = async () => "tok";
  assert.deepEqual(await P.fetchRemote({ origin: "https://app.aitherium.com", token, fetchImpl: answer(404, "nope") }), { status: "none" });
  assert.equal(calls[0].url, "https://app.aitherium.com/v1/workspace/browser-policy");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.equal((await P.fetchRemote({ origin: "https://app.aitherium.com", token, fetchImpl: answer(500, "") })).status, "error");
  assert.equal((await P.fetchRemote({ origin: "https://app.aitherium.com", token, fetchImpl: answer(200, "<html>") })).status, "error");
  assert.equal((await P.fetchRemote({ origin: "https://app.aitherium.com", token, fetchImpl: answer(200, "[]") })).status, "error");
  assert.equal((await P.fetchRemote({ origin: "https://app.aitherium.com", token, fetchImpl: answer(200, JSON.stringify(signed())) })).status, "doc");
  const before = calls.length;
  assert.deepEqual(await P.fetchRemote({ origin: "https://app.aitherium.com", token: async () => "", fetchImpl: answer(200, "{}") }), { status: "none" });
  assert.equal((await P.fetchRemote({ origin: "http://evil.example", token, fetchImpl: answer(200, "{}") })).status, "error");
  assert.equal((await P.fetchRemote({ origin: "", token, fetchImpl: answer(200, "{}") })).status, "error");
  assert.equal(calls.length, before, "no token or a plain-http origin: nothing is sent");
  assert.equal((await P.fetchRemote({ origin: "https://app.aitherium.com", token, fetchImpl: async () => { throw new Error("offline"); } })).status, "error");
});

test("refresh: a fetched policy is verified like the file, kept for next time, and a 404 changes nothing", async () => {
  const dir = tmp();
  let body = { status: 404, text: async () => "" };
  const remote = { origin: () => "https://app.aitherium.com", token: async () => "tok", fetchImpl: async () => body };
  const s = store(dir, { remote });
  assert.equal((await s.refresh()).state, "none");
  assert.equal(fs.existsSync(path.join(dir, P.POLICY_FILE)), false);
  body = { status: 200, text: async () => JSON.stringify(signed({ serial: 3 })) };
  const got = await s.refresh();
  assert.equal(got.state, "ok");
  assert.equal(got.remote, "doc");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, P.POLICY_FILE), "utf8")).serial, 3, "kept for the next start");
  // Offline afterwards: the kept file still stands.
  body = { status: 503, text: async () => "" };
  assert.equal((await s.refresh()).state, "ok");
  // A forged answer does not replace the good file; the newer signed one does.
  const forged = signed({ serial: 4 });
  forged.apps = [];
  body = { status: 200, text: async () => JSON.stringify(forged) };
  assert.equal((await s.refresh()).state, "ok");
  assert.equal(s.status().serial, 3);
  body = { status: 200, text: async () => JSON.stringify(signed({ serial: 4 })) };
  assert.equal((await s.refresh()).serial, 4);
});
