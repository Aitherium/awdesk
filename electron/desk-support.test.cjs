"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const support = require("./desk-support.cjs");

const API = "https://acme-api.aitherium.com";

function home({ tenant, devices, settings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-support-"));
  const a = path.join(dir, ".aither");
  fs.mkdirSync(a, { recursive: true });
  if (tenant) fs.writeFileSync(path.join(a, "desk-tenant.json"), JSON.stringify(tenant));
  if (devices) fs.writeFileSync(path.join(a, "app_devices.json"), JSON.stringify(devices));
  if (settings) fs.writeFileSync(path.join(a, "support.json"), JSON.stringify(settings));
  return dir;
}

const tenantHome = (extra = {}) => home({
  tenant: { host: "acme.aitherium.com", api: API },
  devices: { [API]: { device_id: "dev1", token: "s3cret" } },
  ...extra,
});

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { status }; };
  fn.calls = calls;
  return fn;
}

const report = (over = {}) => support.buildReport({ kind: "error", title: "boom", ...over }, { appVersion: "0.1.16" });

test("on by default, off by support.json or env", () => {
  assert.equal(support.enabled({ env: {}, homedir: home() }), true);
  assert.equal(support.enabled({ env: {}, homedir: home({ settings: { enabled: false } }) }), false);
  assert.equal(support.enabled({ env: { AITHER_SUPPORT_REPORTS: "0" }, homedir: home() }), false);
});

test("the destination is desk-tenant.json's api, validated; nothing without one", () => {
  assert.equal(support.tenantApi({ homedir: tenantHome() }), API);
  assert.equal(support.tenantApi({ homedir: home({ tenant: { host: "acme.aitherium.com" } }) }), null);
  assert.equal(support.tenantApi({ homedir: home({ tenant: { api: "http://acme-api.aitherium.com" } }) }), null);
  assert.equal(support.tenantApi({ homedir: home({ tenant: { api: "https://aitherium.com.evil.io" } }) }), null);
  assert.deepEqual(support.trayItems(() => {}, { homedir: home() }), []);
  assert.equal(support.trayItems(() => {}, { homedir: tenantHome() })[0].label, "Send feedback…");
});

test("secrets, tokens, e-mail and home paths are scrubbed; the screenshot is kept", () => {
  const out = support.scrubReport(report({
    message: "ghp_abcSECRET9 sk-ant-xyz password=hunter2 patuser@example.com",
    logs: ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y", "C:\\Users\\patuser\\app.log", "https://x/cb?code=abc123&ok=1"],
    screenshot: "data:image/png;base64,iVBORw0KGgo=",
  }), "C:\\Users\\someone");
  const text = JSON.stringify({ ...out, screenshot: undefined });
  for (const leak of ["ghp_abcSECRET9", "sk-ant-xyz", "hunter2", "patuser@example.com", "eyJhbGciOiJIUzI1NiJ9", "\\patuser\\", "abc123"]) {
    assert.ok(!text.includes(leak), leak);
  }
  assert.equal(out.screenshot, "data:image/png;base64,iVBORw0KGgo=");
});

test("opted out: automatic reports are not written, hand-sent feedback is", () => {
  const h = tenantHome({ settings: { enabled: false } });
  assert.equal(support.enqueue(report(), { homedir: h, env: {} }), null);
  assert.ok(support.enqueue(report({ kind: "feedback" }), { homedir: h, env: {}, force: true }));
});

test("flush posts with the device secret to the device route and empties the outbox", async () => {
  const h = tenantHome();
  support.enqueue(report(), { homedir: h, env: {} });
  const f = fakeFetch(200);
  const out = await support.flush({ homedir: h, fetchImpl: f });
  assert.equal(out.sent, 1);
  assert.equal(out.kept, 0);
  assert.equal(f.calls[0].url, `${API}/api/devices/dev1/reports`);
  assert.equal(f.calls[0].init.headers["X-Device-Token"], "s3cret");
  assert.equal(JSON.parse(f.calls[0].init.body).source, "desk");
});

test("offline or 5xx keeps the report; a refused one is set aside", async () => {
  const h = tenantHome();
  support.enqueue(report(), { homedir: h, env: {} });
  assert.equal((await support.flush({ homedir: h, fetchImpl: fakeFetch(503) })).kept, 1);
  assert.equal((await support.flush({ homedir: h, fetchImpl: async () => { throw new Error("offline"); } })).kept, 1);
  const out = await support.flush({ homedir: h, fetchImpl: fakeFetch(422) });
  assert.equal(out.rejected, 1);
  assert.equal(out.kept, 0);
});

