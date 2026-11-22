"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSseParser, createTerminalClient, validId, HARNESS_ORDER } = require("./terminal-client.cjs");

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const r = routes[key];
    if (!r) return { ok: false, status: 404, json: async () => ({ detail: "nope" }) };
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body };
  };
  return { impl, calls };
}

test("SSE parser: events across chunk boundaries, keepalives skipped", () => {
  const feed = createSseParser();
  assert.deepEqual(feed(": keepalive\n\nevent: text.delta\ndata: {\"seq\":3"), []);
  assert.deepEqual(feed(",\"text\":\"hi\"}\n\n"), [{ event: "text.delta", data: "{\"seq\":3,\"text\":\"hi\"}" }]);
  assert.deepEqual(feed("event: x\r\ndata: a\r\ndata: b\r\n\r\n"), [{ event: "x", data: "a\nb" }]);
});

test("the bearer goes to the daemon on every call and never into a result", async () => {
  const { impl, calls } = fakeFetch({ "GET /sessions": { body: { sessions: [{ id: "abc123", harness: "terminal", state: "ready" }] } } });
  const c = createTerminalClient({ fetchImpl: impl, base: "http://d", token: "SECRET" });
  const r = await c.list();
  assert.equal(r.ok, true);
  assert.equal(calls[0].headers.authorization, "Bearer SECRET");
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  assert.equal(r.sessions[0].label, "Shell");
});

test("only terminal harnesses start; ids are validated before any request", async () => {
  const { impl, calls } = fakeFetch({ "POST /sessions": { body: { id: "s1", harness: "claude", state: "ready" } },
    "POST /sessions/s1/resize": { body: { resized: true } } });
  const c = createTerminalClient({ fetchImpl: impl, base: "http://d", token: "t" });
  assert.equal((await c.create({ harness: "group" })).ok, false);
  const made = await c.create({ harness: "claude", cwd: "C:\\x", rows: 40, cols: 120 });
  assert.equal(made.ok, true);
  assert.deepEqual(calls.map((x) => x.key), ["POST /sessions", "POST /sessions/s1/resize"]);
  assert.deepEqual(calls[1].body, { rows: 40, cols: 120 });
  for (const bad of ["../x", "a/b", "", "x".repeat(200)]) {
    assert.equal(validId(bad), false);
    assert.equal((await c.input(bad, "ls")).ok, false);
  }
  assert.equal(calls.length, 2, "a bad id never reaches the daemon");
});

test("keystrokes are sent raw (no implied Enter); daemon errors come back as text", async () => {
  const { impl, calls } = fakeFetch({ "POST /sessions/s1/input": { status: 409, body: { detail: "session exited cannot accept input" } } });
  const c = createTerminalClient({ fetchImpl: impl, base: "http://d", token: "t" });
  const r = await c.input("s1", "\u0003");
  assert.deepEqual(calls[0].body, { text: "\u0003", submit: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot accept input/);
});

test("harnesses: only what the daemon has installed, in menu order", async () => {
  const { impl } = fakeFetch({ "GET /health": { body: { harnesses_installed: ["gemini", "terminal", "group", "claude"] } } });
  const c = createTerminalClient({ fetchImpl: impl, base: "http://d", token: "t" });
  const r = await c.harnesses();
  assert.deepEqual(r.harnesses.map((h) => h.id), ["terminal", "claude", "gemini"]);
  assert.ok(HARNESS_ORDER.every((h) => h !== "group"));
});

test("a dead daemon is an answer, not a throw", async () => {
  const c = createTerminalClient({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, base: "http://d", token: "t" });
  const r = await c.list();
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer/);
});

test("external: only DISCOVERED Claude Code tabs, never a daemon's own or another harness", async () => {
  const { impl } = fakeFetch({ "GET /sessions/unified": { body: { sessions: [
    { id: "ext-1", origin: "discovered", harness: "claude", name: "repo dev 10:01", cwd: "C:\r", status: "idle", last_activity_at: 5 },
    { id: "own-1", origin: "daemon", harness: "claude", title: "mine" },
    { id: "ext-g", origin: "discovered", harness: "gemini" },
    { id: "bad id!", origin: "discovered", harness: "claude" },
  ] } } });
  const c = createTerminalClient({ fetchImpl: impl, base: "http://d", token: "t" });
  const r = await c.external();
  assert.equal(r.ok, true);
  assert.deepEqual(r.sessions, [{ id: "ext-1", label: "repo dev 10:01", cwd: "C:\r", status: "idle", lastActivityAt: 5 }]);
});

test("resume: a claude-tty pty session carrying the old id, sized like a new tab", async () => {
  const { impl, calls } = fakeFetch({
    "POST /sessions": { body: { id: "new1", harness: "claude-tty", state: "ready" } },
    "POST /sessions/new1/resize": { body: {} },
  });
  const c = createTerminalClient({ fetchImpl: impl, base: "http://d", token: "t" });
  const r = await c.resume("ext-1", { cwd: "C:\r" });
  assert.equal(r.ok, true);
  assert.equal(r.session.id, "new1");
  assert.deepEqual(calls[0].body, { harness: "claude-tty", resume_session_id: "ext-1", cwd: "C:\r", title: "" });
  assert.equal((await c.resume("../x")).ok, false);
});

/** terminal-dock-model.js is a page script (the package is ESM, so no require): load it as the page does. */
function dockModel() {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const self = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "terminal-dock-model.js"), "utf8"), { self });
  return self.TerminalDockModel;
}

test("dock model: the strip mirrors the daemon, running first, without reshuffling", () => {
  const model = dockModel();
  const rows = [
    { id: "b", state: "exited", createdAt: 1 },
    { id: "c", state: "ready", createdAt: 3 },
    { id: "a", state: "running", createdAt: 2 },
  ];
  assert.deepEqual(model.stripOrder(rows, []).map((s) => s.id), ["a", "c"], "an exited session nobody shows drops out");
  assert.deepEqual(model.stripOrder(rows, new Set(["b"])).map((s) => s.id), ["a", "c", "b"], "a shown exited tab stays, last");
  assert.equal(model.runningCount(rows), 2);
  assert.equal(model.summary(rows), "2 running");
  assert.equal(model.summary([]), "no sessions");
  assert.equal(model.summary(rows, { daemonUp: false }), "awsh daemon offline");
});

test("dock model: a re-read reports what changed, and nothing when nothing did", () => {
  const model = dockModel();
  const prev = [{ id: "a", state: "running", label: "Shell" }, { id: "b", state: "running", label: "Claude" }];
  assert.equal(model.diffSessions(prev, prev.map((s) => ({ ...s }))).same, true);
  const d = model.diffSessions(prev, [{ id: "a", state: "exited", label: "Shell" }, { id: "n", state: "running", label: "new" }]);
  // JSON: the arrays come from the vm realm, and deepEqual compares prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify([d.added, d.changed, d.removed, d.same])), [["n"], ["a"], ["b"], false]);
});

test("dock model: resume offers external tabs not already ours, newest first", () => {
  const model = dockModel();
  const ext = [{ id: "x", lastActivityAt: 1 }, { id: "y", lastActivityAt: 9 }, { id: "mine", lastActivityAt: 99 }];
  assert.deepEqual(model.resumeChoices(ext, [{ id: "mine" }]).map((s) => s.id), ["y", "x"]);
  assert.equal(model.resumeChoices(ext, [], 1).length, 1);
});
