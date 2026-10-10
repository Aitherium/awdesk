"use strict";

/**
 * awconnect-webauth.test.cjs -- the chrome.identity flow machine, without Electron.
 * The one Electron call (BrowserWindow) is a fake EventEmitter here; the end-to-end
 * proof against a real window is awconnect-webauth-smoke.cjs.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const webauth = require("./awconnect-webauth.cjs");

const ID = "hlmfknhcfhjjngckfpacgleffckpmphe";
const CALLBACK = `https://${ID}.chromiumapp.org/?code=TEST123&state=STATE_XYZ`;
const AUTHORIZE = "https://idp.aitherium.com/identity/oidc/authorize?client_id=aitheros-awconnect";

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = "";
    this.loads = [];
  }

  loadURL(url) {
    this.url = url;
    this.loads.push(url);
    return Promise.resolve();
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    FakeWindow.made.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }

  /** BrowserWindow.loadURL, as in Electron; the fake records on the webContents. */
  loadURL(url) {
    return this.webContents.loadURL(url);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}
FakeWindow.made = [];

function flowsWith(extra = {}) {
  FakeWindow.made = [];
  return webauth.createWebAuthFlows({ BrowserWindow: FakeWindow, ...extra });
}
const lastWindow = () => FakeWindow.made[FakeWindow.made.length - 1];
const rx = (text) => new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

function fakeSession({ getExtension = () => null, worker = null } = {}) {
  const workers = new EventEmitter();
  const started = [];
  workers.getAllRunning = () => ({});
  workers.getWorkerFromVersionID = () => undefined;
  workers.startWorkerForScope = async (scope) => {
    started.push(scope);
    return worker && worker.scope === scope ? worker : null;
  };
  return {
    started,
    workers,
    session: { serviceWorkers: workers, extensions: { getExtension } },
  };
}

test("the callback redirect resolves with the redirected URL and closes the window", async () => {
  const flows = flowsWith();
  const session = {};
  const pending = flows.run({ session, id: ID, url: AUTHORIZE });
  const win = lastWindow();
  assert.equal(flows.busy(), true);
  assert.equal(win.options.webPreferences.session, session, "the auth window shares the extension's session");
  assert.equal(win.options.show, true);
  assert.deepEqual(win.webContents.loads, [AUTHORIZE]);
  let prevented = false;
  win.webContents.emit("will-redirect", { preventDefault: () => { prevented = true; } }, CALLBACK, false, true);
  assert.equal(prevented, true, "the callback navigation is cancelled before it is fetched");
  assert.equal(await pending, CALLBACK);
  assert.equal(win.destroyed, true, "the auth window closes itself");
  assert.equal(flows.busy(), false);
});

test("a page that navigates itself to the callback resolves too (will-navigate)", async () => {
  const flows = flowsWith();
  const pending = flows.run({ session: {}, id: ID, url: AUTHORIZE });
  let prevented = false;
  lastWindow().webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, CALLBACK);
  assert.equal(prevented, true);
  assert.equal(await pending, CALLBACK);
});

test("a foreign callback host never settles the flow", async () => {
  const flows = flowsWith();
  const pending = flows.run({ session: {}, id: ID, url: AUTHORIZE });
  const foreign = `https://${"b".repeat(32)}.chromiumapp.org/?code=EVIL`;
  lastWindow().webContents.emit("will-redirect", { preventDefault: () => assert.fail("a foreign redirect must never be cancelled") }, foreign, false, true);
  lastWindow().webContents.emit("will-navigate", { preventDefault: () => assert.fail("a foreign navigation must never be cancelled") }, "https://evil.example/cb");
  assert.equal(flows.busy(), true, "still waiting for THIS extension's callback");
  lastWindow().webContents.emit("will-redirect", { preventDefault: () => {} }, CALLBACK, false, true);
  assert.equal(await pending, CALLBACK);
});

