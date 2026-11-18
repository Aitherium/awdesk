"use strict";
// The WSL address lookup must never block the main thread: a synchronous `wsl`
// call froze the whole desk for up to 15 s inside every WSL wedge (2026-11-18).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const dr = require("./drop-router.cjs");

test("drop-router never calls wsl synchronously", () => {
  const src = fs.readFileSync(path.join(__dirname, "drop-router.cjs"), "utf8");
  assert.doesNotMatch(src, /execFileSync\(\s*"wsl"/);
  assert.match(src, /const alt = await wslHost\(\)/);
});

test("wslHost returns a promise immediately and resolves the address", async () => {
  dr._resetWslHost();
  let cb;
  const p = dr.wslHost({ execFile: (_f, _a, _o, done) => { cb = done; } });
  assert.ok(p instanceof Promise);
  cb(null, "172.20.1.5 10.89.0.1\n");
  assert.equal(await p, "172.20.1.5");
  assert.equal(await dr.wslHost({ execFile: () => { throw new Error("cached, not called"); } }), "172.20.1.5");
});

test("a wedged distro resolves null and is retried next time", async () => {
  dr._resetWslHost();
  assert.equal(await dr.wslHost({ execFile: (_f, _a, _o, done) => done(new Error("timeout")) }), null);
  let calls = 0;
  const p = dr.wslHost({ execFile: (_f, _a, _o, done) => { calls++; done(null, "172.20.1.9"); } });
  assert.equal(await p, "172.20.1.9");
  assert.equal(calls, 1);
});

test("concurrent callers share one lookup", async () => {
  dr._resetWslHost();
  let calls = 0; let cb;
  const exec = (_f, _a, _o, done) => { calls++; cb = done; };
  const a = dr.wslHost({ execFile: exec }); const b = dr.wslHost({ execFile: exec });
  cb(null, "172.20.1.7");
  assert.deepEqual(await Promise.all([a, b]), ["172.20.1.7", "172.20.1.7"]);
  assert.equal(calls, 1);
});
