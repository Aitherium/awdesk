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