test("the user closing the window rejects with Chromium's text", async () => {
  const flows = flowsWith();
  const pending = flows.run({ session: {}, id: ID, url: AUTHORIZE });
  const win = lastWindow();
  const closed = assert.rejects(pending, rx(webauth.MESSAGES.userClosed));
  win.emit("closed");
  await closed;
  assert.equal(win.destroyed, true);
  assert.equal(flows.busy(), false);
});

test("a main-frame load failure rejects; aborted and subframe failures do not", async () => {
  const flows = flowsWith();
  const pending = flows.run({ session: {}, id: ID, url: AUTHORIZE });
  const wc = lastWindow().webContents;
  wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", AUTHORIZE, true);
  wc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://sub.example/x", false);
  assert.equal(flows.busy(), true);
  const failed = assert.rejects(pending, rx(webauth.MESSAGES.loadFailed));
  wc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", AUTHORIZE, true);
  await failed;
});

test("a second concurrent call is refused, and the lock frees after the first settles", async () => {
  const flows = flowsWith();
  const first = flows.run({ session: {}, id: ID, url: AUTHORIZE });
  await assert.rejects(flows.run({ session: {}, id: ID, url: AUTHORIZE }),
    rx(webauth.MESSAGES.singleFlow));
  assert.equal(FakeWindow.made.length, 1, "the refused call opened no window");
  lastWindow().webContents.emit("will-redirect", { preventDefault: () => {} }, CALLBACK, false, true);
  assert.equal(await first, CALLBACK);
  const again = flows.run({ session: {}, id: ID, url: AUTHORIZE });
  assert.equal(flows.busy(), true);
  lastWindow().webContents.emit("will-redirect", { preventDefault: () => {} }, CALLBACK, false, true);
  assert.equal(await again, CALLBACK);
});

test("a URL that is not http(s) is refused before any window opens", async () => {
  const flows = flowsWith();
  await assert.rejects(flows.run({ session: {}, id: ID, url: "file:///etc/passwd" }), rx(webauth.MESSAGES.badUrl));
  await assert.rejects(flows.run({ session: {}, id: ID, url: "not a url" }), rx(webauth.MESSAGES.badUrl));
  assert.equal(FakeWindow.made.length, 0);
});

test("a silent (interactive:false) flow opens the window hidden", async () => {
  const flows = flowsWith();
  const pending = flows.run({ session: {}, id: ID, url: AUTHORIZE, interactive: false });
  assert.equal(lastWindow().options.show, false);
  lastWindow().webContents.emit("will-redirect", { preventDefault: () => {} }, CALLBACK, false, true);
  assert.equal(await pending, CALLBACK);
});

test("a flow that never comes back times out and closes its window", async () => {
  const flows = flowsWith({ timeoutMs: 30 });
  const pending = flows.run({ session: {}, id: ID, url: AUTHORIZE });
  const win = lastWindow();
  await assert.rejects(pending, rx(webauth.MESSAGES.timedOut));
  assert.equal(win.destroyed, true);
  assert.equal(flows.busy(), false);
});

test("run() refuses an id that is not a Chromium extension id", async () => {
  const flows = flowsWith();
  await assert.rejects(flows.run({ session: {}, id: "not-an-extension", url: AUTHORIZE }), rx(webauth.MESSAGES.badUrl));
  assert.equal(FakeWindow.made.length, 0);
});

