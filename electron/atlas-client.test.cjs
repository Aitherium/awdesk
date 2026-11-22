"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { atlasBoard, atlasDigest } = require("./atlas-client.cjs");

function fakeCall(calls, answers) {
  return async (name, args) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(name, args);
    return answer;
  };
}

const BOARD = {
  counts: { triage: 2, progress: 1 },
  rows: [{ number: 15130, stage: "progress", pr: "https://github.com/Aitherium/AitherOS/pull/15130", thread: "https://github.com/Aitherium/AitherOS/issues/15130" }],
  metrics: { open: 3 },
  text: "3 open",
  message_id: "msg-1",
  updated_at: "2026-11-09T12:00:00Z",
};

test("atlasBoard calls atlas_board and returns the parsed snapshot", async () => {
  const calls = [];
  const result = await atlasBoard(fakeCall(calls, { atlas_board: JSON.stringify(BOARD) }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.board, BOARD);
  assert.deepEqual(calls, [{ name: "atlas_board", args: { view: "full" } }]);
});

test("atlasBoard: a JSON error key is an error, never a board", async () => {
  const result = await atlasBoard(fakeCall([], {
    atlas_board: JSON.stringify({ error: "platform gate: forbidden" }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.board, undefined);
  assert.match(result.error, /platform gate/);
});

test("atlasBoard: the undeployed unknown-tool rejection is a clean error", async () => {
  // Before the gateway tool ships, callTool rejects (JSON-RPC error) -- the
  // section must render this as unavailable, not throw through the IPC.
  const result = await atlasBoard(fakeCall([], {
    atlas_board: new Error("atlas_board: unknown tool"),
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown tool/);
});

test("atlasBoard: non-JSON prose is an error with a shape", async () => {
  const result = await atlasBoard(fakeCall([], { atlas_board: "Not Found" }));
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("atlasDigest calls atlas_digest and returns its result", async () => {
  const calls = [];
  const result = await atlasDigest(fakeCall(calls, {
    atlas_digest: JSON.stringify({ ok: true, message_id: "msg-2", sent_to: "owner" }),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.result.message_id, "msg-2");
  assert.deepEqual(calls, [{ name: "atlas_digest", args: {} }]);
});

test("atlasDigest: a transport failure never throws", async () => {
  const result = await atlasDigest(fakeCall([], {
    atlas_digest: new Error("gateway timeout"),
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /gateway timeout/);
});

test("atlasPresence calls atlas_presence and returns the agents; undeployed = a clean error", async () => {
  const { atlasPresence } = require("./atlas-client.cjs");
  const calls = [];
  const body = { agents: [{ agent: "atlas", state: "working", work: [], discord: null, thread_url: "" }], updated_at: 1 };
  const ok = await atlasPresence(fakeCall(calls, { atlas_presence: JSON.stringify(body) }));
  assert.deepEqual(calls.map((c) => c.name), ["atlas_presence"]);
  assert.equal(ok.ok, true);
  assert.equal(ok.presence.agents[0].agent, "atlas");
  const missing = await atlasPresence(fakeCall([], { atlas_presence: new Error("unknown tool: atlas_presence") }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /unknown tool/);
});
