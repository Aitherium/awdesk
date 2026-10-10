"use strict";

/**
 * aither-host/1 on the desk side: living-desktop-preload.cjs is pinned to the
 * aither-host-protocol.json that ships beside it (Veil's test pins that copy to Veil's
 * and awconnect's, byte for byte). The preload runs in a vm exactly as Electron runs
 * a sandboxed preload: `require("electron")` only.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const protocol = JSON.parse(fs.readFileSync(path.join(__dirname, "aither-host-protocol.json"), "utf8"));
const PRELOAD = fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8");

/** Run the preload; returns its message listener and what it posted. */
function loadPreload({ argv = [], invoke = async () => null } = {}) {
  const listeners = { message: [] };
  const ipcOn = {};
  const posted = [];
  const ipcSent = [];
  const win = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    postMessage: (data, target) => posted.push([JSON.parse(JSON.stringify(data)), target]),
    location: { origin: "https://aitherium.com" },
  };
  const attrs = {};
  const ctx = vm.createContext({
    window: win,
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
    navigator: {},
    sessionStorage: { getItem: () => null, setItem() {} },
    process: { argv },
    require: (name) => {
      assert.equal(name, "electron", "a sandboxed preload may require only electron");
      return { ipcRenderer: { on: (ch, fn) => { ipcOn[ch] = fn; }, send: (...a) => ipcSent.push(a), invoke } };
    },
  });
  vm.runInContext(PRELOAD, ctx);
  const send = async (data, { source = win, origin = "https://aitherium.com" } = {}) => {
    for (const fn of listeners.message) await fn({ source, origin, data });
  };
  return { send, posted, ipcSent, attrs, win, ipcOn };
}

test("os-hello is answered with host-hello on the page's own window, pinned to its origin", async () => {
  const p = loadPreload();
  await p.send({ __aither: "os-hello", protocol: "aither-host/1", planes: ["page"] });
  const hellos = p.posted.filter(([m]) => m.__aither === "host-hello");
  assert.equal(hellos.length, 1);
  const [msg, target] = hellos[0];
  assert.equal(target, "https://aitherium.com");
  assert.equal(msg.protocol, protocol.protocol);
  assert.equal(msg.host, "desk");
  for (const field of protocol.messages["host-hello"].fields) assert.ok(field in msg, field);
  for (const plane of msg.planes) assert.ok(plane in protocol.planes, plane);
  // Everything the OS assumed of an old desk is still answered.
  for (const plane of protocol.legacyPlanes.desk) assert.ok(msg.planes.includes(plane), plane);
  assert.ok(protocol.chrome.taskbar.includes(msg.chrome.taskbar));
});

test("the taskbar owner follows the context: the browser strip in the hosted tab, the OS dock in the overlay window", async () => {
  const overlay = loadPreload();
  await overlay.send({ __aither: "os-hello" });
  assert.equal(overlay.posted.find(([m]) => m.__aither === "host-hello")[0].chrome.taskbar, "os");
  const tab = loadPreload({ argv: ["--aither-desk-surface=browser-tab"] });
  await tab.send({ __aither: "os-hello" });
  assert.equal(tab.posted.find(([m]) => m.__aither === "host-hello")[0].chrome.taskbar, "host");
});

test("a hello from a child frame or another origin is not answered", async () => {
  const p = loadPreload();
  await p.send({ __aither: "os-hello" }, { source: {} });
  await p.send({ __aither: "os-hello" }, { origin: "https://evil.test" });
  assert.equal(p.posted.filter(([m]) => m.__aither === "host-hello").length, 0);
});

test("every kind the preload handles or posts is a message of the contract", () => {
  const kinds = new Set();
  // `data.__aither === "x"` (handled) and `{ __aither: "x"` (posted); not `typeof ... "string"`.
  for (const m of PRELOAD.matchAll(/(?:(?<!typeof )data\.__aither\s*(?:===|!==)|\{\s*__aither:)\s*"([^"]+)"/g)) kinds.add(m[1]);
  assert.ok(kinds.size >= 8, `found ${[...kinds].join(", ")}`);
  for (const k of kinds) assert.ok(protocol.messages[k], `${k} is not in aither-host-protocol.json`);
});

test("one identity: os-token-request is answered from main's Online session, pinned to the origin", async () => {
  const asked = [];
  const p = loadPreload({ invoke: async (ch) => { asked.push(ch); return ch === "living-desktop:host-token" ? { token: "platform-bearer" } : {}; } });
  await p.send({ __aither: "os-token-request" });
  assert.deepEqual(asked, ["living-desktop:host-token"]);
  assert.deepEqual(p.posted, [[{ __aither: "os-token", token: "platform-bearer" }, "https://aitherium.com"]]);
});

test("one identity: signed in, identity is left to the OS; signed out, it is null", async () => {
  let signedIn = true;
  const p = loadPreload({ invoke: async () => (signedIn ? {} : { identity: null }) });
  await p.send({ __aither: "os-identity-request" });
  assert.equal(p.posted.length, 0, "signed in: nothing (the OS keeps what it verified)");
  signedIn = false;
  await p.send({ __aither: "os-identity-request" });
  assert.deepEqual(p.posted, [[{ __aither: "os-identity", identity: null }, "https://aitherium.com"]]);
});

test("one identity: a failed IPC posts nothing (never read as a sign-out)", async () => {
  const p = loadPreload({ invoke: async () => { throw new Error("main gone"); } });
  await p.send({ __aither: "os-token-request" });
  await p.send({ __aither: "os-identity-request" });
  assert.equal(p.posted.length, 0);
});

test("one identity: main's sign-out reaches the OS as token:null and identity:null; sign-in as a fresh bearer", async () => {
  const p = loadPreload({ invoke: async () => ({ token: "fresh" }) });
  const auth = p.ipcOn["living-desktop:auth"];
  assert.equal(typeof auth, "function");
  await auth({}, false);
  await auth({}, true);
  assert.deepEqual(p.posted, [
    [{ __aither: "os-token", token: null }, "https://aitherium.com"],
    [{ __aither: "os-identity", identity: null }, "https://aitherium.com"],
    [{ __aither: "os-token", token: "fresh" }, "https://aitherium.com"],
  ]);
});

test("one identity: the desk declares the identity and token planes, and no renderer sees a local token", () => {
  assert.match(PRELOAD, /DESK_PLANES = Object\.freeze\(\[[^\]]*"identity"[^\]]*"token"/);
  for (const f of ["living-desktop-preload.cjs", "living-desktop-window.cjs", "awconnect-compat-preload.cjs"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assert.doesNotMatch(src, /X-Aither-Local-Token|daemon-token|harness-token/i, f);
  }
  const win = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  for (const channel of ["host-token", "host-identity"]) {
    assert.match(win, new RegExp(`"living-desktop:${channel}"[^\\n]*\\n\\s*if \\(!fromOverlay\\(event\\)`), channel);
  }
});
