"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChromeBridge } = require("./chrome-bridge.cjs");

test("an agent's call reaches a long-polling awconnect and resolves with its answer", async () => {
  const bridge = createChromeBridge();
  const poll = bridge.next(1000);
  const answer = bridge.call("read", { tab: 7 });
  const request = await poll;
  assert.deepEqual(request, { id: 1, action: "read", args: { tab: 7 } });
  assert.equal(bridge.result(request.id, { ok: true, text: "page" }), true);
  assert.deepEqual(await answer, { ok: true, text: "page" });
  assert.equal(bridge.status().connected, true);
});

test("a call queued before awconnect polls is handed over on the next poll", async () => {
  const bridge = createChromeBridge();
  const answer = bridge.call("tabs");
  const request = await bridge.next(10);
  assert.equal(request.action, "tabs");
  bridge.result(request.id, { ok: true, tabs: [] });
  assert.deepEqual(await answer, { ok: true, tabs: [] });
});

test("no awconnect: the call says so instead of hanging; unknown actions refused at once", async () => {
  let fire = null;
  const bridge = createChromeBridge({ setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  const answer = bridge.call("snapshot", { tab: 1 });
  fire();
  const r = await answer;
  assert.equal(r.ok, false);
  assert.match(r.error, /awconnect is not connected/);
  assert.match((await bridge.call("eval", {})).error, /unknown chrome action/);
});

test("a result for an unknown or already-settled id is ignored; a poll with nothing to do returns null", async () => {
  const bridge = createChromeBridge();
  assert.equal(bridge.result(999, { ok: true }), false);
  assert.equal(await bridge.next(5), null);
  const answer = bridge.call("tabs");
  const req = await bridge.next(5);
  bridge.result(req.id, { ok: true, n: 1 });
  assert.equal(bridge.result(req.id, { ok: true, n: 2 }), false, "the first answer wins");
  assert.deepEqual(await answer, { ok: true, n: 1 });
});
