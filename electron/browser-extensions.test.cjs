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
  // awconnect 4.x's manifest (store 4.1.4 / staged 4.1.5): a root-level side panel.
  assert.equal(ext.uiPath({ side_panel: { default_path: "sidepanel.html" }, options_page: "options.html" }), "sidepanel.html");
  assert.equal(ext.uiUrl(ID, "sidepanel.html"), `chrome-extension://${ID}/sidepanel.html`);
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

test("identity: getRedirectURL is a real synchronous callback URL on the extension's own host", () => {
  const { compatShim } = require("./awconnect-compat-preload.cjs");
  const id = "hlmfknhcfhjjngckfpacgleffckpmphe";
  globalThis.location = { protocol: "chrome-extension:", host: id };
  globalThis.chrome = { runtime: { id } };
  compatShim(null);
  const identity = globalThis.chrome.identity;
  assert.equal(typeof identity.getRedirectURL(), "string", "a string, not the Promise the old stub returned");
  assert.equal(identity.getRedirectURL(), `https://${id}.chromiumapp.org/`);
  assert.equal(identity.getRedirectURL("cb"), `https://${id}.chromiumapp.org/cb`);
  assert.equal(identity.getRedirectURL("/cb?x=1"), `https://${id}.chromiumapp.org/cb?x=1`);
  assert.equal(identity.getRedirectURL("https://evil.example/x"), `https://${id}.chromiumapp.org/`, "an absolute URL never leaves the callback host");
  assert.equal(identity.getRedirectURL("//evil.example/x"), `https://${id}.chromiumapp.org/`, "protocol-relative never leaves the callback host");
  assert.equal(identity.getRedirectURL("../x"), `https://${id}.chromiumapp.org/x`);
  assert.equal(typeof identity.getProfileUserInfo, "function", "members the desk cannot fill stay stubs");
  delete globalThis.chrome;
  delete globalThis.location;
});

test("identity: launchWebAuthFlow goes through the bridged desk call, and the callback form has parity", async () => {
  const { compatShim } = require("./awconnect-compat-preload.cjs");
  const id = "hlmfknhcfhjjngckfpacgleffckpmphe";
  const seen = [];
  const bridge = {
    launchWebAuthFlow: (details) => {
      seen.push(details);
      return Promise.resolve(`https://${id}.chromiumapp.org/?code=C&state=S`);
    },
  };
  globalThis.location = { protocol: "chrome-extension:", host: id };
  globalThis.chrome = { runtime: { id } };
  compatShim(bridge);
  const p = globalThis.chrome.identity.launchWebAuthFlow({ url: "https://idp/authorize" });
  assert.equal(typeof p.then, "function");
  assert.equal(await p, `https://${id}.chromiumapp.org/?code=C&state=S`);
  assert.deepEqual(seen, [{ url: "https://idp/authorize", interactive: true }]);
  await globalThis.chrome.identity.launchWebAuthFlow({ url: "https://idp/authorize", interactive: false });
  assert.equal(seen[1].interactive, false);
  let got;
  const silent = globalThis.chrome.identity.launchWebAuthFlow({ url: "https://idp/authorize" }, (u) => { got = u; });
  assert.equal(silent, undefined, "the callback form returns no promise (a rejected one would be unhandled)");
  await new Promise((r) => setImmediate(r));
  assert.equal(got, `https://${id}.chromiumapp.org/?code=C&state=S`);
  delete globalThis.chrome;
  delete globalThis.location;
});

test("identity: the callback form reports WHY via runtime.lastError (Chromium semantics)", async () => {
  const { compatShim } = require("./awconnect-compat-preload.cjs");
  const id = "hlmfknhcfhjjngckfpacgleffckpmphe";
  const bridge = {
    launchWebAuthFlow: () => Promise.reject(new Error("The user did not approve access.")),
  };
  globalThis.location = { protocol: "chrome-extension:", host: id };
  globalThis.chrome = { runtime: { id } };
  compatShim(bridge);
  let got = "unset";
  let errDuring = null;
  globalThis.chrome.identity.launchWebAuthFlow({ url: "https://idp/authorize" }, (u) => {
    got = u;
    errDuring = globalThis.chrome.runtime.lastError;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(got, undefined, "the callback form hands back undefined on failure");
  assert.equal(
    errDuring && errDuring.message,
    "The user did not approve access.",
    "a legacy caller reads the reason from runtime.lastError during the callback",
  );
  assert.equal(globalThis.chrome.runtime.lastError, undefined, "and it is cleared after");
  delete globalThis.chrome;
  delete globalThis.location;
});

test("identity: without a bridge it stays inert, and the id can come from location.host", async () => {  const { compatShim } = require("./awconnect-compat-preload.cjs");
  const id = "hlmfknhcfhjjngckfpacgleffckpmphe";
  globalThis.location = { protocol: "chrome-extension:", host: id };
  globalThis.chrome = {}; // no runtime.id: location.host is the fallback (measured in the worker world)
  compatShim();
  assert.equal(globalThis.chrome.identity.getRedirectURL(), `https://${id}.chromiumapp.org/`);
  assert.equal(await globalThis.chrome.identity.launchWebAuthFlow({ url: "https://idp/authorize" }), undefined,
    "no bridge = exactly as on a browser without the API");
  delete globalThis.chrome;
  delete globalThis.location;
});
