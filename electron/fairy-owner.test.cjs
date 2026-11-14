"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FILE = path.join(os.tmpdir(), `fairy-owner-test-${process.pid}.json`);
process.env.DESK_FAIRY_OWNER_FILE = FILE;
const owner = require("./fairy-owner.cjs");

test.afterEach(() => fs.rmSync(FILE, { force: true }));

test("one fairy cluster per machine: a second live desk is refused, a dead one is taken over", () => {
  assert.deepEqual(owner.claim({ pid: 100, isAlive: () => true }), { ok: true, pid: 100 }, "first desk claims");
  assert.deepEqual(owner.claim({ pid: 200, isAlive: () => true }), { ok: false, pid: 100 }, "second live desk refused");
  assert.deepEqual(owner.claim({ pid: 100, isAlive: () => true }), { ok: true, pid: 100 }, "the owner again: fine");
  assert.deepEqual(owner.claim({ pid: 200, isAlive: () => false }), { ok: true, pid: 200 }, "a dead owner is taken over");
  assert.equal(owner.release({ pid: 100 }), false, "only the holder releases");
  assert.equal(owner.release({ pid: 200 }), true);
  assert.equal(fs.existsSync(FILE), false);
});

test("a claim from before this boot never blocks (Windows skips before-quit at logoff; pids are reused)", () => {
  fs.writeFileSync(FILE, JSON.stringify({ pid: 100, at: "2020-01-01T00:00:00Z" }));
  assert.deepEqual(owner.claim({ pid: 200, isAlive: () => true }), { ok: true, pid: 200 }, "pre-boot claim is stale");
  fs.writeFileSync(FILE, "{half");
  assert.deepEqual(owner.claim({ pid: 300, isAlive: () => true }), { ok: true, pid: 300 }, "a torn file is no owner");
});

test("alive(): this process runs, nonsense pids do not", () => {
  assert.equal(owner.alive(process.pid), true);
  assert.equal(owner.alive(0), false);
  assert.equal(owner.alive("x"), false);
});

test("the fairy asks for the claim before it shows, and lets go on quit", () => {
  const src = fs.readFileSync(path.join(__dirname, "orb-window.cjs"), "utf8");
  assert.match(src, /function showOrb\(\) \{\n[\s\S]{0,400}fairyOwner\.claim\(\)/);
  assert.match(src, /function stopOrb\(\) \{\n {2}quitting = true;\n {2}fairyOwner\.release\(\);/);
});
