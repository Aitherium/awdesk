"use strict";

// The signed workspace policy: a policy is in force only when its signature matches a
// pinned key, its serial has not gone back, it has not expired and it is this tenant's.
// Anything else closes the apps the last good policy named, and decide() never allows on
// an error. A PRIVATE app opens only after the platform has confirmed the policy in this
// launch. The key pair is made here; no private key is in the repository.

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
function put(dir, doc) {
  fs.writeFileSync(path.join(dir, P.POLICY_FILE), typeof doc === "string" ? doc : JSON.stringify(doc));
}
/** A stand-in platform: answers the policy route with `platform.doc` (null = 404). */
function platformOf(doc = null) {
  const platform = { doc, calls: 0 };
  platform.remote = { origin: () => "https://app.aitherium.com", token: async () => "tok",
    fetchImpl: async () => { platform.calls += 1; return platform.doc ? { status: 200, text: async () => JSON.stringify(platform.doc) } : { status: 404, text: async () => "" }; } };
  return platform;
}
/** A store that only has the local file (the platform has not answered in this launch). */
function store(dir, opts = {}) {
  return P.createWorkspacePolicy({ dir, keys: KEYS, ...opts });
}
/** A store whose platform has just confirmed `doc`. */
async function live(dir, doc = signed(), opts = {}) {
  const platform = platformOf(doc);
  const s = P.createWorkspacePolicy({ dir, keys: KEYS, remote: platform.remote, ...opts });
  await s.refresh();
  return { s, platform };
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

// Review finding 10: a signed policy does not get to point the door at the desk itself.
test("a private app's mesh address is never this computer, link-local, unspecified or malformed", () => {
  const withHost = (host) => base({ apps: [{ origin: WIKI, private: { host, port: 8080 } }] });
  for (const host of ["127.0.0.1", "127.9.9.9", "localhost", "LOCALHOST.", "db.localhost", "169.254.169.254", "0.0.0.0", "999.1.1.1", "1.2.3", "1.2.3.4.5",
    "::1", "[::1]", "::", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "224.0.0.1", "255.255.255.255", "ff02::1", "12:34", "::g"]) {
    const r = P.normalize(withHost(host));
    assert.equal(r.ok, false, host);
    assert.match(r.error, /private\.host/, host);
  }
  for (const host of ["100.64.0.7", "10.1.2.3", "192.168.1.9", "fd7a:115c:a1e0::7", "[fd00::1]", "wiki.mesh.example", "Wiki.Mesh.Example."]) {
    assert.equal(P.normalize(withHost(host)).ok, true, host);
  }
  assert.equal(P.normalize(withHost("[FD00::1]")).policy.apps[0].private.host, "fd00::1");
  assert.equal(P.normalize(withHost("Wiki.Mesh.Example.")).policy.apps[0].private.host, "wiki.mesh.example");
  // The live proof's seam lets loopback through and nothing else; the app never sets it.
  assert.equal(P.normalize(withHost("127.0.0.1"), { allowLoopback: true }).ok, true);
  assert.equal(P.normalize(withHost("169.254.169.254"), { allowLoopback: true }).ok, false);
  assert.equal(P.normalize(withHost("0.0.0.0"), { allowLoopback: true }).ok, false);
  assert.equal(P.forbiddenAddress("100.64.0.7"), "");
  assert.equal(P.forbiddenAddress(""), "empty");
});

test("with no policy at all, nothing is governed and everything is allowed", () => {
  const s = store(tmp());
  assert.equal(s.load().state, "none");
  for (const action of ["open", ...P.ACTIONS]) assert.deepEqual(s.decide("https://example.com", action), { allow: true, governed: false, reason: "not a workspace app" });
  assert.equal(s.gate({ url: "https://example.com/x" }).verdict, "allow");
  assert.equal(s.gate({ url: "https://example.com/x", by: "agent" }).verdict, "allow");
  assert.equal(s.partition(), null);
  assert.deepEqual(s.privateHosts(), []);
  assert.deepEqual(s.routedHosts(), []);
  assert.equal(s.requestAllowed({ url: "http://wiki.corp.test/x", resourceType: "xhr", topOrigin: "https://example.com" }), true);
});

test("a good policy governs its origins: the deny list per app, everything else allowed", async () => {
  const dir = tmp();
  const { s } = await live(dir);
  assert.equal(s.status().state, "ok");
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
  assert.deepEqual(s.privateTarget("wiki.corp.test.", 80), { host: "100.64.0.7", port: 8080, origin: WIKI }, "the same host, fully qualified");
  assert.equal(s.privateTarget("wiki.corp.test", 8080), null, "the app's own port only");
  assert.equal(s.privateTarget("crm.example.com", 443), null, "not a private app");
  assert.equal(s.appFor(WIKI).watermark, true);
  assert.deepEqual(s.apps().map((a) => a.origin), [WIKI, CRM]);
});

// Review finding 2: the serial state is a file the user can delete, so it cannot be what
// keeps a rolled-back policy from opening a private app. The platform, in this launch, is.
test("a private app stays closed until the platform has confirmed the policy in this launch", async () => {
  const dir = tmp();
  put(dir, signed());
  const s = store(dir);
  assert.equal(s.load().state, "ok", "the local file is a good policy");
  assert.equal(s.status().confirmed, false);
  assert.deepEqual(s.decide(WIKI, "open"), { allow: false, governed: true, reason: P.UNCONFIRMED });
  assert.equal(s.gate({ url: WIKI }).verdict, "closed");
  assert.equal(s.privateTarget("wiki.corp.test", 80), null);
  assert.deepEqual(s.privateHosts(), []);
  assert.deepEqual(s.routedHosts(), ["wiki.corp.test"], "still routed to the door, which refuses it");
  assert.equal(s.decide(CRM, "open").allow, true, "a public app works from the local policy");
  assert.equal(s.decide(CRM, "download").allow, false, "with its rules");
  // A desk that never reaches the platform (404, offline) gets no private access.
  const lonely = platformOf(null);
  const t = store(dir, { remote: lonely.remote });
  assert.equal((await t.refresh()).state, "ok");
  assert.equal(t.privateTarget("wiki.corp.test", 80), null);
  const offline = store(dir, { remote: { origin: () => "https://app.aitherium.com", token: async () => "tok", fetchImpl: async () => { throw new Error("offline"); } } });
  await offline.refresh();
  assert.equal(offline.privateTarget("wiki.corp.test", 80), null);
  // The platform answers: confirmed, for this launch only.
  const { s: ok } = await live(dir);
  assert.equal(ok.status().confirmed, true);
  assert.notEqual(ok.privateTarget("wiki.corp.test", 80), null);
  assert.equal(store(dir).load().confirmed, false, "the next launch starts unconfirmed: nothing on disk says 'confirmed'");
  assert.ok(!fs.readFileSync(path.join(dir, P.STATE_FILE), "utf8").includes("confirmed"));
});

test("deleting the serial state does not let an older signed policy open a private app", async () => {
  const dir = tmp();
  const { s } = await live(dir, signed({ serial: 9, apps: [{ origin: WIKI, private: { host: "100.64.0.7", port: 8080 }, deny: ["copy"] }] }));
  assert.notEqual(s.privateTarget("wiki.corp.test", 80), null);
  // The attacker's move: remove the state, put back last year's policy (validly signed, weaker, another mesh address).
  fs.rmSync(path.join(dir, P.STATE_FILE));
  put(dir, signed({ serial: 2, apps: [{ origin: WIKI, private: { host: "100.64.0.99", port: 8080 } }] }));
  const next = store(dir);
  assert.equal(next.load().state, "ok", "locally it looks like a good policy");
  assert.equal(next.privateTarget("wiki.corp.test", 80), null, "and it opens nothing private");
  assert.equal(next.decide(WIKI, "open").allow, false);
  // The platform's answer (serial 9) takes over and is the one confirmed.
  const platform = platformOf(signed({ serial: 9, apps: [{ origin: WIKI, private: { host: "100.64.0.7", port: 8080 }, deny: ["copy"] }] }));
  const healed = store(dir, { remote: platform.remote });
  const st = await healed.refresh();
  assert.equal(st.serial, 9);
  assert.equal(healed.privateTarget("wiki.corp.test", 80).host, "100.64.0.7");
  // A platform that is BEHIND the local policy has not confirmed it.
  const dir2 = tmp();
  put(dir2, signed({ serial: 9 }));
  const behind = store(dir2, { remote: platformOf(signed({ serial: 8 })).remote });
  assert.equal((await behind.refresh()).serial, 9);
  assert.equal(behind.status().confirmed, false);
  assert.equal(behind.privateTarget("wiki.corp.test", 80), null);
});

test("decide never allows on an error", async () => {
  const dir = tmp();
  const { s } = await live(dir);
  assert.equal(s.decide("http://[", "copy").allow, false, "an address that cannot be read");
  assert.equal(s.decide({ toString() { throw new Error("boom"); } }, "open").allow, false);
  assert.equal(s.gate({ url: "http://[" }).verdict, "closed");
  assert.equal(s.governs("http://["), true);
  assert.equal(s.requestAllowed({ url: "http://[", resourceType: "xhr" }), false);
  const broken = P.createWorkspacePolicy({ dir, keys: KEYS, now: () => { throw new Error("clock"); } });
  broken.load();
  assert.equal(broken.decide(CRM, "open").allow, false, "a failing clock is not 'not expired'");
  assert.equal(broken.gate({ url: CRM }).verdict, "closed");
  const unsafeThrows = P.createWorkspacePolicy({ dir, keys: KEYS, unsafe: () => { throw new Error("x"); } });
  unsafeThrows.load();
  assert.equal(unsafeThrows.decide(CRM, "open").allow, false, "a launch that cannot be checked is not 'safe'");
});

test("a tampered policy closes the governed apps and leaves ordinary browsing alone", async () => {
  const dir = tmp();
  const { s } = await live(dir);
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
  assert.deepEqual(s.routedHosts(), ["wiki.corp.test"], "review finding 9: the host stays routed to the door, never direct");
  // After a restart too: the governed origins and the private hosts were written down.
  const again = store(dir);
  assert.equal(again.load().state, "invalid");
  assert.equal(again.decide(WIKI, "open").allow, false);
  assert.deepEqual(again.routedHosts(), ["wiki.corp.test"]);
  // A policy signed by someone else is the same.
  put(dir, signed({ serial: 9 }, other.privateKey));
  assert.equal(again.load().state, "invalid");
  // Garbage in the file is the same.
  put(dir, "{not json");
  assert.equal(again.load().state, "invalid");
  assert.equal(again.decide(WIKI, "open").allow, false);
});

test("a rolled-back serial is refused, and so is a different policy with the same serial", async () => {
  const dir = tmp();
  const { s } = await live(dir, signed({ serial: 7 }));
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

test("an expired policy closes the governed apps, at decision time", async () => {
  const dir = tmp();
  let clock = Date.parse("2026-11-13T00:00:00Z");
  const { s } = await live(dir, signed({ not_after: "2026-11-14T00:00:00Z" }), { now: () => clock });
  assert.equal(s.status().state, "ok");
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

// Review finding 6.
test("turning the clock back does not revive an expired policy", async () => {
  const dir = tmp();
  let clock = Date.parse("2026-11-13T12:00:00Z");
  put(dir, signed({ not_after: "2026-11-14T00:00:00Z", apps: [{ origin: CRM, deny: ["download"] }] }));
  const s = store(dir, { now: () => clock });
  assert.equal(s.load().state, "ok");
  clock = Date.parse("2026-11-20T00:00:00Z");
  assert.equal(s.load().state, "expired", "a week later it has expired, and that time was seen");
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, P.STATE_FILE), "utf8")).seen >= clock);
  // The attacker sets the clock back to before not_after, and restarts.
  clock = Date.parse("2026-11-13T12:00:00Z");
  for (const t of [s, store(dir, { now: () => clock })]) {
    const st = t.load();
    assert.equal(st.state, "expired");
    assert.match(st.reason, /clock went back/);
    assert.equal(t.decide(CRM, "open").allow, false);
  }
  // A few minutes of drift is not "went back".
  const dir2 = tmp();
  let clock2 = Date.parse("2026-11-13T12:00:00Z");
  put(dir2, signed());
  const drift = store(dir2, { now: () => clock2 });
  drift.load();
  clock2 -= P.CLOCK_SLACK_MS - 1000;
  assert.equal(drift.status().state, "ok");
  clock2 -= 2000;
  assert.equal(drift.status().state, "expired");
  // The platform answering with a good policy is what puts a wrong "latest time" right.
  const dir3 = tmp();
  let clock3 = Date.parse("2030-01-01T00:00:00Z"); // the clock was once set years ahead by mistake
  const p3 = platformOf(signed());
  const fixed = store(dir3, { now: () => clock3, remote: p3.remote });
  await fixed.refresh();
  clock3 = Date.parse("2026-11-13T12:00:00Z");
  assert.equal(fixed.status().state, "expired");
  assert.equal((await fixed.refresh()).state, "ok");
});

test("a policy file that disappears keeps its apps closed; a state file that is unreadable trusts nothing", async () => {
  const dir = tmp();
  const { s } = await live(dir);
  fs.rmSync(path.join(dir, P.POLICY_FILE));
  assert.equal(s.load().state, "missing");
  assert.equal(s.decide(WIKI, "open").allow, false);
  put(dir, signed());
  fs.writeFileSync(path.join(dir, P.STATE_FILE), "{broken");
  const t = store(dir);
  assert.equal(t.load().state, "invalid");
  assert.deepEqual(t.privateHosts(), []);
});

test("another tenant's policy is refused once a tenant is bound", async () => {
  const dir = tmp();
  const { s } = await live(dir);
  put(dir, signed({ tenant_id: "evil", serial: 99, apps: [] }));
  const st = s.load();
  assert.equal(st.state, "invalid");
  assert.match(st.reason, /another workspace/);
  assert.equal(s.decide(WIKI, "open").allow, false);
});

// One pinned key signs every tenant's policy, so the tenant must be the account's own.
test("a policy applies only to the workspace the account is signed in to", async () => {
  const dir = tmp();
  let who = null;
  const { s } = await live(dir, signed(), { accountTenant: () => who });
  assert.equal(s.status().state, "ok", "not signed in (not known): the binding is not applied");
  who = "ACME";
  assert.equal(s.status().state, "ok", "the same workspace, whatever the case");
  who = "globex";
  const st = s.status();
  assert.equal(st.state, "invalid");
  assert.match(st.reason, /signed in to another one/);
  for (const o of [WIKI, CRM]) assert.equal(s.decide(o, "open").allow, false, o);
  assert.equal(s.decide(CRM, "copy").allow, false);
  assert.equal(s.privateTarget("wiki.corp.test", 80), null);
  assert.deepEqual(s.apps(), []);
  assert.equal(s.decide("https://example.com", "copy").allow, true);
  who = "acme";
  assert.equal(s.decide(WIKI, "open").allow, true);
});

// Review finding 1.
test("on a desk that can be driven from outside, governed apps stay closed; with no policy nothing changes", async () => {
  const dir = tmp();
  let door = "";
  const { s } = await live(dir, signed(), { unsafe: () => door });
  assert.equal(s.decide(WIKI, "open").allow, true);
  door = "--remote-debugging-port";
  const st = s.status();
  assert.equal(st.state, "unsafe");
  assert.match(st.reason, /remote debugging is on \(--remote-debugging-port\)/);
  for (const o of [WIKI, CRM]) {
    assert.equal(s.decide(o, "open").allow, false, o);
    assert.equal(s.gate({ url: o }).verdict, "closed", o);
  }
  assert.equal(s.privateTarget("wiki.corp.test", 80), null);
  assert.deepEqual(s.privateHosts(), []);
  assert.deepEqual(s.apps(), []);
  assert.equal(s.decide("https://example.com", "copy").allow, true, "the rest of the web is as before");
  // A desk with no workspace policy keeps its CDP door and is told nothing.
  const plain = store(tmp(), { unsafe: () => "DESK_CDP_PORT" });
  assert.equal(plain.load().state, "none");
  assert.equal(plain.decide("https://example.com", "open").allow, true);
  assert.equal(plain.gate({ url: "https://example.com" }).verdict, "allow");
});

// Review finding 4 (the gate) and the session rules.
test("the gate: owner tabs go to the work partition; an agent never gets a governed app; InPrivate never a private one", async () => {
  const dir = tmp();
  const { s } = await live(dir);
  const work = "persist:aither-work-acme";
  assert.deepEqual(s.gate({ url: `${WIKI}/a`, by: "you", partition: "persist:aither-browser" }), { verdict: "work", partition: work });
  assert.deepEqual(s.gate({ url: `${WIKI}/a`, by: "you", partition: work }), { verdict: "allow" });
  assert.equal(s.gate({ url: `${CRM}/a`, by: "you", partition: null }).verdict, "work", "a public governed app too");
  assert.equal(s.gate({ url: `${WIKI}/a`, by: "agent", partition: "persist:aither-browser-agent" }).verdict, "refuse");
  assert.equal(s.gate({ url: `${WIKI}/a`, by: "agent", partition: work }).verdict, "refuse", "not even on the work partition");
  assert.equal(s.gate({ url: `${CRM}/a`, by: "agent" }).verdict, "refuse", "a PUBLIC governed app is not the agent's either");
  assert.equal(s.gate({ url: `${CRM}/a`, by: "agent", partition: "persist:aither-browser" }).verdict, "refuse", "nor when it rides the owner's sign-in");
  assert.match(s.gate({ url: `${CRM}/a`, by: "agent" }).reason, /agent's tab/);
  assert.equal(s.gate({ url: `${WIKI}/a`, by: "you", private: true, partition: "aither-inprivate" }).verdict, "refuse");
  assert.equal(s.gate({ url: `${CRM}/a`, by: "you", private: true }).verdict, "allow", "a public app InPrivate is allowed, under its rules");
  assert.equal(s.gate({ url: "https://example.com", by: "you", partition: work }).verdict, "allow", "a sign-in redirect stays in the work tab");
  assert.equal(s.gate({ url: "https://example.com", by: "agent" }).verdict, "allow");
  // Out of force, an agent is still refused (never "allow" by way of a broken policy).
  put(dir, "{");
  s.load();
  assert.equal(s.gate({ url: `${CRM}/a`, by: "agent" }).verdict, "refuse");
});

// Review finding 3.
test("a private app's host is requested only by a governed page (or as the page itself)", async () => {
  const dir = tmp();
  const { s } = await live(dir);
  const ask = (over) => s.requestAllowed({ url: `${WIKI}/api/data`, resourceType: "xhr", topOrigin: WIKI, ...over });
  assert.equal(ask({}), true, "the app's own request");
  assert.equal(ask({ topOrigin: CRM }), true, "another governed app of the workspace");
  assert.equal(ask({ topOrigin: "https://evil.example" }), false, "an ungoverned page that got into the work session");
  assert.equal(ask({ topOrigin: "https://evil.example", resourceType: "subFrame" }), false, "framing it");
  assert.equal(ask({ topOrigin: "https://evil.example", resourceType: "image" }), false);
  assert.equal(ask({ topOrigin: "" }), false, "a request with no page behind it");
  assert.equal(ask({ topOrigin: "https://evil.example", url: "http://WIKI.corp.test./x" }), false, "the same host, fully qualified");
  assert.equal(ask({ topOrigin: "https://evil.example", resourceType: "mainFrame" }), true, "a top-level navigation is the gate's to judge");
  assert.equal(s.requestAllowed({ url: "https://cdn.example.com/a.js", resourceType: "script", topOrigin: "https://evil.example" }), true, "every other host is untouched");
  assert.equal(s.requestAllowed({ url: `${CRM}/x`, resourceType: "xhr", topOrigin: "https://evil.example" }), true, "a public app is the open web's to request");
  // Out of force, nothing gets the private host.
  put(dir, "{");
  s.load();
  assert.equal(ask({}), false);
});

test("the listeners hear a change, and only a change", async () => {
  const dir = tmp();
  const platform = platformOf(null);
  const s = store(dir, { remote: platform.remote });
  const heard = [];
  s.onChange((st) => heard.push(`${st.state}${st.confirmed ? "+confirmed" : ""}`));
  s.load();
  put(dir, signed());
  s.load();
  s.load();
  platform.doc = signed();
  await s.refresh();
  await s.refresh();
  put(dir, "{");
  s.load();
  assert.deepEqual(heard, ["ok", "ok+confirmed", "invalid"]);
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
  assert.equal(got.confirmed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, P.POLICY_FILE), "utf8")).serial, 3, "kept for the next start");
  // Offline afterwards: the kept file still stands, and what was confirmed in this launch stays confirmed.
  body = { status: 503, text: async () => "" };
  assert.equal((await s.refresh()).state, "ok");
  assert.notEqual(s.privateTarget("wiki.corp.test", 80), null);
  // A forged answer does not replace the good file and confirms nothing; the newer signed one does.
  const forged = signed({ serial: 4 });
  forged.apps = [];
  body = { status: 200, text: async () => JSON.stringify(forged) };
  assert.equal((await s.refresh()).state, "ok");
  assert.equal(s.status().serial, 3);
  body = { status: 200, text: async () => JSON.stringify(signed({ serial: 4 })) };
  assert.equal((await s.refresh()).serial, 4);
  assert.equal(s.status().confirmed, true);
});
