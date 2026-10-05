"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ext = require("./browser-extensions.cjs");

const ID = "hhnjemffdkpakbnimmkkcjagddakagcd";

test("the staged awconnect build is found; an override wins; 0 turns it off", () => {
  const home = path.join("H:", "home");
  const staged = path.join(home, ".aither", "awconnect", "current");
  const has = (set) => (file) => set.includes(file);
  assert.equal(ext.awconnectDir({ env: {}, home, exists: has([path.join(staged, "manifest.json")]) }), staged);
  assert.equal(ext.awconnectDir({ env: { DESK_AWCONNECT_DIR: "X:\\b" }, home,
    exists: has([path.join("X:\\b", "manifest.json"), path.join(staged, "manifest.json")]) }), "X:\\b");
  assert.equal(ext.awconnectDir({ env: { DESK_AWCONNECT: "0" }, home, exists: () => true }), null);
  assert.equal(ext.awconnectDir({ env: {}, home, exists: () => false }), null);
});

test("a tab may hold only the loaded extension's own pages", () => {
  assert.equal(ext.isExtensionPage(`chrome-extension://${ID}/sidepanel/sidepanel.html`, ID), true);
  assert.equal(ext.isExtensionPage(`chrome-extension://${"a".repeat(32)}/x.html`, ID), false);
  assert.equal(ext.isExtensionPage("https://example.com/", ID), false);
  assert.equal(ext.isExtensionPage(`chrome-extension://${ID}/x`, undefined), false, "nothing loaded = nothing allowed");
  assert.equal(ext.uiUrl(ID), `chrome-extension://${ID}/sidepanel/sidepanel.html`);
  assert.equal(ext.uiPath({ side_panel: { default_path: "panel/p.html" } }), "panel/p.html");
  assert.equal(ext.uiPath({ action: { default_popup: "popup/popup.html" } }), "popup/popup.html");
  assert.equal(ext.uiPath({ side_panel: { default_path: "../../etc.html" } }), ext.UI_PAGE);
  assert.equal(ext.uiPath({ side_panel: { default_path: "https://evil/x.html" } }), ext.UI_PAGE);
  assert.equal(ext.uiUrl("../x"), null);
});

test("load: once per folder, through ses.extensions when Electron has it", async () => {
  const loaded = [];
  const ses = { extensions: {
    getAllExtensions: () => loaded,
    loadExtension: async (dir) => {
      const e = { id: ID, name: "awconnect", version: "3.8.0", path: dir };
      loaded.push(e);
      return e;
    },
  } };
  const a = await ext.loadAwconnect(ses, { dir: "C:\\aw" });
  const b = await ext.loadAwconnect(ses, { dir: "C:\\aw" });
  assert.equal(a.ok && b.ok, true);
  assert.equal(loaded.length, 1);
  assert.equal((await ext.loadAwconnect(ses, { dir: null })).ok, false);
  assert.equal((await ext.loadAwconnect({}, { dir: "C:\\aw" })).ok, false);
});

test("the compat shim fills only what is missing, maps storage.sync to local, and runs once", () => {
  const { compatShim } = require("./awconnect-compat-preload.cjs");
  const realQuery = () => "real";
  const local = { get: () => "local" };
  globalThis.chrome = { tabs: { query: realQuery }, storage: { local, get sync() { throw new Error("not available"); } } };
  compatShim();
  assert.equal(globalThis.chrome.cookies, undefined, "off an extension origin it does nothing");
  globalThis.location = { protocol: "chrome-extension:" };
  compatShim();
  const c = globalThis.chrome;
  assert.equal(c.tabs.query(), "real", "a real member is kept");
  assert.equal(typeof c.tabs.onActivated.addListener, "function", "a missing event is a stub");
  assert.equal(typeof c.cookies.onChanged.addListener, "function", "a missing namespace is a stub");
  assert.equal(c.storage.sync, local, "storage.sync -> storage.local");
  const tabs = c.tabs;
  compatShim();
  assert.equal(c.tabs, tabs, "a second run wraps nothing twice");
  delete globalThis.chrome;
  delete globalThis.location;
});
