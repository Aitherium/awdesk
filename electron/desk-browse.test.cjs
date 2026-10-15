"use strict";

/**
 * aither-host/1 `desk-browse` (2026-10-14): the AitherOS Online Browser app, running
 * inside the desk, opens a URL in the desk's NATIVE Aither Browser instead of a remote
 * session. Pinned here:
 *   - the preload relays it only with a human gesture and ALWAYS answers (so the page
 *     falls back at once), pinned to the page's origin, with the request's reqId;
 *   - main's IPC is fenced to desk-hosted pages and survives a throwing handler;
 *   - main opens it through browser-policy's URL check (the bridge's /browser/open act).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const protocol = JSON.parse(fs.readFileSync(path.join(__dirname, "aither-host-protocol.json"), "utf8"));
const PRELOAD = fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8");

function loadPreload({ active = true, invoke = async () => null } = {}) {
  const listeners = { message: [] };
  const posted = [];
  const invoked = [];
  const win = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    postMessage: (data, target) => posted.push([JSON.parse(JSON.stringify(data)), target]),
    location: { origin: "https://aitherium.com" },
  };
  const ctx = vm.createContext({
    window: win,
    document: { documentElement: { setAttribute() {} } },
    navigator: { userActivation: { isActive: active } },
    sessionStorage: { getItem: () => null, setItem() {} },
    process: { argv: [] },
    require: () => ({
      ipcRenderer: { on() {}, send() {}, invoke: async (ch, ...a) => { invoked.push([ch, ...a]); return invoke(ch, ...a); } },
    }),
  });
  vm.runInContext(PRELOAD, ctx);
  const send = async (data, { source = win, origin = "https://aitherium.com" } = {}) => {
    for (const fn of listeners.message) await fn({ source, origin, data });
  };
  return { send, posted, invoked };
}

test("desk-browse and desk-browse-result are messages of the contract, on the desk plane", () => {
  assert.deepEqual(protocol.messages["desk-browse"], { dir: "os→host", plane: "desk", fields: ["reqId", "url"] });
  assert.deepEqual(protocol.messages["desk-browse-result"], { dir: "host→os", plane: "desk", fields: ["reqId", "ok", "url", "error"] });
});

test("with a human gesture the preload asks main and answers with main's verdict", async () => {
  const p = loadPreload({ invoke: async () => ({ ok: true, url: "https://github.com/" }) });
  await p.send({ __aither: "desk-browse", reqId: "b1", url: "https://github.com" });
  assert.deepEqual(p.invoked, [["living-desktop:browse", "https://github.com"]]);
  assert.deepEqual(p.posted, [[{ __aither: "desk-browse-result", reqId: "b1", ok: true, url: "https://github.com/", error: "" }, "https://aitherium.com"]]);
});

test("without a human gesture nothing opens, and the page is told why at once", async () => {
  const p = loadPreload({ active: false, invoke: async () => ({ ok: true }) });
  await p.send({ __aither: "desk-browse", reqId: "b2", url: "https://github.com" });
  assert.deepEqual(p.invoked, []);
  assert.equal(p.posted.length, 1);
  assert.equal(p.posted[0][0].ok, false);
  assert.match(p.posted[0][0].error, /click or key press/);
});

test("a failing main still answers; another window or origin is ignored", async () => {
  const p = loadPreload({ invoke: async () => { throw new Error("main gone"); } });
  await p.send({ __aither: "desk-browse", reqId: "b3", url: "https://github.com" });
  assert.deepEqual(p.posted, [[{ __aither: "desk-browse-result", reqId: "b3", ok: false, url: "", error: "main gone" }, "https://aitherium.com"]]);
  await p.send({ __aither: "desk-browse", reqId: "b4", url: "https://x.test" }, { source: {} });
  await p.send({ __aither: "desk-browse", reqId: "b5", url: "https://x.test" }, { origin: "https://evil.test" });
  assert.equal(p.posted.length, 1);
});

function loadWindowModule() {
  const handles = {};
  const fake = {
    BrowserWindow: function BrowserWindow() {},
    ipcMain: { on() {}, handle(ch, fn) { handles[ch] = fn; } },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => ({ workArea: {} }) },
    session: { fromPartition: () => ({ cookies: { get: async () => [], set: async () => {}, remove: async () => {} } }) },
    shell: { openExternal: async () => {} },
  };
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return fake;
    return original.call(this, request, ...rest);
  };
  try {
    const file = require.resolve("./living-desktop-window.cjs");
    delete require.cache[file];
    return { ldw: require(file), handles };
  } finally {
    Module._load = original;
  }
}

test("main's living-desktop:browse is fenced to desk-hosted pages and never throws", async () => {
  const { ldw, handles } = loadWindowModule();
  const fn = handles["living-desktop:browse"];
  assert.equal(typeof fn, "function");
  const hostWc = { isDestroyed: () => false };
  const opened = [];
  ldw.setExtraHosts(() => [hostWc]);
  ldw.setOverlayHost({ browse: (url) => { opened.push(url); return { ok: true, url }; } });
  assert.deepEqual(await fn({ sender: {} }, "https://github.com"), { ok: false, error: "not the AitherOS Online overlay" });
  assert.deepEqual(opened, []);
  assert.deepEqual(await fn({ sender: hostWc }, "https://github.com"), { ok: true, url: "https://github.com" });
  ldw.setOverlayHost({ browse: () => { throw new Error("browser died"); } });
  assert.deepEqual(await fn({ sender: hostWc }, "https://github.com"), { ok: false, error: "browser died" });
  ldw.setOverlayHost({});
  assert.equal((await fn({ sender: hostWc }, "https://github.com")).ok, false);
  ldw.setOverlayHost(null);
  ldw.setExtraHosts(null);
});

test("main opens a desk-browse URL as a new OWNER tab, through browser-policy's URL check", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const block = main.match(/ {2}browse: \(url\) => \{[\s\S]*?\n {2}\},/);
  assert.ok(block, "setOverlayHost has a browse handler");
  assert.match(block[0], /browserPolicy\.sanitizeUrl\(url\)/);
  assert.match(block[0], /if \(!verdict\.ok\) return \{ ok: false, error: verdict\.reason \}/);
  assert.match(block[0], /createBrowserWindow\(\{ askAgent: browserAskAgent, url: verdict\.url \}\)/);
  const policy = require("./browser-policy.cjs");
  assert.equal(policy.sanitizeUrl("javascript:alert(1)").ok, false);
  assert.equal(policy.sanitizeUrl("https://github.com").ok, true);
});
