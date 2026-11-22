"use strict";

// The Wiki tab's two sources: a folder of markdown read offline (fenced, bounded) and
// LyraWiki through the gateway (up, down, slow, malformed).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWikiFolders, createWikiPlatform, defaultRoots, slugKey, splitFrontmatter, withIds } = require("./explore-wiki.cjs");

/** A LyraWiki-shaped project plus a file OUTSIDE it that no slug may ever reach. */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "explore-wiki-"));
  const root = path.join(base, "project");
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write("index.md", "# Index\n\n- [[agent-loop]] — how an agent runs\n- [[memory]]\n");
  write("wiki/concepts/agent-loop.md", "---\ntitle: Agent Loop\ntype: concept\nconfidence: 0.90\n---\n# Agent Loop\n\nThe loop reads [[memory]] and calls [tools](../entities/tools.md).\nSee https://example.com/loop.\n");
  write("wiki/concepts/memory.md", "---\ntitle: Memory\ntype: concept\n---\nMemory feeds the [[agent-loop]]. It is not [[unwritten-page]].\n");
  write("wiki/entities/tools.md", "# Tools\n\nTools are called by the [[Agent Loop]].\n");
  write("raw/source_1.md", "# Raw source\n\nNot a wiki page.\n");
  write("wiki/.hidden/secret.md", "# hidden\n");
  fs.writeFileSync(path.join(base, "outside.md"), "# OUTSIDE\n\nthe secret outside the root\n");
  return { base, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function folders(root, extra = {}) {
  const roots = withIds([{ dir: root, label: "Fixture" }]);
  return { wiki: createWikiFolders({ roots: () => roots, cacheMs: 0, ...extra }), id: roots[0].id };
}

test("frontmatter and slug keys", () => {
  assert.deepEqual(splitFrontmatter("---\ntitle: \"A B\"\ntype: concept\n---\nbody"), { meta: { title: "A B", type: "concept" }, body: "body" });
  assert.deepEqual(splitFrontmatter("no front matter"), { meta: {}, body: "no front matter" });
  assert.equal(slugKey("Agent Loop"), "agent-loop");
  assert.equal(slugKey("../../etc/passwd"), "etc-passwd");
});

test("offline: lists the pages of a LyraWiki project (raw/ and dot folders are not pages)", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { wiki, id } = folders(fx.root);
  const r = wiki.list(id);
  assert.equal(r.ok, true);
  assert.equal(r.source, "folder");
  assert.deepEqual(r.pages.map((p) => p.slug).sort(), ["agent-loop", "index", "memory", "tools"]);
  assert.equal(r.pages.find((p) => p.slug === "agent-loop").title, "Agent Loop");
  assert.equal(r.pages.find((p) => p.slug === "agent-loop").type, "concept");
  assert.equal(r.pages.find((p) => p.slug === "tools").title, "Tools");
});

test("offline: read renders the page, resolves its links and finds its backlinks", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { wiki, id } = folders(fx.root);
  const r = wiki.read(id, "agent-loop");
  assert.equal(r.ok, true);
  assert.match(r.page.html, /<h1>Agent Loop<\/h1>/);
  assert.match(r.page.html, /data-wiki="memory"/);
  assert.equal(/href=|src=/.test(r.page.html), false);
  assert.deepEqual(r.page.links.map((l) => [l.slug, l.exists]), [["memory", true], ["tools", true]]);
  assert.deepEqual(r.page.external, ["https://example.com/loop"]);
  assert.deepEqual(r.page.backlinks.map((b) => b.slug).sort(), ["index", "memory", "tools"]);
  assert.equal(r.page.meta.confidence, "0.90");
  // A [[Title Case]] link and a path-shaped slug both resolve to the same page.
  assert.equal(wiki.read(id, "Agent Loop").page.slug, "agent-loop");
  assert.equal(wiki.read(id, "concepts/agent-loop.md").page.slug, "agent-loop");
  // A link to a page nobody wrote is reported missing, not an error state.
  const mem = wiki.read(id, "memory");
  assert.deepEqual(mem.page.links.find((l) => l.slug === "unwritten-page"), { slug: "unwritten-page", title: "unwritten-page", exists: false });
  assert.equal(wiki.read(id, "unwritten-page").missing, true);
});

