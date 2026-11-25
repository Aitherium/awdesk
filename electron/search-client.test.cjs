"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createSearchClient, reportView, resultRow, cleanQuery } = require("./search-client.cjs");
const { searchHandlers, fromSearchPage } = require("./search-window.cjs");
const { isSearchText } = require("./browser-rail.cjs");

function fakeExec(stdout, record = []) {
  return (cmd, args, _opts, cb) => { record.push([cmd, ...args]); setImmediate(() => cb(null, stdout, "")); };
}

test("search runs awfind --json with the query after --, never as a flag", async () => {
  const calls = [];
  const c = createSearchClient({ execFile: fakeExec(JSON.stringify({ results: [
    { title: "A", url: "https://a.test/", snippet: "s", source: "duckduckgo", score: 0.8 },
    { title: "bad", url: "javascript:alert(1)" },
  ] }), calls) });
  const r = await c.search("q", "--help me");
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ["awfind", "--json", "q", "--limit", "12", "--", "--help me"]);
  assert.deepEqual(r.results.map((x) => x.url), ["https://a.test/"], "non-http links are dropped");
});

test("answer mode reads sources; unknown modes and empty queries are refused", async () => {
  const calls = [];
  const c = createSearchClient({ execFile: fakeExec(`banner\n{"answer":"42","results":[]}`, calls) });
  const r = await c.search("answer", "meaning");
  assert.equal(r.answer, "42");
  assert.deepEqual(calls[0].slice(0, 5), ["awfind", "--json", "answer", "--sources", "4"]);
  assert.equal((await c.search("rm", "x")).ok, false);
  assert.equal((await c.search("q", "   ")).ok, false);
  assert.equal(calls.length, 1);
});

test("a missing awfind says how to fix it", async () => {
  const c = createSearchClient({ execFile: (_c, _a, _o, cb) => cb(Object.assign(new Error("spawn"), { code: "ENOENT" }), "", "") });
  const r = await c.search("q", "x");
  assert.equal(r.ok, false);
  assert.match(r.error, /awfind is not installed/);
});

test("a half-installed awfind (script exists, module missing) names the repair lane, not a bare traceback", async () => {
  const trace = "Traceback (most recent call last):\n  File \"...\", line 2, in <module>\nModuleNotFoundError: No module named 'awfind'";
  const c = createSearchClient({ execFile: (_c, _a, _o, cb) => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", trace) });
  const r = await c.search("q", "x");
  assert.equal(r.ok, false);
  assert.match(r.error, /pip install -e packages\/awfind/);
  assert.doesNotMatch(r.error, /^\s*ModuleNotFoundError/);
});

test("research is a job: started, listed, read back as claims pinned to sources", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-research-"));
  let child;
  const spawn = (cmd, args) => {
    child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.args = [cmd, ...args];
    return child;
  };
  const c = createSearchClient({ spawn, dataDir: dir });
  const started = c.startResearch("why is the sky blue", "deep");
  assert.equal(started.ok, true);
  assert.deepEqual(child.args.slice(0, 7), ["awresearch", "--question", "why is the sky blue", "--depth", "deep", "--output", "json"]);
  assert.equal(c.listResearch().jobs[0].state, "running");
  const file = child.args[child.args.indexOf("--out-file") + 1];
  fs.writeFileSync(file, JSON.stringify({ question: "why is the sky blue", claims: [
    { text: "Rayleigh scattering.", sources: [1, 9] }, { text: "Unsure.", sources: [], unsourced_reason: "no source" },
  ], sources: [{ url: "https://physics.test/r", title: "Rayleigh", domain: "physics.test" }] }));
  child.emit("exit", 0);
  const read = c.readResearch(started.job.id);
  assert.equal(read.job.state, "done");
  assert.deepEqual(read.report.claims[0].sources, [1], "a citation to a source that does not exist is dropped");
  assert.equal(read.report.claims[1].unsourcedReason, "no source");
});

test("a failed research run keeps its reason", () => {
  let child;
  const spawn = () => { child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child; };
  const c = createSearchClient({ spawn, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "desk-research-")) });
  const { job } = c.startResearch("q");
  child.stderr.emit("data", "Traceback...\nRuntimeError: no model reachable\n");
  child.emit("exit", 1);
  const listed = c.listResearch().jobs.find((j) => j.id === job.id);
  assert.equal(listed.state, "failed");
  assert.match(listed.error, /no model reachable/);
});

