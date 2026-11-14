"use strict";

/**
 * The managed browser, live -- one block of browser-parity-smoke.cjs (docs/WORKSPACE-POLICY.md).
 *
 * A local HTTP server stands in for a mesh peer: it is the "private app" of a workspace,
 * known to the browser only as http://wiki.corp.test (a name no DNS answers), and
 * reachable only because a SIGNED policy maps that name to it through the loopback door.
 * The key pair is made here, for this run; the public half goes in through the test seam
 * and no private key is ever written anywhere.
 *
 *   - no policy: nothing is governed; the platform's policy route answering 404 is "no policy".
 *   - with the policy: the app loads in the owner's work tab (the tenant's own session),
 *     the watermark overlay covers it and the window is kept out of screen captures.
 *   - copy, print and download are each blocked, each with exactly one audit row.
 *   - an agent's tab and an InPrivate tab do not get the app, and neither does a local
 *     process that knocks on the door without this launch's credential.
 *   - a tampered policy closes the app: the open tab, a new one, and the door.
 *
 * Each check fails without the feature (without it the made-up name does not resolve at all).
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const P = require("./browser-workspace-policy.cjs");

const HOST = "wiki.corp.test";
const ORIGIN = `http://${HOST}`;
const TENANT = "smoke";
const SECRET = "confidential roadmap";
const SENTINEL = "aither-ws-sentinel";

const PAGES = {
  "/": `<!doctype html><title>Private wiki</title><p id="secret">${SECRET}</p><a id="dl" href="/export.csv">export</a>`,
};

/** The stand-in mesh peer. `hits` is every request it served: {path, host}. */
function startPrivateApp() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, "http://x").pathname;
      hits.push({ path: pathname, host: String(req.headers.host || "") });
      if (pathname === "/export.csv") {
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=\"export.csv\"" });
        res.end("name,salary\nanna,1\n");
        return;
      }
      const body = PAGES[pathname];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body || "nope");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, port: server.address().port }));
  });
}

