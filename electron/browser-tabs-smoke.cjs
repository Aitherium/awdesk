"use strict";

/**
 * The Aither Browser's TABS in a real window (`npm run test:browser-tabs`): the
 * real browser-window.cjs, the real gate and dispatcher, local data: pages. It
 * proves what the unit tests cannot -- that the agent's tools land in the agent's
 * tab and are REFUSED on the owner's, with real WebContentsViews behind them.
 *
 * Own entry point, a throwaway userData, no network. DESK_BROWSER_HOME and the
 * context push are pointed away from the live fleet. Exit 0 all pass, 1 a check
 * failed, 2 the run broke, 3 it hung.
 */
const os = require("node:os");
const path = require("node:path");

process.env.DESK_BROWSER_HOME = "http://127.0.0.1:1/";
process.env.DESK_BROWSER_CONTEXT_PUSH = "0";
// The BROWSER-5 checks turn the push on; it may only ever aim at a dead port.
process.env.DESK_GENESIS_BRIDGE_URL = "http://127.0.0.1:1";

const { app, session } = require("electron");
const bw = require("./browser-window.cjs");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-browser-tabs-smoke-${process.pid}`));
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 60000);

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for ad-hoc smoke pages
const page = (title) => "data:text/html;charset=utf-8," + encodeURIComponent(
  `<!doctype html><title>${title}</title><input aria-label="Box"><a href="#" onclick="window.open('data:text/html,<title>Popup</title>');return false">pop</a>`);

app.whenReady().then(async () => {
  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };
  const win = bw.createBrowserWindow();
  const agent = bw.browserAgent();
  const tabs = bw.getTabs();
  await new Promise((r) => setTimeout(r, 500));
  const home = tabs.snapshot().tabs[0];
  expect("the window opens with ONE owner tab", tabs.snapshot().tabs.length === 1 && home.by === "you", tabs.snapshot());

  const refusedNoTab = await agent("snapshot", {});
  expect("an agent with no tab is told to open one", !refusedNoTab.ok && /browser_open/.test(refusedNoTab.error), refusedNoTab);

  const opened = await agent("open", { url: "data:text/html,x" });
  expect("browser_open refuses data: even with tabs", !opened.ok, opened);
  // http(s) only: serve the pages from a local server.
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/file.bin") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", "attachment; filename=payload.bin");
      res.end("x".repeat(64));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    const name = decodeURIComponent(req.url.slice(1)) || "Root";
    res.end(`<!doctype html><title>${name}</title><input aria-label="Box ${name}">`
      + `<a id="pop" href="#" onclick="window.open('/Popup');return false">pop</a>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const a1 = await agent("open", { url: `${base}/AgentOne` });
  expect("browser_open makes an agent tab and shows it", a1.ok && a1.title === "AgentOne"
    && tabs.get(a1.tab).by === "agent" && tabs.active === a1.tab, { a1, snap: tabs.snapshot() });

  const snap = await agent("snapshot", {});
  expect("the agent reads ITS tab", snap.ok && snap.elements.some((e) => e.label === "Box AgentOne"), snap);

  // The owner looks at their own tab: the agent must still act on its own.
  bw.__showTabForTest(home.id);
  const stillMine = await agent("snapshot", {});
  expect("owner watching another tab does not redirect the agent", stillMine.ok && stillMine.elements.some((e) => e.label === "Box AgentOne"), stillMine);

  const sw = await agent("switch_tab", { tab: home.id });
  expect("the agent cannot switch to the owner's tab", !sw.ok && /owner's/.test(sw.error), sw);
  const cl = await agent("close_tab", { tab: home.id });
  expect("the agent cannot close the owner's tab", !cl.ok && /owner's/.test(cl.error), cl);

  const a2 = await agent("open", { url: `${base}/AgentTwo`, new_tab: true });
  expect("new_tab opens a second agent tab", a2.ok && a2.tab !== a1.tab && a2.title === "AgentTwo", a2);
  const back = await agent("switch_tab", { tab: a1.tab });
  expect("the agent switches between its own tabs", back.ok && tabs.target().id === a1.tab, back);

  const before = tabs.snapshot().tabs.length;
  await agent("click", { selector: "#pop" });
  await new Promise((r) => setTimeout(r, 800));
  const after = tabs.snapshot();
  const popup = after.tabs.find((t) => !([home.id, a1.tab, a2.tab]).includes(t.id));
  expect("a popup from an agent page opens as an AGENT tab beside it", after.tabs.length === before + 1 && popup && popup.by === "agent"
    && after.tabs.findIndex((t) => t.id === popup.id) === after.tabs.findIndex((t) => t.id === a1.tab) + 1, after);

  const list = await agent("tabs", {});
  expect("browser_tabs lists every tab with its owner; the owner's are withheld", list.ok && list.tabs.length === after.tabs.length
    && list.tabs.some((t) => t.by === "you" && t.withheld && !("url" in t) && !("title" in t))
    && list.tabs.filter((t) => t.by === "agent").every((t) => t.title && t.url), list);

  // History remembers the agent's pages AS the agent's.
  const hist = bw.getLibrary().history(20);
  expect("history records the agent's pages with who visited", hist.some((h) => h.title === "AgentOne" && h.by === "agent"), hist);
  // A download an agent starts is cancelled AND shown, never silently dropped.
  await agent("open", { url: `${base}/file.bin` }).catch(() => null);
  await new Promise((r) => setTimeout(r, 800));
  const rows = bw.getState().downloads || [];
  expect("an agent's download is a visible blocked row", rows.some((d) => d.filename === "payload.bin" && d.state === "blocked"), rows);

  const closed = await agent("close_tab", { tab: a2.tab });
  expect("the agent closes its own tab", closed.ok, closed);

  // The strip redraws on the next state push after close_tab resolves, so wait for it
  // (up to 3 s) instead of reading the frame the close raced; a strip that never matches still fails.
  const want = () => `${tabs.snapshot().tabs.length}:${tabs.snapshot().tabs.filter((t) => t.by === "agent").length}`;
  const drawn = () => win.webContents.executeJavaScript("document.querySelectorAll('#tabs .tab').length + ':' + document.querySelectorAll('#tabs .tab.agent').length");
  let chrome = await drawn();
  for (let i = 0; i < 30 && chrome !== want(); i++) {
    await new Promise((r) => setTimeout(r, 100));
    chrome = await drawn();
  }
  expect("the strip draws every tab and marks the agent's", chrome === want(), `${chrome} vs ${want()}`);

  // BROWSER-5: an owner tab's URL and title reach neither browser_tabs nor the context push
  // until the owner shares it with the strip's real button, and an off-origin navigation unshares it.
  process.env.DESK_BROWSER_CONTEXT_PUSH = "1";
  const pushedUrl = () => (bw.getState().contextPush || {}).url || "";
  const settle = (ms = 2200) => new Promise((r) => setTimeout(r, ms));
  const owned = bw.__openTabForTest(`${base}/OwnerPrivate`);
  await settle();
  const hidden = await agent("tabs", {});
  const hiddenText = JSON.stringify(hidden);
  expect("an owner tab's url and title never reach browser_tabs", hidden.ok && !hiddenText.includes("OwnerPrivate")
    && hidden.tabs.some((t) => t.id === owned.id && t.withheld) && hidden.owner && hidden.owner.withheld >= 2, hidden);
  expect("an owner tab is never pushed to the context feed", !pushedUrl().includes("OwnerPrivate"), bw.getState().contextPush);
  const shared = await win.webContents.executeJavaScript(`window.aitherBrowser.shareTab(${owned.id}, true)`);
  await settle();
  const seen = await agent("tabs", {});
  const row = seen.tabs.find((t) => t.id === owned.id) || {};
  expect("Share with agent shows that tab's url and title", shared.ok && row.shared && row.title === "OwnerPrivate", { shared, row });
  expect("a shared owner tab is pushed", pushedUrl().endsWith("/OwnerPrivate"), bw.getState().contextPush);
  const elsewhere = base.replace("127.0.0.1", "localhost") + "/OwnerElsewhere";
  await win.webContents.executeJavaScript(`window.aitherBrowser.navigate(${JSON.stringify(elsewhere)})`);
  await settle();
  const after2 = JSON.stringify(await agent("tabs", {}));
  expect("navigating a shared tab to another site withdraws the share", !after2.includes("OwnerElsewhere")
    && !pushedUrl().includes("OwnerElsewhere"), { after2, push: bw.getState().contextPush });
  const sw2 = await agent("switch_tab", { tab: owned.id });
  expect("sharing never lets the agent drive the owner's tab", !sw2.ok && /owner's/.test(sw2.error), sw2);
  const agentPush = await agent("open", { url: `${base}/AgentPushed` });
  await settle();
  expect("the agent's own page is still pushed", agentPush.ok && pushedUrl().endsWith("/AgentPushed"), bw.getState().contextPush);
  process.env.DESK_BROWSER_CONTEXT_PUSH = "0";

  // BROWSER-M3: an agent tab rides the agent's OWN session by default; the toolbar's
  // "Let the agent use my sign-in" moves that site's agent tabs onto the owner's
  // session (driven through the REAL chrome IPC), and revoking moves them back.
  const ownerSession = session.fromPartition(bw.PARTITION);
  const agentSession = session.fromPartition(bw.AGENT_PARTITION);
  const control = (host, on) => win.webContents.executeJavaScript(
    `window.aitherBrowser.agentSignIn(${JSON.stringify(host)}, ${on ? "true" : "false"})`);
  const first = await agent("open", { url: `${base}/SignInProbe`, new_tab: true });
  await settle(700);
  const agentTabId = first.tab;
  expect("an agent tab is created on the AGENT session (persist:agent) by default",
    bw.__tabSessionForTest(agentTabId) === agentSession && bw.__tabSessionForTest(agentTabId) !== ownerSession, first);
  const host = "127.0.0.1";
  expect("the toolbar control sees the page's site, off by default",
    bw.getState().agentSignIn.host === host && bw.getState().agentSignIn.allowed === false
    && bw.getState().agentSignIn.sites.length === 0, bw.getState().agentSignIn);

  const granted = await control(host, true);
  await settle(900);
  expect("allowing the site moves the OPEN agent tab onto the owner's session, same address",
    granted.ok && bw.__tabSessionForTest(agentTabId) === ownerSession
    && /SignInProbe/.test(bw.getState().tabs.find((t) => t.id === agentTabId).url || ""), { granted, tabs: bw.getState().tabs });
  expect("the agent tab is marked as riding the owner's sign-in",
    bw.getState().tabs.find((t) => t.id === agentTabId).agentSignIn === true, bw.getState().tabs);
  const allowedTab = await agent("open", { url: `${base}/SignInSecond`, new_tab: true });
  await settle(700);
  expect("with the site allowed, a NEW agent tab is created on the owner's session",
    bw.__tabSessionForTest(allowedTab.tab) === ownerSession && bw.getState().agentSignIn.allowed === true, allowedTab);
  const ownerTab = bw.__openTabForTest(`${base}/OwnerSignIn`);
  await settle(600);
  expect("the owner's own tab is never moved (no privacy rule changed by this)",
    bw.__tabSessionForTest(ownerTab.id) === ownerSession, ownerTab);

  // The prefs file is written (debounced 400 ms): the allow survives a restart of the window.
  await settle(700);
  const layoutFile = path.join(app.getPath("userData"), "browser-layout.json");
  const onDisk = JSON.parse(require("node:fs").readFileSync(layoutFile, "utf8"));
  expect("the allow-list round-trips through browser-layout.json", Array.isArray(onDisk.agentCookieSites)
    && onDisk.agentCookieSites.includes(host), onDisk.agentCookieSites);

  const revoked = await control(host, false);
  await settle(900);
  expect("revoking sends the open agent tabs back to their own session",
    revoked.ok && bw.__tabSessionForTest(agentTabId) === agentSession
    && bw.__tabSessionForTest(allowedTab.tab) === agentSession, { revoked });
  expect("the site is gone from the toolbar's list",
    bw.getState().agentSignIn.allowed === false && bw.getState().agentSignIn.sites.length === 0, bw.getState().agentSignIn);
  const later = await agent("open", { url: `${base}/SignInLater`, new_tab: true });
  await settle(700);
  expect("after a revoke a new agent tab is on the agent session again",
    bw.__tabSessionForTest(later.tab) === agentSession, later);

  server.close();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
});
