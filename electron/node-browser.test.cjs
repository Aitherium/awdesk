"use strict";

// The Strata page's node browser: node-browser-client.cjs (gateway storage_files_*),
// the plane-window IPC verbs, and plane-page.js's pure view rendered from a fixture.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPage() {
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "plane-page.js"), "utf8"), sandbox);
  return sandbox.module.exports;
}
const page = loadPage();
const NOW = Date.parse("2026-11-07T12:00:00Z");

const INVENTORY_TREE = {
  node: "box-7", path: "D:/data", source: "inventory",
  children: [
    { name: "models", kind: "dir", bytes: 3 * 1024 ** 3, files: 12, newest_mtime: NOW / 1000 - 7200 },
    { name: "notes.txt", kind: "file", bytes: 2048, files: 1, newest_mtime: NOW / 1000 - 60 },
  ],
  truncated: false, next_cursor: null, stale: false,
  indexed_roots: [{ node: "box-7", root: "D:/data", scanned_at: "2026-11-07T09:00:00Z" }],
  genesis_error: "Genesis HTTP 404: not found",
  inventory: { node: "box-7", release: "box-7-20261107T100000Z", published_at: "2026-11-07T10:00:00Z",
    verified_at: "2026-11-07T11:57:00Z" },
};

/** Every text in a view tree, depth first. */
function texts(v, out = []) {
  if (v.text) out.push(v.text);
  for (const c of v.children || []) texts(c, out);
  return out;
}
function find(v, pred, out = []) {
  if (pred(v)) out.push(v);
  for (const c of v.children || []) find(c, pred, out);
  return out;
}

test("nodeBrowserView renders a folder from an inventory fixture with its source and freshness", () => {
  const view = page.nodeBrowserView({ nodes: [{ node: "box-7", source: "inventory", inventory: { verified: true } }],
    node: "box-7", stack: ["", "D:/data"], answer: INVENTORY_TREE }, NOW);
  const all = texts(view).join("\n");
  assert.match(all, /▸ models/);
  assert.match(all, /3\.0 GiB/);
  assert.match(all, /notes\.txt/);
  assert.match(all, /Signed inventory box-7-20261107T100000Z · published 2 h ago · signature verified 3 min ago/);
  assert.match(all, /Genesis did not answer: Genesis HTTP 404/);
  const pill = find(view, (v) => /\bpill\b/.test(v.cls))[0];
  assert.equal(pill.text, "inventory");
  const opens = find(view, (v) => v.action && v.action.type === "open");
  assert.deepEqual(opens.map((v) => v.action.path), ["D:/data/models"], "only folders drill down");
  const crumbs = find(view, (v) => v.action && v.action.type === "crumb");
  assert.equal(crumbs.length, 1, "every level above the current one is a way back");
});

test("a Genesis answer is labelled genesis and a stale index says so", () => {
  const m = page.nodeTreeModel({ node: "fleet", path: "", source: "genesis", stale: true,
    children: [{ name: "C:/", kind: "root", bytes: 10, files: 1 }],
    indexed_roots: [{ node: "fleet", root: "C:/", scanned_at: "2026-11-01T12:00:00Z", last_push_at: null }] }, NOW);
  assert.equal(m.source.pill, "genesis");
  assert.equal(m.source.tone, "warn");
  assert.match(m.source.lines[0], /updated 6 d ago · STALE/);
  assert.equal(m.rows[0].path, "C:/", "a root is already a full path");
  assert.equal(m.rows[0].open, true);
  assert.equal(page.childPath("C:/", "Users"), "C:/Users");
  assert.equal(page.childPath("/home/a", "b"), "/home/a/b");
});

test("a failed folder read shows its error, never an empty folder", () => {
  const all = texts(page.nodeBrowserView({ nodes: [], node: "box-7", stack: [""], error: "inventory: REFUSED" }, NOW)).join("\n");
  assert.match(all, /Could not read this folder: inventory: REFUSED/);
  assert.doesNotMatch(all, /Empty/);
});

test("node-browser-client calls the two gateway tools and normalises nodes", async () => {
  const { createNodeBrowserClient } = require("./node-browser-client.cjs");
  const calls = [];
  const client = createNodeBrowserClient({ callTool: async (name, args) => {
    calls.push([name, args]);
    if (name === "storage_files_nodes") {
      return JSON.stringify({ nodes: [
        { node: "fleet", source: "genesis", roots: [{ bytes: 5, scanned_at: "2026-11-07T01:00:00Z" }], stale: false },
        { node: "laptop", source: "inventory", release: "laptop-20261101T120000Z", published_at: "2026-11-01T12:00:00Z",
          verified: false },
      ], count: 2, genesis_error: null });
    }
    return JSON.stringify(INVENTORY_TREE);
  } });
  const n = await client.nodes();
  assert.deepEqual(n.nodes.map((r) => [r.node, r.source]), [["fleet", "genesis"], ["laptop", "inventory"]]);
  assert.equal(n.nodes[0].bytes, 5);
  assert.equal(n.nodes[1].inventory.verified, false);
  const t = await client.tree("box-7", "D:/data");
  assert.equal(t.source, "inventory");
  assert.deepEqual(calls[1], ["storage_files_tree", { node: "box-7", path: "D:/data", depth: 1, limit: 200 }]);
  await assert.rejects(client.tree("../etc"), /not a node id/);
  assert.equal(calls.length, 2, "a bad node id never reaches the gateway");
});

test("a refused or failed tree read is an error, not an empty answer", async () => {
  const { createNodeBrowserClient } = require("./node-browser-client.cjs");
  const client = createNodeBrowserClient({ callTool: async () => JSON.stringify({ error: "Genesis did not answer",
    source: "none", inventory_error: "REFUSED: box-7 FAILED verification" }) });
  await assert.rejects(client.tree("box-7"), /REFUSED: box-7 FAILED verification/);
});

test("plane-window exposes the node browser verbs and never throws across the bridge", async () => {
  const { planeHandlers } = require("./plane-window.cjs");
  const browser = { nodes: async () => ({ nodes: [] }), tree: async (n, p) => { if (n === "x") throw new Error("boom"); return { node: n, path: p }; } };
  const h = planeHandlers({ planes: () => [], snapshot: async () => ({}) }, browser);
  assert.deepEqual(await h["desk:plane-files-nodes"](), { ok: true, data: { nodes: [] } });
  assert.deepEqual(await h["desk:plane-files-tree"]({}, "box-7", "D:/"), { ok: true, data: { node: "box-7", path: "D:/" } });
  assert.deepEqual(await h["desk:plane-files-tree"]({}, "x", ""), { ok: false, error: "boom" });
});