test("offline: traversal attempts never leave the root", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { wiki, id } = folders(fx.root);
  const outside = path.join(fx.base, "outside.md");
  for (const attempt of ["../outside", "../outside.md", "..\\outside.md", "../../outside", "/outside.md", outside, outside.replace(/\\/g, "/"),
    "wiki/../../outside.md", "%2e%2e/outside", "....//outside", "outside\u0000.md", "C:outside.md", "file:///" + outside.replace(/\\/g, "/"),
    "raw/source_1", "source_1", ".hidden/secret", "secret"]) {
    const r = wiki.read(id, attempt);
    assert.equal(r.ok, false, `read(${JSON.stringify(attempt)}) must be refused`);
    assert.equal(JSON.stringify(r).includes("secret outside the root"), false);
    assert.equal(wiki.graph(id, { around: attempt }).ok, false);
  }
  // An unknown or malformed source id reads nothing at all.
  for (const badRoot of ["", "..", "../fixture", "nope", fx.base, "FIXTURE "]) {
    assert.equal(wiki.list(badRoot).ok, false);
    assert.equal(wiki.read(badRoot, "agent-loop").ok, false);
    assert.equal(wiki.search(badRoot, "loop").ok, false);
  }
  const everything = JSON.stringify([wiki.list(id), wiki.search(id, "secret"), wiki.graph(id)]);
  assert.equal(everything.includes("OUTSIDE"), false);
});

test("offline: a symlink or junction that points out of the root is not a page", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const elsewhere = path.join(fx.base, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "leaked.md"), "# LEAKED\n");
  try {
    fs.symlinkSync(elsewhere, path.join(fx.root, "wiki", "linked"), "junction");
  } catch {
    t.skip("this host cannot create a junction / symlink");
    return;
  }
  const { wiki, id } = folders(fx.root);
  assert.equal(wiki.list(id).pages.some((p) => p.slug === "leaked"), false);
  assert.equal(wiki.read(id, "leaked").ok, false);
});

test("offline: search ranks a title hit first and carries a snippet", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { wiki, id } = folders(fx.root);
  const r = wiki.search(id, "memory");
  assert.equal(r.ok, true);
  assert.equal(r.results[0].slug, "memory");
  assert.ok(r.results.some((p) => p.slug === "agent-loop"));
  assert.ok(r.results[0].snippet.length > 0);
  assert.equal(wiki.search(id, "zebra").total, 0);
  assert.equal(wiki.search(id, "   ").ok, false);
});

test("offline: the link graph has a node per page and an edge per resolved link", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { wiki, id } = folders(fx.root);
  const all = wiki.graph(id);
  assert.equal(all.ok, true);
  assert.deepEqual(all.nodes.map((n) => n.id).sort(), ["agent-loop", "index", "memory", "tools"]);
  const has = (a, b) => all.edges.some((e) => e.source === a && e.target === b);
  assert.ok(has("agent-loop", "memory") && has("memory", "agent-loop") && has("tools", "agent-loop") && has("index", "agent-loop"));
  assert.equal(all.edges.some((e) => e.target === "unwritten-page"), false);
  const near = wiki.graph(id, { around: "tools" });
  assert.deepEqual(near.nodes.map((n) => n.id).sort(), ["agent-loop", "tools"]);
});

test("offline: bounds are enforced and reported", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { wiki, id } = folders(fx.root, { limits: { maxFiles: 2, maxPageBytes: 20 } });
  const r = wiki.list(id);
  assert.equal(r.pages.length, 2);
  assert.equal(r.truncated, true);
  assert.match(r.note, /stopped at 2 pages/);
  const page = wiki.read(id, r.pages[0].slug);
  assert.equal(page.page.truncated, true);
  // A folder that vanished is a stated failure, never an empty wiki.
  const gone = folders(path.join(fx.base, "missing"));
  const answer = gone.wiki.list(gone.id);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /not readable/);
});

test("offline: an awbrain brain (wiki/<slug>.md with id/source/span frontmatter) reads the same way", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "explore-brain-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "wiki"));
  fs.writeFileSync(path.join(base, "wiki", "pool-decision-1.md"), "---\nid: c1\nsource: notes/pool.md\nspan: 3-9\nheading: Pool decision\n---\n\n# Pool decision\nWe keep one pool.\n\n## Related\n- [[pool-cost-2]]\n");
  fs.writeFileSync(path.join(base, "wiki", "pool-cost-2.md"), "---\nid: c2\nsource: notes/pool.md\nspan: 10-14\nheading: (none)\n---\n\nIt costs less.\n");
  const { wiki, id } = folders(base);
  const r = wiki.read(id, "pool-decision-1");
  assert.equal(r.page.title, "Pool decision");
  assert.equal(r.page.meta.source, "notes/pool.md");
  assert.deepEqual(r.page.links, [{ slug: "pool-cost-2", title: "pool-cost-2", exists: true }]);
  assert.deepEqual(wiki.read(id, "pool-cost-2").page.backlinks.map((b) => b.slug), ["pool-decision-1"]);
});

