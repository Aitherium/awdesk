"use strict";

/**
 * awconnect-webauth-smoke.cjs -- does Sign in actually WORK in the Aither Browser?
 * `npm run test:awconnect-webauth`.
 *
 * Desk-faithful: the real staged awconnect build loads into a browser partition, its own
 * UI page runs in a tab built with withCompat("extension"), and the OIDC-shaped flow is
 * driven against a LOCAL authorization server that 302s to
 * https://<id>.chromiumapp.org/?code=... -- exactly the redirect shape the IdP uses.
 * Every arm is chrome.identity.launchWebAuthFlow called FROM the extension's own main
 * world (page, then MV3 service worker), so the whole chain is exercised: shim ->
 * executeInMainWorld bridge -> ipcRenderer -> awconnect-webauth.cjs -> BrowserWindow.
 *
 * Exit 0 pass, 1 a check failed, 2 nothing staged or the run broke (could not judge),
 * 3 it hung. Windows may flash the auth window for a few seconds: that IS the feature.
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");
const ext = require("./browser-extensions.cjs");
const webauth = require("./awconnect-webauth.cjs");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-awconnect-webauth-${process.pid}`));
app.on("window-all-closed", () => {});
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 150000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > ms) return null;
    await sleep(120);
  }
}

/**
 * Runs INSIDE the extension's service worker: proves the worker world's shim and bridge
 * (no timers live in this world -- the main process owns every one).
 */
const SW_DRIVER = `"use strict";
const e = require("electron");
e.ipcRenderer.on("probe:run", (_event, url) => {
  const out = e.contextBridge.executeInMainWorld({
    func: (target) => chrome.identity.launchWebAuthFlow({ url: target }).then(
      (resolved) => ({ ok: true, resolved }),
      (error) => ({ ok: false, error: String((error && error.message) || error) }),
    ),
    args: [String(url || "")],
  });
  Promise.resolve(out).then(
    (r) => e.ipcRenderer.send("probe:report", r),
    (error) => e.ipcRenderer.send("probe:report", { ok: false, error: String((error && error.message) || error) }),
  );
});
`;

/** One launchWebAuthFlow call, FROM the page's own main world; never throws. */
function askFlow(wc, url, extra = "") {
  return wc.executeJavaScript(`(async () => {
    try {
      const resolved = await chrome.identity.launchWebAuthFlow({ url: ${JSON.stringify(url)}${extra} });
      return { ok: true, resolved };
    } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
  })()`, true);
}

app.whenReady().then(async () => {
  const dir = ext.awconnectDir();
  if (!dir) {
    console.log("DEAD no awconnect build is staged at ~/.aither/awconnect/current");
    return app.exit(2);
  }
  const ses = session.fromPartition("persist:awconnect-webauth-smoke");
  // Before the extension loads: the channel and the worker hooks must already exist.
  const installed = webauth.install({ ipcMain, session: ses });
  expect("the identity channel installs on the browser's session", installed.ok, installed);
  const swDriver = path.join(app.getPath("userData"), "probe-sw-driver.cjs");
  fs.writeFileSync(swDriver, SW_DRIVER, "utf8");
  ses.registerPreloadScript({ id: "awconnect-webauth-smoke-sw", type: "service-worker", filePath: swDriver });
  const loaded = await ext.loadAwconnect(ses, { dir });
  expect("awconnect loads into the browser partition", loaded.ok, loaded);
  if (!loaded.ok) return app.exit(1);
  console.log(`INFO ${loaded.name} ${loaded.version} id=${loaded.id}`);
  const base = `https://${loaded.id}.chromiumapp.org/`;
  const callback = `${base}?code=TEST123&state=STATE_XYZ`;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/authorize")) {
      res.writeHead(302, { Location: callback });
      res.end();
      return;
    }
    if (req.url.startsWith("/slow")) {
      res.setHeader("content-type", "text/html");
      res.end("<html><body>an authorization page that never redirects</body></html>");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const authorize = `http://127.0.0.1:${port}/authorize`;
  const slow = `http://127.0.0.1:${port}/slow`;
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));

  const win = new BrowserWindow({ show: false, webPreferences: ext.withCompat("extension", {
    partition: "persist:awconnect-webauth-smoke", sandbox: true, contextIsolation: true }) });
  await win.loadURL(ext.uiUrl(loaded.id, loaded.ui));
  const wc = win.webContents;

  const page = await wc.executeJavaScript(`(async () => ({
    id: chrome.runtime.id,
    redirect: chrome.identity.getRedirectURL(),
    launchType: typeof chrome.identity.launchWebAuthFlow,
  }))()`, true);
  expect("the UI page's chrome.runtime.id is the loaded extension", page.id === loaded.id, page);
  expect("getRedirectURL() is a string on the extension's own callback host", page.redirect === base, page);
  expect("launchWebAuthFlow is callable in the page", page.launchType === "function", page);

  // 1) The real flow: authorization page -> 302 -> the chromiumapp callback.
  const flow = await askFlow(wc, authorize);
  expect("the 302 to the chromiumapp callback resolves the flow with the redirect URL",
    flow.ok && flow.resolved === callback, flow);
  expect("the auth window closes itself after the callback", BrowserWindow.getAllWindows().length === 1,
    BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));

  // 2) One flow at a time, and the user closing the window.
  const pending = askFlow(wc, slow);
  const authWin = await until(() => BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().startsWith(slow)), 12000);
  expect("the auth window opens on the authorization page", Boolean(authWin),
    BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
  const busy = await askFlow(wc, authorize);
  expect("a second concurrent flow is refused with Chromium's wording",
    !busy.ok && busy.error === webauth.MESSAGES.singleFlow, busy);
  if (authWin) authWin.close();
  const closed = await pending;
  expect("closing the auth window rejects the flow with Chromium's wording",
    !closed.ok && closed.error === webauth.MESSAGES.userClosed, closed);

  // 3) An authorization page that cannot be loaded.
  const bad = await askFlow(wc, `http://127.0.0.1:${deadPort}/authorize`);
  expect("an unreachable authorization page rejects with Chromium's wording",
    !bad.ok && bad.error === webauth.MESSAGES.loadFailed, bad);

  // 4) The MV3 service worker: same flow, driven from the worker's main world.
  let worker = null;
  for (let i = 0; i < 25 && !worker; i++) {
    try { worker = await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${loaded.id}/`); } catch { /* still starting */ }
    if (!worker) await sleep(400);
  }
  expect("the extension's MV3 worker is running", Boolean(worker), null);
  if (worker) {
    const reported = new Promise((resolve) => worker.ipc.on("probe:report", (_event, r) => resolve(r)));
    worker.send("probe:run", authorize);
    const swOut = await Promise.race([reported, sleep(20000).then(() => null)]);
    expect("the FLOW FROM THE SERVICE WORKER resolves through the same interception",
      Boolean(swOut) && swOut.ok && swOut.resolved === callback, swOut);
  }

  win.destroy();
  server.close();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
