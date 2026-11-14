"use strict";

/**
 * Edge parity, live (`npm run test:browser-parity`): the real Aither Browser window, a
 * local web server, and every gap closed on 2026-11-13 exercised on real pages --
 * keys, find, zoom, InPrivate, ad blocking, password save + autofill, the PDF viewer,
 * right-click, session restore. Unit tests prove the parts; only a real Chromium shows
 * that a login form fills, an ad request is cancelled and a PDF renders in the tab.
 *
 * And the library pages (browser-library-pages.cjs), each driven by clicking its own
 * buttons in a real aither:// tab: the history page lists a visit and deletes it; a
 * bookmark is added, renamed and deleted; the bookmarks bar takes its row; clear
 * browsing data empties history after the confirm; a site asking for notifications
 * raises the prompt, Block is remembered, and an agent's tab is never asked.
 *
 * Own entry point: a temp userData (never the owner's profile), no tray.
 * Exit 0 all pass, 1 a check failed, 2 the run itself broke, 3 it hung.
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { app, protocol } = require("electron");
// aither:// must be a standard scheme before the app is ready (main.cjs does this).
require("./browser-internal.cjs").registerPrivilegedScheme(protocol);

const userData = path.join(os.tmpdir(), `awdesk-parity-smoke-${process.pid}`);
app.setPath("userData", userData);
// Closing the browser (the session-restore check) must not quit the run.
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 140000);

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
  "/perm": "<!doctype html><title>Perm</title><p>asks for notifications</p>",
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (gaps.serve(req, res)) return; // the high-impact gaps' own pages (browser-parity-gaps.cjs)
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/doc.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(PDF); return; }
      const body = PAGES[u.pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body || "nope");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const gaps = require("./browser-parity-gaps.cjs");
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
  // The landing page asks for notifications on top of the offer: the prompt takes the
  // toolbar, Allow is dead while it is new, and the offer comes back when it is answered.
  if (offer) {
    await loaded(wc, "/done");
    await sleep(300);
    await wc.executeJavaScript("window.__answer = null; Notification.requestPermission().then((v) => { window.__answer = v; }); 0", true);
    const over = await until(() => { const n = bw.__noticeForTest(active()); return n && n.kind === "permission" ? n : null; });
    expect("a permission prompt takes the place of the save offer", Boolean(over), bw.__noticeForTest(active()));
    const early = await bw.noticeAction("permission-allow");
    const still = bw.__noticeForTest(active());
    expect("Allow does nothing in the prompt's first half second", early && early.ok === false && early.early === true
      && still && still.kind === "permission" && (await wc.executeJavaScript("window.__answer", true)) === null
      && bw.getPermissionStore().list().length === 0, { early, still, list: bw.getPermissionStore().list() });
    await bw.noticeAction("dismiss");
    const back = await until(() => { const n = bw.__noticeForTest(active()); return n && n.kind === "password-save" ? n : null; });
    expect("the save offer comes back after the prompt is answered", Boolean(back) && back.data.username === "david"
      && bw.getPermissionStore().list().length === 0, bw.__noticeForTest(active()));
  }
  if (bw.__noticeForTest(active())) await bw.noticeAction("password-save");
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

  // ------------------------------------------------------------------ the library pages
  const lib = bw.getLibrary();
  const confirms = [];
  let confirmAnswer = true;
  bw.__setConfirmForTest((q) => { confirms.push(q); return confirmAnswer; });
  /** The aither:// page a browser action opened, once its list has drawn. */
  const libraryPage = async (action, pane) => {
    const opened = bw.runBrowserAction(action);
    const lwc = await until(() => {
      const p = page();
      return p && p.getURL().startsWith(`aither://${pane}/`) && !p.isLoading() ? p : null;
    });
    if (lwc) await until(() => lwc.executeJavaScript("Boolean(window.aitherLibrary) && document.getElementById('nav').children.length === 5"));
    return { opened, lwc, tabId: active() };
  };
  const js = (target, code) => target.executeJavaScript(code, true);

  // History (Ctrl+H): the visits above are listed with who made them; Delete forgets one.
  const hist = await libraryPage("history", "history");
  expect("Ctrl+H opens aither://history", hist.opened === true && Boolean(hist.lwc), page() && page().getURL());
  if (hist.lwc) {
    const findRow = "document.querySelector('#list .row[data-url$=\"/find\"]')";
    const listed = await until(() => js(hist.lwc, `(() => { const r = ${findRow}; return r ? r.textContent : ""; })()`));
    expect("the history page lists a visit and who made it", /Find/.test(listed || "") && /you/.test(listed || ""), listed);
    expect("the history page groups by day", (await js(hist.lwc, "document.querySelector('#list h2.day').textContent")).startsWith("Today"), null);
    await js(hist.lwc, "document.getElementById('q').value = 'login'; document.getElementById('q').dispatchEvent(new Event('input')); 0");
    const searched = await until(() => js(hist.lwc, "(() => { const rows = [...document.querySelectorAll('#list .row')]; return rows.length > 0 && rows.every((r) => r.dataset.url.includes('/login')); })()"));
    expect("the history page searches", Boolean(searched), await js(hist.lwc, "document.getElementById('list').textContent"));
    await js(hist.lwc, "document.getElementById('q').value = ''; document.getElementById('q').dispatchEvent(new Event('input')); 0");
    await until(() => js(hist.lwc, `Boolean(${findRow})`));
    await js(hist.lwc, `${findRow}.querySelector('button.small').click(); 0`);
    const gone = await until(() => !lib.history(500).some((h) => h.url.endsWith("/find")));
    const rowGone = await until(() => js(hist.lwc, `!${findRow}`));
    expect("Delete on the history page forgets that visit", Boolean(gone) && Boolean(rowGone), lib.history(500).map((h) => h.url));
    expect("the other visits stay", lib.history(500).some((h) => h.url.endsWith("/login")), lib.history(500).map((h) => h.url));
  }

  // Bookmarks (Ctrl+Shift+O): add, rename, delete, each through the page's own buttons.
  const marks = await libraryPage("bookmarks", "bookmarks");
  expect("Ctrl+Shift+O opens aither://bookmarks", Boolean(marks.lwc), page() && page().getURL());
  const markUrl = `${base}/done?bookmark=1`;
  if (marks.lwc) {
    await js(marks.lwc, `document.getElementById('add').click(); document.getElementById('add-url').value = ${JSON.stringify(markUrl)};`
      + "document.getElementById('add-title').value = 'First name'; document.getElementById('add-folder').value = 'Work'; document.getElementById('add-save').click(); 0");
    const added = await until(() => lib.bookmarks().find((b) => b.url === markUrl));
    expect("a bookmark is added from the page, in its folder", Boolean(added) && added.title === "First name" && added.folder === "Work", lib.bookmarks());
    const markRow = `document.querySelector('#list .row[data-url=${JSON.stringify(markUrl)}]')`;
    await until(() => js(marks.lwc, `Boolean(${markRow})`));
    expect("the page lists it under its folder", /Work \(1\)/.test(await js(marks.lwc, "document.querySelector('#list h2.folder').textContent")), null);
    await js(marks.lwc, `${markRow}.querySelector('[data-act=edit]').click(); ${markRow}.querySelector('[data-field=title]').value = 'Second name';`
      + `${markRow}.querySelector('[data-act=save]').click(); 0`);
    const renamed = await until(() => (lib.bookmarks().find((b) => b.url === markUrl) || {}).title === "Second name");
    expect("a bookmark is renamed from the page", Boolean(renamed), lib.bookmarks());
    expect("the address bar's star knows it", lib.isBookmarked(markUrl), null);

    // The bookmarks bar (Ctrl+Shift+B): off by default; on, the chrome grows by its row and
    // the page view moves down with it; the bar shows the folder.
    const chromeWc = bw.getWindow().webContents;
    const pageY = () => bw.getState().rail.rects.page.y;
    expect("the bookmarks bar is off by default", bw.getState().chromeHeight === bw.CHROME_HEIGHT && bw.getState().bookmarksBar === null
      && pageY() === bw.CHROME_HEIGHT, { h: bw.getState().chromeHeight, y: pageY() });
    bw.runBrowserAction("bookmarks-bar");
    const tall = bw.CHROME_HEIGHT + bw.BOOKMARKS_BAR_HEIGHT;
    expect("Ctrl+Shift+B shows the bar and the page moves down", bw.getState().chromeHeight === tall && pageY() === tall,
      { h: bw.getState().chromeHeight, y: pageY() });
    const barDrawn = await until(() => chromeWc.executeJavaScript("(() => { const b = document.getElementById('bmbar'); return !b.hidden"
      + " && Math.round(b.getBoundingClientRect().height) === 30 && Math.round(document.getElementById('top').getBoundingClientRect().height) === 108"
      + " ? [...b.querySelectorAll('button')].map((x) => x.textContent).join('|') : ''; })()"));
    expect("the toolbar draws the bar with the folder on it", /Work/.test(barDrawn || ""), barDrawn || await chromeWc.executeJavaScript("(() => { const b = document.getElementById('bmbar'); return [b.hidden, b.getBoundingClientRect().height, document.getElementById('top').getBoundingClientRect().height, b.textContent, getComputedStyle(document.documentElement).getPropertyValue('--chrome-h')]; })()"));
    // A click on a bar item opens that bookmark; the bar opens nothing that is not one.
    const barUrl = `${base}/done?bar=1`;
    lib.addBookmark({ url: barUrl, title: "Bar item" });
    bw.runBrowserAction("bookmarks-bar");
    bw.runBrowserAction("bookmarks-bar");
    const barItem = await until(() => chromeWc.executeJavaScript("Boolean([...document.querySelectorAll('#bmbar button.bm')].find((b) => b.textContent === 'Bar item'))"));
    expect("a top-level bookmark is a button on the bar", Boolean(barItem), null);
    const tabsBefore = bw.getTabs().snapshot().tabs.length;
    await chromeWc.executeJavaScript("[...document.querySelectorAll('#bmbar button.bm')].find((b) => b.textContent === 'Bar item').click(); 0", true);
    const barOpened = await until(() => { const p = page(); return p && p.getURL().includes("bar=1") ? p : null; });
    expect("clicking it opens the bookmark in a tab", Boolean(barOpened) && bw.getTabs().snapshot().tabs.length === tabsBefore + 1,
      page() && page().getURL());
    const notOne = await chromeWc.executeJavaScript(`window.aitherBrowser.openBookmark(${JSON.stringify(`${base}/login?not-a-bookmark`)})`);
    expect("the bar opens nothing that is not a bookmark", notOne && notOne.ok === false, notOne);
    if (barOpened) bw.runBrowserAction("close-tab");
    lib.removeBookmark(barUrl);
    bw.__showTabForTest(marks.tabId);
    bw.runBrowserAction("bookmarks-bar");
    expect("Ctrl+Shift+B again hides it", bw.getState().chromeHeight === bw.CHROME_HEIGHT && pageY() === bw.CHROME_HEIGHT, bw.getState().chromeHeight);

    await js(marks.lwc, `${markRow}.querySelector('[data-act=delete]').click(); 0`);
    const deleted = await until(() => !lib.isBookmarked(markUrl));
    expect("a bookmark is deleted from the page", Boolean(deleted), lib.bookmarks());
  }

  // Downloads (Ctrl+J): the shelf as a page. A real download would raise the OS save
  // dialog, so the row is put on the shelf directly; the page lists and removes it.
  const failedId = bw.getDownloads().start({ filename: "report.pdf", url: `${base}/report.pdf` });
  bw.getDownloads().update(failedId, { state: "interrupted" });
  const dl = await libraryPage("downloads", "downloads");
  expect("Ctrl+J opens aither://downloads", dl.opened === true && Boolean(dl.lwc), page() && page().getURL());
  if (dl.lwc) {
    const dlRow = `document.querySelector('#list .row[data-id="${failedId}"]')`;
    const dlText = await until(() => js(dl.lwc, `(() => { const r = ${dlRow}; return r ? r.textContent : ""; })()`));
    expect("the downloads page lists a failed download with Try again", /report\.pdf/.test(dlText || "") && /Failed/.test(dlText || "")
      && /Try again/.test(dlText || ""), dlText);
    await js(dl.lwc, `[...${dlRow}.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click(); 0`);
    const removed = await until(() => bw.getDownloads().get(failedId) === null);
    expect("Remove takes the row off the shelf", Boolean(removed), bw.getDownloads().list());
  }

  // Site permissions: a page asking for notifications raises the prompt; Block is
  // remembered for the site; the next ask is refused with no prompt.
  const store = bw.getPermissionStore();
  const permTab = bw.__openTabForTest(`${base}/perm`);
  const permWc = await until(() => { const p = bw.__pageForTest(permTab.id); return p && p.getURL().includes("/perm") && !p.isLoading() ? p : null; });
  const ask = "window.__answer = null; Notification.requestPermission().then((v) => { window.__answer = v; }); 0";
  await js(permWc, ask);
  const prompt = await until(() => { const n = bw.__noticeForTest(permTab.id); return n && n.kind === "permission" ? n : null; });
  expect("a site asking for notifications raises the owner's prompt", Boolean(prompt) && /wants to show notifications/.test(prompt.text)
    && prompt.actions.map((a) => a.label).join() === "Allow,Block,Not now", prompt);
  expect("nothing is granted while the prompt is up", (await js(permWc, "window.__answer")) === null && store.list().length === 0, store.list());
  const shownInToolbar = await until(() => bw.getWindow().webContents.executeJavaScript(
    "(() => { const n = document.getElementById('notice'); return !n.hidden && /notifications/.test(n.textContent) ? n.textContent : ''; })()"));
  expect("the toolbar shows it with Allow and Block", /Allow/.test(shownInToolbar || "") && /Block/.test(shownInToolbar || ""), shownInToolbar);
  if (prompt) await bw.noticeAction("permission-block");
  const refused = await until(() => js(permWc, "window.__answer"));
  expect("Block answers the page with denied", refused === "denied", refused);
  expect("Block is remembered for the site", store.get(base, "notifications") === "block", store.list());
  const permFile = JSON.parse(fs.readFileSync(path.join(userData, "browser-permissions.json"), "utf8"));
  expect("it is written to userData", permFile.sites[base] && permFile.sites[base].notifications.value === "block", permFile);
  await permWc.loadURL(`${base}/perm`).catch(() => {});
  await loaded(permWc, "/perm");
  await js(permWc, ask);
  const again = await until(() => js(permWc, "window.__answer"));
  expect("the next ask is refused without a prompt", again === "denied" && !bw.__noticeForTest(permTab.id), { again, notice: bw.__noticeForTest(permTab.id) });

  // An InPrivate tab of the same site: the remembered Block holds, and nothing is asked.
  bw.runBrowserAction("inprivate", `${base}/perm?private=2`);
  const privWc = await until(() => { const p = page(); return p && p.getURL().includes("private=2") && !p.isLoading() ? p : null; });
  await js(privWc, ask);
  expect("a blocked site stays blocked InPrivate", (await until(() => js(privWc, "window.__answer"))) === "denied" && !bw.__noticeForTest(active()), null);
  bw.runBrowserAction("close-tab");

  // The review page lists it; Remove takes it back, so the site asks again.
  const perms = await libraryPage("permissions", "permissions");
  expect("aither://permissions opens", Boolean(perms.lwc), page() && page().getURL());
  if (perms.lwc) {
    const permRow = "document.querySelector('#list .row[data-kind=notifications]')";
    const permText = await until(() => js(perms.lwc, `(() => { const r = ${permRow}; return r ? r.dataset.origin + ' ' + r.textContent : ""; })()`));
    expect("the permissions page lists the blocked site", (permText || "").startsWith(base) && /Notifications/.test(permText) && /Blocked/.test(permText), permText);
    await js(perms.lwc, `[...${permRow}.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click(); 0`);
    const forgotten = await until(() => store.get(base, "notifications") === null);
    expect("Remove on the permissions page forgets the answer", Boolean(forgotten), store.list());
  }
  bw.__showTabForTest(permTab.id);
  await js(permWc, ask);
  const reasked = await until(() => { const n = bw.__noticeForTest(permTab.id); return n && n.kind === "permission" ? n : null; });
  expect("after Remove the site asks again", Boolean(reasked), bw.__noticeForTest(permTab.id));
  if (reasked) await bw.noticeAction("dismiss");
  expect("Not now denies once and remembers nothing", (await until(() => js(permWc, "window.__answer"))) === "denied" && store.list().length === 0, store.list());
  await js(permWc, ask);
  const third = await until(() => { const n = bw.__noticeForTest(permTab.id); return n && n.kind === "permission" ? n : null; });
  await sleep(600); // Allow is dead for the prompt's first half second
  if (third) await bw.noticeAction("permission-allow");
  expect("Allow answers granted and is remembered", (await until(() => js(permWc, "window.__answer"))) === "granted"
    && store.get(base, "notifications") === "allow", { answer: await js(permWc, "window.__answer"), list: store.list() });
  expect("an allowed site reads as granted afterwards", (await js(permWc, "Notification.permission")) === "granted", await js(permWc, "Notification.permission"));

  // Taking the Allow back on the review page reaches the page that is still open: it
  // reads as not granted and asks again, with no reload in between.
  const perms2 = await libraryPage("permissions", "permissions");
  if (perms2.lwc) {
    const row2 = "document.querySelector('#list .row[data-kind=notifications]')";
    await until(() => js(perms2.lwc, `Boolean(${row2})`));
    await js(perms2.lwc, `[...${row2}.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click(); 0`);
    await until(() => store.get(base, "notifications") === null);
  }
  expect("Remove takes the Allow out of the store", store.get(base, "notifications") === null, store.list());
  bw.__showTabForTest(permTab.id);
  expect("the open page no longer reads as granted", (await js(permWc, "Notification.permission")) !== "granted", await js(permWc, "Notification.permission"));
  await js(permWc, ask);
  const fourth = await until(() => { const n = bw.__noticeForTest(permTab.id); return n && n.kind === "permission" ? n : null; });
  expect("after an Allow is taken back the open page is asked again", Boolean(fourth) && (await js(permWc, "window.__answer")) === null,
    { notice: bw.__noticeForTest(permTab.id), answer: await js(permWc, "window.__answer") });
  await sleep(600);
  if (fourth) await bw.noticeAction("permission-allow");
  expect("Allow is remembered again", (await until(() => js(permWc, "window.__answer"))) === "granted" && store.get(base, "notifications") === "allow", store.list());

  // A 60-character host: the toolbar shows the END of the name and the whole sentence.
  const longHost = `${"a".repeat(40)}.accounts-sign-in.localhost`;
  const longBase = `http://${longHost}:${server.address().port}`;
  const longTab = bw.__openTabForTest(`${longBase}/perm?long=1`);
  const longWc = await until(() => { const p = bw.__pageForTest(longTab.id); return p && p.getURL().includes("long=1") && !p.isLoading() ? p : null; });
  expect("a 60-character host opens", Boolean(longWc) && longHost.length >= 60, { longHost, url: longWc && longWc.getURL() });
  if (longWc) {
    await js(longWc, ask);
    const longPrompt = await until(() => { const n = bw.__noticeForTest(longTab.id); return n && n.kind === "permission" ? n : null; });
    expect("the long host's prompt ends with the real site and what it wants", Boolean(longPrompt)
      && longPrompt.text.startsWith("\u2026") && longPrompt.text.endsWith(`.localhost:${server.address().port} wants to show notifications.`), longPrompt);
    const fit = await until(() => bw.getWindow().webContents.executeJavaScript(`(() => {
      const n = document.getElementById('notice'); const t = document.getElementById('ntext');
      if (n.hidden || !/wants to show notifications\\.$/.test(t.textContent)) return null;
      const box = n.getBoundingClientRect(); const bar = n.parentElement.getBoundingClientRect();
      const buttons = [...n.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      return { text: t.textContent, title: n.title, sw: t.scrollWidth, cw: t.clientWidth, sh: t.scrollHeight, ch: t.clientHeight,
        inBar: box.left >= bar.left && box.right <= bar.right + 0.5,
        buttonsIn: buttons.length === 3 && buttons.every((b) => b.width > 0 && b.right <= bar.right + 0.5) };
    })()`));
    expect("the toolbar shows the whole prompt, nothing cut off", Boolean(fit) && fit.sw <= fit.cw && fit.sh < fit.ch + 8
      && fit.inBar && fit.buttonsIn && fit.title.startsWith(longBase), fit);
    if (longPrompt) await bw.noticeAction("dismiss");
    bw.runBrowserAction("close-tab");
  }

  // An AGENT's tab is never asked and never allowed, even on a site the owner allowed.
  const agent = bw.browserAgent();
  const agentTab = await agent("open", { url: `${base}/perm?agent=1` });
  const agentWc = agentTab.ok ? bw.__pageForTest(agentTab.tab) : null;
  if (agentWc) {
    await loaded(agentWc, "agent=1");
    await js(agentWc, ask);
    const agentAnswer = await until(() => js(agentWc, "window.__answer"));
    expect("an agent tab is denied with no prompt", agentAnswer === "denied" && !bw.__noticeForTest(agentTab.tab),
      { agentAnswer, notice: bw.__noticeForTest(agentTab.tab) });
    expect("an agent tab reads the permission as not granted", (await js(agentWc, "Notification.permission")) !== "granted", null);
    bw.runBrowserAction("close-tab");
  } else {
    expect("an agent tab opens for the permission check", false, agentTab);
  }
  bw.getGate().release();

  // The high-impact gaps: user agent, full screen, Copy buttons, popups, the discard's
  // exemptions and app links (browser-parity-gaps.cjs).
  await gaps.run({ bw, base, expect, until, sleep });

  // Clear browsing data (Ctrl+Shift+Delete): nothing goes without the confirm; with it,
  // history is emptied. Cookies are ticked too, so the owner profile's cookie really goes.
  const sessions = require("electron").session;
  const ownerSes = sessions.fromPartition(bw.PARTITION);
  const agentSes = sessions.fromPartition(bw.AGENT_PARTITION);
  await ownerSes.cookies.set({ url: base, name: "owner_cookie", value: "1", expirationDate: Date.now() / 1000 + 3600 });
  await agentSes.cookies.set({ url: base, name: "agent_cookie", value: "1", expirationDate: Date.now() / 1000 + 3600 });
  const clear = await libraryPage("clear-data", "clear-data");
  expect("Ctrl+Shift+Delete opens aither://clear-data", clear.opened === true && Boolean(clear.lwc), page() && page().getURL());
  if (clear.lwc) {
    await until(() => js(clear.lwc, "document.getElementById('range').options.length === 5"));
    const before = lib.history(500).length;
    expect("there is history to clear", before > 0, before);
    await js(clear.lwc, "document.getElementById('range').value = 'all'; document.getElementById('cookies').checked = true; 0");
    confirms.length = 0;
    confirmAnswer = false;
    await js(clear.lwc, "document.getElementById('go').click(); 0");
    await until(() => confirms.length === 1);
    await sleep(300);
    expect("clearing asks first, and Cancel clears nothing", confirms.length === 1 && lib.history(500).length === before
      && /Browsing history from all time/.test(confirms[0].detail) && /Cookies and site data/.test(confirms[0].detail), confirms);
    confirmAnswer = true;
    await js(clear.lwc, "document.getElementById('go').click(); 0");
    const emptied = await until(() => lib.history(500).length === 0);
    expect("clear browsing data empties history", Boolean(emptied), lib.history(500).length);
    const said = await until(() => js(clear.lwc, "(() => { const t = document.getElementById('status').textContent; return /^Cleared/.test(t) ? t : ''; })()"), 15000);
    expect("the page says what was cleared", /history entr/.test(said || "") && /cookies and site data/.test(said || "") && /the cache/.test(said || "")
      && !/Not cleared/.test(said || ""), said || await js(clear.lwc, "document.getElementById('status').textContent"));
    expect("the owner profile's cookies are gone", (await ownerSes.cookies.get({ name: "owner_cookie" })).length === 0, null);
    expect("the agent's own session is not touched", (await agentSes.cookies.get({ name: "agent_cookie" })).length === 1, null);
    expect("saved passwords stay unless ticked", bw.getVault().list().length === 1, bw.getVault().list().length);
    const onDiskLib = JSON.parse(fs.readFileSync(path.join(userData, "browser-library.json"), "utf8"));
    expect("the history file on disk is empty", onDiskLib.history.length === 0, onDiskLib.history.length);
  }
  bw.__setConfirmForTest(null);
  // Back on a web page, so the session checks below have one to save.
  bw.__showTabForTest(permTab.id);
  await permWc.loadURL(`${base}/login`).catch(() => {});
  await loaded(permWc, "/login");

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
