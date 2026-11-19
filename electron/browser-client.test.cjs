"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { desktopSnapshot, browserHistory } = require("./browser-client.cjs");

// The host probe is injected so no test spawns PowerShell/osascript/xprop.
const hostDown = async () => ({ ok: false, platform: "win32", reason: "probe timed out" });
const hostUp = async () => ({
  ok: true, platform: "win32", app: "Code", title: "Deck.tsx", pid: 4242, exe: "C:/Code.exe",
});
// What the Linux gateway container answers on EVERY machine (the owner's bug).
const GATEWAY_LINUX = JSON.stringify({
  available: false,
  message: "Desktop context tools require Windows platform",
});

function fakeCall(calls) {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "get_active_window") {
      return JSON.stringify({ process: "Code.exe", title: "Desk.tsx" });
    }
    if (name === "browser_context") {
      return JSON.stringify({ url: "https://aitherium.com", title: "Portal" });
    }
    throw new Error(`unexpected tool ${name}`);
  };
}

test("desktopSnapshot aggregates the focused window and the active tab", async () => {
  const calls = [];
  const snap = await desktopSnapshot(fakeCall(calls), hostDown);
  assert.equal(snap.ok, true);
  assert.equal(snap.window.process, "Code.exe");
  assert.equal(snap.window.source, "gateway");
  assert.match(snap.window.hostReason, /probe timed out/);
  assert.equal(snap.context.url, "https://aitherium.com");
  assert.ok(snap.at > 0);
  assert.deepEqual(
    calls.map((c) => c.name).sort(),
    ["browser_context", "get_active_window"],
  );
});

test("a failing source degrades to an ERROR note, not a failed snapshot", async () => {
  const snap = await desktopSnapshot(async (name) => {
    if (name === "browser_context") throw new Error("no active tab");
    return JSON.stringify({ process: "Code.exe" });
  }, hostDown);
  assert.equal(snap.ok, true);
  assert.match(snap.context.note, /no active tab/);
});

test("a dead transport degrades every source to an ERROR note", async () => {
  const snap = await desktopSnapshot(async () => {
    throw new Error("no session bearer");
  }, hostDown);
  assert.equal(snap.ok, true);
  assert.match(snap.window.note, /no session bearer/);
  assert.match(snap.context.note, /no session bearer/);
});

test("the host sample wins over a Linux gateway that says available:false", async () => {
  const calls = [];
  const snap = await desktopSnapshot(async (name, args) => {
    calls.push({ name, args });
    if (name === "get_active_window") return GATEWAY_LINUX;
    return JSON.stringify({ url: "https://aitherium.com", title: "Portal" });
  }, hostUp);
  assert.equal(snap.ok, true);
  assert.notEqual(snap.window.available, false);
  assert.equal(snap.window.source, "host");
  assert.equal(snap.window.process, "Code");
  assert.equal(snap.window.title, "Deck.tsx");
  assert.equal(snap.context.url, "https://aitherium.com");
  // The gateway is a fallback only: a working host sample never asks it.
  assert.deepEqual(calls.map((c) => c.name), ["browser_context"]);
});

test("host failed AND gateway unavailable stays unavailable, naming both causes", async () => {
  const snap = await desktopSnapshot(async (name) => {
    if (name === "get_active_window") return GATEWAY_LINUX;
    throw new Error("no active tab");
  }, hostDown);
  assert.equal(snap.window.available, false);
  assert.match(snap.window.message, /require Windows platform/);
  assert.match(snap.window.hostReason, /probe timed out/);
});

test("a host answer with no pid is silence, not a window", async () => {
  const snap = await desktopSnapshot(async (name) => {
    if (name === "get_active_window") return GATEWAY_LINUX;
    return "{}";
  }, async () => ({ ok: true, platform: "win32", pid: 0 }));
  assert.equal(snap.window.source, "gateway");
  assert.equal(snap.window.available, false);
});

test("a throwing host sampler falls back to the gateway", async () => {
  const snap = await desktopSnapshot(async (name) => {
    if (name === "get_active_window") return JSON.stringify({ process: "Code.exe" });
    return "{}";
  }, async () => { throw new Error("spawn powershell.exe ENOENT"); });
  assert.equal(snap.window.process, "Code.exe");
  assert.match(snap.window.hostReason, /ENOENT/);
});

test("browserHistory forwards the limit", async () => {
  const calls = [];
  await browserHistory(3, async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify([{ url: "https://x.example" }]);
  });
  assert.deepEqual(calls[0], { name: "browser_context_history", args: { limit: 3 } });
});
