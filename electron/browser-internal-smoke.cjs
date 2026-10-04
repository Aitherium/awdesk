"use strict";

/**
 * Do the aither:// pages really load, with their bridge, and does the fence hold in
 * a REAL Chromium? `npm run test:browser-internal` -- an Electron run that exits by
 * itself, like browser-smoke.cjs. browser-internal.test.cjs proves the decisions;
 * only a live renderer shows that a page under aither:// gets its stylesheet past
 * its own CSP, that its preload's bridge is there, and that a web page in the
 * browser's partition cannot load, fetch or frame the scheme.
 *
 * Own entry point: no single-instance lock, no tray, HIDDEN windows (never steals
 * focus), a temp userData. Exit 0 all pass, 1 a check failed, 2 the run broke, 3 it hung.
 */
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, protocol, session } = require("electron");
const internal = require("./browser-internal.cjs");
const { PANES } = require("./console-window.cjs");

const WEB_PARTITION = "persist:aither-browser-smoke";
internal.registerPrivilegedScheme(protocol);
app.setPath("userData", path.join(os.tmpdir(), `awdesk-internal-smoke-${process.pid}`));
// Hidden windows open and close one by one; the default would quit with the first.
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 90000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};

/** The names a pane preload exposes, read from its source (contextBridge.exposeInMainWorld). */
function exposedBy(preload) {
  const src = fs.readFileSync(path.join(__dirname, preload), "utf8");
  return [...src.matchAll(/exposeInMainWorld\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

async function open(prefs, url) {
  const win = new BrowserWindow({ show: false, webPreferences: prefs });
  try {
    await win.loadURL(url);
    return { win, error: null };
  } catch (error) {
    return { win, error: String((error && error.message) || error) };
  }
}

app.whenReady().then(async () => {
  internal.installInternalProtocol(session.fromPartition(internal.INTERNAL_PARTITION), { rendererUrl: "" });
  const prefs = internal.tabPreferences("internal", { webPartition: WEB_PARTITION });
  const webPrefs = internal.tabPreferences("web", { webPartition: WEB_PARTITION });

  for (const pane of PANES.filter((p) => p.kind === "file")) {
    const url = internal.internalUrl(pane.id);
    const { win, error } = await open(prefs, url);
    const wc = win.webContents;
    const page = await wc.executeJavaScript(`({ href: location.href, origin: location.origin,
      css: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      sheets: document.styleSheets.length })`).catch((e) => ({ error: String(e) }));
    expect(`${url} loads`, !error && page.href === url, { error, page });
    expect(`${url} is its own origin`, page.origin === `aither://${pane.id}`, page);
    expect(`${url} gets aither-tokens.css past its CSP`, Boolean(page.css), page);
    const preload = internal.preloadFor(pane);
    for (const name of preload ? exposedBy(preload) : []) {
      const kind = await wc.executeJavaScript(`typeof window[${JSON.stringify(name)}]`);
      expect(`${url} has its bridge ${name}`, kind === "object", kind);
    }
    const code = await wc.executeJavaScript(`fetch("aither://${pane.id}/main.cjs").then((r) => r.status, (e) => "error: " + e)`);
    // 403 from the handler, or refused earlier by the page's own CSP (connect-src 'none').
    expect(`${url} cannot read desk code (main.cjs)`, code === 403 || /Failed to fetch/.test(String(code)), code);
    win.destroy();
  }

  // The fence, from a WEB page in the browser's own partition (no aither handler there).
  const direct = await open(webPrefs, "aither://settings/");
  expect("a web tab cannot load aither://", Boolean(direct.error), direct.error);
  direct.win.destroy();
  const webPage = "data:text/html;charset=utf-8," + encodeURIComponent(
    '<!doctype html><iframe id="f" src="aither://settings/"></iframe>');
  const { win: web } = await open(webPrefs, webPage);
  await new Promise((r) => setTimeout(r, 1500));
  const probe = await web.webContents.executeJavaScript(`(async () => {
    let fetched = "blocked";
    try { const r = await fetch("aither://settings/"); fetched = r.status; } catch { fetched = "blocked"; }
    let framed = "blocked";
    try {
      const doc = document.getElementById("f").contentDocument;
      framed = doc ? (doc.title || "empty") : "opaque";
    } catch { framed = "opaque"; }
    return { fetched, framed, bridge: typeof window.settingsBridge, desk: typeof window.deskBridge };
  })()`);
  expect("a web page cannot fetch aither://", probe.fetched === "blocked", probe);
  expect("a web page cannot read a framed aither:// page", probe.framed !== "Settings", probe);
  const frames = web.webContents.mainFrame.framesInSubtree.map((f) => f.url);
  expect("no aither:// frame loaded inside a web page", !frames.some((u) => u.startsWith("aither:")), frames);
  expect("a web page has no desk bridge", probe.bridge === "undefined" && probe.desk === "undefined", probe);
  web.destroy();

  // An internal page cannot frame itself or another pane either (frame-ancestors 'none').
  const { win: host } = await open(prefs, internal.internalUrl("settings"));
  await host.webContents.executeJavaScript(`(() => { const f = document.createElement("iframe");
    f.src = "aither://command/"; document.body.appendChild(f); return true; })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const inner = await host.webContents.executeJavaScript(`(() => { try {
    return document.querySelector("iframe").contentDocument?.title || "empty"; } catch { return "opaque"; } })()`);
  expect("aither:// pages are never framed (frame-ancestors 'none')", inner !== "Command", inner);
  host.destroy();

  console.log(fails.length ? `${fails.length} FAILED` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((error) => {
  console.log("BROKE " + ((error && error.stack) || error));
  app.exit(2);
});
