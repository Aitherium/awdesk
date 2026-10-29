"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createNotebooksClient, readIndex, mergeRows, replayCensus, ownerToken, validId, viewUrl,
} = require("./notebooks-client.cjs");
const { notebooksHandlers, fromNotebooksPage } = require("./notebooks-window.cjs");

// The same index fixture the awsh tests use (awdk tests/test_mcp_stdio.py _NB_INDEX).
const INDEX = {
  "sess-old": { created: "2026-10-26T10:00:00", log_path: "C:/t/old.jsonl",
    surfaces: { notebook: { id: "nb_old00001", at: "2026-10-26T10:01" } } },
  "sess-new": { created: "2026-10-27T20:00:00", log_path: "C:/t/new.jsonl",
    surfaces: { notebook: { id: "nb_new00002" }, archive: { path: "C:/b/new.md" } } },
  "sess-err": { created: "2026-10-27T21:00:00", surfaces: { notebook: { status: "error" } } },
};

function indexDir(entries = INDEX) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-index-"));
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(entries), "utf8");
  return dir;
}

/** fetch double: routes by URL suffix; records every call. */
function fakeFetch(routes, calls = []) {
  return async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", auth: (opts.headers || {}).Authorization || "" });
    const hit = Object.entries(routes).find(([suffix]) => url.split("?")[0].endsWith(suffix));
    if (!hit) throw new Error("connect ECONNREFUSED " + url);
    const [status, body] = hit[1];
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

const ENV = { AITHER_PORTAL_URL: "https://portal.test", AITHER_API_KEY: "tok" };

test("the host index is read newest first; failed creations are not rows", () => {
  const out = readIndex({ dir: indexDir() });
  assert.equal(out.readable, true);
  assert.deepEqual(out.rows.map((r) => r.notebook), ["nb_new00002", "nb_old00001"]);
  assert.equal(out.rows[0].log_path, "C:/t/new.jsonl");
  assert.equal(out.rows[0].brief, "C:/b/new.md");
  assert.equal(out.rows[0].view, "https://aitherium.com/workspace/one?tab=notebooks&id=nb_new00002");
});

test("a missing or broken index is reported, never an empty success", () => {
  const missing = readIndex({ dir: path.join(os.tmpdir(), "nb-absent-" + Date.now()) });
  assert.equal(missing.readable, false);
  assert.match(missing.error, /no notebook index/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-bad-"));
  fs.writeFileSync(path.join(dir, "index.json"), "{not json", "utf8");
  assert.equal(readIndex({ dir }).readable, false);
});

// The replay rule, pinned with the same cases as awdk tests/test_mcp_stdio.py _RECORDED.
const RECORDED = [
  { type: "context", config: { title: "s" } },
  { type: "tool_call", config: { tool: "Read", input: { p: "a" } } },
  { type: "tool_call", config: { tool: "Bash", input: { c: "rm" } } },
  { type: "prompt", config: { prompt: "summarise" } },
  { type: "agent_delegate", config: { agent: "demiurge", task: "fix" } },
];

test("replay census: every agent cell acts -- prompts, delegates, even a recorded Read", () => {
  // Genesis hands tool_call, prompt and agent_delegate cells to an agent with full tools
  // (verifier, 2026-10-28: the old rule let prompt/agent_delegate replay with no consent).
  const out = replayCensus({ cells: RECORDED });
  assert.deepEqual(out.acting, { "tool_call:Read": 1, "tool_call:Bash": 1, prompt: 1, agent_delegate: 1 });
  assert.equal(out.emptyTask, 2, "the recorded tool calls carry no prompt");
  const inert = replayCensus({ cells: [{ type: "context" }, { type: "note" }, { type: "checkpoint" }] });
  assert.deepEqual(inert.acting, {});
  assert.deepEqual(replayCensus({ cells: [{ type: "brand_new_kind" }] }).acting, { brand_new_kind: 1 },
    "an unknown cell type fails closed");
});

test("rows carry the brief's title; an archived (deleted) platform row is hidden", () => {
  const dir = indexDir();
  fs.writeFileSync(path.join(dir, "sess-new.md"), "EXECUTIVE-BRIEF: Notebooks get a desk page\n\nbody\n", "utf8");
  const rows = readIndex({ dir }).rows;
  assert.deepEqual(rows.map((r) => r.title), ["Notebooks get a desk page", ""]);
  const merged = mergeRows(rows, [{ id: "nb_probe01", status: "archived" }, { id: "nb_web00003", name: "web" }]);
  assert.deepEqual(merged.map((r) => r.notebook), ["nb_new00002", "nb_old00001", "nb_web00003"]);
});

test("platform up: rows merge by id and Live needs Genesis itself", async () => {
  const calls = [];
  const c = createNotebooksClient({ env: ENV, dir: indexDir(), fetchImpl: fakeFetch({
    "/api/notebooks": [200, { success: true, notebooks: [
      { id: "nb_new00002", name: "Exec brief", status: "draft" }, { id: "nb_web00003", name: "web" }] }],
    "/api/bridge/genesis/notebooks/sessions": [200, { sessions: [], active_count: 0 }],
  }, calls) });
  const out = await c.list();
  assert.equal(out.live.live, true);
  assert.deepEqual(Object.fromEntries(out.notebooks.map((r) => [r.notebook, r.source])),
    { nb_new00002: "both", nb_old00001: "host", nb_web00003: "platform" });
  assert.ok(calls.every((call) => call.auth === "Bearer tok"), "every call carries the owner's bearer");
});

test("an empty portal list with Genesis down behind it is NOT live", async () => {
  const c = createNotebooksClient({ env: ENV, dir: indexDir(), fetchImpl: fakeFetch({
    "/api/notebooks": [200, { success: true, notebooks: [] }],
    "/api/bridge/genesis/notebooks/sessions": [502, { error: "bad gateway" }],
  }) });
  const out = await c.list();
  assert.equal(out.live.live, false);
  assert.match(out.live.error, /502/);
  assert.equal(out.notebooks.length, 2, "this computer's rows survive");
});

test("platform unreachable: host rows, Offline, the reason; local-only makes no call", async () => {
  const calls = [];
  const c = createNotebooksClient({ env: ENV, dir: indexDir(), fetchImpl: fakeFetch({}, calls) });
  const out = await c.list();
  assert.equal(out.live.checked, true);
  assert.equal(out.live.live, false);
  assert.match(out.live.error, /ECONNREFUSED/);
  assert.equal(out.notebooks.length, 2);
  calls.length = 0;
  const local = await c.list({ localOnly: true });
  assert.equal(local.live.checked, false);
  assert.equal(calls.length, 0);
});

test("not signed in says so instead of a bare 401", async () => {
  const c = createNotebooksClient({ env: { AITHER_PORTAL_URL: "https://portal.test", AITHER_HOME_DIR: os.tmpdir() },
    dir: indexDir(), token: "", fetchImpl: fakeFetch({
      "/api/notebooks": [401, { error: "unauthorized" }],
      "/api/bridge/genesis/notebooks/sessions": [401, { detail: "Authentication required" }],
    }) });
  const out = await c.list();
  assert.equal(out.live.live, false);
  assert.match(out.live.error, /not signed in/);
});

test("replay refuses recorded side effects unless the owner confirmed them", async () => {
  const calls = [];
  const c = createNotebooksClient({ env: ENV, dir: indexDir(), fetchImpl: fakeFetch({
    "/api/bridge/genesis/notebooks/nb_new00002": [200, { id: "nb_new00002", cells: [
      { type: "context" }, { type: "tool_call", config: { tool: "Bash" } }] }],
    "/api/bridge/genesis/notebooks/nb_new00002/execute": [200, { run_id: "nbrun_1", status: "completed" }],
  }, calls) });
  const refused = await c.replay("nb_new00002");
  assert.equal(refused.refused, true);
  assert.deepEqual(refused.acting, { "tool_call:Bash": 1 });
  assert.equal(refused.emptyTask, 1, "a recorded tool call has no prompt");
  assert.ok(!calls.some((call) => call.method === "POST"), "nothing ran");
  const run = await c.replay("nb_new00002", { allowSideEffects: true });
  assert.deepEqual(run, { ok: true, runId: "nbrun_1", status: "completed" });
});

test("export saves the .ipynb under ~/.aither/notebooks", async () => {
  const written = {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-home-"));
  const c = createNotebooksClient({ env: { ...ENV, AITHER_HOME_DIR: home }, dir: indexDir(),
    writeFile: (file, text) => { written[file] = text; }, mkdir: () => {},
    fetchImpl: fakeFetch({ "/api/bridge/genesis/notebooks/nb_new00002/export": [200, { nbformat: 4 }] }) });
  const out = await c.exportTo("nb_new00002");
  assert.equal(out.ok, true);
  assert.equal(out.path, path.join(home, ".aither", "notebooks", "nb_new00002.ipynb"));
  assert.match(written[out.path], /"nbformat":4/);
});

test("ids that could walk the URL path are refused before any call", async () => {
  for (const bad of ["", "../admin", "nb/1", "a".repeat(90), "nb_1..x"]) assert.equal(validId(bad), false, bad);
  assert.equal(validId("nb_f34c8499"), true);
  const c = createNotebooksClient({ env: ENV, dir: indexDir(), fetchImpl: fakeFetch({}) });
  assert.equal((await c.outline("../x")).ok, false);
  assert.equal((await c.exportTo("a/b")).ok, false);
  assert.equal(viewUrl("nb 1"), "https://aitherium.com/workspace/one?tab=notebooks&id=nb%201");
});

test("the owner's bearer comes from the active adk login profile", () => {
  const files = { [path.join("/h", ".aither", "auth.json")]: JSON.stringify({
    active_profile: "me", profiles: { me: { access_token: "abc" } } }) };
  const readFile = (file) => { if (files[file] !== undefined) return files[file]; throw new Error("ENOENT"); };
  assert.equal(ownerToken({ env: { AITHER_HOME_DIR: "/h" }, readFile }), "abc");
  assert.equal(ownerToken({ env: { AITHER_HOME_DIR: "/none" }, readFile }), "");
  assert.equal(ownerToken({ env: { AITHER_API_KEY: "env" }, readFile }), "env");
  assert.deepEqual(mergeRows([], [{ name: "no id" }]), []);
});

test("main answers only the aither://notebooks page", async () => {
  const opened = [];
  const shown = [];
  const fakeClient = { list: async () => ({ ok: true }) };
  const handlers = notebooksHandlers(fakeClient, { openUrl: (u) => opened.push(u),
    shell: { showItemInFolder: (p) => shown.push(p) }, exists: (p) => p === "C:/t/new.jsonl" });
  const page = { sender: { getURL: () => "aither://notebooks/" } };
  const other = { sender: { getURL: () => "https://evil.test/" } };
  assert.deepEqual(await handlers["desk:notebooks-list"](other), { ok: false, error: "not the notebooks page" });
  assert.deepEqual(await handlers["desk:notebooks-list"](page), { ok: true });
  const viewed = await handlers["desk:notebooks-view"](page, "nb_new00002");
  assert.equal(viewed.ok, true);
  assert.deepEqual(opened, ["https://aitherium.com/workspace/one?tab=notebooks&id=nb_new00002"]);
  assert.equal((await handlers["desk:notebooks-view"](page, "../x")).ok, false);
  assert.equal((await handlers["desk:notebooks-transcript"](page, "C:/t/new.jsonl")).ok, true);
  assert.equal((await handlers["desk:notebooks-transcript"](page, "C:/Windows/notepad.exe")).ok, false);
  assert.deepEqual(shown, ["C:/t/new.jsonl"]);
  assert.equal(fromNotebooksPage({ getURL: () => "aither://projects/" }), false);
});

test("the Notebooks badge counts what is new since the pane was last opened", () => {
  const dir = indexDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-home-"));
  const env = { ...ENV, AITHER_HOME_DIR: home };
  const c = createNotebooksClient({ env, dir });
  assert.deepEqual(c.unseen(), { ok: true, count: 0, seenAt: "2026-10-27T20:00:00" },
    "a computer with no mark records one: a fresh desk does not show every notebook");
  const later = { ...INDEX, "sess-3": { created: "2026-10-28T09:00:00", surfaces: { notebook: { id: "nb_three003" } } } };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(later), "utf8");
  assert.equal(c.unseen().count, 1);
  assert.equal(c.unseen({ markSeen: true }).count, 0);
  assert.equal(c.unseen().count, 0, "opening the pane clears it");
  const broken = createNotebooksClient({ env, dir: path.join(os.tmpdir(), "nb-none-" + Date.now()) }).unseen();
  assert.equal(broken.ok, false, "an unreadable index is reported, not a zero");
});

test("main answers the badge count to the console, and marks seen only when asked", async () => {
  const marks = [];
  const handlers = notebooksHandlers({ unseen: (o) => (marks.push(o), { ok: true, count: o.markSeen ? 0 : 2 }) },
    { isNotebooks: () => false });
  assert.deepEqual(await handlers["desk:notebooks-count"]({ sender: {} }, {}), { ok: true, count: 2 });
  assert.deepEqual(await handlers["desk:notebooks-count"]({ sender: {} }, { markSeen: true }), { ok: true, count: 0 });
  assert.deepEqual(marks, [{ markSeen: false }, { markSeen: true }]);
});

test("one identity: the desk's Online session is the bearer; signed out falls back to adk login", async () => {
  const seen = [];
  const routes = { "/api/notebooks": [200, { notebooks: [] }], "/api/bridge/genesis/notebooks/sessions": [200, { sessions: [] }] };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nb-auth-"));
  fs.mkdirSync(path.join(home, ".aither"));
  fs.writeFileSync(path.join(home, ".aither", "auth.json"),
    JSON.stringify({ active_profile: "p", profiles: { p: { access_token: "adk-login" } } }), "utf8");
  const env = { AITHER_PORTAL_URL: "https://portal.test", AITHER_HOME_DIR: home };
  const desk = createNotebooksClient({ env, dir: indexDir(), token: async () => "desk-online", fetchImpl: fakeFetch(routes, seen) });
  assert.equal((await desk.list()).live.live, true);
  assert.ok(seen.length && seen.every((c) => c.auth === "Bearer desk-online"), "every call carries the desk session");
  seen.length = 0;
  const signedOut = createNotebooksClient({ env, dir: indexDir(), token: async () => null, fetchImpl: fakeFetch(routes, seen) });
  await signedOut.list();
  assert.ok(seen.every((c) => c.auth === "Bearer adk-login"), "signed out on the desk: the adk login profile");
  seen.length = 0;
  const broken = createNotebooksClient({ env, dir: indexDir(), token: async () => { throw new Error("no partition"); }, fetchImpl: fakeFetch(routes, seen) });
  await broken.list();
  assert.ok(seen.every((c) => c.auth === "Bearer adk-login"), "a failing provider never blanks the bearer");
});
