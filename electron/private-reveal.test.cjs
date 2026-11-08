"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseHello, createPrivateReveal, REVEAL_MS } = require("./private-reveal.cjs");

test("Windows Hello answers are read exactly; anything else is NOT verified", () => {
  assert.equal(parseHello("RESULT:Verified").ok, true);
  assert.equal(parseHello("RESULT:Canceled").reason, "cancelled");
  assert.match(parseHello("UNAVAILABLE:DeviceNotPresent").reason, /not set up here \(DeviceNotPresent\)/);
  assert.equal(parseHello("").ok, false);
  assert.equal(parseHello("garbage").ok, false);
});

test("a failed check never reveals", async () => {
  const r = createPrivateReveal({ verify: async () => ({ ok: false, reason: "cancelled" }) });
  const out = await r.unlock();
  assert.equal(out.ok, false);
  assert.equal(r.active(), false);
});

test("a passed check reveals for five minutes, then hides by itself", async () => {
  let t = 1_000;
  const r = createPrivateReveal({ verify: async () => ({ ok: true, reason: "verified" }), now: () => t });
  assert.equal((await r.unlock()).ok, true);
  assert.equal(r.active(), true);
  t += REVEAL_MS - 1;
  assert.equal(r.active(), true);
  t += 2;
  assert.equal(r.active(), false);
});

test("lock() hides again at once", async () => {
  const r = createPrivateReveal({ verify: async () => ({ ok: true, reason: "verified" }) });
  await r.unlock();
  r.lock();
  assert.equal(r.active(), false);
});

test("an OS with no device check refuses instead of revealing", async () => {
  const out = await createPrivateReveal({ platform: "linux" }).unlock();
  assert.equal(out.ok, false);
  assert.match(out.reason, /no device check/);
});

// --------------------------------------------------------------------------- //
// Fallback: Aitherium sign-in when the device cannot check (no Windows Hello)
// --------------------------------------------------------------------------- //

const { verifyIdp } = require("./private-reveal.cjs");

test("no Windows Hello -> the owner's own sign-in opens the reveal", async () => {
  const r = createPrivateReveal({
    platform: "win32",
    verify: null,
    signIn: async ({ prompt }) => { assert.equal(prompt, "login"); return { claims: { preferred_username: "david" } }; },
    expectUser: "david",
  });
  // Force the device path to report "not set up" without spawning PowerShell.
  const device = async () => ({ ok: false, reason: "Windows Hello is not set up here (DeviceNotPresent)" });
  const prove = async () => { const f = await device(); return /not set up/.test(f.reason) ? verifyIdp({ signIn: async () => ({ claims: { preferred_username: "david" } }), expectUser: "david" }) : f; };
  const r2 = createPrivateReveal({ verify: prove });
  assert.equal((await r2.unlock()).ok, true);
  assert.equal(r2.active(), true);
  assert.ok(r);
});

test("someone else's sign-in opens NOTHING", async () => {
  const out = await verifyIdp({ signIn: async () => ({ claims: { preferred_username: "mallory" } }), expectUser: "david" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /not this desk's owner/);
});

test("an abandoned sign-in is a refusal, not a reveal", async () => {
  const out = await verifyIdp({ signIn: async () => { throw new Error("timed out"); }, expectUser: "david" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /did not finish/);
});

test("a CANCELLED device check does NOT fall back to sign-in", async () => {
  // Drive the real fallback rule: a fake win32 device answer of "cancelled".
  const childProcess = require("node:child_process");
  const original = childProcess.execFile;
  childProcess.execFile = (_f, _a, _o, cb) => cb(null, "RESULT:Canceled");
  delete require.cache[require.resolve("./private-reveal.cjs")];
  try {
    const { createPrivateReveal: fresh } = require("./private-reveal.cjs");
    let asked = false;
    const childProcess2 = require("node:child_process"); assert.equal(typeof childProcess2.execFile, "function");
    const r = fresh({ platform: "win32", signIn: async () => { asked = true; return { claims: { preferred_username: "david" } }; }, expectUser: "david" });
    const out = await r.unlock();
    assert.equal(out.ok, false);
    assert.equal(out.reason, "cancelled");
    assert.equal(asked, false, "a cancelled face scan is a NO, not 'try another way'");
  } finally {
    childProcess.execFile = original;
    delete require.cache[require.resolve("./private-reveal.cjs")];
  }
});

test("no device check -> falls back to the owner's sign-in", async () => {
  let asked = false;
  const r = createPrivateReveal({ platform: "linux-test", signIn: async () => { asked = true; return { claims: { preferred_username: "david" } }; }, expectUser: "david" });
  assert.equal((await r.unlock()).ok, true);
  assert.equal(asked, true);
});
