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
  // Every aitherium page: /workspace/agents drew the desktop's dock over the strip
  // (owner screenshot 2026-10-10). The flag is a no-op where there is no dock.
  for (const u of ["https://app.aitherium.com/", "https://app.aitherium.com/?spawn=aeon", "https://app.aitherium.com/relay",
    "https://app.aitherium.com/spaces", "https://app.aitherium.com/forum",
    "https://app.aitherium.com/workspace/agents", "https://app.aitherium.com/workspace/business",
    "https://app.aitherium.com/admin/tenants", "https://app.aitherium.com/settings/connected-devices"]) {
    assert.equal(tb.pageHasOwnTaskbar(u), true, u);
  }
  for (const u of ["https://app.aitherium.com/embed/taskbar",
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

test("a strip click opens a window in place before any page load (owner 2026-10-10)", () => {
  assert.deepEqual(tb.inPlaceTargets({ spawnId: "spaces", overlay: true, activeUrl: "https://www.reddit.com/" }),
    ["overlay", "online"]);
  assert.deepEqual(tb.inPlaceTargets({ spawnId: "spaces", activeUrl: "https://app.aitherium.com/workspace/agents" }),
    ["active", "online"], "an AitherOS tab on screen opens the window itself, no Online-tab switch");
  assert.deepEqual(tb.inPlaceTargets({ spawnId: "spaces", activeUrl: "https://app.aitherium.com/embed/taskbar" }),
    ["online"]);
  assert.deepEqual(tb.inPlaceTargets({ spawnId: null, activeUrl: "https://app.aitherium.com/" }), ["online"]);
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-window.cjs"), "utf8");
  assert.doesNotMatch(src, /here\.pathname === "\/" && !wc\.isLoading\(\)/,
    "the Online tab answers desk-open-app on any path, not only the root");
});

/* A refusal is an answer (review 2026-10-14). Silence made the desk reload the pinned
   Online desktop at ?spawn=: the same gates refused the same id there, and the windows it
   had open were gone. Veil desk-host.ts answers a refusal with desk-open-app-ok +
   refused:true -- one message, so a desk without this code still stops at it. */
function runOpenAppScript(id, reply) {
  const vm = require("node:vm");
  const listeners = new Set();
  const win = {
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    postMessage: (data) => {
      const answer = reply(data);
      if (answer) for (const fn of [...listeners]) fn({ source: win, data: answer });
    },
  };
  const ctx = { window: win, location: { origin: "https://aitherium.com" }, setTimeout, clearTimeout, Promise };
  return vm.runInNewContext(tb.openAppScript(id), ctx);
}

test("openAppScript tells opened, refused and silence apart", async () => {
  assert.equal(await runOpenAppScript("shop", (d) => ({ __aither: "desk-open-app-ok", id: d.id })), true);
  assert.equal(await runOpenAppScript("company-room",
    (d) => ({ __aither: "desk-open-app-ok", id: d.id, refused: true })), tb.OPEN_REFUSED);
  assert.equal(await runOpenAppScript("shop",
    () => ({ __aither: "desk-open-app-ok", id: "other", refused: true })), false, "another id's answer is not ours");
  assert.equal(await runOpenAppScript("shop", () => null), false, "no answer: an older Veil");
});

test("a refusal by the Online desktop is final -- never a ?spawn= reload", () => {
  assert.equal(tb.nextAfterAnswer("online", tb.OPEN_REFUSED), "done", "a reload refuses again and loses the windows");
  assert.equal(tb.nextAfterAnswer("online", true), "done");
  assert.equal(tb.nextAfterAnswer("online", false), "reload", "silence = an older Veil: ?spawn= as before");
  for (const kind of ["overlay", "active"]) {
    assert.equal(tb.nextAfterAnswer(kind, true), "done", kind);
    assert.equal(tb.nextAfterAnswer(kind, tb.OPEN_REFUSED), "next", `${kind}: the Online tab may be entitled`);
    assert.equal(tb.nextAfterAnswer(kind, false), "next", kind);
  }
});

test("browser-window decides every in-place answer with nextAfterAnswer", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-window.cjs"), "utf8");
  const body = src.slice(src.indexOf("function openFromTaskbar("), src.indexOf("function ensureTaskbar("));
  assert.match(body, /nextAfterAnswer\(kind, answer\) === "next"/);
  assert.match(body, /nextAfterAnswer\("online", answer\) === "reload"/);
  assert.doesNotMatch(body, /if \(!ok/, "a truthy 'refused' must never read as 'no answer'");
});

// Garg, 2026-10-16: two title watchers on the tenant taskbar page flipped the title about
// 3,000 times a second; every flip re-laid the browser and re-seated the docked avatar
// and the main process grew ~150 MB/s to 6 GB. The open signal is now rate-limited and a
// title that flaps is ignored (the strip stays collapsed) until it settles.
function signalHarness(opts = {}) {
  let t = 0;
  const timers = [];
  const applied = [];
  const sig = tb.createOpenSignal({
    apply: (open) => applied.push(open),
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, live: true }; timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.live = false; },
    ...opts,
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((h) => h.live && h.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.live = false;
      due.fn();
    }
    t = end;
  };
  return { sig, applied, advance };
}

test("open signal: a real open and close each apply once", () => {
  const { sig, applied, advance } = signalHarness();
  sig.title(tb.OPEN_TITLE);
  advance(1000);
  sig.title("Aither taskbar");
  advance(1000);
  assert.deepEqual(applied, [true, false]);
});

test("open signal: a title storm (3k flips/s) applies at most a handful of layouts, then holds the strip collapsed", () => {
  const { sig, applied, advance } = signalHarness();
  const titles = ["Aither taskbar", "GargBot", tb.OPEN_TITLE, "GARG · open"];
  for (let i = 0; i < 3000; i += 1) {
    sig.title(titles[i % titles.length]);
    advance(1000 / 3000);
  }
  assert.equal(sig.flapping(), true, "a fight is recognised while it lasts");
  assert.ok(applied.length <= 6, `applied ${applied.length} layouts in one second of storm`);
  assert.equal(applied.length === 0 || applied[applied.length - 1] === false, true, "a flapping title leaves the strip collapsed");
  advance(10_000);
  assert.ok(applied.length <= 6);
});

test("open signal: after the storm stops the real state is applied again", () => {
  const { sig, applied, advance } = signalHarness();
  for (let i = 0; i < 400; i += 1) {
    sig.title(i % 2 ? tb.OPEN_TITLE : "GargBot");
    advance(1);
  }
  advance(20_000);
  sig.title(tb.OPEN_TITLE);
  advance(1000);
  assert.equal(applied[applied.length - 1], true);
  assert.equal(sig.flapping(), false);
});

// Measured on the 0.1.19 CI build 2026-10-16: with the layout storm gone, the fighting
// taskbar PAGE itself still burned ~1.3 cores in its own renderer. A fight unloads the strip.
test("open signal: a fight calls onFlap exactly once, and again only after a quiet spell", () => {
  let flaps = 0;
  const { sig, advance } = signalHarness({ onFlap: () => { flaps += 1; } });
  for (let i = 0; i < 3000; i += 1) {
    sig.title(i % 2 ? tb.OPEN_TITLE : "GargBot");
    advance(1000 / 3000);
  }
  assert.equal(flaps, 1);
  advance(20_000);
  for (let i = 0; i < 100; i += 1) {
    sig.title(i % 2 ? tb.OPEN_TITLE : "GargBot");
    advance(1);
  }
  assert.equal(flaps, 2);
});

test("browser-window unloads a taskbar page whose title fights itself", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-window.cjs"), "utf8");
  const body = src.slice(src.indexOf("openSignal = taskbar.createOpenSignal({"), src.indexOf('wc.on("page-title-updated"', src.indexOf("openSignal = taskbar.createOpenSignal({")));
  assert.match(body, /onFlap: \(\) => unloadTaskbar\(/);
  assert.match(src, /function unloadTaskbar\(/);
});

test("browser-window drives the taskbar view through createOpenSignal, not straight off page-title-updated", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-window.cjs"), "utf8");
  const at = src.indexOf('wc.on("page-title-updated"', src.indexOf("function ensureTaskbar("));
  assert.ok(at > 0);
  const handler = src.slice(at, src.indexOf("});", at));
  assert.match(handler, /openSignal\.title\(/);
  assert.doesNotMatch(handler, /layout\(\)/);
});

test("browser-window re-seats the avatar only when the layout really changed", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "browser-window.cjs"), "utf8");
  const body = src.slice(src.indexOf("function layout() {"), src.indexOf("function currentRects() {"));
  assert.match(body, /if \(layoutChanged\b/);
  assert.doesNotMatch(body, /^\s{2}notifyGeometry\("layout"\);/m, "no unconditional notify");
});