/** A request to the door from "another local process": the status line it answers with. */
function knock(doorPort, { auth = null, target = `${ORIGIN}/` } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: doorPort, method: "GET", path: target, agent: false,
      headers: { host: HOST, ...(auth ? { "proxy-authorization": auth } : {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function run({ bw, base, expect, until, sleep, userData }) {
  const { clipboard, session } = require("electron");
  const js = (wc, code) => wc.executeJavaScript(code, true);
  const tabsNow = () => bw.getTabs().snapshot().tabs;
  const win = bw.getWindow();
  const app = await startPrivateApp();
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ed25519");
  const sign = (over = {}) => P.signPolicy({ v: 1, tenant_id: TENANT, serial: 3, not_after: "2099-01-01T00:00:00Z",
    apps: [{ origin: ORIGIN, private: { host: "127.0.0.1", port: app.port }, deny: ["copy", "print", "download", "devtools"], watermark: true, audit: true }],
    ...over }, privateKey);
  const policyFile = path.join(userData, P.POLICY_FILE);
  const image = clipboard.readImage();
  const clipboardBefore = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), ...(image.isEmpty() ? {} : { image }) };
  const rows = (ws, action, verdict = "deny") => ws.audit.read().filter((r) => r.action === action && r.verdict === verdict && r.origin === ORIGIN);
  const appHits = () => app.hits.filter((h) => h.path === "/").length;
  const blockedPage = (wc) => wc && wc.getURL().startsWith("data:text/html") && !wc.isLoading();

  // ------------------------------------------------------------------ no policy
  // The seam: this run's public key, and this run's web server as "the platform" (it has
  // no policy route, so it answers 404 -- as the real platform does today).
  const ws = await bw.__workspaceSeamForTest({ keys: [P.publicKeyRaw(publicKey)], origin: base, token: () => "test-token", account: () => "smoke-user" });
  const none = await ws.refresh();
  expect("workspace: with no policy nothing is governed, and the policy route's 404 means 'no policy'", none.state === "none" && none.remote === "none"
    && ws.policy.decide(ORIGIN, "copy").allow === true && ws.state().doorPort === 0, { none, door: ws.state().doorPort });

  // ------------------------------------------------------------------ the signed policy, the work tab
  fs.writeFileSync(policyFile, JSON.stringify(sign()));
  const loaded = await ws.reload();
  expect("workspace: a policy signed with the pinned key comes into force", loaded.state === "ok" && loaded.tenant_id === TENANT && loaded.serial === 3
    && ws.state().doorPort > 0, { loaded, door: ws.state().doorPort });
  const doorPort = ws.state().doorPort;

  const tab = bw.__openTabForTest(`${ORIGIN}/`);
  const wc = tab.ok ? await until(() => { const p = bw.__pageForTest(tab.id); return p && p.getURL() === `${ORIGIN}/` && !p.isLoading() ? p : null; }) : null;
  const shownText = wc ? await js(wc, "document.getElementById('secret') ? document.getElementById('secret').textContent : ''") : "";
  expect("workspace: the private app loads in the owner's work tab, through the door", Boolean(wc) && shownText === SECRET && appHits() === 1
    && app.hits[0].host === HOST, { tab, url: tab.ok && bw.__pageForTest(tab.id) ? bw.__pageForTest(tab.id).getURL() : null, hits: app.hits });
  if (!wc) {
    app.server.close();
    await bw.__workspaceSeamForTest(null);
    return;
  }
  const workSession = session.fromPartition(`persist:aither-work-${TENANT}`);
  expect("workspace: the work tab rides the tenant's own session, not the owner's or the agent's", wc.session === workSession
    && wc.session !== session.fromPartition(bw.PARTITION) && wc.session !== session.fromPartition(bw.AGENT_PARTITION)
    && (wc.getLastWebPreferences() || {}).sandbox === true && !(wc.getLastWebPreferences() || {}).preload, null);
  expect("workspace: the door's connection and the app's opening are audited", ws.audit.read().some((r) => r.action === "mesh-connect" && r.verdict === "allow"
    && r.origin === ORIGIN && r.tab === "door") && rows(ws, "open", "allow").length === 1 && rows(ws, "open", "allow")[0].tab === "work", ws.audit.read());

  // ------------------------------------------------------------------ the watermark and the capture guard
  const mark = await until(() => { const m = ws.state().watermark; return m && m.shown && m.url.startsWith("data:text/html") ? m : null; });
  const content = win.getContentBounds();
  const view = bw.__viewBoundsForTest(tab.id);
  const near = (got, want) => Math.abs(got - want) <= 1; // a scaled display rounds a window's edge by a pixel
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  expect("workspace: the watermark overlay is over the page, names the signed-in user and the day, and is main's own window", Boolean(mark)
    && mark.text === `smoke-user · ${TENANT} · ${day}` && mark.clickThrough === true && mark.focusable === false
    && near(mark.bounds.x, content.x + view.x) && near(mark.bounds.y, content.y + view.y) && near(mark.bounds.width, view.width) && near(mark.bounds.height, view.height)
    && decodeURIComponent(mark.url).includes("smoke-user") && !/<script/i.test(decodeURIComponent(mark.url)), { mark: mark && { ...mark, url: mark.url.slice(0, 40) }, state: { ...ws.state(), watermark: ws.state().watermark && { ...ws.state().watermark, url: ws.state().watermark.url.slice(0, 40) } }, content, view });
  expect("workspace: the page itself holds no watermark (it is not page content)", (await js(wc, "document.body.innerText")).includes("smoke-user") === false, null);
  expect("workspace: the window is kept out of screen captures while the app shows", ws.state().protected === true
    && (typeof win.isContentProtected !== "function" || win.isContentProtected() === true), ws.state());

  // ------------------------------------------------------------------ copy
  clipboard.writeText(SENTINEL);
  wc.focus();
  await js(wc, "getSelection().selectAllChildren(document.getElementById('secret')); getSelection().toString()");
  wc.sendInputEvent({ type: "keyDown", keyCode: "C", modifiers: ["control"] });
  wc.sendInputEvent({ type: "keyUp", keyCode: "C", modifiers: ["control"] });
  await until(() => rows(ws, "copy").length >= 1);
  await sleep(300);
  const copyNotice = bw.__noticeForTest(tab.id);
  expect("workspace: Ctrl+C is blocked, with exactly one audit row and a notice naming the workspace policy", rows(ws, "copy").length === 1
    && clipboard.readText() !== SECRET && copyNotice && copyNotice.kind === "workspace-policy"
    && copyNotice.text === `Copying is turned off on ${HOST} by your workspace policy.`, { rows: rows(ws, "copy"), clipboard: clipboard.readText().slice(0, 40), copyNotice });
  // The copy command itself (the right-click row runs it): the page's isolated-world guard stops the copy event.
  await sleep(800);
  wc.copy();
  const guarded = await until(() => rows(ws, "copy").length === 2);
  expect("workspace: the copy command is stopped in the page too (one more row, clipboard untouched)", Boolean(guarded) && clipboard.readText() !== SECRET,
    { rows: rows(ws, "copy").length, clipboard: clipboard.readText().slice(0, 40) });
  const grant = bw.__permissionForTest(tab.id, "clipboard-sanitized-write");
  expect("workspace: a page's Copy button (clipboard write) is refused there", Boolean(grant) && grant.request === false && grant.check === false, grant);

  // ------------------------------------------------------------------ print
  await bw.noticeAction("dismiss");
  const printed = bw.runBrowserAction("print", undefined, tab.id);
  expect("workspace: printing is blocked, with exactly one audit row", printed === true && rows(ws, "print").length === 1
    && (bw.__noticeForTest(tab.id) || {}).text === `Printing is turned off on ${HOST} by your workspace policy.`, { rows: rows(ws, "print"), notice: bw.__noticeForTest(tab.id) });

  // ------------------------------------------------------------------ download
  const shelfBefore = bw.getDownloads().list().length;
  wc.downloadURL(`${ORIGIN}/export.csv`);
  await until(() => rows(ws, "download").length >= 1);
  await sleep(400);
  expect("workspace: a download is cancelled, with exactly one audit row", rows(ws, "download").length === 1 && bw.getDownloads().list().length === shelfBefore
    && (bw.__noticeForTest(tab.id) || {}).text === `Downloads are turned off on ${HOST} by your workspace policy.`,
  { rows: rows(ws, "download"), shelf: bw.getDownloads().list().length, shelfBefore, notice: bw.__noticeForTest(tab.id) });

  // ------------------------------------------------------------------ developer tools
  wc.openDevTools({ mode: "detach", activate: false });
  const shut = await until(() => rows(ws, "devtools").length === 1 && !wc.isDevToolsOpened());
  expect("workspace: developer tools are closed again, with one audit row", Boolean(shut), { rows: rows(ws, "devtools"), open: wc.isDevToolsOpened() });

  expect("workspace: the audit holds origins only -- no path, no file name, no page text", (() => {
    const raw = fs.readFileSync(ws.audit.file, "utf8");
    return raw.length > 0 && !raw.includes(SECRET) && !raw.includes("export") && !raw.includes("smoke-user")
      && raw.split("\n").filter(Boolean).every((l) => Object.keys(JSON.parse(l)).join() === "ts,tenant,origin,action,verdict,tab");
  })(), fs.readFileSync(ws.audit.file, "utf8").slice(0, 400));

  // ------------------------------------------------------------------ an agent's tab
  const hitsBefore = appHits();
  const agent = bw.browserAgent();
  const tabsBefore = tabsNow().length;
  const fresh = await agent("open", { url: `${ORIGIN}/`, new_tab: true }).catch((e) => ({ ok: false, error: String(e && e.message) }));
  expect("workspace: an agent asking for the private app gets an error and no tab", fresh.ok === false && /private workspace app/.test(String(fresh.error))
    && tabsNow().length === tabsBefore, { fresh, tabs: tabsNow().length, tabsBefore });
  const agentTab = await agent("open", { url: `${base}/find?agent=ws`, new_tab: true });
  const agentWc = agentTab.ok ? await until(() => { const p = bw.__pageForTest(agentTab.tab); return p && p.getURL().includes("agent=ws") && !p.isLoading() ? p : null; }) : null;
  expect("workspace: an agent tab opens on an ordinary page", Boolean(agentWc), agentTab);
  if (agentWc) {
    const steered = await agent("open", { url: `${ORIGIN}/` }).catch((e) => ({ ok: false, error: String(e && e.message) }));
    await until(() => blockedPage(agentWc));
    const agentText = await js(agentWc, "document.body.innerText").catch(() => "");
    expect("workspace: the agent's own tab steered to the private app gets the refusal page, not the app", !agentText.includes(SECRET)
      && /Workspace policy/.test(agentText) && /agent's tab/.test(agentText) && agentWc.session !== workSession, { steered, agentText: agentText.slice(0, 200) });
    // The network layer, with no gate in the way: the agent's session has no proxy script.
    const viaAgentSession = await session.fromPartition(bw.AGENT_PARTITION).fetch(`${ORIGIN}/`).then((r) => r.text(), (e) => `ERR ${e.message}`);
    expect("workspace: the agent's session cannot reach the private host at all", /^ERR /.test(viaAgentSession) && !viaAgentSession.includes(SECRET), viaAgentSession.slice(0, 120));
    await agentWc.loadURL(`${base}/find?agent=door`).catch(() => {});
    const fromPage = await js(agentWc, `fetch("http://127.0.0.1:${doorPort}/", { mode: "no-cors" }).then((r) => r.type + " " + r.status, (e) => "ERR " + e.message)`);
    const framed = await js(agentWc, `new Promise((res) => { const f = document.createElement("iframe"); f.src = ${JSON.stringify(`${ORIGIN}/`)};`
      + " f.onload = () => { let t = ''; try { t = f.contentDocument ? f.contentDocument.body.innerText : 'cross-origin'; } catch (e) { t = 'cross-origin'; } res(t); };"
      + " document.body.append(f); setTimeout(() => res('no load'), 2500); })");
    expect("workspace: an agent page gets nothing from the door or from a frame of the app", !String(fromPage).includes(SECRET) && !String(framed).includes(SECRET)
      && /^(opaque 0|ERR )/.test(String(fromPage)), { fromPage, framed });
    bw.__showTabForTest(agentTab.tab);
    bw.runBrowserAction("close-tab");
  }
  bw.getGate().release();

  // ------------------------------------------------------------------ an InPrivate tab
  bw.runBrowserAction("inprivate", `${ORIGIN}/`);
  const privId = bw.getTabs().active;
  const privWc = await until(() => { const p = bw.__pageForTest(privId); return p && bw.getState().private === true && blockedPage(p) ? p : null; });
  const privText = privWc ? await js(privWc, "document.body.innerText") : "";
  expect("workspace: an InPrivate tab gets the refusal page, not the app", Boolean(privWc) && !privText.includes(SECRET) && /Workspace policy/.test(privText)
    && /InPrivate/.test(privText) && privWc.session !== workSession, { url: bw.__pageForTest(privId) && bw.__pageForTest(privId).getURL().slice(0, 80), privText: privText.slice(0, 200) });
  const viaPrivate = await session.fromPartition(require("./browser-everyday.cjs").INPRIVATE_PARTITION).fetch(`${ORIGIN}/`).then((r) => r.text(), (e) => `ERR ${e.message}`);
  expect("workspace: the InPrivate session cannot reach the private host either", /^ERR /.test(viaPrivate), viaPrivate.slice(0, 120));
  if (bw.getState().private === true) bw.runBrowserAction("close-tab");
  expect("workspace: none of those attempts reached the private app", appHits() === hitsBefore, { hits: appHits(), hitsBefore });

  // ------------------------------------------------------------------ another local process at the door
  const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  const noCred = await knock(doorPort);
  const wrongCred = await knock(doorPort, { auth: basic("aither-door", "0".repeat(64)) });
  expect("workspace: a local process without this launch's credential is refused by the door (407)", noCred.status === 407 && wrongCred.status === 407
    && !noCred.body.includes(SECRET) && appHits() === hitsBefore, { noCred, wrongCred });
  const cred = ws.door.credential();
  const elsewhere = await knock(doorPort, { auth: basic(cred.username, cred.password), target: `${base}/find` });
  expect("workspace: even with the credential the door goes nowhere but the policy's private hosts (403)", elsewhere.status === 403, elsewhere);

  // ------------------------------------------------------------------ a tampered policy closes the app
  bw.__showTabForTest(tab.id);
  const forged = sign();
  forged.apps[0].deny = []; // the signature no longer covers what the file says
  fs.writeFileSync(policyFile, JSON.stringify(forged));
  const after = await ws.reload();
  const closed = await until(() => blockedPage(wc));
  const closedText = closed ? await js(wc, "document.body.innerText") : "";
  expect("workspace: a tampered policy closes the open app with a page that says why", after.state === "invalid" && /signature/.test(after.reason)
    && Boolean(closed) && /Workspace policy/.test(closedText) && /signature/.test(closedText) && !closedText.includes(SECRET),
  { after, url: wc.getURL().slice(0, 60), closedText: closedText.slice(0, 200) });
  expect("workspace: the watermark and the capture guard go with it", ws.state().watermark === null && ws.state().protected === false, ws.state());
  const hitsClosed = appHits();
  const again = bw.__openTabForTest(`${ORIGIN}/`);
  const againWc = again.ok ? await until(() => { const p = bw.__pageForTest(again.id); return blockedPage(p) ? p : null; }) : null;
  const withCred = await knock(doorPort, { auth: basic(cred.username, cred.password) });
  expect("workspace: the app does not open again, and the door refuses even the real credential", Boolean(againWc) && againWc.session !== workSession
    && withCred.status === 403 && appHits() === hitsClosed && rows(ws, "open", "deny").length >= 2, { again, withCred, hits: appHits(), hitsClosed });
  expect("workspace: ordinary browsing is untouched by the broken policy", ws.policy.decide(base, "copy").allow === true
    && ws.policy.gate({ url: `${base}/find` }).verdict === "allow", null);

  // Leave things as they were: the clipboard, no work tabs, no seam, no stand-in server.
  for (const id of [again.ok ? again.id : null, tab.id]) {
    if (id == null || !bw.getTabs().get(id)) continue;
    bw.__showTabForTest(id);
    bw.runBrowserAction("close-tab");
  }
  if (clipboard.readText() === SENTINEL) clipboard.write(clipboardBefore);
  await bw.__workspaceSeamForTest(null);
  await new Promise((done) => { app.server.closeAllConnections(); app.server.close(() => done()); });
}

module.exports = { run };
