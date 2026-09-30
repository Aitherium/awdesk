"use strict";

/**
 * Disk Explorer + drop "share this" — the desk half of the disk index contract
 * (the disk index contract, Surfaces). Genesis is mocked: a fake
 * session-bound fetch records every request, so these tests pin the wire shape
 * (Veil /api/storage/* proxy paths, contract query names, the share body) and
 * the invariants (no approve/apply verb, failures are verdicts, not empties).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { DiskExplorerClient, awstorageWhoami, DEFAULT_MIN_BYTES, validNode, validPath } = require("./disk-explorer-client.cjs");
const { diskExplorerHandlers } = require("./disk-explorer-window.cjs");
const { routeShare } = require("./drop-router.cjs");
const { byId } = require("./command-registry.cjs");

const BASE = "https://api.aitherium.com";

function fakeFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: new URL(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = typeof reply === "function" ? reply(call) : reply;
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body ?? {},
    };
  };
  return { fetchImpl, calls };
}

test("search: Veil proxy path + the contract's query names", async () => {
  const { fetchImpl, calls } = fakeFetch({ body: { items: [{ node: "desk", path: "/a", size: 1 }], next_cursor: null } });
  const c = new DiskExplorerClient({ fetchImpl, base: BASE });
  const r = await c.search({ q: " invoice ", node: "desk", ext: ".pdf", minSize: 1024, newerDays: 7, limit: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.data.items.length, 1);
  const u = calls[0].url;
  assert.equal(u.origin, BASE);
  assert.equal(u.pathname, "/api/storage/files/search");
  assert.equal(u.searchParams.get("q"), "invoice");
  assert.equal(u.searchParams.get("node"), "desk");
  assert.equal(u.searchParams.get("ext"), "pdf");
  assert.equal(u.searchParams.get("min_bytes"), "1024");
  assert.equal(u.searchParams.has("min_size"), false);
  assert.equal(u.searchParams.get("newer_days"), "7");
  assert.equal(u.searchParams.get("limit"), "20");
});

test("search: empty query and malformed node are refused locally, no request", async () => {
  const { fetchImpl, calls } = fakeFetch({ body: {} });
  const c = new DiskExplorerClient({ fetchImpl, base: BASE });
  assert.equal((await c.search({ q: "  " })).ok, false);
  assert.equal((await c.search({ q: "x", node: "../etc" })).ok, false);
  assert.equal(calls.length, 0);
});

test("dupes and tree hit their contract paths", async () => {
  const { fetchImpl, calls } = fakeFetch({ body: { groups: [], total_wasted_bytes: 0 } });
  const c = new DiskExplorerClient({ fetchImpl, base: BASE });
  await c.dupes({ node: "desk", minBytes: 0 });
  await c.tree({ node: "desk", path: "E:/data", depth: 2 });
  await c.dupes({ node: "desk" });
  assert.equal(calls[0].url.pathname, "/api/storage/files/dupes");
  assert.equal(calls[0].url.searchParams.get("min_bytes"), "0");
  assert.equal(calls[2].url.searchParams.get("min_bytes"), String(DEFAULT_MIN_BYTES));
  assert.equal(calls[1].url.pathname, "/api/storage/files/tree");
  assert.equal(calls[1].url.searchParams.get("path"), "E:/data");
  assert.equal(calls[1].url.searchParams.get("depth"), "2");
});

test("failures are verdicts: 401 signedOut, 403 detail, network status 0 — never a rejection", async () => {
  const c401 = new DiskExplorerClient({ fetchImpl: fakeFetch({ status: 401, body: {} }).fetchImpl, base: BASE });
  const r401 = await c401.dupes();
  assert.equal(r401.ok, false);
  assert.equal(r401.signedOut, true);

  const c403 = new DiskExplorerClient({ fetchImpl: fakeFetch({ status: 403, body: { error: "not your node" } }).fetchImpl, base: BASE });
  const r403 = await c403.tree({ node: "someone-else" });
  assert.deepEqual([r403.ok, r403.status, r403.error], [false, 403, "not your node"]);

  const cNet = new DiskExplorerClient({ fetchImpl: fakeFetch(new Error("ECONNREFUSED")).fetchImpl, base: BASE });
  const rNet = await cNet.shares();
  assert.deepEqual([rNet.ok, rNet.status], [false, 0]);
  assert.match(rNet.error, /ECONNREFUSED/);
});

test("share: POSTs exactly {node, path[, seal]} and returns the proposal", async () => {
  const { fetchImpl, calls } = fakeFetch({ body: { proposal_id: 7, status: "proposed", card_id: "dc-1" } });
  const c = new DiskExplorerClient({ fetchImpl, base: BASE });
  const r = await c.share({ node: "desk", path: "E:/docs/a.pdf", seal: true, owner: "evil", tenant: "x" });
  assert.equal(r.ok, true);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.pathname, "/api/storage/share");
  assert.deepEqual(calls[0].body, { node: "desk", path: "E:/docs/a.pdf", seal: true });
  await c.share({ node: "desk", path: "/b" });
  assert.deepEqual(calls[1].body, { node: "desk", path: "/b" });
});

test("share and raiseCard validate before any request", async () => {
  const { fetchImpl, calls } = fakeFetch({ body: {} });
  const c = new DiskExplorerClient({ fetchImpl, base: BASE });
  assert.equal((await c.share({ node: "", path: "/a" })).ok, false);
  assert.equal((await c.share({ node: "desk", path: "a\0b" })).ok, false);
  assert.equal((await c.raiseCard("1; drop")).ok, false);
  assert.equal((await c.raiseCard(-3)).ok, false);
  assert.equal(calls.length, 0);
  await c.raiseCard(42);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url.pathname, "/api/storage/manage/proposals/42/card");
});

test("nodes and proposals use the caller-scoped routes", async () => {
  const { fetchImpl, calls } = fakeFetch({ body: { nodes: [], proposals: [] } });
  const c = new DiskExplorerClient({ fetchImpl, base: BASE });
  await c.nodes();
  await c.proposals({ node: "local", status: "proposed" });
  assert.equal(calls[0].url.pathname, "/api/storage/files/nodes");
  assert.equal(calls[1].url.pathname, "/api/storage/files/proposals");
  assert.equal(calls[1].url.searchParams.get("node"), "local");
});

test("awstorageWhoami: env, then ~/.aither/node-id, then hostname -- never a bare guess first", () => {
  const home = () => "/home/u";
  const noFile = () => { throw new Error("ENOENT"); };
  assert.deepEqual(awstorageWhoami({ env: { AWSTORAGE_NODE: "debian-fleet" }, readFile: noFile, homedir: home, hostname: () => "h" }),
    { node: "debian-fleet", source: "env:AWSTORAGE_NODE" });
  const fromFile = awstorageWhoami({ env: {}, readFile: () => "local\n", homedir: home, hostname: () => "h" });
  assert.equal(fromFile.node, "local");
  assert.match(fromFile.source, /^file:/);
  assert.deepEqual(awstorageWhoami({ env: {}, readFile: () => "../bad id", homedir: home, hostname: () => "h" }),
    { node: "h", source: "hostname" });
  assert.deepEqual(awstorageWhoami({ env: {}, readFile: noFile, homedir: home, hostname: () => "h" }),
    { node: "h", source: "hostname" });
});

test("the client has no approve / apply / delete verb", () => {
  const proto = Object.getOwnPropertyNames(DiskExplorerClient.prototype);
  for (const verb of proto) assert.doesNotMatch(verb, /approve|apply|delete|remove|answer/i);
  assert.ok(validNode("desk-01.local"));
  assert.ok(!validNode("a/b"));
  assert.ok(validPath("C:\\Users\\x"));
  assert.ok(!validPath(""));
});

test("handlers forward only the named fields to the client", async () => {
  const seen = {};
  const fake = {
    search: async (o) => { seen.search = o; return { ok: true, data: {} }; },
    dupes: async (o) => { seen.dupes = o; return { ok: true, data: {} }; },
    tree: async (o) => { seen.tree = o; return { ok: true, data: {} }; },
    proposals: async (o) => { seen.proposals = o; return { ok: true, data: {} }; },
    raiseCard: async (id) => { seen.raise = id; return { ok: true, data: {} }; },
    nodes: async () => ({ ok: true, data: { nodes: [{ node: "local", tenant: "platform" }] } }),
    share: async (o) => { seen.share = o; return { ok: true, data: {} }; },
    shares: async () => ({ ok: true, data: { shares: [] } }),
  };
  const h = diskExplorerHandlers(fake, { whoami: () => ({ node: "desk", source: "env:AWSTORAGE_NODE" }) });
  assert.deepEqual(await h["desk:disk-host"](), { ok: true, data: { node: "desk", source: "env:AWSTORAGE_NODE" } });
  assert.equal((await h["desk:disk-nodes"]()).data.nodes[0].tenant, "platform");
  await h["desk:disk-share"](null, { node: "desk", path: "/a", seal: "yes", tenant: "other" });
  assert.deepEqual(seen.share, { node: "desk", path: "/a", seal: false });
  await h["desk:disk-search"](null, { q: "x", owner_id: "u2" });
  assert.equal("owner_id" in seen.search, false);
  await h["desk:disk-tree"](null, "not-an-object");
  assert.deepEqual(seen.tree, { node: undefined, path: undefined, depth: undefined });
  await h["desk:disk-raise-card"](null, 9);
  assert.equal(seen.raise, 9);
  assert.equal(Object.keys(h).some((k) => /approve|apply|answer/.test(k)), false);
});

test("routeShare: proposes a share of the ORIGINAL path from this node", async () => {
  let body = null;
  const v = await routeShare({ filePath: "E:/docs/report.pdf" }, {
    stat: () => ({ size: 10 }),
    node: "desk",
    share: async (b) => { body = b; return { ok: true, data: { proposal_id: 3, card_id: "dc-3" } }; },
  });
  assert.deepEqual(body, { node: "desk", path: "E:/docs/report.pdf", seal: false });
  assert.equal(v.ok, true);
  assert.equal(v.kind, "share");
  assert.equal(v.name, "report.pdf");
  assert.match(v.summary, /#3/);
  assert.match(v.summary, /decision card/);
});

test("routeShare: with no node given it uses awstorage whoami, not a bare hostname", async () => {
  const prev = process.env.AWSTORAGE_NODE;
  process.env.AWSTORAGE_NODE = "debian-fleet";
  try {
    let body = null;
    await routeShare({ filePath: "/x" }, { stat: () => ({}), share: async (b) => { body = b; return { ok: true, data: { proposal_id: 1 } }; } });
    assert.equal(body.node, "debian-fleet");
  } finally {
    if (prev === undefined) delete process.env.AWSTORAGE_NODE; else process.env.AWSTORAGE_NODE = prev;
  }
});

test("routeShare: failures are verdicts (moved file, signed out, no client)", async () => {
  const moved = await routeShare({ filePath: "/gone" }, { stat: () => { throw new Error("ENOENT"); }, share: async () => ({ ok: true }) });
  assert.equal(moved.ok, false);
  const out = await routeShare({ filePath: "/a" }, { stat: () => ({}), node: "desk", share: async () => ({ ok: false, signedOut: true }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /sign in/);
  const none = await routeShare({ filePath: "/a" }, { stat: () => ({}) });
  assert.equal(none.ok, false);
  assert.equal((await routeShare({ filePath: "" })).ok, false);
});

test("the page talks only to the bridge and never builds HTML from data", () => {
  const html = fs.readFileSync(path.join(__dirname, "disk-explorer.html"), "utf8");
  assert.match(html, /window\.diskExplorer/);
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(html, /fetch\(/, "the page must go through the bridge");
  assert.doesNotMatch(html, /api\.(approve|apply|answer|delete)/i, "the page grew an approve/apply verb");
  for (const tab of ["tree", "search", "dupes", "proposals", "shares"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
  }
  // A5/A7: three empty states, actionable bytes as the reclaimable figure, manage
  // buttons only on platform nodes, nodes picked from /files/nodes.
  assert.match(html, /awstorage files scan --all-volumes && awstorage push/);
  assert.match(html, /actionable_bytes/);
  assert.match(html, /function manageable\(/);
  assert.match(html, /api\.nodes\(\)/);
});

test("disk.open is a registry command main answers", () => {
  const cmd = byId("disk.open");
  assert.ok(cmd, "disk.open missing from the registry");
  assert.ok(cmd.surfaces.includes("palette") && cmd.surfaces.includes("tray"));
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /case "disk\.open":/);
  assert.match(main, /ipcMain\.handle\("desk:file-share"/);
  const preload = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  assert.match(preload, /fileShare:/);
});
