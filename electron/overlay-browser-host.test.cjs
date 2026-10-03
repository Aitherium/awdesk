"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const host = require("./overlay-browser-host.cjs");
const { AgentGate, createBrowserAgent } = require("./browser-policy.cjs");

function realAgent() {
  const calls = [];
  const gate = new AgentGate();
  const driver = {
    open: async () => ({ ok: true }),
    read: async () => { calls.push(["read"]); return { ok: true, url: "https://a.test/", title: "A", text: "body" }; },
    tabs: async () => ({ ok: true, tabs: [{ id: 1, by: "you" }, { id: 2, by: "agent", agentTarget: true, url: "https://a.test/", title: "A" }] }),
    click: async (t) => { calls.push(["click", t]); return { ok: true, label: "Send" }; },
    type: async (t, x) => { calls.push(["type", t, x]); return { ok: true, label: "Name" }; },
    press: async (k) => { calls.push(["press", k]); return { ok: true }; },
  };
  return { gate, calls, agent: createBrowserAgent({ gate, driver }) };
}

test("os→page goes through the browser's agent dispatcher, with Veil's reply shape", async () => {
  const { agent, calls } = realAgent();
  assert.deepEqual(await host.hostPageAction(agent, { action: "read" }), { ok: true, text: "body", url: "https://a.test/", title: "A" });
  assert.deepEqual(await host.hostPageAction(agent, { action: "info" }), { ok: true, url: "https://a.test/", title: "A" });
  assert.deepEqual(await host.hostPageAction(agent, { action: "click", selector: "#go" }), { ok: true, text: "Send" });
  assert.deepEqual(await host.hostPageAction(agent, { action: "type", selector: "#n", text: "Al" }), { ok: true, text: "Name" });
  assert.deepEqual(await host.hostPageAction(agent, { action: "key", key: "Return" }), { ok: true });
  assert.deepEqual(await host.hostPageAction(agent, { action: "scroll" }), { ok: true });
  assert.deepEqual(calls, [["read"], ["click", { selector: "#go" }], ["type", { selector: "#n" }, "Al"], ["press", "Enter"], ["press", "PageDown"]]);
});

test("the owner's Take over stops the overlay too; junk is refused, never thrown", async () => {
  const { agent, gate, calls } = realAgent();
  gate.takeOver();
  const refused = await host.hostPageAction(agent, { action: "click", selector: "#go" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^REFUSED: the owner has taken over/);
  assert.equal(calls.length, 0);
  gate.handBack();
  assert.match((await host.hostPageAction(agent, { action: "eval" })).error, /unknown page action/);
  assert.match((await host.hostPageAction(agent, { action: "key", key: "Ctrl+W" })).error, /not one the browser presses/);
  assert.equal((await host.hostPageAction(agent, { action: "click", selector: "" })).ok, false);
  const boom = await host.hostPageAction(async () => { throw new Error("gone"); }, { action: "read" });
  assert.deepEqual(boom, { ok: false, error: "gone" });
});

test("page context: an owner's tab gives no text; an agent's does", () => {
  const page = { ok: true, url: "https://bank.test/acct", title: "Bank", text: "balance 100", headings: ["Accounts"], description: "d" };
  const mine = host.hostContext(page, "you", () => 7);
  assert.equal(mine.text, "", "the owner's page text never reaches the overlay");
  assert.equal(mine.host, "bank.test");
  assert.deepEqual(mine.headings, ["Accounts"]);
  assert.equal(mine.owner, "you");
  assert.equal(host.hostContext(page, "agent").text, "balance 100");
  assert.equal(host.hostContext({ ok: false }, "agent"), null);
  assert.equal(host.hostContext(null, "agent"), null);
});

test("the card's summary, and the command allowlist", () => {
  assert.deepEqual(host.browserSummary(null), { open: false });
  const s = host.browserSummary({
    open: true,
    agent: { driving: true, paused: true, handoff: { reason: "Tick the captcha" }, lastAction: { tool: "browser_type" } },
    tabs: [{ id: 1, by: "you" }, { id: 2, by: "agent", agentTarget: true, title: "Form", url: "https://f.test/" }],
  });
  assert.deepEqual(s, { open: true, driving: true, paused: true, handoff: { reason: "Tick the captcha" },
    lastTool: "browser_type", agentTab: { title: "Form", url: "https://f.test/" }, tabCount: 2 });
  for (const id of host.DESK_COMMANDS) assert.equal(host.allowedCommand(id), true);
  for (const id of ["fleet.stop", "browser.open; rm", "", "desktop.signout"]) assert.equal(host.allowedCommand(id), false, id);
});

test("the overlay preload relays only same-window, same-origin messages, and the IPC checks its sender", () => {
  const preload = fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8");
  assert.match(preload, /if \(event\.source !== window \|\| event\.origin !== window\.location\.origin\) return;/);
  assert.match(preload, /setAttribute\("data-aither-host", "desk"\)/);
  assert.match(preload, /if \(!activation \|\| !activation\.isActive\) return;/, "a desk command needs a real click");
  const win = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  for (const channel of ["host-page", "host-context", "desk-command"]) {
    assert.match(win, new RegExp(`"living-desktop:${channel}"[^\\n]*\\n\\s*if \\(!fromOverlay\\(event\\)`), channel);
  }
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /if \(!overlayBrowserHost\.allowedCommand\(id\)\) return;/);
  assert.match(main, /browser: overlayBrowserHost\.browserSummary\(browserWindow\.getState\(\)\)/);
});