test("Media Forge opens at its root only when it is reachable over http(s)", async () => {
  const live = createSearchClient({ callTool: async () => JSON.stringify({ reachable: true, base: "http://forge.example.test:8200", gpu_busy: false }) });
  assert.deepEqual(await live.forgeUrl(), { ok: true, url: "http://forge.example.test:8200/", busy: false });
  const down = createSearchClient({ callTool: async () => ({ reachable: false }) });
  assert.equal((await down.forgeUrl()).ok, false);
  const odd = createSearchClient({ callTool: async () => ({ reachable: true, base: "file:///C:/x" }) });
  assert.equal((await odd.forgeUrl()).ok, false);
});

test("report and result shapes are sanitized", () => {
  assert.equal(resultRow({ url: "ftp://x" }), null);
  const rep = reportView({ claims: [{ text: "" }, { text: "ok", sources: ["1"] }], sources: [{ url: "javascript:x", title: "t" }] });
  assert.equal(rep.claims.length, 1);
  assert.equal(rep.sources[0].url, "", "a non-http source keeps its title but loses its link");
  assert.equal(cleanQuery("a\u0000b"), "a b");
});

test("videos: search_videos rows, unsafe URLs dropped, a provider failure is an error", async () => {
  const calls = [];
  const c = createSearchClient({
    callTool: async (name, args) => {
      calls.push([name, args]);
      return JSON.stringify({ videos: [
        { title: "Quadlets in 10 minutes", url: "https://www.youtube.com/watch?v=abc", thumbnail_url: "https://i.ytimg.com/a.jpg",
          duration: "10:02", publisher: "YouTube", published: "2026-10-01T12:00:00Z" },
        { title: "no link", url: "javascript:alert(1)" },
        { title: "", url: "https://x.test/v" },
        { title: "plain thumb", url: "http://v.test/1", thumbnail_url: "http://insecure.test/t.jpg" },
      ] });
    },
  });
  const r = await c.videos("podman quadlet");
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ["search_videos", { query: "podman quadlet", limit: 20 }]);
  assert.equal(r.videos.length, 2);
  assert.deepEqual(r.videos[0], { title: "Quadlets in 10 minutes", url: "https://www.youtube.com/watch?v=abc",
    thumb: "https://i.ytimg.com/a.jpg", duration: "10:02", publisher: "YouTube", published: "2026-10-01" });
  assert.equal(r.videos[1].thumb, "", "an http thumbnail is not shown");
  assert.equal((await c.videos("  ")).ok, false);
  const limited = createSearchClient({ callTool: async () => ({ videos: [], error: "429 rate limited" }) });
  assert.deepEqual(await limited.videos("x"), { ok: false, error: "429 rate limited" });
  const thrown = createSearchClient({ callTool: async () => { throw new Error("gateway down"); } });
  assert.deepEqual(await thrown.videos("x"), { ok: false, error: "gateway down" });
});

test("desk:search-videos reaches videos() from the search page only", async () => {
  const s = (url) => ({ getURL: () => url });
  const h = searchHandlers({ videos: async (q) => ({ ok: true, query: q, videos: [] }) });
  assert.deepEqual(await h["desk:search-videos"]({ sender: s("aither://search/") }, "cats"), { ok: true, query: "cats", videos: [] });
  assert.equal((await h["desk:search-videos"]({ sender: s("https://x.test/") }, "cats")).ok, false);
});

