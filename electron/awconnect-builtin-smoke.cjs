"use strict";

/**
 * Does the staged awconnect build really load into the Aither Browser's partition,
 * and do its content scripts run on a page? `npm run test:awconnect-builtin`.
 * Hidden windows, temp userData. Exit 0 pass, 1 a check failed, 2 nothing staged or
 * the run broke (could not judge), 3 it hung.
 */
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const ext = require("./browser-extensions.cjs");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-awconnect-smoke-${process.pid}`));
app.on("window-all-closed", () => {});
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 90000);
const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};

app.whenReady().then(async () => {
  const dir = ext.awconnectDir();
  if (!dir) {
    console.log("DEAD no awconnect build is staged at ~/.aither/awconnect/current");
    return app.exit(2);
  }
  const ses = session.fromPartition("persist:awconnect-smoke");
  const loaded = await ext.loadAwconnect(ses, { dir });
  expect("awconnect loads into the browser partition", loaded.ok, loaded);
  if (!loaded.ok) return app.exit(1);
  console.log(`INFO ${loaded.name} ${loaded.version} id=${loaded.id}`);
  const again = await ext.loadAwconnect(ses, { dir });
  expect("a second load reuses it", again.ok && again.id === loaded.id, again);

  const win = new BrowserWindow({ show: false, webPreferences: ext.withCompat("extension",
    { partition: "persist:awconnect-smoke", sandbox: true, contextIsolation: true }) });
  await new Promise((r) => setTimeout(r, 4000));
  const workers = Object.values(ses.serviceWorkers.getAllRunning()).map((w) => w.scriptUrl);
  expect("its background worker runs (compat shim)", workers.some((u) => u.startsWith(`chrome-extension://${loaded.id}/`)), workers);
  const ui = ext.uiUrl(loaded.id, loaded.ui);
  let uiError = null;
  try { await win.loadURL(ui); } catch (error) { uiError = String((error && error.message) || error); }
  expect("its own UI page opens in a tab", !uiError && win.webContents.getURL().startsWith(`chrome-extension://${loaded.id}/`), uiError);
  const title = await win.webContents.executeJavaScript("document.title").catch(() => "");
  console.log(`INFO ui title: ${title}`);
  expect("its UI page renders", Boolean(title), title);
  win.destroy();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