test("not listed in the app yet: kept for awdk/the next start, nothing sent", async () => {
  const h = home({ tenant: { host: "acme.aitherium.com", api: API } });
  support.enqueue(report(), { homedir: h, env: {} });
  const f = fakeFetch(200);
  const out = await support.flush({ homedir: h, fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.equal(out.kept, 1);
});

test("crash hooks monitor exceptions and report renderer/child crashes and hangs", () => {
  const proc = new EventEmitter();
  const app = new EventEmitter();
  const crashReporter = { started: null, start(opts) { this.started = opts; } };
  const seen = [];
  const installed = support.installCrashHooks({ app, crashReporter, proc, report: (kind, title) => seen.push([kind, title]) });
  assert.ok(installed.includes("uncaughtExceptionMonitor"));
  assert.equal(proc.listenerCount("uncaughtException"), 0, "must not swallow uncaught exceptions");
  assert.equal(crashReporter.started.uploadToServer, false);
  proc.emit("uncaughtExceptionMonitor", new TypeError("x is undefined"), "uncaughtException");
  proc.emit("unhandledRejection", new Error("nope"));
  app.emit("render-process-gone", {}, { getURL: () => "file:///x.html?token=1" }, { reason: "crashed", exitCode: 1 });
  app.emit("render-process-gone", {}, {}, { reason: "clean-exit" });
  app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 9 });
  const wc = new EventEmitter();
  wc.getURL = () => "file:///deck.html";
  app.emit("web-contents-created", {}, wc);
  wc.emit("unresponsive");
  wc.emit("unresponsive");
  assert.deepEqual(seen.map((s) => s[0]), ["crash", "error", "crash", "crash", "error"]);
  assert.match(seen[0][1], /TypeError: x is undefined/);
});

test("an existing unhandledRejection handler is left in charge", () => {
  const proc = new EventEmitter();
  proc.on("unhandledRejection", () => {});
  const installed = support.installCrashHooks({ app: null, crashReporter: null, proc, report: () => {} });
  assert.ok(!installed.includes("unhandledRejection"));
  assert.equal(proc.listenerCount("unhandledRejection"), 1);
});

test("each crash dump is reported once, by metadata only", () => {
  const h = home();
  const dumps = path.join(h, "dumps", "reports");
  fs.mkdirSync(dumps, { recursive: true });
  fs.writeFileSync(path.join(dumps, "a.dmp"), "MDMP");
  const seen = [];
  const rep = (kind, title, d) => seen.push(d);
  assert.equal(support.reportNewDumps({ dumpDir: path.join(h, "dumps"), report: rep, homedir: h }), 1);
  assert.equal(support.reportNewDumps({ dumpDir: path.join(h, "dumps"), report: rep, homedir: h }), 0);
  assert.equal(seen[0].extra.dump, "a.dmp");
  assert.ok(!JSON.stringify(seen).includes("MDMP"));
});

test("no tenant host or id is compiled into the module (it comes from desk-tenant.json)", () => {
  const src = fs.readFileSync(path.join(__dirname, "desk-support.cjs"), "utf8").toLowerCase();
  assert.ok(!/[a-z0-9-]+\.aitherium\.com/.test(src.replace(/aitherium\.com\.evil/g, "")), "a tenant host literal");
  assert.ok(!src.includes("tnt_"), "a tenant id literal");
});

test("the feedback window answers only its own page, and cannot navigate away", async () => {
  const { pathToFileURL } = require("node:url");
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const wcEvents = {};
  let opener = null;
  const webContents = { on: (ev, fn) => { wcEvents[ev] = fn; }, setWindowOpenHandler: (fn) => { opener = fn; } };
  class FakeWin { constructor() { this.webContents = webContents; } on() {} loadFile() {} isDestroyed() { return false; } }
  const fb = support.createFeedbackWindow({ BrowserWindow: FakeWin, ipcMain, desktopCapturer: null,
    homedir: tenantHome(), flushNow: async () => ({ sent: 1 }) });
  await fb.open();
  const own = pathToFileURL(path.join(__dirname, "desk-feedback.html")).href;
  const send = (url) => handlers["desk-feedback:send"]({ sender: webContents, senderFrame: { url } }, { message: "hi" });
  assert.equal((await send("https://evil.example/")).ok, false);
  assert.equal((await send(own)).ok, true);
  let prevented = false;
  wcEvents["will-navigate"]({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(opener(), { action: "deny" });
});
