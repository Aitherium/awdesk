"use strict";

// aither:// -- every Aither Console pane as an Aither Browser page (plan slices 8+9).
// Routing, preloads, the fence between web tabs and console pages, and the shim.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const internal = require("./browser-internal.cjs");
const { PANES } = require("./console-window.cjs");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const DIST_INDEX = path.join(__dirname, "..", "dist", "index.html");
const BUNDLE = pathToFileURL(DIST_INDEX).href;

test("EVERY console pane has an aither:// page, derived from PANES", () => {
  const pages = internal.internalPages();
  assert.deepEqual(pages.map((p) => p.id), PANES.map((p) => p.id), "one page per pane, in rail order");
  for (const pane of PANES) {
    const url = internal.internalUrl(pane.id);
    assert.ok(url.startsWith(`aither://${pane.id}/`), `${pane.id}: ${url}`);
    const route = internal.resolveRequest(url, { rendererUrl: BUNDLE, hostedUrl: "https://app.aitherium.com/?shell=x" });
    if (pane.kind === "file") {
      assert.equal(route.type, "file", `${pane.id} is a file pane`);
      assert.equal(route.file, path.join(__dirname, pane.file), `${pane.id} serves its own html`);
      assert.ok(fs.existsSync(route.file), `${pane.file} is missing`);
    } else if (pane.kind === "view") {
      assert.equal(route.type, "file", `${pane.id} is the bundle`);
      assert.equal(route.file, DIST_INDEX);
      assert.ok(url.includes(`?${pane.query}`), `${pane.id} keeps its query flag (${pane.query})`);
    } else if (pane.kind === "hosted") {
      assert.deepEqual(route, { type: "hosted", url: "https://app.aitherium.com/?shell=x", partition: pane.partition });
    } else {
      assert.fail(`pane ${pane.id} has a kind (${pane.kind}) aither:// does not route`);
    }
  }
});

test("a pane ANOTHER change adds to PANES appears with no edit to browser-internal", () => {
  // Ids no real pane uses (a concurrent change really does add files, strata, ...).
  const panes = [...PANES, { id: "ledger", label: "Ledger", kind: "file", file: "ledger.html" },
    { id: "atlas", label: "Atlas", kind: "file", file: "atlas.html", preload: "atlas-preload.cjs" }];
  assert.ok(internal.internalPages(panes).some((p) => p.id === "ledger" && p.url === "aither://ledger/"));
  const route = internal.resolveRequest("aither://ledger/", { panes });
  assert.equal(route.type, "file");
  assert.equal(path.basename(route.file), "ledger.html");
  // Its preload follows the <stem>-preload.cjs convention, or the pane's own `preload`.
  const ledger = panes.find((p) => p.id === "ledger");
  assert.equal(internal.preloadFor(ledger, { exists: (n) => n === "ledger-preload.cjs" }), "ledger-preload.cjs");
  assert.equal(internal.preloadFor(ledger, { exists: () => false }), null, "no preload file -> no bridge, never a guess");
  const atlas = panes.find((p) => p.id === "atlas");
  assert.equal(internal.preloadFor(atlas, { exists: () => true }), "atlas-preload.cjs");
  assert.equal(internal.preloadFor({ ...atlas, preload: "../main.cjs" }, { exists: () => true }), null);
});

test("each page gets ITS pane's preload -- the same pairs the console uses", () => {
  const consolePreload = read("console-preload.cjs");
  for (const pane of PANES) {
    const preload = internal.preloadFor(pane);
    if (pane.kind === "hosted") {
      assert.equal(preload, null, "a hosted pane is web content: no preload");
      continue;
    }
    assert.ok(preload, `${pane.id} has no preload`);
    assert.ok(fs.existsSync(path.join(__dirname, preload)), `${preload} is missing`);
    assert.ok(consolePreload.includes(`require("./${preload}")`), `the console does not give ${pane.id} ${preload}`);
    assert.equal(internal.preloadForUrl(internal.internalUrl(pane.id)), preload);
  }
  assert.equal(internal.preloadForUrl("https://evil.test/"), null);
  assert.equal(internal.preloadForUrl("aither://nope/"), null);
});

