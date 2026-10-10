"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tb = require("./browser-taskbar.cjs");

test("the taskbar page lives on the Online host, https only", () => {
  assert.equal(tb.taskbarUrl("https://app.aitherium.com/"), "https://app.aitherium.com/embed/taskbar");
  assert.equal(tb.taskbarUrl("https://app.aitherium.com/workspace"), "https://app.aitherium.com/embed/taskbar");
  assert.equal(tb.taskbarUrl("http://app.aitherium.com/"), null);
  assert.equal(tb.taskbarUrl("not a url"), null);
});

test("navigation out of the taskbar: Online for aitherium pages, web tab otherwise, never local schemes", () => {
  assert.equal(tb.routeFor("https://app.aitherium.com/embed/taskbar"), "stay");
  assert.equal(tb.routeFor("https://app.aitherium.com/embed/taskbar/"), "stay");
  assert.equal(tb.routeFor("https://app.aitherium.com/?spawn=learn"), "online");
  assert.equal(tb.routeFor("https://aitherium.com/"), "online");
  assert.equal(tb.routeFor("https://evil.example/aitherium.com"), "web");
  assert.equal(tb.routeFor("https://aitherium.com.evil.example/"), "web");
  assert.equal(tb.routeFor("file:///C:/x"), "deny");
  assert.equal(tb.routeFor("aither://settings/"), "deny");
  assert.equal(tb.routeFor("javascript:alert(1)"), "deny");
  assert.equal(tb.routeFor("http://app.aitherium.com/embed/taskbar"), "web", "http is never the taskbar itself");
});

test("only the exact title opens the view; a 404 means unavailable", () => {
  assert.equal(tb.isOpenTitle(tb.OPEN_TITLE), true);
  assert.equal(tb.isOpenTitle("Aither taskbar"), false);
  assert.equal(tb.isOpenTitle("Aither taskbar · open — injected"), false);
  assert.equal(tb.isUnavailable(404), true);
  assert.equal(tb.isUnavailable(200), false);
  assert.equal(tb.isUnavailable(undefined), false);
});

test("expanded, the view runs from under the toolbar to the bottom, full width", () => {
  const rects = { page: { x: 254, y: 118, width: 700, height: 650 }, taskbar: { x: 0, y: 768, width: 1320, height: 56 } };
  assert.deepEqual(tb.expandedRect(rects), { x: 0, y: 118, width: 1320, height: 706 });
});

test("no double taskbar: which Online pages draw their own (that copy gets hidden)", () => {
  for (const u of ["https://app.aitherium.com/", "https://app.aitherium.com/?spawn=aeon", "https://app.aitherium.com/relay",
    "https://app.aitherium.com/spaces", "https://app.aitherium.com/forum"]) assert.equal(tb.pageHasOwnTaskbar(u), true, u);
  for (const u of ["https://app.aitherium.com/workspace/business", "https://app.aitherium.com/admin/tenants",
    "https://app.aitherium.com/settings/connected-devices", "https://app.aitherium.com/embed/taskbar",
    "https://www.reddit.com/", "aither://search/", "http://127.0.0.1:3002/"]) assert.equal(tb.pageHasOwnTaskbar(u), false, u);
});