test("default roots: only folders that exist, from the documented places", (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const lyra = path.join(fx.base, "lyra");
  fs.mkdirSync(path.join(lyra, "default"), { recursive: true });
  const roots = defaultRoots({ env: { LYRA_WIKI_DATA_DIR: lyra, AITHER_WIKI_ROOTS: [fx.root, path.join(fx.base, "nope")].join(path.delimiter) }, cwd: fx.base });
  assert.deepEqual(roots.map((r) => r.dir), [path.join(lyra, "default"), fx.root]);
  const ids = withIds([...roots, ...roots]).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.deepEqual(defaultRoots({ env: {}, cwd: path.join(fx.base, "nowhere") }), []);
});

// ── the platform (LyraWiki through the gateway) ──────────────────────────────

test("platform up: list, search and read map the tool's rows", async () => {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    if (name === "wiki_list_pages") return JSON.stringify({ pages: [{ slug: "react", category: "entities", strength: 0.8 }] });
    if (name === "wiki_search") return JSON.stringify({ query: args.query, results: [{ slug: "react", title: "React", score: 0.7, snippet: "a library" }] });
    if (name === "wiki_read_page") return JSON.stringify({ slug: "react", content: "---\ntitle: React\n---\n# React\nSee [[hooks]] <script>x</script>" });
    return JSON.stringify({ total_pages: 1 });
  };
  const wiki = createWikiPlatform({ callTool });
  assert.deepEqual((await wiki.list()).pages.map((p) => [p.slug, p.type]), [["react", "entities"]]);
  const found = await wiki.search("react", { limit: 3 });
  assert.equal(found.results[0].title, "React");
  assert.deepEqual(calls.find((c) => c[0] === "wiki_search")[1], { query: "react", project: "default", limit: 3 });
  const page = await wiki.read("../react.md");
  assert.equal(page.ok, true);
  assert.deepEqual(calls.find((c) => c[0] === "wiki_read_page")[1], { slug: "react", project: "default" });
  assert.equal(page.page.title, "React");
  assert.equal(/<script/.test(page.page.html), false);
  assert.equal(page.page.backlinks, null, "the platform has no backlinks tool: null, not an empty list");
  assert.equal((await wiki.stats()).stats.total_pages, 1);
});

test("platform down: the tool's own {error} is an unreachable state, never an empty wiki", async () => {
  // Measured against the live gateway on 2026-11-13 with LyraWiki stopped.
  const callTool = async () => JSON.stringify({ error: "[Errno -2] Name or service not known: aitheros-lyra (cached by AitherHttp; next attempt in 15s)" });
  const wiki = createWikiPlatform({ callTool });
  for (const answer of [await wiki.list(), await wiki.search("x"), await wiki.read("x"), await wiki.stats()]) {
    assert.equal(answer.ok, false);
    assert.equal(answer.unreachable, true);
    assert.match(answer.reason, /Name or service not known: aitheros-lyra/);
    assert.match(answer.remedy, /aitheros-lyra/);
    assert.equal("pages" in answer || "results" in answer, false);
  }
});

test("platform: gateway refused, no bearer, slow and malformed each say what happened", async () => {
  const refused = createWikiPlatform({ callTool: async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8182"), { code: "ECONNREFUSED" }); } });
  const r1 = await refused.list();
  assert.equal(r1.unreachable, true);
  assert.match(r1.remedy, /127\.0\.0\.1:8182/);

  const noBearer = createWikiPlatform({ callTool: async () => { throw new Error("no session bearer"); } });
  assert.match((await noBearer.search("x")).reason, /no session bearer/);

  const slow = createWikiPlatform({ callTool: () => new Promise(() => {}), timeoutMs: 30 });
  const r3 = await slow.list();
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /took over/);

  const prose = createWikiPlatform({ callTool: async () => "Tool 'wiki_list_pages' is not available on the platform tier." });
  const r4 = await prose.list();
  assert.equal(r4.ok, false);
  assert.match(r4.reason, /answered text, not JSON: Tool 'wiki_list_pages' is not available/);

  const odd = createWikiPlatform({ callTool: async () => JSON.stringify({ pages: [null, 7, { title: "no slug" }, { slug: "ok" }] }) });
  assert.deepEqual((await odd.list()).pages.map((p) => p.slug), ["ok"]);
});
