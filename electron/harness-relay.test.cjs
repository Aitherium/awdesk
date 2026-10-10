"use strict";

/** awsh's Shell tab inside the desk: harness-relay.cjs relays AitherShell's routes only. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { allowedRoute, relayHarness } = require("./harness-relay.cjs");

test("exactly AitherShell's routes pass; traversal, encoded slashes and other verbs do not", () => {
  for (const [m, p] of [
    ["GET", "/sessions"], ["GET", "/sessions/unified"], ["GET", "/harnesses"], ["GET", "/profiles"],
    ["GET", "/agents"], ["GET", "/workforce"], ["GET", "/fs/list?path=%2Fhome"], ["GET", "/fs/read?path=a.txt"],
    ["GET", "/sessions/s-1/transcript?after=3&limit=200"], ["POST", "/sessions"], ["POST", "/sessions/s-1/input"],
    ["POST", "/sessions/s-1/message"], ["POST", "/sessions/s-1/resize"], ["POST", "/sessions/s-1/interrupt"],
    ["POST", "/sessions/s-1/focus"], ["DELETE", "/sessions/s-1"],
  ]) assert.equal(allowedRoute(m, p), true, `${m} ${p}`);
  for (const [m, p] of [
    ["POST", "/shell/exec"], ["GET", "/sessions/../config"], ["DELETE", "/sessions"], ["PUT", "/sessions/s-1"],
    ["POST", "/sessions/s-1/kill"], ["GET", "/sessions%2F..%2Fsecrets"], ["GET", "/fs/write?path=x"],
    ["GET", "/fs/list?path=a&evil=1"], ["GET", "sessions"], ["POST", "/sessions/a b/input"],
  ]) assert.equal(allowedRoute(m, p), false, `${m} ${p}`);
});

test("the harness token is added in main, and a refused route never reaches the daemon", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init]); return { ok: true, status: 200, text: async () => "{\"sessions\":[]}" }; };
  const r = await relayHarness({ method: "GET", path: "/sessions" }, { fetchImpl, token: () => "harness-secret", base: "http://127.0.0.1:8362" });
  assert.deepEqual(r, { ok: true, status: 200, data: { sessions: [] }, baseUrl: "http://127.0.0.1:8362" });
  assert.equal(calls[0][0], "http://127.0.0.1:8362/sessions");
  assert.equal(calls[0][1].headers.Authorization, "Bearer harness-secret");
  const refused = await relayHarness({ method: "POST", path: "/shell/exec" }, { fetchImpl, token: () => "t" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal(calls.length, 1);
});

test("a POST carries its body; a dead daemon is a sentence, not a throw", async () => {
  let sent = null;
  const ok = await relayHarness({ method: "POST", path: "/sessions/s-1/input", body: { data: "ls\r" } },
    { fetchImpl: async (_u, init) => { sent = init; return { ok: true, status: 200, text: async () => "" }; }, token: () => "" });
  assert.equal(ok.ok, true);
  assert.deepEqual(JSON.parse(sent.body), { data: "ls\r" });
  assert.equal(sent.headers.Authorization, undefined, "no token, no header");
  const down = await relayHarness({ method: "GET", path: "/sessions" }, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, token: () => "" });
  assert.match(down.error, /no awsh harness daemon/);
});
