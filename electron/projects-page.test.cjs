"use strict";

/**
 * aither://projects, run against a paper DOM (the cast-page.test.cjs technique).
 *
 * Owner screenshot 2026-11-16: the C:\AitherOS-Fresh card sat on a bare "reading..." while
 * `awgit state` counted 1,264 changed files, and showed "develop - 1264 changed" only once
 * that walk finished. The card must show the LAST result at once, say how old it is,
 * refresh behind it, and keep it on screen when the refresh fails.
 *
 *   node --test electron/projects-page.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT = fs.readFileSync(path.join(__dirname, "projects-page.js"), "utf8");

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = "";
    this.value = "";
    this._text = "";
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...kids) { for (const k of kids) this.children.push(k); }
  walk() { return [this, ...this.children.flatMap((c) => (c.walk ? c.walk() : []))]; }
}

function page(api) {
  const ids = {};
  for (const id of ["status", "list", "form", "dir", "refresh"]) ids[id] = new Node("div");
  const document = {
    getElementById: (id) => ids[id],
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  vm.runInNewContext(SCRIPT, { window: { aitherProjects: api }, document, console });
  const chips = () => ids.list.walk().filter((n) => /\bchip\b/.test(n.className)).map((n) => n.textContent);
  return { ids, chips };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const DIR = "C:\\AitherOS-Fresh";
const LAST = { ok: true, cached: true, dir: DIR, branch: "develop", dirty: 1264, ahead: 0, behind: 0, pr: null, ageMs: 180_000 };

test("the last result shows at once, aged, while the fresh read runs; never a bare reading...", async () => {
  const fresh = deferred();
  const { chips } = page({
    list: async () => ({ ok: true, projects: [{ dir: DIR, name: "AitherOS-Fresh", pinned: false }] }),
    cached: async () => LAST,
    state: () => fresh.promise,
  });
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(chips(), ["develop", "1264 changed", "as of 3 min ago · refreshing…"]);
  assert.ok(!chips().some((c) => /reading/i.test(c)));
  fresh.resolve({ ...LAST, cached: undefined, ageMs: undefined, dirty: 1270 });
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(chips(), ["develop", "1270 changed"], "the fresh read replaces it, no age note");
});

test("a repo never read shows its branch from HEAD and what is still being counted", async () => {
  const { chips } = page({
    list: async () => ({ ok: true, projects: [{ dir: DIR, name: "AitherOS-Fresh", pinned: false }] }),
    cached: async () => ({ ok: true, partial: true, dir: DIR, branch: "develop", detached: false }),
    state: () => new Promise(() => {}),
  });
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(chips(), ["develop", "counting changes…"]);
});

test("a refresh that times out keeps the last result on screen and says why", async () => {
  const { chips } = page({
    list: async () => ({ ok: true, projects: [{ dir: DIR, name: "AitherOS-Fresh", pinned: false }] }),
    cached: async () => LAST,
    state: async () => ({ ok: false, timedOut: true, error: "git status took longer than 20 s", last: LAST }),
  });
  for (let i = 0; i < 6; i++) await flush();
  assert.deepEqual(chips(), ["develop", "1264 changed", "git status took longer than 20 s · showing 3 min ago"]);
});

test("an older main without `cached` still renders the fresh read", async () => {
  const { chips } = page({
    list: async () => ({ ok: true, projects: [{ dir: DIR, name: "AitherOS-Fresh", pinned: false }] }),
    state: async () => ({ ...LAST, cached: undefined, dirty: 0 }),
  });
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(chips(), ["develop", "clean"]);
});