test("one taskbar: the page's copy is hidden by the data-host flag; a strip click opens the app in place", () => {
  assert.equal(tb.HOST_DOCK_CSS, 'html[data-host="desk"] [data-os-dock] { display: none !important; }');
  assert.doesNotMatch(tb.HOST_DOCK_CSS, /:has\(|data-launcher-toggle/, "keyed on the flag, never the dock's DOM shape");
  assert.equal(tb.PAGE_TASKBAR_CSS, undefined, "the DOM-shape selector is gone");
  assert.equal(tb.spawnIdOf("https://app.aitherium.com/?spawn=aeon"), "aeon");
  assert.equal(tb.spawnIdOf("https://app.aitherium.com/relay?spawn=aeon"), null, "only the desktop root");
  assert.equal(tb.spawnIdOf("https://evil.example/?spawn=aeon"), null);
  assert.equal(tb.spawnIdOf("https://app.aitherium.com/?spawn=a%22);alert(1)//"), null);
  const js = tb.openAppScript("aeon");
  assert.match(js, /desk-open-app/);
  assert.match(js, /location\.origin/, "pinned to the page's origin");
  assert.throws(() => tb.openAppScript("x\"y"));
});

test("one taskbar owner per context: the strip unless the desktop overlay is up", () => {
  const table = [
    [{ overlayUp: false, tabOverlay: false }, "host"],
    [{ overlayUp: false, tabOverlay: true }, "host"], // the in-tab OS sits UNDER the strip
    [{ overlayUp: true, tabOverlay: false }, "os"], // Ctrl+Shift+D keeps its dock
    [{ overlayUp: true, tabOverlay: true }, "os"],
  ];
  for (const [input, owner] of table) assert.equal(tb.stripOwner(input), owner, JSON.stringify(input));
  assert.equal(tb.stripOwner(), "host");
  assert.equal(tb.stripOwner({}), "host");
});

test("the desk flag script sets data-host=desk + the session key, and clears only its own value", () => {
  const vm = require("node:vm");
  const run = (on, attr, stored) => {
    const store = new Map(stored ? [["aither-host", stored]] : []);
    const attrs = new Map(attr ? [["data-host", attr]] : []);
    const ctx = vm.createContext({
      window: {},
      document: { documentElement: {
        setAttribute: (k, v) => attrs.set(k, v), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        removeAttribute: (k) => attrs.delete(k) } },
      sessionStorage: { setItem: (k, v) => store.set(k, v), getItem: (k) => (store.has(k) ? store.get(k) : null),
        removeItem: (k) => store.delete(k) },
    });
    vm.runInContext(tb.hostFlagScript(on), ctx);
    return { attr: attrs.get("data-host") || null, stored: store.get("aither-host") || null };
  };
  assert.deepEqual(run(true, null, null), { attr: "desk", stored: "desk" });
  assert.deepEqual(run(false, "desk", "desk"), { attr: null, stored: null });
  assert.deepEqual(run(false, "awconnect", "awconnect"), { attr: "awconnect", stored: "awconnect" }, "not ours to clear");
  assert.equal(tb.DESK_TAB_ARG, "--aither-desk-surface=browser-tab");
});

test("the shared preload marks data-host=desk in the BROWSER TAB only; the desktop overlay keeps its dock", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const src = fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8");
  const load = (argv, stored) => {
    const attrs = new Map();
    const store = new Map(stored ? [["aither-host", stored]] : []);
    const ctx = vm.createContext({
      process: { argv },
      window: { addEventListener() {}, postMessage() {}, location: { origin: "https://app.aitherium.com" } },
      document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v) } },
      sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
      navigator: {},
      require: () => ({ ipcRenderer: { on() {}, send() {}, invoke: async () => null } }),
    });
    vm.runInContext(src, ctx);
    return { aither: attrs.get("data-aither-host") || null, host: attrs.get("data-host") || null, stored: store.get("aither-host") || null };
  };
  assert.deepEqual(load(["electron", tb.DESK_TAB_ARG]), { aither: "desk", host: "desk", stored: "desk" }, "the hosted Online tab");
  assert.deepEqual(load(["electron"]), { aither: "desk", host: null, stored: null }, "the Ctrl+Shift+D overlay keeps its dock");
  assert.deepEqual(load(["electron", tb.DESK_TAB_ARG], "awconnect"), { aither: "desk", host: null, stored: "awconnect" },
    "another host's flag is not overwritten");
  assert.match(src, new RegExp(tb.DESK_TAB_ARG.replace(/[-]/g, "\\-")), "the preload names the same argument");
});