test("a pane's origin serves its page and shared assets only -- never code, never another page", () => {
  const ok = internal.resolveRequest("aither://settings/aither-tokens.css");
  assert.equal(ok.type, "file");
  assert.equal(ok.contentType, "text/css; charset=utf-8");
  for (const url of [
    "aither://settings/main.cjs",
    "aither://settings/settings-preload.cjs",
    "aither://settings/command.html",
    "aither://settings/console.html",
    "aither://settings/..%2fpackage.json",
    "aither://settings/%2e%2e/%2e%2e/package.json",
    "aither://settings/.git/config",
    "aither://settings/a%5C..%5Cmain.cjs",
    "aither://cards/..%2f..%2fpackage.json",
  ]) {
    const route = internal.resolveRequest(url, { rendererUrl: BUNDLE });
    assert.equal(route.type, "missing", `${url} must be refused, got ${JSON.stringify(route)}`);
  }
  assert.equal(internal.resolveRequest("aither://cards/assets/index-abc.js", { rendererUrl: BUNDLE }).type, "file");
  assert.equal(internal.resolveRequest("aither://nope/").status, 404);
  assert.equal(internal.resolveRequest("https://aitherium.com/").status, 404);
  assert.equal(internal.resolveRequest("aither://cards/", { rendererUrl: "" }).status, 503);
});

test("the renderer dev server is proxied only on loopback http", () => {
  const dev = internal.resolveRequest("aither://chat/src/main.tsx?chat=1", { rendererUrl: "http://127.0.0.1:5173" });
  assert.deepEqual(dev, { type: "proxy", url: "http://127.0.0.1:5173/src/main.tsx?chat=1" });
  assert.equal(internal.resolveRequest("aither://chat/@vite/client", { rendererUrl: "http://localhost:5173/" }).type, "proxy");
  assert.equal(internal.resolveRequest("aither://chat/", { rendererUrl: "https://evil.test/" }).status, 403);
  assert.equal(internal.resolveRequest("aither://chat/", { rendererUrl: "http://10.0.0.5:5173" }).status, 403);
});

test("a card id rides as card=, exactly as the console frame got it", () => {
  assert.equal(internal.internalUrl("cards", "c 1/2"), "aither://cards/?deck=1&card=c%201%2F2");
  assert.equal(internal.internalUrl("settings", "x"), "aither://settings/?card=x");
  assert.equal(internal.internalUrl("nope"), null);
});

