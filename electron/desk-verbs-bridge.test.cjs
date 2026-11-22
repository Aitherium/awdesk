"use strict";

// window.aitherDeskVerbs (2026-11-07): the bridge Veil's aitherone-canvas desk.ts
// detects. Exposed by the desk-host preload, gated on a human gesture, fenced in main.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PRELOAD = fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8");

function load({ active = true } = {}) {
  const exposed = {};
  const invoked = [];
  const ctx = vm.createContext({
    window: { addEventListener() {}, postMessage() {}, location: { origin: "https://aitherium.com" } },
    document: { documentElement: { setAttribute() {} } },
    navigator: { userActivation: { isActive: active } },
    sessionStorage: { getItem: () => null, setItem() {} },
    process: { argv: [] },
    require: () => ({
      ipcRenderer: { on() {}, send() {}, invoke: async (ch, msg) => { invoked.push([ch, msg]); return { ok: true, id: "pin-x" }; } },
      contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    }),
  });
  vm.runInContext(PRELOAD, ctx);
  return { api: exposed.aitherDeskVerbs, invoked };
}

test("the bridge exists with the agreed name and shape", () => {
  const { api } = load();
  assert.ok(api, "window.aitherDeskVerbs is exposed");
  assert.equal(api.version, 1);
  for (const fn of ["pin", "ink", "gif", "canvas"]) assert.equal(typeof api[fn], "function", fn);
});

test("pin sends only the card's own fields, through the fenced desk-verb channel", async () => {
  const { api, invoked } = load();
  const r = await api.pin({ kind: "url", src: "https://example.com/", title: "Ex", evil: "x", bounds: { x: 1, y: 2, width: 3, height: 4, z: 9 } });
  assert.deepEqual(r, { ok: true, id: "pin-x" });
  assert.equal(invoked[0][0], "living-desktop:desk-verb");
  assert.deepEqual(JSON.parse(JSON.stringify(invoked[0][1])), { verb: "pin",
    item: { kind: "url", src: "https://example.com/", title: "Ex", bounds: { x: 1, y: 2, width: 3, height: 4 } } });
});

test("no human gesture, no verb: a page script cannot pin or start ink on its own", async () => {
  const { api, invoked } = load({ active: false });
  const r = await api.pin({ kind: "url", src: "https://example.com/" });
  assert.equal(r.ok, false);
  api.ink();
  api.gif("cats");
  assert.deepEqual(invoked, []);
});

test("main fences desk-verb to desk hosts and allows only the four verbs", () => {
  const src = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  const block = /ipcMain\.handle\("living-desktop:desk-verb"[\s\S]*?\n\}\);/.exec(src)[0];
  assert.match(block, /if \(!fromOverlay\(event\)\) return/);
  assert.match(src, /const DESK_VERBS = new Set\(\["pin", "ink", "gif", "canvas"\]\);/);
});
