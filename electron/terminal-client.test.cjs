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
