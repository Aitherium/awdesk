"use strict";

// desk-inbox: "My devices" messages reach the desk as a notification (+ voice when asked),
// read with the Online session's own bearer; the first answer never replays old messages.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDeskInbox, ROUTE } = require("./desk-inbox.cjs");

function harness(replies, { token = "tok" } = {}) {
  const calls = [];
  const shown = [];
  const said = [];
  const inbox = createDeskInbox({
    token: async () => token,
    notify: (title, body, urgent) => shown.push({ title, body, urgent }),
    speak: (text) => said.push(text),
    apiBase: "https://api.test",
    schedule: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const r = replies.shift() || { status: 200, body: { items: [] } };
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    },
  });
  return { inbox, calls, shown, said };
}

test("the first answer sets the cursor and shows nothing", async () => {
  const h = harness([{ status: 200, body: { items: [{ id: "old", title: "t", body: "old" }], now: 100 } }]);
  await h.inbox.tick();
  assert.equal(h.shown.length, 0);
  assert.equal(h.inbox.cursor(), 100);
  assert.equal(h.calls[0].url, `https://api.test${ROUTE}`);
  assert.equal(h.calls[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(h.calls[0].body, { since: 0, wait_s: 0 });
});

test("new messages toast once, and speak only when asked", async () => {
  const items = [
    { id: "a", title: "Message to all your devices", body: "Dinner", speak: true, urgent: false, created_at: 101 },
    { id: "b", title: "Message to all your devices", body: "Quiet one", speak: false, created_at: 102 },
  ];
  const h = harness([
    { status: 200, body: { items: [], now: 100 } },
    { status: 200, body: { items, cursor: 102 } },
    { status: 200, body: { items: [items[0]], cursor: 102 } },
  ]);
  await h.inbox.tick();
  await h.inbox.tick();
  await h.inbox.tick();
  assert.deepEqual(h.shown.map((s) => s.body), ["Dinner", "Quiet one"]);
  assert.deepEqual(h.said, ["Dinner"]);
  assert.equal(h.inbox.cursor(), 102);
  assert.deepEqual(h.calls[1].body, { since: 100, wait_s: 20 });
});

test("signed out: no request at all", async () => {
  const h = harness([], { token: null });
  const delay = await h.inbox.tick();
  assert.equal(h.calls.length, 0);
  assert.ok(delay > 0);
});

test("a refusal or an outage never throws and backs off", async () => {
  const h = harness([{ status: 401, body: {} }, { status: 502, body: {} }]);
  assert.ok((await h.inbox.tick()) > 0);
  assert.ok((await h.inbox.tick()) > 0);
  assert.equal(h.shown.length, 0);
});
