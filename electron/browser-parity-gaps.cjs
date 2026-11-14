"use strict";

/**
 * The high-impact Edge gaps, live -- one block of browser-parity-smoke.cjs, kept in its
 * own file so the smoke itself only gains three lines. Each check fails without its fix:
 *
 *   1. user agent     a page, its request header, an agent tab, an InPrivate tab, a popup
 *                     and a service worker never see "Electron".
 *   2. full screen    a click-triggered requestFullscreen() works, the tab's view takes the
 *                     whole window, Escape restores the exact layout; an agent tab is refused.
 *   3. Copy buttons   navigator.clipboard.writeText resolves after a click in the owner's
 *                     tab; with no click, and in an agent's tab, it is refused.
 *   4. popups         window.open gives a TAB that keeps window.opener (postMessage arrives),
 *                     window.close() closes that tab; an agent page's popup is the agent's.
 *   5. discard        a page with typed text says so in the isolated world; a site allowed
 *                     to notify is exempt.
 *   +  page errors    a crashed page raises "This page crashed." with Reload; a followed link
 *                     that did not load shows the dark error page, not a blank one.
 *   6. app links      mailto: raises "Open <App>?", Open hands the EXACT address to the
 *                     (stubbed) system opener, Always is remembered; an agent tab and an
 *                     unlisted scheme get nothing.
 *
 * The clipboard check writes the real clipboard; what was on it is put back afterwards.
 */

const MAILTO = "mailto:owner@example.com?subject=Hello%20there";
const ZOOM = "zoommtg://zoom.us/join?confno=123456789";
const COPIED = "aither-gap-copy";

const BUTTON = "position:fixed;left:0;width:140px;height:40px;display:block";
const PAGES = {
  "/gap-main": `<!doctype html><title>Gap</title>
<button id="fs" style="${BUTTON};top:0">full screen</button>
<button id="cp" style="${BUTTON};top:50px">copy</button>
<button id="pop" style="${BUTTON};top:100px">popup</button>
<a id="mail" href="${MAILTO}" style="${BUTTON};top:150px">mail</a>
<a id="odd" href="calculator:run" style="${BUTTON};top:200px">not listed</a>
<div id="box" style="position:fixed;left:200px;top:0;width:120px;height:120px;background:#246">video</div>
<script>
window.__log = [];
document.getElementById("fs").onclick = () => document.getElementById("box").requestFullscreen()
  .then(() => __log.push("fs ok"), (e) => __log.push("fs fail " + e.message));
document.getElementById("cp").onclick = () => navigator.clipboard.writeText(${JSON.stringify(COPIED)})
  .then(() => __log.push("cp ok"), (e) => __log.push("cp fail " + e.message));
document.getElementById("pop").onclick = () => { window.__w = window.open("/gap-popup", "gap", "width=420,height=320"); };
window.addEventListener("message", (e) => __log.push("msg " + e.data));
</script>`,
  "/gap-popup": `<!doctype html><title>Gap popup</title><p>popup</p><script>
window.__hadOpener = Boolean(window.opener);
if (window.opener) window.opener.postMessage("hello from popup", "*");
</script>`,
  "/gap-form": "<!doctype html><title>Gap form</title><input id=\"t\" type=\"text\"><input id=\"p\" type=\"password\"><textarea id=\"a\"></textarea>",
  "/gap-sw.js": "self.addEventListener('install', () => self.skipWaiting());"
    + "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));"
    + "self.addEventListener('message', (e) => e.source.postMessage(navigator.userAgent));",
};

/** path -> the User-Agent header of the last request for it. */
const headers = {};

