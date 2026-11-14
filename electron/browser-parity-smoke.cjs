"use strict";

/**
 * Edge parity, live (`npm run test:browser-parity`): the real Aither Browser window, a
 * local web server, and every gap closed on 2026-11-13 exercised on real pages --
 * keys, find, zoom, InPrivate, ad blocking, password save + autofill, the PDF viewer,
 * right-click, session restore. Unit tests prove the parts; only a real Chromium shows
 * that a login form fills, an ad request is cancelled and a PDF renders in the tab.
 *
 * Content blocking depth (2026-11-13): an ad box named by an EasyList selector is
 * hidden, an ad path on the page's own host is cancelled, the shield pauses both, a
 * page address loses its tracking parameters, requests carry Sec-GPC, and a German
 * page is offered for translation and translated (by a fake model here, so the run
 * needs no model; AWDESK_TRANSLATE_LIVE=1 adds a real one and prints what it wrote).
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
app.commandLine.appendSwitch("lang", "en-US"); // the owner's language here: German pages are foreign
const LIVE_TRANSLATE = process.env.AWDESK_TRANSLATE_LIVE === "1";
// The block lists, as a download leaves them, so the run needs no network. Every line
// is a real EasyList rule (checked against easylist.txt, 2026-11-13).
fs.mkdirSync(path.join(userData, "adblock"), { recursive: true });
fs.writeFileSync(path.join(userData, "adblock", "adblock-easylist.txt"),
  ["[Adblock Plus 2.0]", "! smoke seed", "##.ad_banner", "##.sponsored-ad", "/ads/banners/*$image", ""].join("\n"));
// Closing the browser (the session-restore check) must not quit the run.
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, LIVE_TRANSLATE ? 140000 : 120000);

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
  // .ad_banner is an EasyList generic selector; the page fights back with !important.
  // The image is an ad on the page's OWN host, which only a path rule can catch.
  "/cosmetic": "<!doctype html><title>Cosmetic</title><p id=\"keep\">news</p>"
    + "<div id=\"box\" class=\"ad_banner\" style=\"display:block !important\">BUY NOW</div>"
    + "<img id=\"b\" src=\"/ads/banners/top.gif\">",
  // Says lang=en and is German: the text decides, as it must on real sites.
  "/de": "<!doctype html><html lang=\"en\"><title>Nachrichten</title><h1 id=\"h\">Die Stadt hat ein neues Museum eröffnet</h1>"
    + "<p id=\"p1\">Der Eintritt ist für Kinder frei, und die Ausstellung wird bis zum Ende des Jahres zu sehen sein.</p>"
    + "<p id=\"p2\">Viele Besucher sind aus der ganzen Region gekommen, um die Bilder zu sehen.</p></html>",
  "/es": "<!doctype html><html lang=\"es\"><title>Noticias</title><h1 id=\"h\">El gobierno anunció hoy un nuevo plan para el transporte</h1>"
    + "<p id=\"p1\">Los vecinos dicen que es una buena noticia, pero que todavía hay mucho por hacer en los barrios del sur.</p>"
    + "<p id=\"p2\">El alcalde explicó que las obras empezarán en enero y que durarán dos años.</p></html>",
};
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
/** Every request the server saw: {url, gpc, dnt}. */
const seen = [];
/** The smoke's translator: a model that knows exactly these sentences. */
const FAKE_DE = {
  "Die Stadt hat ein neues Museum eröffnet": "The city has opened a new museum",
  "Der Eintritt ist für Kinder frei, und die Ausstellung wird bis zum Ende des Jahres zu sehen sein.": "Entry is free for children, and the exhibition will be on show until the end of the year.",
  "Viele Besucher sind aus der ganzen Region gekommen, um die Bilder zu sehen.": "Many visitors have come from across the region to see the pictures.",
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      seen.push({ url: req.url, gpc: req.headers["sec-gpc"], dnt: req.headers.dnt });
      if (u.pathname === "/ads/banners/top.gif") { res.writeHead(200, { "content-type": "image/gif" }); res.end(GIF); return; }
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

  // Cosmetic filtering: the box an EasyList selector names is gone, the page's own
  // !important loses to the user sheet, and the rest of the page is untouched.
  const shown = (sel) => wc.executeJavaScript(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display`);
  const adHits = () => seen.filter((r) => r.url.startsWith("/ads/banners/")).length;
  await wc.loadURL(`${base}/cosmetic`).catch(() => {});
  await loaded(wc, "/cosmetic");
  expect("an ad box named by an EasyList selector is hidden", await until(async () => (await shown("#box")) === "none", 5000), await shown("#box"));
  expect("the rest of the page still shows", (await shown("#keep")) === "block", await shown("#keep"));
  // A path rule: the ad image lives on the page's own host and is still cancelled.
  expect("an ad path on the page's own host is cancelled", adHits() === 0 && bw.getAdblock().blockedOn(wc.id) >= 1,
    { hits: adHits(), blocked: bw.getAdblock().blockedOn(wc.id) });
  const shield = bw.getState().adblock;
  expect("the shield shows on a web page with the count", shield && shield.web === true && shield.blocked >= 1 && !shield.siteOff, shield);

  // The shield, "Pause on this site": the page reloads with its ads, unhidden.
  bw.shieldAction("pause-site", true);
  expect("pause on this site: the box is back", await until(async () => !wc.isLoading() && (await shown("#box")) === "block", 6000), await shown("#box"));
  expect("pause on this site: the ad request goes through", Boolean(await until(() => adHits() >= 1, 4000)), adHits());
  expect("pause on this site: state says so", bw.getState().adblock.siteOff === true, bw.getState().adblock);
  bw.shieldAction("pause-site", false);
  expect("resume on this site: hidden again", await until(async () => !wc.isLoading() && (await shown("#box")) === "none", 6000), await shown("#box"));
  // "Pause everywhere", and back.
  bw.shieldAction("pause-all", true);
  expect("pause everywhere: the box is back", await until(async () => !wc.isLoading() && (await shown("#box")) === "block", 6000), await shown("#box"));
  expect("pause everywhere: state says blocking is off", bw.getState().adblock.enabled === false, bw.getState().adblock);
  bw.shieldAction("pause-all", false);
  expect("resume everywhere: hidden again", await until(async () => !wc.isLoading() && (await shown("#box")) === "none", 6000), await shown("#box"));

  // Tracking: a page address loses its click identifiers before the request leaves,
  // the other parameter and the fragment stay, and requests carry Sec-GPC and DNT.
  seen.length = 0;
  await wc.loadURL(`${base}/find?utm_source=newsletter&id=7&fbclid=AbC123#top`).catch(() => {});
  await until(() => !wc.isLoading() && wc.getURL().includes("/find?"));
  expect("tracking parameters are stripped from the address", wc.getURL() === `${base}/find?id=7#top`, wc.getURL());
  const finds = seen.filter((r) => r.url.startsWith("/find"));
  expect("the server never sees them", finds.length >= 1 && finds.every((r) => r.url === "/find?id=7"), finds);
  expect("requests carry Sec-GPC: 1 and DNT: 1", finds.length >= 1 && finds.every((r) => r.gpc === "1" && r.dnt === "1"), finds);

  // Translate: a German page is offered (its lang attribute lies; the text decides),
  // and Translate rewrites the text in place and names the model that did it.
  const fakeCalls = [];
  bw.__setTranslateBackendsForTest([{ id: "fake", label: "the smoke's fake model", ask: async (prompt) => {
    fakeCalls.push(prompt);
    const list = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    return JSON.stringify(list.map((t) => FAKE_DE[t] || t));
  } }]);
  await wc.loadURL(`${base}/de`).catch(() => {});
  await loaded(wc, "/de");
  const offerTr = await until(() => { const n = bw.__noticeForTest(active()); return n && n.kind === "translate-offer" ? n : null; }, 6000);
  expect("a German page is offered for translation", Boolean(offerTr) && /German/.test(offerTr.text) && /English/.test(offerTr.text),
    bw.__noticeForTest(active()));
  expect("nothing is sent to a model before the owner says so", fakeCalls.length === 0, fakeCalls.length);
  const tr = offerTr ? await bw.noticeAction("translate") : { ok: false };
  const textOf = (sel) => wc.executeJavaScript(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  expect("Translate rewrites the page in place", tr.ok && tr.changed === 3 && (await textOf("#h")) === "The city has opened a new museum"
    && /free for children/.test(await textOf("#p1")), { tr, h: await textOf("#h") });
  const doneNote = bw.__noticeForTest(active());
  expect("the notice names the model that answered", Boolean(doneNote) && doneNote.text === "Translated into English by the smoke's fake model.", doneNote);

  if (LIVE_TRANSLATE) {
    // A real model: whatever this machine can reach right now, in the shipped order.
    bw.__setTranslateBackendsForTest(null);
    await wc.loadURL(`${base}/es`).catch(() => {});
    await loaded(wc, "/es");
    const before = [await textOf("#h"), await textOf("#p1"), await textOf("#p2")];
    const t0 = Date.now();
    const live = await bw.translatePage(active());
    const after = [await textOf("#h"), await textOf("#p1"), await textOf("#p2")];
    console.log("LIVE backend " + JSON.stringify(live.backend) + " tried " + JSON.stringify(live.tried) + " in " + (Date.now() - t0) + " ms");
    before.forEach((b, i) => console.log("LIVE es: " + b + "\nLIVE en: " + after[i]));
    console.log("LIVE notice " + JSON.stringify((bw.__noticeForTest(active()) || {}).text));
    expect("LIVE: a real model translated the Spanish page", live.ok && live.changed === 3 && after.every((a, i) => a !== before[i])
      && /government|plan|transport/i.test(after[0]), { live, after });
    bw.__setTranslateBackendsForTest([{ id: "fake", label: "the smoke's fake model", ask: async () => "[]" }]);
  }

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
  // InPrivate: ad boxes are still hidden; a foreign page is NOT offered for translation.
  await pwc.loadURL(`${base}/cosmetic`).catch(() => {});
  expect("InPrivate pages get the hiding sheet too", await until(async () => !pwc.isLoading()
    && (await pwc.executeJavaScript("getComputedStyle(document.querySelector('#box')).display")) === "none", 5000), null);
  await pwc.loadURL(`${base}/de`).catch(() => {});
  await until(() => !pwc.isLoading() && pwc.getURL().includes("/de"));
  await sleep(1500);
  expect("InPrivate: no translation is offered unasked", !bw.__noticeForTest(active()), bw.__noticeForTest(active()));
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
