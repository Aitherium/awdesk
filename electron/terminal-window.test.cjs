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