test("isCallbackUrl binds to the exact host, and extensionIdFromUrl reads pages and scopes", () => {
  assert.equal(webauth.isCallbackUrl(ID, CALLBACK), true);
  assert.equal(webauth.isCallbackUrl(ID, `https://${"b".repeat(32)}.chromiumapp.org/?code=x`), false);
  assert.equal(webauth.isCallbackUrl(ID, `https://${ID}.chromiumapp.org.evil.example/?code=x`), false);
  assert.equal(webauth.isCallbackUrl(ID, `https://${ID}.chromiumapp.org`), false, "no trailing slash is not our registered callback");
  assert.equal(webauth.redirectBase(ID), `https://${ID}.chromiumapp.org/`);
  assert.equal(webauth.extensionIdFromUrl(`chrome-extension://${ID}/sidepanel/index.html`), ID);
  assert.equal(webauth.extensionIdFromUrl(`chrome-extension://${ID}/`), ID);
  assert.equal(webauth.extensionIdFromUrl("https://example.com/"), "");
  assert.equal(webauth.extensionIdFromUrl("chrome-extension://zzz/"), "", "not a 32-letter id");
  assert.equal(webauth.extensionIdFromUrl("chrome-extension://example.com/x.html"), "", "a web origin is not an extension");
});

test("the frame request must come from a loaded extension of its own session", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const { session } = fakeSession({ getExtension: (id) => (id === ID ? { id } : null) });
  const installed = webauth.install({ ipcMain, session, BrowserWindow: FakeWindow });
  assert.equal(installed.ok, true);
  const handler = handlers.get(webauth.CHANNEL);
  assert.equal(typeof handler, "function");
  const from = (url) => ({ senderFrame: { url }, sender: { session } });
  await assert.rejects(handler(from("https://example.com/"), { url: AUTHORIZE }),
    rx(webauth.MESSAGES.notExtension), "a web page gets nothing");
  await assert.rejects(handler(from(`chrome-extension://${"b".repeat(32)}/x.html`), { url: AUTHORIZE }),
    rx(webauth.MESSAGES.notExtension), "an unloaded extension gets nothing");
  await assert.rejects(handler({ senderFrame: null, sender: { session, getURL: () => "" } }, { url: AUTHORIZE }),
    rx(webauth.MESSAGES.notExtension), "a sender we cannot attribute gets nothing");
  FakeWindow.made = [];
  const pending = handler(from(`chrome-extension://${ID}/sidepanel/index.html`), { url: AUTHORIZE });
  assert.equal(FakeWindow.made.length, 1);
  lastWindow().webContents.emit("will-redirect", { preventDefault: () => {} }, CALLBACK, false, true);
  assert.equal(await pending, CALLBACK);
  assert.equal(webauth.install({ ipcMain, session, BrowserWindow: FakeWindow }).ok, true, "install is idempotent per session");
});

test("the extension's MV3 worker is hooked through its own ipc, and only an extension's", async () => {
  let hooked = null;
  const worker = { scope: `chrome-extension://${ID}/`, ipc: { handle: (channel, fn) => { hooked = { channel, fn }; } } };
  const { session, workers, started } = fakeSession({
    getExtension: (id) => (id === ID ? { id } : null),
    worker,
  });
  webauth.install({ ipcMain: { handle() {} }, session, BrowserWindow: FakeWindow });
  workers.emit("registration-completed", {}, { scope: "http://127.0.0.1:41777/" });
  await new Promise((r) => setImmediate(r));
  assert.equal(started.length, 0, "a web page's service worker is never woken or hooked");
  workers.emit("registration-completed", {}, { scope: worker.scope });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(started[0], worker.scope);
  assert.equal(hooked && hooked.channel, webauth.CHANNEL);
  FakeWindow.made = [];
  const pending = hooked.fn({ session, serviceWorker: worker }, { url: AUTHORIZE });
  lastWindow().webContents.emit("will-redirect", { preventDefault: () => {} }, CALLBACK, false, true);
  assert.equal(await pending, CALLBACK);
});

