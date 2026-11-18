"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { terminalHandlers, fromTerminalPage } = require("./terminal-window.cjs");

const sender = (url) => ({ id: 7, getURL: () => url, send() {}, once() {}, isDestroyed: () => false });

test("only aither://terminal may reach a shell", () => {
  assert.equal(fromTerminalPage(sender("aither://terminal/")), true);
  assert.equal(fromTerminalPage(sender("aither://settings/")), false);
  assert.equal(fromTerminalPage(sender("https://terminal.evil/")), false);
  assert.equal(fromTerminalPage(sender("file:///C:/terminal.html")), false);
});

test("every channel refuses another sender before touching the client", async () => {
  let touched = 0;
  const client = new Proxy({}, { get: () => () => { touched++; return { ok: true }; } });
  const handlers = terminalHandlers(client);
  for (const [channel, handler] of Object.entries(handlers)) {
    const r = await handler({ sender: sender("https://example.com/") }, "s1", "ls");
    assert.equal(r.ok, false, channel);
  }
  assert.equal(touched, 0);
  const ok = await handlers["desk:terminal-input"]({ sender: sender("aither://terminal/") }, "s1", "ls");
  assert.equal(ok.ok, true);
  assert.equal(touched, 1);
});

test("the dock's verbs reach the browser window only from the terminal page", async () => {
  const runs = [];
  const host = { run: (action, arg) => { runs.push([action, arg]); return { ok: true }; } };
  const handlers = terminalHandlers({}, { dock: () => host });
  const refused = await handlers["desk:terminal-dock"]({ sender: sender("https://example.com/") }, "toggle");
  assert.equal(refused.ok, false);
  assert.equal(runs.length, 0);
  const ok = await handlers["desk:terminal-dock"]({ sender: sender("aither://terminal/?dock=1") }, "popout", "abc");
  assert.equal(ok.ok, true);
  assert.deepEqual(runs, [["popout", "abc"]]);
  const none = terminalHandlers({}, { dock: () => null });
  const lone = await none["desk:terminal-dock"]({ sender: sender("aither://terminal/") }, "open");
  assert.equal(lone.ok, false, "a terminal page with no browser window has no dock to drive");
});

test("a stage hears which shell it is working in: attach, detach and a real close", async () => {
  const seen = [];
  const client = {
    stream: async () => ({ ok: true }),
    close: async (id) => (id === "keep" ? { ok: false, error: "the daemon said no" } : { ok: true }),
  };
  const page = { sender: sender("aither://terminal/") };
  const handlers = terminalHandlers(client, { onSession: () => (id, action) => seen.push([id, action]) });
  await handlers["desk:terminal-attach"](page, "s1", 0);
  await handlers["desk:terminal-detach"](page, "s1");
  await handlers["desk:terminal-close"](page, "s2");
  await handlers["desk:terminal-close"](page, "keep");
  assert.deepEqual(seen, [["s1", "attach"], ["s1", "detach"], ["s2", "detach"]], "a refused close keeps the session");
  // A watcher that throws is bookkeeping breaking, never a shell: attach still succeeds.
  const safe = terminalHandlers(client, { onSession: () => () => { throw new Error("bookkeeping"); } });
  assert.equal((await safe["desk:terminal-attach"](page, "s3", 0)).ok, true);
});

test("Ctrl+` (or Cmd+`) alone toggles the dock; popout refuses a bad id", () => {
  const bw = require("./browser-window.cjs");
  assert.equal(bw.isDockKey({ type: "keyDown", control: true, code: "Backquote", key: "`" }), true);
  assert.equal(bw.isDockKey({ type: "keyDown", meta: true, key: "`" }), true);
  assert.equal(bw.isDockKey({ type: "keyDown", control: true, shift: true, code: "Backquote" }), false);
  assert.equal(bw.isDockKey({ type: "keyUp", control: true, code: "Backquote" }), false);
  assert.equal(bw.isDockKey({ type: "keyDown", code: "Backquote" }), false);
  assert.equal(bw.dockAction("popout", "../../etc").ok, false);
  assert.equal(bw.dockAction("rm -rf").ok, false);
});