/** The smoke server's first stop: serves the gap pages and records what the browser sent. */
function serve(req, res) {
  const pathname = new URL(req.url, "http://x").pathname;
  const body = PAGES[pathname];
  if (body == null) return false;
  headers[pathname] = String(req.headers["user-agent"] || "");
  res.writeHead(200, { "content-type": pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" });
  res.end(body);
  return true;
}

async function run({ bw, base, expect, until, sleep }) {
  const { clipboard, session } = require("electron");
  const js = (wc, code) => wc.executeJavaScript(code, true); // with a user gesture
  const jsNoGesture = (wc, code) => wc.executeJavaScript(code, false);
  const tabsNow = () => bw.getTabs().snapshot().tabs;
  const notice = (id, kind) => { const n = bw.__noticeForTest(id); return n && n.kind === kind ? n : null; };
  const ready = (id, part, ms = 8000) => until(() => { const p = bw.__pageForTest(id); return p && p.getURL().includes(part) && !p.isLoading() ? p : null; }, ms);
  const click = async (wc, y) => {
    wc.sendInputEvent({ type: "mouseDown", x: 60, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: 60, y, button: "left", clickCount: 1 });
    await sleep(150);
  };
  /** The document counts as focused even when the smoke's window is not the foreground one. */
  const focusAlways = async (wc) => {
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch { /* a focused window still passes */ }
    wc.focus();
  };
  const noElectron = (ua) => typeof ua === "string" && /Chrome\/\d+\.0\.0\.0 Safari\//.test(ua) && !/Electron|awdesk/i.test(ua);
  const UA = "navigator.userAgent";
  const win = bw.getWindow();
  const opened = [];
  bw.__setOpenExternalForTest((url) => { opened.push(url); });
  // Whatever the owner had copied (text, rich text, a picture) is put back at the end.
  const image = clipboard.readImage();
  const clipboardBefore = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), ...(image.isEmpty() ? {} : { image }) };

  // ------------------------------------------------------------------ 1. user agent
  const main = bw.__openTabForTest(`${base}/gap-main`);
  const wc = await ready(main.id, "/gap-main");
  expect("gap: the owner's page opens", Boolean(wc), main);
  if (!wc) return;
  const pageUa = await js(wc, UA);
  expect("a page reads a plain Chrome user agent (no Electron)", noElectron(pageUa), pageUa);
  expect("the request header carries the same user agent", headers["/gap-main"] === pageUa && noElectron(headers["/gap-main"]), headers["/gap-main"]);
  const brands = await js(wc, "navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : '[]'");
  expect("navigator.userAgentData names no Electron brand", !/Electron/i.test(brands) && /Chromium/.test(brands), brands);
  const swUa = await js(wc, "new Promise((res) => { navigator.serviceWorker.addEventListener('message', (e) => res(e.data));"
    + " navigator.serviceWorker.register('/gap-sw.js').then(() => navigator.serviceWorker.ready).then((r) => r.active.postMessage('ua'))"
    + ".catch((e) => res('error ' + e.message)); setTimeout(() => res('timeout'), 6000); })");
  expect("a service worker reads the plain user agent too", noElectron(swUa), swUa);
  bw.runBrowserAction("inprivate", `${base}/gap-popup?private=ua`);
  const privWc = await until(() => { const p = bw.__pageForTest(bw.getTabs().active); return p && p.getURL().includes("private=ua") && !p.isLoading() ? p : null; });
  expect("an InPrivate tab reads the plain user agent", Boolean(privWc) && noElectron(await js(privWc, UA)), privWc && await js(privWc, UA));
  if (privWc) bw.runBrowserAction("close-tab");

  // ------------------------------------------------------------------ 3. Copy buttons
  bw.__showTabForTest(main.id);
  await focusAlways(wc);
  await click(wc, 70);
  const copied = await until(() => js(wc, "__log.find((l) => l.startsWith('cp ')) || ''"), 5000);
  expect("a Copy button works after a click in the owner's tab", copied === "cp ok" && clipboard.readText() === COPIED, { copied, clipboard: clipboard.readText().slice(0, 40) });
  expect("the page reads clipboard-write as granted", (await js(wc, "navigator.permissions.query({ name: 'clipboard-write' }).then((s) => s.state, () => 'error')")) === "granted", null);
  // With no click: wait until the page has no user gesture left, then try again. Chromium
  // does not even ask the embedder then (the write stays pending), so "not written" is the check.
  await until(async () => (await jsNoGesture(wc, "navigator.userActivation.isActive")) === false, 8000);
  const noClick = await jsNoGesture(wc, "Promise.race([navigator.clipboard.writeText('aither-no-click').then(() => 'written', (e) => 'refused: ' + e.message),"
    + " new Promise((res) => setTimeout(() => res('pending'), 2000))])");
  expect("writeText with no click writes nothing", noClick !== "written" && clipboard.readText() !== "aither-no-click", { noClick, clipboard: clipboard.readText().slice(0, 40) });

  // ------------------------------------------------------------------ 2. full screen
  const layoutBefore = JSON.stringify(bw.getState().rail.rects);
  const boundsBefore = bw.__viewBoundsForTest(main.id);
  const windowBefore = win.getBounds();
  await click(wc, 20);
  const inFull = await until(() => js(wc, "Boolean(document.fullscreenElement) && __log.includes('fs ok')"), 6000);
  expect("a click-triggered requestFullscreen() is granted", Boolean(inFull), await js(wc, "JSON.stringify(__log)"));
  const whole = await until(() => {
    const b = bw.__viewBoundsForTest(main.id);
    const c = win.getContentBounds();
    return win.isFullScreen() && b && b.x === 0 && b.y === 0 && b.width === c.width && b.height === c.height ? b : null;
  }, 6000);
  expect("the tab's view takes the whole window while the page is full screen", Boolean(whole) && bw.__fullscreenTabForTest() === main.id,
    { view: bw.__viewBoundsForTest(main.id), content: win.getContentBounds(), tab: bw.__fullscreenTabForTest() });
  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  const out = await until(async () => !(await js(wc, "Boolean(document.fullscreenElement)")) && !win.isFullScreen() && bw.__fullscreenTabForTest() === null, 6000);
  expect("Escape leaves full screen", Boolean(out), { element: await js(wc, "Boolean(document.fullscreenElement)"), window: win.isFullScreen() });
  if (!out) { await js(wc, "document.fullscreenElement ? document.exitFullscreen() : 0"); await sleep(1200); }
  const restored = await until(() => JSON.stringify(bw.__viewBoundsForTest(main.id)) === JSON.stringify(boundsBefore)
    && JSON.stringify(bw.getState().rail.rects) === layoutBefore && JSON.stringify(win.getBounds()) === JSON.stringify(windowBefore), 6000);
  expect("the exact layout from before is restored", Boolean(restored),
    { view: bw.__viewBoundsForTest(main.id), before: boundsBefore, window: win.getBounds(), windowBefore });
  // Showing another tab ends a page's full screen.
  await js(wc, "__log.length = 0; 0");
  await click(wc, 20);
  const again = await until(async () => (await js(wc, "Boolean(document.fullscreenElement)")) && bw.__fullscreenTabForTest() === main.id, 6000);
  const other = bw.__openTabForTest(`${base}/gap-form`);
  const formWc = await ready(other.id, "/gap-form");
  const ended = await until(async () => bw.__fullscreenTabForTest() === null && !win.isFullScreen() && !(await js(wc, "Boolean(document.fullscreenElement)")), 6000);
  expect("showing another tab ends the page's full screen", Boolean(again) && Boolean(ended), { again, tab: bw.__fullscreenTabForTest(), window: win.isFullScreen() });

  // ------------------------------------------------------------------ 5. what a discard leaves alone
  if (formWc) {
    expect("an untouched form has nothing unsaved", (await bw.__pageHasUnsavedForTest(other.id)) === false, null);
    await js(formWc, "document.getElementById('p').value = 'secret'; 0");
    expect("a typed password alone is not 'unsaved input'", (await bw.__pageHasUnsavedForTest(other.id)) === false, null);
    await js(formWc, "document.getElementById('a').value = 'Dear Anna, a draft'; 0");
    expect("a page with typed text reports unsaved input (it is never discarded)", (await bw.__pageHasUnsavedForTest(other.id)) === true, null);
    const allowed = bw.getPermissionStore().get(base, "notifications") === "allow";
    const fact = bw.__tabFactsForTest().find((t) => t.id === other.id);
    expect("a site allowed to notify is marked exempt from the discard", allowed && fact && fact.notifies === true && fact.capturing === false, { allowed, fact });
    bw.runBrowserAction("close-tab");
  }

  // ------------------------------------------------------------------ 4. popups
  bw.__showTabForTest(main.id);
  await js(wc, "__log.length = 0; 0");
  const before = tabsNow().map((t) => t.id);
  await click(wc, 120);
  const popTab = await until(() => tabsNow().find((t) => !before.includes(t.id)));
  const popWc = popTab ? await ready(popTab.id, "/gap-popup") : null;
  expect("window.open gives a tab of the opener's owner, beside it", Boolean(popWc) && popTab.by === "you"
    && tabsNow().findIndex((t) => t.id === popTab.id) === tabsNow().findIndex((t) => t.id === main.id) + 1, { popTab, tabs: tabsNow() });
  if (popWc) {
    expect("the popup keeps window.opener", (await js(popWc, "window.__hadOpener && Boolean(window.opener)")) === true, null);
    const got = await until(() => js(wc, "__log.includes('msg hello from popup')"), 5000);
    expect("the opener receives the popup's postMessage", Boolean(got), await js(wc, "JSON.stringify(__log)"));
    const prefs = popWc.getLastWebPreferences() || {};
    expect("the popup is sandboxed, isolated and has no preload", prefs.sandbox === true && prefs.contextIsolation === true && !prefs.preload
      && prefs.nodeIntegration !== true && popWc.session === wc.session, { sandbox: prefs.sandbox, preload: prefs.preload });
    expect("the popup's request and page read the plain user agent", noElectron(headers["/gap-popup"]) && noElectron(await js(popWc, UA)),
      { header: headers["/gap-popup"], page: await js(popWc, UA) });
    popWc.executeJavaScript("window.close(); 0", true).catch(() => {});
    const closed = await until(() => !tabsNow().some((t) => t.id === popTab.id), 5000);
    expect("window.close() from the popup closes that tab", Boolean(closed) && (await js(wc, "window.__w.closed")) === true, tabsNow());
  }

  // ------------------------------------------------------------------ 6. app links
  bw.__showTabForTest(main.id);
  await click(wc, 170);
  const ask = await until(() => notice(main.id, "external-app"));
  expect("a mailto: link raises \"Open <App>?\" in the owner's tab", Boolean(ask) && /^Open your mail app\? localhost:\d+ wants to open a link in it\.$/.test(ask.text)
    && ask.actions.map((a) => a.label).join() === "Open,Always for this site,Not now", ask);
  expect("nothing is opened before the owner answers", opened.length === 0, opened);
  const early = await bw.noticeAction("external-open");
  expect("Open does nothing in the question's first half second", early && early.ok === false && early.early === true && opened.length === 0, { early, opened });
  await sleep(600);
  const openedNow = await bw.noticeAction("external-open");
  expect("Open hands the exact address to the system", openedNow && openedNow.ok === true && opened.length === 1 && opened[0] === MAILTO
    && !bw.__noticeForTest(main.id) && bw.getExternalStore().list().length === 0, { openedNow, opened });
  await click(wc, 220);
  await sleep(700);
  expect("a scheme that is not on the list gets nothing", !bw.__noticeForTest(main.id) && opened.length === 1 && wc.getURL().endsWith("/gap-main"),
    { notice: bw.__noticeForTest(main.id), opened });
  // An embedded frame's app link: asked, and "Always" is not offered for it.
  await js(wc, `const f = document.createElement("iframe"); f.src = ${JSON.stringify(ZOOM)}; document.body.append(f); 0`);
  const framed = await until(() => notice(main.id, "external-app"));
  expect("an embedded frame's app link asks, without \"Always\"", Boolean(framed) && /^Open Zoom\?/.test(framed.text)
    && framed.actions.map((a) => a.label).join() === "Open,Not now" && opened.length === 1, framed);
  if (framed) await bw.noticeAction("dismiss");
  expect("Not now opens nothing", !bw.__noticeForTest(main.id) && opened.length === 1, opened);
  // Always for this site: remembered, then a clicked link opens with no question.
  await click(wc, 170);
  const second = await until(() => notice(main.id, "external-app"));
  await sleep(600);
  const always = second ? await bw.noticeAction("external-always") : null;
  expect("Always for this site opens and is remembered", always && always.always === true && opened.length === 2 && opened[1] === MAILTO
    && bw.getExternalStore().get(base, "mailto:") === true, { always, opened, list: bw.getExternalStore().list() });
  await click(wc, 170);
  const third = await until(() => opened.length === 3, 4000);
  expect("the next click on that site opens with no question", Boolean(third) && opened[2] === MAILTO && !bw.__noticeForTest(main.id),
    { opened, notice: bw.__noticeForTest(main.id) });
  await click(wc, 170);
  const loop = await until(() => notice(main.id, "external-app"), 4000);
  expect("a second app start right after it is asked about (no launch loop)", Boolean(loop) && opened.length === 3, { opened, loop });
  if (loop) await bw.noticeAction("dismiss");

  // ------------------------------------------------------------------ a page that crashed or did not load
  const dead = await new Promise((resolve) => {
    const s = require("node:http").createServer(() => {});
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(`http://localhost:${port}/gone`)); });
  });
  await js(wc, `location.href = ${JSON.stringify(dead)}; 0`);
  const errorPage = await until(() => (wc.getURL().startsWith("data:text/html") && !wc.isLoading() ? wc.getTitle() : null), 10000);
  expect("a followed link that does not load shows the error page", /Could not open/.test(errorPage || "")
    && /didn't open/.test(await js(wc, "document.body.innerText")) && /ERR_CONNECTION_REFUSED/.test(await js(wc, "document.body.innerText")),
  { url: wc.getURL().slice(0, 60), title: wc.getTitle() });
  await wc.loadURL(`${base}/gap-main`).catch(() => {});
  await ready(main.id, "/gap-main");
  wc.forcefullyCrashRenderer();
  const crashed = await until(() => notice(main.id, "crashed"));
  expect("a crashed page says so, with Reload", Boolean(crashed) && crashed.text === "This page crashed."
    && crashed.actions.map((a) => a.label).join() === "Reload,Not now", bw.__noticeForTest(main.id));
  if (crashed) await bw.noticeAction("crash-reload");
  const back = await until(async () => !wc.isCrashed() && !wc.isLoading() && (await js(wc, "document.title")) === "Gap", 10000);
  expect("Reload brings the crashed page back", Boolean(back) && !bw.__noticeForTest(main.id),
    { crashed: wc.isCrashed(), loading: wc.isLoading(), url: wc.getURL(), title: wc.getTitle(), notice: bw.__noticeForTest(main.id) });

  // ------------------------------------------------------------------ an AGENT's tab gets none of it
  const agent = bw.browserAgent();
  const agentTab = await agent("open", { url: `${base}/gap-main?agent=1` });
  const agentWc = agentTab.ok ? await ready(agentTab.tab, "agent=1", 20000) : null;
  expect("gap: an agent tab opens", Boolean(agentWc), { agentTab, url: agentTab.ok && bw.__pageForTest(agentTab.tab) ? bw.__pageForTest(agentTab.tab).getURL() : null });
  if (agentWc) {
    await focusAlways(agentWc);
    expect("an agent tab reads the plain user agent", noElectron(await js(agentWc, UA)) && noElectron(headers["/gap-main"]), await js(agentWc, UA));
    const agentCopy = await js(agentWc, "navigator.clipboard.writeText('aither-agent-copy').then(() => 'written', (e) => 'refused: ' + e.message)");
    expect("an agent tab cannot write the clipboard", /^refused/.test(agentCopy) && /permission/i.test(agentCopy) && clipboard.readText() !== "aither-agent-copy", agentCopy);
    agentWc.executeJavaScript("document.documentElement.requestFullscreen().then(() => __log.push('fs ok'), () => __log.push('fs refused')); 0", true).catch(() => {});
    await sleep(1200);
    expect("an agent tab cannot go full screen", !(await js(agentWc, "Boolean(document.fullscreenElement) || __log.includes('fs ok')"))
      && !win.isFullScreen() && bw.__fullscreenTabForTest() === null, await js(agentWc, "JSON.stringify(__log)"));
    await js(agentWc, `location.href = ${JSON.stringify(MAILTO)}; 0`);
    await js(agentWc, `const f = document.createElement("iframe"); f.src = ${JSON.stringify(ZOOM)}; document.body.append(f); 0`);
    await sleep(900);
    expect("an agent tab's app links raise no question and open nothing", !bw.__noticeForTest(agentTab.tab) && opened.length === 3,
      { notice: bw.__noticeForTest(agentTab.tab), opened });
    const beforeAgentPop = tabsNow().map((t) => t.id);
    await js(agentWc, "window.__w = window.open('/gap-popup?agent=1'); 0");
    const agentPop = await until(() => tabsNow().find((t) => !beforeAgentPop.includes(t.id)));
    const agentPopWc = agentPop ? await ready(agentPop.id, "/gap-popup") : null;
    const agentSession = session.fromPartition(bw.AGENT_PARTITION);
    expect("an agent page's popup is the agent's tab, in the agent's session", Boolean(agentPopWc) && agentPop.by === "agent"
      && agentPopWc.session === agentSession && agentPopWc.session !== wc.session, agentPop);
    if (agentPop) { bw.__showTabForTest(agentPop.id); bw.runBrowserAction("close-tab"); }
    bw.__showTabForTest(agentTab.tab);
    bw.runBrowserAction("close-tab");
  }
  bw.getGate().release();

  // Leave things as they were: the owner's clipboard text, no stub, no gap tab.
  try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* gone */ }
  if (clipboard.readText() === COPIED) clipboard.write(clipboardBefore); // not when the owner copied something meanwhile
  bw.__setOpenExternalForTest(null);
  bw.__showTabForTest(main.id);
  bw.runBrowserAction("close-tab");
}

module.exports = { PAGES, headers, run, serve };
