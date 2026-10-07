"use strict";

// Stage Manager on the Living Desktop overlay: the overlay WINDOW's OS focus is
// forwarded to the Veil shell as {__aither:'os-host-focus', focused}. Both halves run
// for real here: main's wireHostFocus against a fake BrowserWindow, and the preload
// in a vm with a fake ipcRenderer + window.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

/** living-desktop-window.cjs wires ipcMain at load: give it an inert electron. */
function loadWindowModule() {
  const fake = {
    BrowserWindow: function BrowserWindow() {},
    ipcMain: { on() {}, handle() {} },
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
    return require(file);
  } finally {
    Module._load = original;
  }
}

function fakeWin() {
  const handlers = {};
  const sent = [];
  let destroyed = false;
  return {
    handlers, sent,
    destroy() { destroyed = true; },
    isDestroyed: () => destroyed,
    on(name, fn) { handlers[name] = fn; },
    webContents: { send: (channel, value) => sent.push([channel, value]) },
  };
}

test("blur/focus of the overlay window reach the shell's host-focus channel", () => {
  const ldw = loadWindowModule();
  const win = fakeWin();
  ldw.wireHostFocus(win);
  win.handlers.blur();
  win.handlers.focus();
  assert.deepEqual(win.sent, [["living-desktop:host-focus", false], ["living-desktop:host-focus", true]]);
  win.destroy();
  win.handlers.blur();
  assert.equal(win.sent.length, 2, "a destroyed window sends nothing");
  const throwing = fakeWin();
  throwing.webContents.send = () => { throw new Error("closing"); };
  ldw.wireHostFocus(throwing);
  assert.doesNotThrow(() => throwing.handlers.blur(), "a send during close never throws into Electron");
});

test("createWindow wires host focus next to its show/hide handlers", () => {
  const src = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  assert.match(src, /win\.on\("hide", stopGhostLoop\);\n\s*wireHostFocus\(win\);/);
});

test("the preload turns the channel into os-host-focus on the page's own window", () => {
  const listeners = {};
  const posted = [];
  const win = {
    addEventListener() {},
    postMessage: (data, target) => posted.push([data, target]),
    location: { origin: "https://aitherium.com" },
  };
  const ctx = vm.createContext({
    window: win,
    document: { documentElement: { setAttribute() {} } },
    navigator: {},
    require: (name) => {
      assert.equal(name, "electron");
      return { ipcRenderer: { on: (ch, fn) => { listeners[ch] = fn; }, send() {}, invoke: async () => null } };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8"), ctx);
  const fire = listeners["living-desktop:host-focus"];
  assert.equal(typeof fire, "function", "the preload listens on the channel main sends");
  fire({}, false);
  fire({}, true);
  fire({}, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
    [{ __aither: "os-host-focus", focused: false }, "*"],
    [{ __aither: "os-host-focus", focused: true }, "*"],
    [{ __aither: "os-host-focus", focused: true }, "*"],
  ]);
});