test("sendToRoom: one relay_send line, web links only, a refusal is an error", async () => {
  const calls = [];
  const c = createSearchClient({ callTool: async (name, args) => { calls.push([name, args]); return JSON.stringify({ ok: true }); } });
  const r = await c.sendToRoom({ url: "https://www.youtube.com/watch?v=abc", title: "Quadlets", kind: "video" }, "#agents");
  assert.deepEqual(r, { ok: true, channel: "#agents" });
  assert.equal(calls[0][0], "relay_send");
  assert.deepEqual(calls[0][1], {
    channel: "#agents", text: "Quadlets - https://www.youtube.com/watch?v=abc", kind: "MESSAGE",
    payload: { url: "https://www.youtube.com/watch?v=abc", title: "Quadlets", source: "aither-search", what: "video" },
  });
  assert.equal((await c.sendToRoom({ url: "javascript:alert(1)" }, "#agents")).ok, false);
  assert.equal((await c.sendToRoom({ url: "https://x.test" }, "agents; rm")).ok, false, "a room is a #name");
  assert.equal(calls.length, 1, "refused items never reach the gateway");
  const refused = createSearchClient({ callTool: async () => ({ error: "channel does not exist" }) });
  assert.deepEqual(await refused.sendToRoom({ url: "https://x.test" }, "#nope"), { ok: false, error: "channel does not exist" });
});

test("desk:search-share sends to the configured room from the search page only", async () => {
  const s = (url) => ({ getURL: () => url });
  const seen = [];
  const h = searchHandlers({ sendToRoom: async (item, room) => { seen.push([item, room]); return { ok: true, channel: room }; } },
    { shareRoom: () => "#garg" });
  const item = { url: "https://x.test", title: "x", kind: "page" };
  assert.deepEqual(await h["desk:search-share"]({ sender: s("aither://search/") }, item), { ok: true, channel: "#garg" });
  assert.deepEqual(seen, [[item, "#garg"]]);
  assert.equal((await h["desk:search-share"]({ sender: s("https://evil.test/") }, item)).ok, false);
});

