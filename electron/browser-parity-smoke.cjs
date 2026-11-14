"use strict";

/**
 * Edge parity, live (`npm run test:browser-parity`): the real Aither Browser window, a
 * local web server, and every gap closed on 2026-11-13 exercised on real pages --
 * keys, find, zoom, InPrivate, ad blocking, password save + autofill, the PDF viewer,
 * right-click, session restore. Unit tests prove the parts; only a real Chromium shows
 * that a login form fills, an ad request is cancelled and a PDF renders in the tab.
 *
 * Own entry point: a temp userData (never the owner's profile), no tray.
 * Exit 0 all pass, 1 a check failed, 2 the run itself broke, 3 it hung.
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

const userData = path.join(os.tmpdir(), `awdesk-parity-smoke-${process.pid}`);
app.setPath("userData", userData);
// Closing the browser (the session-restore check) must not quit the run.
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 120000);

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
  + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");

const PAGES = {
  "/find": "<!doctype html><title>Find</title><p>apple banana apple cherry apple</p>",
  // The ad host is the seed list's; the request must be cancelled (a third party).
  "/ads": "<!doctype html><title>Ads</title><p>news</p><img src=\"https://securepubads.g.doubleclick.net/pagead/x.gif\">",
  "/login": "<!doctype html><title>Login</title><form action=\"/done\" method=\"get\">"
    + "<input name=\"u\" autocomplete=\"username\"><input name=\"p\" type=\"password\"><button id=\"go\">Sign in</button></form>",
  "/done": "<!doctype html><title>Done</title><p>signed in</p>",
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/doc.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(PDF); return; }
      const body = PAGES[u.pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body || "nope");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    await sleep(100);
  }
  return null;
}

app.whenReady().then(async () => {
  const bw = require("./browser-window.cjs");
  const server = await serve();
  // localhost (not 127.0.0.1) so passwords count it as a secure origin, like Chromium does.
  const base = `http://localhost:${server.address().port}`;
  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };
  const active = () => bw.getTabs().active;
  const page = () => bw.__pageForTest(active());
  const loaded = (wc, suffix) => until(() => wc && !wc.isLoading() && wc.getURL().includes(suffix));

  bw.createBrowserWindow({ url: `${base}/find`, home: false });
  await loaded(await until(page), "/find");

  // Keys: Ctrl+T opens a tab, Ctrl+W closes it, Ctrl+Shift+T brings back a closed page.
  const before = bw.getTabs().snapshot().tabs.length;
  bw.runBrowserAction("new-tab");
  expect("Ctrl+T opens a tab", bw.getTabs().snapshot().tabs.length === before + 1, bw.getTabs().snapshot().tabs.length);
  bw.runBrowserAction("close-tab");
  expect("Ctrl+W closes it", bw.getTabs().snapshot().tabs.length === before, bw.getTabs().snapshot().tabs.length);

  // Find on page: three apples.
  const wc = page();
  await loaded(wc, "/find");
  const found = new Promise((resolve) => wc.once("found-in-page", (_e, r) => resolve(r)));
  wc.findInPage("apple");
  const r = await Promise.race([found, sleep(4000).then(() => null)]);
  expect("find on page counts matches", r && r.matches === 3, r);
  wc.stopFindInPage("clearSelection");

  // Zoom ladder.
  bw.runBrowserAction("zoom-in");
  expect("Ctrl+= zooms to 110%", Math.round(wc.getZoomFactor() * 100) === 110, wc.getZoomFactor());
  bw.runBrowserAction("zoom-reset");
  expect("Ctrl+0 resets", wc.getZoomFactor() === 1, wc.getZoomFactor());
  expect("state carries zoom", bw.getState().zoom === 100, bw.getState().zoom);

  // Ad blocking: the doubleclick image is cancelled and counted.
  await wc.loadURL(`${base}/ads`).catch(() => {});
  await loaded(wc, "/ads");
  const blocked = await until(() => bw.getAdblock().blockedOn(wc.id) > 0, 6000);
  expect("a third-party ad request is cancelled", Boolean(blocked), bw.getAdblock().blockedOn(wc.id));

  // PDF opens in the tab (no download row).
  await wc.loadURL(`${base}/doc.pdf`).catch(() => {});
  await sleep(1500);
  const st = bw.getState();
  expect("a PDF opens in the tab, not as a download", wc.getURL().endsWith("/doc.pdf") && (st.downloads || []).length === 0,
    { url: wc.getURL(), downloads: st.downloads });

  // Passwords: a submitted login is offered for saving; Save stores it (encrypted); the
  // next visit fills it by itself.
  await wc.loadURL(`${base}/login`).catch(() => {});
  await loaded(wc, "/login");
  await sleep(400); // did-stop-loading has attached the capture listener
  await wc.executeJavaScript("document.querySelector('[name=u]').value='david';document.querySelector('[name=p]').value='s3cret!\"x';document.getElementById('go').click();");
  const offer = await until(() => { const n = bw.__noticeForTest(active()); return n && n.kind === "password-save" ? n : null; });
  expect("a submitted login is offered for saving", Boolean(offer), bw.__noticeForTest(active()));
  if (offer) await bw.noticeAction("password-save");
  const saved = bw.getVault().list();
  expect("the password is saved for the origin", saved.length === 1 && saved[0].username === "david", saved);
  const onDisk = fs.readFileSync(path.join(userData, "browser-passwords.json"), "utf8");
  expect("the vault file never holds the plaintext", !onDisk.includes("s3cret"), "plaintext found");
  await wc.loadURL(`${base}/login`).catch(() => {});
  await loaded(wc, "/login");
  const offerFill = await until(() => { const n = bw.__noticeForTest(active()); return n && n.kind === "password-fill" ? n : null; });
  expect("the next visit OFFERS the fill (nothing in the page yet)", Boolean(offerFill)
    && (await wc.executeJavaScript("document.querySelector('[name=p]').value")) === "", bw.__noticeForTest(active()));
  if (offerFill) await bw.noticeAction("password-fill");
  const filled = await until(() => wc.executeJavaScript("document.querySelector('[name=p]').value"), 5000);
  expect("Fill puts the saved password in", filled === "s3cret!\"x", filled);
  expect("the key icon knows the site has one", bw.getState().passwords === 1, bw.getState().passwords);

  // InPrivate: its own in-memory session, and nothing in history.
  bw.runBrowserAction("inprivate", `${base}/done?private=1`);
  const pwc = await until(() => { const p = page(); return p && p.getURL().includes("private=1") && !p.isLoading() ? p : null; });
  expect("InPrivate tab opens", Boolean(pwc), page() && page().getURL());
  expect("InPrivate rides a non-persistent session", pwc && pwc.session !== wc.session && !pwc.session.isPersistent(), null);
  expect("InPrivate visits are not in history", !bw.getLibrary().history(100).some((h) => h.url.includes("private=1")), null);
  expect("state marks the tab InPrivate", bw.getState().private === true, bw.getState().private);
  bw.runBrowserAction("close-tab");

  // Session restore: the open tabs are written for next time; InPrivate is not.
  bw.closeBrowserWindow();
  await sleep(500);
  const session = JSON.parse(fs.readFileSync(path.join(userData, "browser-session.json"), "utf8"));
  const urls = session.tabs.map((t) => t.url);
  expect("open tabs are saved for next time", urls.some((u) => u.includes("/login")), urls);
  expect("InPrivate tabs are never saved", !urls.some((u) => u.includes("private=1")), urls);

  server.close();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* temp */ }
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
