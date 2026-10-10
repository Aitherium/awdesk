"use strict";

/** ONE THREAD on the desk: desk-thread.cjs (the id, its resolution, the local brain's turns). */

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeskThread } = require("./desk-thread.cjs");
const { createOverlay } = require("./browser-overlay.cjs");

function res(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

test("resolve: the newest server session, else a new id; set() notifies once per change", async () => {
  const seen = [];
  const t = createDeskThread({ token: async () => "bearer", fetchImpl: async () => res({ sessions: [{ session_id: "sess-7" }] }) });
  t.onChange((id, from) => seen.push([id, from]));
  assert.equal(await t.resolve(), "sess-7");
  assert.equal(t.set("sess-7", "os"), true);
  assert.equal(t.set("../x"), false);
  assert.deepEqual(seen, [["sess-7", "server"]]);
  const fresh = createDeskThread({ token: async () => null, mint: () => "desk-new" });
  assert.equal(await fresh.resolve(), "desk-new");
});

test("persistTurn appends question + answer with the desk bearer, in main only", async () => {
  const calls = [];
  const t = createDeskThread({
    token: async () => "platform-bearer",
    fetchImpl: async (url, init) => { calls.push([url, init]); return init && init.method === "PUT" ? res({ ok: true, ids: ["m1", "m2"] }) : res({ sessions: [] }); },
    mint: () => "desk-1",
  });
  assert.deepEqual(await t.persistTurn("what is this?", "A form."), ["m1", "m2"]);
  const [url, init] = calls.find(([, i]) => i && i.method === "PUT");
  assert.equal(url, "https://api.aitherium.com/api/conversation/history");
  assert.equal(init.headers.Authorization, "Bearer platform-bearer");
  const body = JSON.parse(init.body);
  assert.equal(body.session_id, "desk-1");
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(body.messages[1].agent_id, "desk");
});

test("signed out, empty, or refused: nothing is claimed kept", async () => {
  const out = createDeskThread({ token: async () => null, fetchImpl: async () => { throw new Error("no call expected"); } });
  assert.equal(await out.persistTurn("q", "a"), null);
  const refused = createDeskThread({ token: async () => "b", fetchImpl: async () => res({ ok: false, error: "Not your conversation" }), mint: () => "d" });
  assert.equal(await refused.persistTurn("q", "a"), null);
  assert.equal(await refused.persistTurn("", "a"), null);
});

test("the awconnect overlay over a web tab reads and moves the desk's thread", async () => {
  const t = createDeskThread({ token: async () => null });
  const overlay = createOverlay({ dir: () => null, session: () => null, thread: () => t });
  assert.deepEqual(await overlay.answer({ type: "awconnect:living-os", op: "thread-get" }), { threadId: null });
  assert.deepEqual(await overlay.answer({ type: "awconnect:living-os", op: "thread-set", threadId: "sess-2" }), { ok: true });
  assert.equal(t.get(), "sess-2");
  assert.deepEqual(await overlay.answer({ type: "awconnect:living-os", op: "thread-set", threadId: "bad id" }), { ok: false });
});