test("the browser's home and new tab is the search page; DESK_BROWSER_HOME still wins", () => {
  const { homeUrlFor, SEARCH_HOME } = require("./browser-internal.cjs");
  const ok = (u) => ({ ok: true, url: u });
  assert.equal(SEARCH_HOME, "aither://search/");
  assert.equal(homeUrlFor({}, ok), "aither://search/");
  assert.equal(homeUrlFor({ DESK_BROWSER_HOME: "https://example.test/" }, ok), "https://example.test/");
  assert.equal(homeUrlFor({ DESK_BROWSER_HOME: "aither://settings/" }, ok), "aither://settings/");
  assert.equal(homeUrlFor({ DESK_BROWSER_HOME: "file:///C:/x" }, () => ({ ok: false })), "aither://search/",
    "a refused override falls back to the search page");
  const win = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(win, /function homeUrl\(\) \{\s*return internal\.homeUrlFor\(/, "browser-window reads the one rule");
});

test("the search page has a Videos mode and opens a mode from ?mode=", () => {
  const html = fs.readFileSync(path.join(__dirname, "search.html"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "search-page.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "search-preload.cjs"), "utf8");
  assert.match(html, /data-mode="videos"/);
  assert.match(page, /function renderVideos\(/);
  assert.match(page, /api\.videos\(q\)/);
  assert.match(page, /params\.get\("mode"\)/);
  assert.match(page, /toforge/, "image results carry the Media Forge action");
  assert.match(preload, /desk:search-videos/);
});

test("only aither://search reaches these channels", async () => {
  const s = (url) => ({ getURL: () => url });
  assert.equal(fromSearchPage(s("aither://search/?q=x")), true);
  assert.equal(fromSearchPage(s("aither://terminal/")), false);
  assert.equal(fromSearchPage(s("https://search.evil/")), false);
  let touched = 0;
  const client = new Proxy({}, { get: () => async () => { touched++; return { ok: true }; } });
  for (const handler of Object.values(searchHandlers(client))) {
    assert.equal((await handler({ sender: s("https://x.test/") }, "q", "x")).ok, false);
  }
  assert.equal(touched, 0);
});

test("the address bar knows a search from an address", () => {
  for (const t of ["best local llm", "bonsai", "how do I fix wsl"]) assert.equal(isSearchText(t), true, t);
  for (const t of ["example.com", "localhost:3000", "https://x.test", "aither://settings", "a/b", ""]) {
    assert.equal(isSearchText(t), false, t);
  }
});

// ── the resident discovery worker (2026-11-01: `adk discover` cost 5.9 s per call) ──

const sc = require("./search-client.cjs");

/** A fake python: answers the ready line, then one JSON line per request via `reply`. */
function fakePython(reply, { ready = true } = {}) {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
    c.stderr = new EventEmitter();
    c.stdin = new EventEmitter();
    c.stdin.write = (line) => {
      const req = JSON.parse(line);
      setImmediate(() => { const out = reply(req); if (out) c.stdout.emit("data", `${JSON.stringify(out)}\n`); });
      return true;
    };
    c.kill = () => { setImmediate(() => c.emit("exit", null)); };
    spawned.push({ cmd, args, opts, c });
    setImmediate(() => c.stdout.emit("data", `${JSON.stringify(ready ? { ready: true } : { ready: false, error: "No module named adk" })}\n`));
    return c;
  };
  return { spawn, spawned };
}

const CARD = { domain: "tools", name: "rf_doctor", description: "Preflight diagnostics", source: "gateway" };

test("discover answers from the resident worker, and reuses ONE process", async () => {
  const py = fakePython((req) => ({ id: req.id, ok: true, cards: [CARD] }));
  const worker = sc.createDiscoveryWorker({ spawn: py.spawn });
  let cli = 0;
  const client = sc.createSearchClient({ discoveryWorker: worker, execFile: () => { cli += 1; } });
  const a = await client.discover("docker");
  const b = await client.discover("deploy veil");
  assert.equal(a.ok, true);
  assert.equal(a.via, "worker");
  assert.equal(a.cards.length, 1);
  assert.equal(b.via, "worker");
  assert.equal(py.spawned.length, 1, "one resident process for both queries");
  assert.equal(cli, 0, "the CLI never ran");
  assert.equal(py.spawned[0].opts.windowsHide, true);
  assert.ok(py.spawned[0].args.includes("-u"));
  worker.stop();
});

test("a worker that cannot import adk falls back to the CLI", async () => {
  const py = fakePython(() => null, { ready: false });
  const worker = sc.createDiscoveryWorker({ spawn: py.spawn });
  let cliArgs = null;
  const execFile = (cmd, args, opts, cb) => { cliArgs = [cmd, ...args]; cb(null, JSON.stringify({ cards: [CARD] }), ""); };
  const client = sc.createSearchClient({ discoveryWorker: worker, execFile });
  const r = await client.discover("docker");
  assert.equal(r.ok, true);
  assert.equal(r.via, undefined, "answered by the CLI");
  assert.deepEqual(cliArgs.slice(0, 3), ["adk", "discover", "query"]);
});

test("a worker that misses its deadline is dropped and the CLI answers", async () => {
  const py = fakePython(() => null); // never replies
  const worker = sc.createDiscoveryWorker({ spawn: py.spawn, timeoutMs: 30 });
  const execFile = (cmd, args, opts, cb) => cb(null, JSON.stringify({ cards: [CARD] }), "");
  const client = sc.createSearchClient({ discoveryWorker: worker, execFile });
  const t0 = Date.now();
  const r = await client.discover("docker");
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 2000, "bounded by the deadline, not the CLI's 10 s");
  assert.equal(worker.running, false, "the wedged worker was dropped");
});

test("the worker script calls adk's own ranking, offline (live=False)", () => {
  assert.match(sc.DISCOVER_WORKER_SCRIPT, /from adk\.discovery import rank/);
  assert.match(sc.DISCOVER_WORKER_SCRIPT, /rank\.query\(.*live=False\)/);
});
