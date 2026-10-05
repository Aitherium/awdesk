"use strict";

/**
 * Does aither://search really search? `npm run test:search` -- an Electron run against
 * the REAL tools on this machine: awfind (AitherSearch) for results and an answer, the
 * gateway for images and for where Media Forge runs. Hidden window, temp userData.
 * Exit 0 all pass, 1 a check failed, 2 the run broke or a dependency is down (could not
 * judge), 3 it hung. Never starts a research job or a GPU render.
 */
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, protocol, session } = require("electron");
const internal = require("./browser-internal.cjs");
const searchWindow = require("./search-window.cjs");

internal.registerPrivilegedScheme(protocol);
app.setPath("userData", path.join(os.tmpdir(), `awdesk-search-smoke-${process.pid}`));
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 240000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(wc, expr, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await wc.executeJavaScript(expr).catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  return null;
}

app.whenReady().then(async () => {
  let opened = null;
  searchWindow.setForgeOpener((url) => { opened = url; });
  searchWindow.ensureSearchIpc();
  internal.installInternalProtocol(session.fromPartition(internal.INTERNAL_PARTITION), { rendererUrl: "" });
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: internal.tabPreferences("internal", { webPartition: "persist:search-smoke" }) });
  await win.loadURL("aither://search/?q=" + encodeURIComponent("podman quadlet tutorial"));
  const wc = win.webContents;
  expect("the bridge is there", await wc.executeJavaScript("typeof window.aitherSearch") === "object");
  const n = await until(wc, `document.querySelectorAll(".r a.t").length || null`, 60000);
  const err = await wc.executeJavaScript(`document.getElementById("status").className === "err" ? document.getElementById("status").textContent : ""`);
  if (!n && /not installed|did not answer|unreadable/.test(err)) {
    console.log("DEAD awfind could not run: " + err);
    return app.exit(2);
  }
  expect("?q= runs the search and renders AitherSearch results", n > 0, { n, err });
  const hrefs = await wc.executeJavaScript(`[...document.querySelectorAll(".r a.t")].map((a) => a.href)`);
  expect("every result link is http(s)", hrefs.length > 0 && hrefs.every((h) => /^https?:\/\//.test(h)), hrefs.slice(0, 3));

  await wc.executeJavaScript(`document.querySelector('[data-mode="images"]').click(); document.getElementById("q").value = "aurora borealis"; document.getElementById("form").requestSubmit();`);
  const imgs = await until(wc, `document.querySelectorAll(".grid img").length || null`, 45000);
  expect("Images mode renders thumbnails", imgs > 0, imgs);

  await wc.executeJavaScript(`document.querySelector('[data-mode="forge"]').click(); document.querySelector(".forge button").click();`);
  await until(wc, `/Opened|not reachable|did not answer|Error/.test(document.getElementById("status").textContent) || null`, 30000);
  expect("Media Forge resolves to an http(s) UI and opens it", Boolean(opened && /^https?:\/\//.test(opened)), opened);

  win.destroy();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
