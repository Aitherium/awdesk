"use strict";

/** assist-pairing: the per-install bearer, the user-confirmed pairing, and the 401 for a forged Origin. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createAssistPairing, bearerFrom } = require("./assist-pairing.cjs");
const { createBridgeServer } = require("./bridge-server.cjs");
const { createAssistFiles, checkPath } = require("./assist-files.cjs");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "assist-pair-")); }

function rig({ allow = true, platform = "win32", icacls = "ok", clock } = {}) {
  const dir = tmp();
  const acl = [];
  let t = 1000000;
  const asked = [];
  const p = createAssistPairing({
    dir, platform, env: { USERNAME: "me", USERDOMAIN: "PC", SystemRoot: "C:\\Windows" },
    execFile: (exe, args, opts, cb) => { acl.push([exe, args]); cb(icacls === "ok" ? null : new Error("access denied")); },
    confirm: async (req) => { asked.push(req); return typeof allow === "function" ? allow(req) : allow; },
    now: clock || (() => t),
  });
  return { p, dir, acl, asked, tick: (ms) => { t += ms; } };
}
const settle = () => new Promise((r) => setTimeout(r, 15));

test("nothing is paired at first: every bearer, even a plausible one, is refused", () => {
  const { p } = rig();
  assert.equal(p.isPaired(), false);
  assert.equal(p.verify("Bearer " + "a".repeat(43)), false);
  assert.equal(p.verify(""), false);
  assert.equal(p.verify(undefined), false);
});

test("pairing: start -> the owner sees the code and allows -> finish hands the token over exactly once", async () => {
  const r = rig();
  const s = r.p.start("chrome-extension://abc");
  assert.ok(s.ok && /^\d{6}$/.test(s.code) && s.id);
  assert.equal(r.asked[0].code, s.code, "the native dialog shows the SAME code the extension is told to show");
  assert.deepEqual(r.p.finish(s.id), { ok: false, pending: true }, "waiting for the owner's click");
  await settle();
  const done = r.p.finish(s.id);
  assert.ok(done.ok && done.token && done.token.length >= 40);
  assert.equal(r.p.finish(s.id).ok, false, "the secret leaves once");
  assert.equal(r.p.verify(`Bearer ${done.token}`), true);
  assert.equal(r.p.verify(`Bearer ${done.token}x`), false);
  assert.equal(r.p.verify(done.token), false, "must be a Bearer header");
});

test("denied or dismissed: no secret is ever minted", async () => {
  const r = rig({ allow: false });
  const s = r.p.start("chrome-extension://abc");
  await settle();
  const f = r.p.finish(s.id);
  assert.equal(f.ok, false);
  assert.equal(f.denied, true);
  assert.equal(r.p.isPaired(), false);
  assert.equal(fs.existsSync(r.p.file), false);
});

test("a wrong pairing id cannot collect the token, and cannot even learn the state", async () => {
  const r = rig();
  const s = r.p.start("chrome-extension://abc");
  await settle();
  const f = r.p.finish("0".repeat(24));
  assert.equal(f.ok, false);
  assert.equal(f.status, 404);
  assert.equal(r.p.finish(s.id).ok, true, "the real holder still gets it");
});

test("the pairing file is locked to the current user (icacls: inheritance off, only this user); a failed ACL means NO secret", async () => {
  const r = rig();
  const s = r.p.start("chrome-extension://abc");
  await settle();
  r.p.finish(s.id);
  assert.equal(r.acl.length, 1);
  assert.match(r.acl[0][0], /icacls\.exe$/i);
  assert.deepEqual(r.acl[0][1].slice(1), ["/inheritance:r", "/grant:r", "PC\\me:(F)"]);
  const bad = rig({ icacls: "fail" });
  const s2 = bad.p.start("chrome-extension://abc");
  await settle();
  const f = bad.p.finish(s2.id);
  assert.equal(f.ok, false);
  assert.match(f.error, /could not restrict/);
  assert.equal(bad.p.isPaired(), false);
  assert.equal(fs.existsSync(bad.p.file), false, "a secret on an unprotected file is deleted, not used");
});

test("re-pairing ROTATES the secret: the old browser is revoked", async () => {
  const r = rig();
  const a = r.p.start("chrome-extension://abc"); await settle();
  const t1 = r.p.finish(a.id).token;
  r.tick(60000);
  const b = r.p.start("chrome-extension://abc"); await settle();
  const t2 = r.p.finish(b.id).token;
  assert.notEqual(t1, t2);
  assert.equal(r.p.verify(`Bearer ${t1}`), false);
  assert.equal(r.p.verify(`Bearer ${t2}`), true);
});

test("a process cannot bury the owner in dialogs: one pending, one start per 20 s", () => {
  const r = rig({ allow: () => new Promise(() => {}) });
  assert.ok(r.p.start("o").ok);
  assert.equal(r.p.start("o").status, 429);
  assert.equal(r.asked.length, 1);
  r.tick(130000);
  assert.ok(r.p.start("o").ok, "after the window it may ask again");
});

test("a paired secret survives a desk restart (read back from the user-only file)", async () => {
  const r = rig();
  const s = r.p.start("o"); await settle();
  const token = r.p.finish(s.id).token;
  const again = createAssistPairing({ dir: r.dir, platform: "win32", execFile: (a, b, c, cb) => cb(null) });
  assert.equal(again.verify(`Bearer ${token}`), true);
});

test("bearerFrom accepts only a well-formed Bearer token", () => {
  assert.equal(bearerFrom("Bearer " + "A".repeat(43)), "A".repeat(43));
  for (const bad of ["", "Basic abc", "Bearer short", "Bearer a b", "bearer", undefined]) assert.equal(bearerFrom(bad), "");
});

// ---- the bridge: a forged Origin without the bearer gets 401 -------------------------------

const EXT = "chrome-extension://hlmfknhcfhjjngckfpacgleffckpmphe";
function post(address, route, { origin = EXT, bearer, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: address.port, path: route, method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("a forged extension Origin WITHOUT the bearer is 401 on every /assist route, and never reaches the handler", async (context) => {
  const r = rig();
  const s = r.p.start(EXT); await settle();
  const token = r.p.finish(s.id).token;
  const seen = [];
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, onEvent: () => {}, assistHandler: async ({ route }) => { seen.push(route); return { ok: true, route }; }, assistAuth: (h) => r.p.verify(h) });
  context.after(() => bridge.close());
  const address = await bridge.listen();
  for (const route of ["suggest", "refine", "run", "route", "note"]) {
    const none = await post(address, `/assist/${route}`);
    assert.equal(none.status, 401, `${route} with no bearer`);
    assert.equal(JSON.parse(none.body).pair, true);
    assert.equal((await post(address, `/assist/${route}`, { bearer: "A".repeat(43) })).status, 401, `${route} with a wrong bearer`);
    assert.equal((await post(address, `/assist/${route}`, { bearer: token })).status, 200, `${route} with the paired bearer`);
  }
  assert.equal((await post(address, "/assist/run", { origin: "https://evil.example", bearer: token })).status, 403, "the bearer does not replace the origin check");
  assert.equal((await post(address, "/assist/run", { origin: null, bearer: token })).status, 403);
  assert.deepEqual(seen, ["suggest", "refine", "run", "route", "note"], "only the paired calls reached the handler");
});

test("a desk with NO verifier fails closed: 401 even for the right origin; the pairing steps need only the origin", async (context) => {
  const seen = [];
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, onEvent: () => {}, assistHandler: async ({ route, origin }) => { seen.push([route, origin]); return { ok: true }; } });
  context.after(() => bridge.close());
  const address = await bridge.listen();
  assert.equal((await post(address, "/assist/run", { bearer: "A".repeat(43) })).status, 401);
  assert.equal((await post(address, "/assist/pair/start")).status, 200);
  assert.equal((await post(address, "/assist/pair/finish", { body: { id: "x" } })).status, 200);
  assert.equal((await post(address, "/assist/pair/start", { origin: "https://evil.example" })).status, 403);
  assert.deepEqual(seen.map((x) => x[0]), ["pair/start", "pair/finish"]);
  assert.equal(seen[0][1], EXT, "the handler is told which origin asked");
});

// ---- the drive-root --arg fix ---------------------------------------------------------------

test("drive root: the shell sentinel `\\.` is stripped, so D:\\ opens; a folder and a file keep working", () => {
  const ex = (p) => ["D:\\", "C:\\Users\\me", "C:\\Users\\me\\a b.txt"].includes(p);
  assert.deepEqual(checkPath("D:\\\\.", ex), { ok: true, path: "D:\\" });
  assert.equal(checkPath("C:\\Users\\me\\.", ex).path, "C:\\Users\\me");
  assert.equal(checkPath("C:\\Users\\me\\a b.txt\\.", ex).path, "C:\\Users\\me\\a b.txt");
  assert.equal(checkPath("C:\\Users\\me", ex).ok, true, "no sentinel still works");
  assert.equal(checkPath("C:\\Windows\\\\.", () => true).ok, false, "the jail still applies after stripping");
  assert.equal(typeof createAssistFiles, "function");
});

test("the launch command quotes the argument so a drive root cannot swallow the command line", () => {
  const sm = require("./shell-menu.cjs");
  const cmd = sm.launchCommand({ exe: "C:\\Desk\\Aither.exe", id: "assist.file.summarize", arg: true });
  assert.ok(cmd.endsWith('--arg="%1\\."'));
  const expanded = cmd.replace("%1", "D:\\");
  assert.match(expanded, /--arg="D:\\\\\."$/, "no backslash sits directly before the closing quote");
});
