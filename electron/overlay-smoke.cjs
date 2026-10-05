"use strict";

/**
 * Does AitherOS Online really draw over a web page in the Aither Browser, the way
 * awconnect's overlay does in Chrome? `npm run test:overlay` -- opens the real window
 * (temp userData), a real web page, turns the Online layer on, and asks the page.
 * Exit 0 pass, 1 a check failed, 2 could not judge (no awconnect staged, no network), 3 hung.
 */
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const bw = require("./browser-window.cjs");
const extensions = require("./browser-extensions.cjs");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-overlay-smoke-${process.pid}`));
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 120000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = "https://example.com/";

app.whenReady().then(async () => {
  if (!extensions.awconnectDir()) { console.log("DEAD no awconnect build is staged"); return app.exit(2); }
  bw.createBrowserWindow();
  await sleep(1500);
  bw.__openTabForTest(PAGE);
  let view = null;
  for (let i = 0; i < 40 && !view; i++) {
    await sleep(500);
    const w = bw.getWindow();
    view = w && w.contentView.children.find((v) => v.webContents.getURL().startsWith(PAGE) && !v.webContents.isLoading());
  }
  if (!view) { console.log("DEAD the web page never loaded"); return app.exit(2); }
  const wc = view.webContents;
  const probe = () => wc.executeJavaScript(`(() => { const h = document.getElementById("aither-os-overlay");
    const f = h && h.querySelector("iframe"); return { host: !!h, src: f ? f.src : null, opacity: h ? getComputedStyle(h).opacity : null }; })()`);
  expect("off by default: no overlay on the page", !(await probe()).host, await probe());

  bw.setOverlay(true);
  let seen = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    seen = await probe();
    if (seen.host && seen.opacity === "1") break;
  }
  expect("on: the page carries the overlay host and the OS iframe", seen && seen.host && /^https:\/\/aitherium\.com\/\?mode=overlay/.test(seen.src || ""), seen);
  expect("the real OS framed and said ready (the host faded in)", seen && seen.opacity === "1", seen);
  const frame = wc.mainFrame.framesInSubtree.find((f) => f.origin === "https://aitherium.com");
  expect("the OS frame is live in the page", Boolean(frame), wc.mainFrame.framesInSubtree.map((f) => f.origin));
  expect("the page never sees the shim (it lives in an isolated world)",
    await wc.executeJavaScript("typeof window.__aitherNext === 'undefined' && typeof window.__aitherReply === 'undefined'"), null);
  expect("the Online layer reads 'over pages'",
    (bw.getState().rail.layers || []).some((l) => l.key === "online" && l.on && l.state === "over pages"), bw.getState().rail.layers);

  if (process.env.OV_DEBUG) {
    console.log("DBG frames " + JSON.stringify(wc.mainFrame.framesInSubtree.map((f) => [f.origin, f.url])));
    if (frame) console.log("DBG frame " + JSON.stringify(await frame.executeJavaScript("[document.documentElement.className, document.title, location.href, document.body ? document.body.innerText.slice(0,120) : null]").catch((e) => String(e))));
    const ov = require("./browser-overlay.cjs");
    console.log("DBG world " + JSON.stringify(await wc.executeJavaScriptInIsolatedWorld(ov.WORLD, [{ code: "[typeof chrome, typeof __aitherNext, window.__aitherOverlay]" }]).catch((e) => String(e))));
    console.log("DBG teardown " + JSON.stringify(await wc.executeJavaScriptInIsolatedWorld(ov.WORLD, [{ code: ov.TEARDOWN }]).catch((e) => String(e))));
  }
  // Read aloud (Voice section): the page's text goes to the desk's one speech path.
  let spoken = null;
  bw.setShellHost({ isOwner: () => false, signedIn: () => false, docked: () => false, overlayVisible: () => false,
    popupMenu: () => {}, run: () => {}, speak: (t) => { spoken = t; } });
  const read = await bw.readAloud();
  expect("Read aloud speaks the page's text", read.ok && /This domain is for use/.test(spoken || ""), { read, spoken: spoken && spoken.slice(0, 80) });
  // Voice -> the browser's agent: a spoken question is answered with the page as context.
  bw.createBrowserWindow({ askAgent: async (prompt) => ({ ok: true, reply: "saw page: " + /This domain is for use/.test(prompt) }) });
  const heard = await bw.voiceAsk("what is this page for?");
  expect("a spoken question is answered about the page on screen", heard.ok && heard.reply === "saw page: true", heard);
  bw.setOverlay(false);
  await sleep(800);
  expect("off again: the overlay is gone from the page", !(await probe()).host, await probe());
  bw.closeBrowserWindow();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