test("the pane pages' file: CSP also trusts their own aither:// origin, and nothing else widens", () => {
  const html = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    + "style-src 'unsafe-inline' file:; script-src 'unsafe-inline'; img-src data:;\" />";
  const out = internal.adaptHtml(html);
  assert.match(out, /style-src 'self' 'unsafe-inline' file:/);
  assert.match(out, /default-src 'none'/);
  assert.match(out, /script-src 'unsafe-inline';/, "script-src must not gain 'self'");
  assert.match(out, /img-src data:;/);
  assert.equal(internal.adaptHtml(out), out, "idempotent");
  for (const pane of PANES.filter((p) => p.kind === "file")) {
    const adapted = internal.adaptHtml(read(pane.file));
    if (/file:/.test(read(pane.file).match(/Content-Security-Policy" content="([^"]*)"/)?.[1] || "")) {
      assert.match(adapted, /style-src 'self'/, `${pane.file} would lose aither-tokens.css`);
    }
  }
});

test("the handler serves pages with the frame/CORP headers, and answers misses loudly", async () => {
  let handler = null;
  let scheme = null;
  const ses = { protocol: { handle: (s, fn) => { scheme = s; handler = fn; } } };
  const fetched = [];
  assert.equal(internal.installInternalProtocol(ses, {
    rendererUrl: "http://127.0.0.1:5173",
    fetch: async (url) => { fetched.push(url); return new Response("<p>dev</p>", { headers: { "content-type": "text/html" } }); },
  }), true);
  assert.equal(scheme, "aither");

  const page = await handler({ url: "aither://command/" });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(page.headers.get("cross-origin-resource-policy"), "same-origin");
  const body = await page.text();
  assert.match(body, /style-src 'self'/);

  const code = await handler({ url: "aither://settings/main.cjs" });
  assert.equal(code.status, 403);
  assert.equal(code.headers.get("x-frame-options"), "DENY");
  assert.equal((await handler({ url: "aither://nope/" })).status, 404);
  const dev = await handler({ url: "aither://chat/?chat=1" });
  assert.equal(dev.status, 200);
  assert.deepEqual(fetched, ["http://127.0.0.1:5173/?chat=1"]);
  const hosted = await handler({ url: "aither://desktop/" });
  assert.equal(hosted.status, 409, "a hosted pane is a tab of its own, never served from the scheme");

  const missing = { protocol: { handle: (_s, fn) => { handler = fn; } } };
  internal.installInternalProtocol(missing, { readFile: async () => { throw new Error("ENOENT"); } });
  assert.equal((await handler({ url: "aither://settings/" })).status, 404);

  const already = { protocol: { handle: () => assert.fail("installed twice"), isProtocolHandled: () => true } };
  assert.equal(internal.installInternalProtocol(already), false);
  assert.throws(() => internal.installInternalProtocol({}), /needs a session/);
});

test("a WEB tab can never navigate to, frame or be redirected into aither://", () => {
  const v = internal.navigationVerdict;
  for (const url of ["aither://settings/", "AITHER://settings/", "aither://cards/?deck=1", "file:///C:/x"]) {
    assert.equal(v("web", url), "deny", `web -> ${url}`);
    assert.equal(v("web", url, { frame: true }), "deny", `web frame -> ${url}`);
    assert.equal(v("hosted", url), "deny", `hosted -> ${url}`);
    assert.equal(v("hosted", url, { frame: true }), "deny", `hosted frame -> ${url}`);
  }
  assert.equal(v("web", "https://example.com/"), "allow");
  assert.equal(v("web", "javascript:alert(1)"), "deny");
  assert.equal(v("web", "https://example.com/", { frame: true }), "allow", "ordinary web frames still work");
  // The links, popups and agent tools all pass sanitizeUrl / isNavigable: aither: is refused there too.
  const policy = require("./browser-policy.cjs");
  assert.equal(policy.sanitizeUrl("aither://settings").ok, false);
  assert.equal(policy.isNavigable("aither://settings/"), false);
});

test("an internal tab never shows web content: a link goes to a web tab", () => {
  const v = internal.navigationVerdict;
  assert.equal(v("internal", "aither://fleet/"), "allow");
  assert.equal(v("internal", "https://aitherium.com/"), "web-tab");
  assert.equal(v("internal", "file:///C:/Windows"), "deny");
  assert.equal(v("internal", "javascript:void 0"), "deny");
  assert.equal(v("internal", "https://evil.test/", { frame: true }), "deny");
  assert.equal(v("internal", "aither://nope%/"), "deny");
  // A hosted (signed-in) tab stays on the aitherium.com family; the rest opens a web tab.
  assert.equal(v("hosted", "https://app.aitherium.com/workspace"), "allow");
  assert.equal(v("hosted", "https://aitherium.com.evil.test/"), "web-tab");
  assert.equal(v("hosted", "http://app.aitherium.com/"), "web-tab", "plain http is not the hosted site");
});

test("tab preferences: web = no preload + sandbox; internal = its own session + the internal preload", () => {
  const web = internal.tabPreferences("web", { webPartition: "persist:aither-browser" });
  assert.equal(web.preload, undefined);
  assert.equal(web.sandbox, true);
  assert.equal(web.partition, "persist:aither-browser");
  const inside = internal.tabPreferences("internal", { webPartition: "persist:aither-browser" });
  assert.equal(inside.partition, internal.INTERNAL_PARTITION);
  assert.notEqual(inside.partition, web.partition, "the scheme's session must not be the web session");
  assert.equal(path.basename(inside.preload), "browser-internal-preload.cjs");
  assert.equal(inside.contextIsolation, true);
  assert.equal(inside.nodeIntegration, false);
  assert.equal(inside.nodeIntegrationInSubFrames, false);
  assert.equal(inside.webviewTag, false);
  const hosted = internal.tabPreferences("hosted", { webPartition: "persist:aither-browser", hostedPartition: "persist:living-desktop" });
  assert.equal(hosted.partition, "persist:living-desktop");
  assert.equal(hosted.preload, undefined, "AitherOS Online is web content: no preload");
  assert.equal(hosted.sandbox, true);
});

test("the scheme handler is installed on the INTERNAL session only", () => {
  const src = read("browser-window.cjs");
  assert.equal((src.match(/installInternalProtocol\(/g) || []).length, 1, "one install site");
  const body = src.slice(src.indexOf("function ensureInternalSession"), src.indexOf("async function loadHostedTab"));
  assert.match(body, /session\.fromPartition\(internal\.INTERNAL_PARTITION\)/);
  assert.match(body, /internal\.installInternalProtocol\(ses,/);
  const harden = src.slice(src.indexOf("function hardenSession"), src.indexOf("async function loadInView"));
  assert.doesNotMatch(harden, /protocol/, "the web partition must never resolve aither://");
  assert.doesNotMatch(read("main.cjs"), /installInternalProtocol/, "main installs no second handler");
  // The guards consult the verdict for main-frame AND sub-frame navigations.
  assert.match(src, /wc\.on\("will-navigate", guard\)/);
  assert.match(src, /wc\.on\("will-frame-navigate", \(details\) => \{/);
  assert.match(src, /navigationVerdict\(kindOf\(\), details\.url, \{ frame: true \}\)/);
});

test("the internal preload hands over ONE pane's bridge, and only on an aither: origin", () => {
  const src = read("browser-internal-preload.cjs");
  const guard = src.indexOf("if (loc && loc.protocol === internal.PROTOCOL)");
  assert.ok(guard > 0, "the preload must check the origin first");
  assert.ok(src.indexOf("require(`./${preload}`)") > guard, "the pane preload is required inside the guard");
  assert.match(src, /internal\.preloadForUrl\(href\)/);
  assert.doesNotMatch(src, /exposeInMainWorld/, "the internal preload exposes nothing of its own");
});

test("aither:// is registered privileged before ready: standard + secure, never CORS or CSP-bypassing", () => {
  let registered = null;
  assert.equal(internal.registerPrivilegedScheme({ registerSchemesAsPrivileged: (list) => { registered = list; } }), true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].scheme, "aither");
  assert.equal(registered[0].privileges.standard, true);
  assert.equal(registered[0].privileges.secure, true);
  assert.ok(!registered[0].privileges.corsEnabled, "a web origin must not get CORS access");
  assert.ok(!registered[0].privileges.bypassCSP, "pages keep their CSP");
  assert.equal(internal.registerPrivilegedScheme(null), false);
  const main = read("main.cjs");
  const at = main.indexOf("browserInternal.registerPrivilegedScheme(");
  assert.ok(at > 0, "main never registers the scheme");
  assert.ok(at < main.indexOf("app.whenReady()"), "registerSchemesAsPrivileged must run before app ready");
});

test("pinned tabs: Inbox, AitherOS Online, Workspace -- the last two in the signed-in partition", () => {
  const pins = internal.pinnedTabs({ workspaceUrl: null });
  assert.deepEqual(pins.map((p) => p.key), ["inbox", "online", "workspace"]);
  assert.equal(pins[0].url, "aither://cards/?deck=1");
  assert.equal(pins[1].url, "aither://desktop/");
  assert.equal(pins[1].label, "AitherOS Online");
  assert.equal(pins[2].url, "https://app.aitherium.com/workspace");
  assert.equal(pins[2].hostedPartition, PANES.find((p) => p.kind === "hosted").partition);
  // A workspace URL off the aitherium.com family never rides the signed-in partition.
  assert.deepEqual(internal.pinnedTabs({ workspaceUrl: "https://evil.test/" }).map((p) => p.key), ["inbox", "online"]);
});

test("the address bar suggests the console's pages by name", () => {
  assert.deepEqual(internal.suggestInternal("sett").map((r) => r.url), ["aither://settings/"]);
  assert.equal(internal.suggestInternal("aither").length, Math.min(8, PANES.length));
  assert.equal(internal.suggestInternal("aither://fle")[0].url, "aither://fleet/");
  assert.deepEqual(internal.suggestInternal(""), []);
  assert.ok(internal.suggestInternal("inbox").every((r) => r.kind === "aither"));
});

test("the console is a shim over the browser; DESK_LEGACY_CONSOLE=1 brings the window back", () => {
  assert.equal(internal.legacyConsole({}), false);
  assert.equal(internal.legacyConsole({ DESK_LEGACY_CONSOLE: "1" }), true);
  assert.equal(internal.legacyConsole({ DESK_LEGACY_CONSOLE: "0" }), false);
  const main = read("main.cjs");
  const opener = main.slice(main.indexOf("function openConsole("), main.indexOf("function wireConsoleHost("));
  assert.match(opener, /const legacy = browserInternal\.legacyConsole\(\);/);
  assert.match(opener, /if \(legacy\) return pane \? focusConsolePane\(pane, param\) : true;/);
  assert.match(opener, /return browserWindow\.openInternal\(pane \|\| "cards", param,/);
  // Every caller names its pane in ONE call: no "open the console, then focus" pairs
  // that would open an Inbox tab before the pane that was asked for.
  assert.doesNotMatch(main, /openConsole\(\);\s*focusPane\(/);
  for (const pane of ["chat", "cast", "stage", "settings", "sessions"]) {
    assert.match(main, new RegExp(`openConsole\\("${pane}"\\)`), `${pane} door`);
  }
  assert.match(main, /return openConsole\("cards", cardId\) !== false;/, "the inbox door carries the card id");
  // The browser half: the console door reuses a pane's tab and pins the front door.
  const bw = read("browser-window.cjs");
  const door = bw.slice(bw.indexOf("function openInternal("), bw.indexOf("function configureInternal("));
  assert.match(door, /createBrowserWindow\(\{ \.\.\.opts, url: null, home: false \}\)/, "no stray home tab");
  assert.match(door, /ensurePinned\(\);/);
  assert.match(door, /const existing = tabForPane\(pane\.id\);/);
});

test("an aither:// page opened from the address bar still gets its pane handlers first", () => {
  const bw = read("browser-window.cjs");
  const open = bw.slice(bw.indexOf("function openTab("), bw.indexOf("function ensurePinned("));
  const hook = open.indexOf("internalConfig.beforeInternal()");
  assert.ok(hook > 0, "openTab never asks main to wire the pane");
  assert.ok(hook < open.indexOf("const target = classify(url);"), "the handlers must be wired before the page is classified");
  assert.ok(hook < open.indexOf("new WebContentsView("), "...and before the page can load");
  const main = read("main.cjs");
  assert.match(main, /browserWindow\.configureInternal\(\{\s*beforeInternal: \(\) => \{\s*if \(!browserInternal\.legacyConsole\(\)\) wireConsoleHost\(false\);/);
  // The owner typing aither://<pane> is routed; sanitizeUrl (agents, links) is not widened.
  const nav = bw.slice(bw.indexOf('ipcMain.handle("desk:browser-navigate"'), bw.indexOf('ipcMain.handle("desk:browser-tab-new"'));
  assert.ok(nav.indexOf("internal.parseInternalUrl(typed)") < nav.indexOf("policy.sanitizeUrl(input)"));
  assert.match(nav, /if \(!fromChrome\(event\)\) return/, "only the owner's toolbar may route to a console page");
});

// ── review round 2: plane pages, the microphone, character models, the Online URL ──

const os = require("node:os");
const vm = require("node:vm");

/** What console-preload.cjs itself requires for a frame at `href` -- run, not grepped. */
function consolePreloadPicks(href) {
  const required = [];
  const noop = () => {};
  const electron = {
    contextBridge: { exposeInMainWorld: noop },
    ipcRenderer: { invoke: () => Promise.resolve(null), on: noop, off: noop, send: noop },
  };
  const fakeRequire = (name) => {
    if (name === "electron") return electron;
    required.push(String(name).replace(/^\.\//, ""));
    return {};
  };
  const root = { dataset: {}, classList: { toggle: noop }, style: { setProperty: noop } };
  const sandbox = {
    location: { href },
    document: { readyState: "complete", documentElement: root, addEventListener: noop },
    Promise,
  };
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  vm.runInNewContext(`(function (require) {\n${read("console-preload.cjs")}\n})`, sandbox)(fakeRequire);
  return required;
}

test("every PANES page gets EXACTLY the preload console-preload.cjs gives it (executed)", () => {
  for (const pane of PANES) {
    if (pane.kind === "hosted") continue;
    const href = pane.kind === "file"
      ? `${pathToFileURL(path.join(__dirname, pane.file)).href}?card=x`
      : `${BUNDLE}?${pane.query}`;
    const picks = consolePreloadPicks(href);
    assert.equal(picks.length, 1, `${pane.id}: console-preload required ${JSON.stringify(picks)}`);
    assert.equal(internal.preloadFor(pane), picks[0], `${pane.id}: aither:// and the console disagree`);
  }
});

test("plane-*.html panes share plane-preload.cjs -- the console-preload regex arm", () => {
  const consoleArm = /\/plane-[a-z]+\.html/; // console-preload.cjs, PR #11729
  for (const id of ["strata", "pulse", "watch", "flux", "nexus"]) {
    const pane = { id, label: id, kind: "file", file: `plane-${id}.html` };
    assert.ok(consoleArm.test(`/electron/${pane.file}`));
    assert.equal(internal.preloadFor(pane, { exists: () => false }), "plane-preload.cjs", id);
    assert.equal(internal.preloadForUrl(`aither://${id}/`, [pane]), "plane-preload.cjs");
  }
  // The pattern is anchored: a look-alike file does not borrow the plane bridge.
  for (const file of ["plane-x.html.bak", "myplane-x.html", "plane-X1.html"]) {
    assert.equal(internal.preloadFor({ id: "x", kind: "file", file }, { exists: () => false }), null, file);
  }
});

/** A throwaway electron/ with plane pages shaped exactly like PR #11729's. */
function planeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aither-planes-"));
  const ids = ["strata", "pulse", "watch", "flux", "nexus"];
  const page = (id) => [
    "<!doctype html><html><head>",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; "
      + "style-src 'unsafe-inline' file:; script-src file:; img-src data:;\" />",
    "<link rel=\"stylesheet\" href=\"aither-tokens.css\" />",
    "<link rel=\"stylesheet\" href=\"plane-page.css\" />",
    `</head><body data-plane="${id}"><script src="plane-page.js"></script></body></html>`,
  ].join("\n");
  for (const id of ids) fs.writeFileSync(path.join(dir, `plane-${id}.html`), page(id));
  fs.writeFileSync(path.join(dir, "settings.html"), "<html><script>inline()</script></html>");
  for (const name of ["plane-page.js", "plane-page.css", "aither-tokens.css", "kv-lend-page.js",
    "plane-preload.cjs"]) {
    fs.writeFileSync(path.join(dir, name), "/* x */");
  }
  const panes = [...ids.map((id) => ({ id, label: id, kind: "file", file: `plane-${id}.html` })),
    { id: "settings", label: "Settings", kind: "file", file: "settings.html" }];
  return { dir, panes };
}

test("a plane page loads its script, styles and bridge at aither://<plane>, not 'loading' forever", () => {
  const { dir, panes } = planeFixture();
  try {
    const opts = { panes, electronDir: dir };
    for (const pane of panes.filter((p) => p.file.startsWith("plane-"))) {
      const html = fs.readFileSync(path.join(dir, pane.file), "utf8");
      const refs = [...internal.scriptSources(html),
        ...[...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1])];
      assert.deepEqual(refs, ["plane-page.js", "aither-tokens.css", "plane-page.css"]);
      for (const ref of refs) {
        const route = internal.resolveRequest(`aither://${pane.id}/${ref}`, opts);
        assert.equal(route.type, "file", `${pane.id}: ${ref} -> ${JSON.stringify(route)}`);
        assert.equal(route.file, path.join(dir, ref));
      }
      assert.equal(internal.resolveRequest(`aither://${pane.id}/plane-page.js`, opts).contentType,
        "text/javascript; charset=utf-8");
      // script-src file: becomes 'self' file:, so the served script may run.
      assert.match(internal.adaptHtml(html), /script-src 'self' file:/);
      assert.equal(internal.preloadForUrl(`aither://${pane.id}/`, panes), "plane-preload.cjs");
      // Code the page does not load, and any .cjs, stay refused under the plane origin.
      for (const bad of ["kv-lend-page.js", "plane-preload.cjs", "..%2fplane-page.js"]) {
        const route = internal.resolveRequest(`aither://${pane.id}/${bad}`, opts);
        assert.equal(route.type, "missing", `${pane.id}/${bad} must be refused`);
      }
    }
    // A pane whose page does not name plane-page.js cannot fetch it from its origin.
    assert.equal(internal.resolveRequest("aither://settings/plane-page.js", opts).status, 403);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every REAL PANES page's own <script src> and <link href> resolve under its origin", () => {
  for (const pane of PANES.filter((p) => p.kind === "file")) {
    const html = read(pane.file);
    const refs = [...internal.scriptSources(html),
      ...[...html.matchAll(/<link[^>]*\bhref="([^":]+)"/g)].map((m) => m[1])];
    for (const ref of refs) {
      const route = internal.resolveRequest(`aither://${pane.id}/${ref}`);
      assert.equal(route.type, "file", `${pane.id}: ${ref} -> ${JSON.stringify(route)}`);
    }
  }
});

test("an aither:// page keeps the console's MICROPHONE grant; nothing else, nowhere else", () => {
  const ok = (p, url, d) => internal.allowInternalPermission(p, url, d);
  for (const p of ["media", "audioCapture", "microphone"]) {
    assert.equal(ok(p, "aither://cards/?deck=1"), true, p);
    assert.equal(ok(p, "aither://settings/"), true, p);
    assert.equal(ok(p, "https://evil.test/"), false, `${p} for a web page`);
    assert.equal(ok(p, "file:///C:/x.html"), false);
    assert.equal(ok(p, ""), false);
  }
  assert.equal(ok("media", "aither://cards/", { mediaTypes: ["audio"] }), true);
  assert.equal(ok("media", "aither://cards/", { mediaTypes: ["audio", "video"] }), false, "no camera");
  assert.equal(ok("media", "aither://cards/", { mediaType: "video" }), false, "no camera (check)");
  for (const p of ["geolocation", "notifications", "clipboard-read", "videoCapture", "openExternal"]) {
    assert.equal(ok(p, "aither://settings/"), false, p);
  }
});

test("ensureInternalSession installs that rule on the internal session (request + check)", () => {
  const ses = {};
  ses.setPermissionRequestHandler = (fn) => { ses.request = fn; };
  ses.setPermissionCheckHandler = (fn) => { ses.check = fn; };
  assert.equal(internal.installInternalPermissions(ses), true);
  const wc = (url) => ({ getURL: () => url });
  const ask = (url, permission, details) => {
    let answer = null;
    ses.request(wc(url), permission, (v) => { answer = v; }, details);
    return answer;
  };
  assert.equal(ask("aither://cards/?deck=1", "media", { mediaTypes: ["audio"] }), true);
  assert.equal(ask("aither://cards/?deck=1", "geolocation", {}), false);
  assert.equal(ask("https://evil.test/", "media", { mediaTypes: ["audio"] }), false);
  assert.equal(ask("https://evil.test/", "media", { requestingUrl: "aither://cards/" }), true,
    "details.requestingUrl (the frame) is what Electron says asked");
  assert.equal(ses.check(wc("aither://settings/"), "media", "aither://settings", {}), true);
  assert.equal(ses.check(wc("aither://settings/"), "geolocation", "aither://settings", {}), false);
  assert.equal(ses.check(wc("https://evil.test/"), "media", "https://evil.test", {}), false);
  assert.throws(() => internal.installInternalPermissions({}));
  const win = read("browser-window.cjs");
  const body = win.slice(win.indexOf("function ensureInternalSession"));
  assert.match(body.slice(0, body.indexOf("\n}\n")), /internal\.installInternalPermissions\(ses\)/);
});

test("the deck's character models reach an aither:// page through /_models/, from main's file", () => {
  const vrm = path.join(os.tmpdir(), "Aria", "model.vrm");
  const models = { Aria: pathToFileURL(vrm).href, "Mr B": "file:///x/b.vrm", ghost: "",
    "../etc": "file:///x" };
  assert.deepEqual(internal.internalModelUrls(models),
    { Aria: "/_models/Aria.vrm", "Mr B": "/_models/Mr%20B.vrm" });
  const modelFile = (name) => (name === "Aria" ? vrm : name === "Bad" ? "relative.vrm" : null);
  const route = internal.resolveRequest("aither://characters/_models/Aria.vrm?characters=1",
    { rendererUrl: BUNDLE, modelFile });
  assert.deepEqual(route, { type: "file", file: vrm, contentType: "model/gltf-binary" });
  assert.equal(internal.resolveRequest("aither://cards/_models/Aria.vrm", { rendererUrl: BUNDLE, modelFile })
    .type, "file", "every view pane (the Inbox renders thumbnails too)");
  for (const url of ["aither://characters/_models/Nope.vrm", "aither://characters/_models/Bad.vrm",
    "aither://characters/_models/..%2f..%2fmain.vrm", "aither://characters/_models/Aria.png"]) {
    assert.equal(internal.resolveRequest(url, { rendererUrl: BUNDLE, modelFile }).status, 404, url);
  }
  // A FILE pane has no model route.
  assert.equal(internal.resolveRequest("aither://settings/_models/Aria.vrm", { modelFile }).type, "missing");
  const main = read("main.cjs");
  assert.match(main, /modelFile: \(name\) =>/, "main wires the roster resolver into the browser");
  assert.match(main, /desk:deck-get-state", \(event\) => deckStateFor\(event && event\.sender\)/);
  assert.match(main, /sendToInternalTabs\("desk:event", deckStateForInternal\(event\)\)/);
});

test("the pinned AitherOS Online tab opens app.aitherium.com (the one page host)", () => {
  assert.equal(internal.onlineUrl({}), "https://app.aitherium.com/");
  assert.equal(internal.onlineUrl({ DESK_ONLINE_URL: "https://app.aitherium.com/?x=1" }),
    "https://app.aitherium.com/?x=1");
  assert.equal(internal.onlineUrl({ DESK_ONLINE_URL: "https://evil.test/" }), "https://app.aitherium.com/");
  const online = internal.pinnedTabs({}).find((p) => p.key === "online");
  const route = internal.resolveRequest(online.url, { hostedUrl: () => internal.onlineUrl({}) });
  assert.equal(route.type, "hosted");
  assert.equal(route.url, "https://app.aitherium.com/");
  const main = read("main.cjs");
  assert.match(main, /hostedUrl: \(\) => browserInternal\.onlineUrl\(\)/,
    "main must hand the browser app.aitherium.com, not desktopAppUrl() (the apex)");
});
