"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseList, createBrickCatalog } = require("./brick-catalog.cjs");
const { bricksHandlers, fromBricksPage } = require("./bricks-window.cjs");

const SAMPLE = [
  "GUIDES (2)", "    guide                The Aither World Guide", "    guide-00             Welcome", "",
  "BRICKS (2)", "    awwall               Fail-closed egress allowlist", "    \u001b[1mawtunnel\u001b[0m             Validate cloudflared ingress", "",
].join("\n");

test("awkno's list becomes sections of {name, summary}, colour codes stripped", () => {
  const rows = parseList(SAMPLE);
  assert.deepEqual(rows.map((r) => [r.section, r.name]), [["guides", "guide"], ["guides", "guide-00"], ["bricks", "awwall"], ["bricks", "awtunnel"]]);
  assert.equal(rows[2].summary, "Fail-closed egress allowlist");
});

test("a brick page runs awkno with the name as an argument; a bad name never spawns", async () => {
  const calls = [];
  const c = createBrickCatalog({ execFile: (cmd, args, _o, cb) => { calls.push([cmd, ...args]); cb(null, "AWWALL(1)\nman page", ""); } });
  assert.equal((await c.page("awwall")).text, "AWWALL(1)\nman page");
  assert.deepEqual(calls[0], ["awkno", "--plain", "awwall"]);
  assert.equal((await c.page("--help")).ok, false);
  assert.equal((await c.page("a; rm")).ok, false);
  assert.equal(calls.length, 1);
});

test("only aither://bricks reaches the catalog channels", async () => {
  assert.equal(fromBricksPage({ getURL: () => "aither://bricks/" }), true);
  let touched = 0;
  const c = { list: async () => { touched++; return { ok: true }; }, page: async () => { touched++; return { ok: true }; } };
  for (const h of Object.values(bricksHandlers(c))) assert.equal((await h({ sender: { getURL: () => "https://x.test/" } }, "awwall")).ok, false);
  assert.equal(touched, 0);
});

test("awpack: list parsed, fixed verbs only, the id validated before any spawn", async () => {
  const calls = [];
  const c = createBrickCatalog({ execFile: (cmd, args, _o, cb) => { calls.push([cmd, ...args]);
    cb(null, JSON.stringify({ ok: true, op: args[0], packs: [{ id: "persona", version: "0.1.0", status: "preview", summary: "s" }] }), ""); } });
  const r = await c.packs();
  assert.deepEqual(r.packs.map((p) => p.id), ["persona"]);
  assert.deepEqual(calls[0], ["awpack", "list", "--json"]);
  assert.equal((await c.packAct("install", "persona")).ok, true);
  assert.deepEqual(calls[1], ["awpack", "install", "persona", "--json"]);
  assert.equal((await c.packAct("exec", "persona")).ok, false);
  assert.equal((await c.packAct("install", "--dest")).ok, false);
  assert.equal(calls.length, 2);
});