test("an idle-killed worker is re-hooked on its next start", async () => {
  const hooked = [];
  const makeWorker = (n) => ({ scope: `chrome-extension://${ID}/`, ipc: { handle: (channel) => hooked.push({ n, channel }) } });
  const queued = [makeWorker(1), makeWorker(2)];
  const workers = new EventEmitter();
  workers.getAllRunning = () => ({});
  workers.getWorkerFromVersionID = () => undefined; // measured: the wrapper is not always materialised
  workers.getInfoFromVersionID = (versionId) => (versionId === 7 ? { versionId, scope: `chrome-extension://${ID}/` } : {});
  const started = [];
  workers.startWorkerForScope = async (scope) => {
    started.push(scope);
    return queued.shift() || null;
  };
  const session = { serviceWorkers: workers, extensions: { getExtension: (id) => (id === ID ? { id } : null) } };
  webauth.install({ ipcMain: { handle() {} }, session, BrowserWindow: FakeWindow });
  workers.emit("registration-completed", {}, { scope: `chrome-extension://${ID}/` });
  await new Promise((r) => setImmediate(r));
  workers.emit("running-status-changed", { versionId: 7, runningStatus: "running" });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(hooked, [{ n: 1, channel: webauth.CHANNEL }, { n: 2, channel: webauth.CHANNEL }]);
});

test("a second session on one ipcMain registers the channel once, never twice", () => {
  const handled = [];
  const ipcMain = { handle: (channel) => handled.push(channel) };
  const first = fakeSession({ getExtension: (id) => (id === ID ? { id } : null) });
  const second = fakeSession({ getExtension: (id) => (id === ID ? { id } : null) });
  assert.equal(webauth.install({ ipcMain, session: first.session, BrowserWindow: FakeWindow }).ok, true);
  assert.equal(webauth.install({ ipcMain, session: second.session, BrowserWindow: FakeWindow }).ok, true,
    "a second session installs without throwing");
  assert.deepEqual(handled, [webauth.CHANNEL], "Electron throws on a second handle for one channel");
});

test("the desk's channel string is the one the preload bridge calls", () => {
  const preload = require("./awconnect-compat-preload.cjs");
  assert.equal(preload.CHANNEL, webauth.CHANNEL);
});

test("one identity: the desk-session channel answers only a loaded extension, through the provider", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const { session } = fakeSession({ getExtension: (id) => (id === ID ? { id } : null) });
  const asked = [];
  webauth.install({ ipcMain, session, BrowserWindow: FakeWindow,
    deskSession: async (id) => { asked.push(id); return { token: "platform-bearer" }; } });
  const handler = handlers.get(webauth.DESK_SESSION_CHANNEL);
  assert.equal(typeof handler, "function");
  const from = (url) => ({ senderFrame: { url }, sender: { session } });
  assert.deepEqual(await handler(from("https://example.com/")), {}, "a web page gets nothing");
  assert.deepEqual(await handler(from(`chrome-extension://${"b".repeat(32)}/x.html`)), {}, "an unloaded extension gets nothing");
  assert.deepEqual(await handler(from(`chrome-extension://${ID}/sidepanel.html`)), { token: "platform-bearer" });
  assert.deepEqual(asked, [ID], "the provider is asked only for the loaded extension");
});

test("one identity: answerDeskSession never rejects, and an empty token is a sign-out", async () => {
  assert.deepEqual(await webauth.answerDeskSession(async () => ({ token: "" }), ID), { token: null });
  assert.deepEqual(await webauth.answerDeskSession(async () => ({ token: null }), ID), { token: null });
  assert.deepEqual(await webauth.answerDeskSession(async () => { throw new Error("x"); }, ID), {});
  assert.deepEqual(await webauth.answerDeskSession(async () => ({}), ID), {}, "a refusal is not a sign-out");
  assert.deepEqual(await webauth.answerDeskSession(async () => ({ token: "t" }), ""), {});
  const preload = require("./awconnect-compat-preload.cjs");
  assert.equal(preload.DESK_SESSION_CHANNEL, webauth.DESK_SESSION_CHANNEL);
});

test("one identity: without a provider the desk-session channel is not served at all", () => {
  const handled = [];
  const { session } = fakeSession({ getExtension: () => null });
  webauth.install({ ipcMain: { handle: (c) => handled.push(c) }, session, BrowserWindow: FakeWindow });
  assert.equal(handled.includes(webauth.DESK_SESSION_CHANNEL), false);
});
