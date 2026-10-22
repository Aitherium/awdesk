"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createLocalAi, decideChatTarget, probeCloud, parseApiBase, visibleText, createOfflineWatch,
  MODEL_IDS, COPY,
} = require("./local-ai.cjs");

// --- the fallback decision ----------------------------------------------------------

test("a reachable workspace with a working model is where chat goes", () => {
  const d = decideChatTarget({ reachable: true, modelOk: true }, { installed: true, running: true });
  assert.deepEqual(d, { target: "cloud", offline: false, banner: "" });
});

test("a workspace that does not report its model counts as working", () => {
  assert.equal(decideChatTarget({ reachable: true, modelOk: null }, { running: true }).target, "cloud");
});

test("workspace unreachable + local model running -> local, and it says no company documents", () => {
  const d = decideChatTarget({ reachable: false, modelOk: null }, { installed: true, running: true });
  assert.equal(d.target, "local");
  assert.equal(d.offline, true);
  assert.match(d.banner, /can't see your company documents/);
});

test("workspace up but its model down is offline too", () => {
  const d = decideChatTarget({ reachable: true, modelOk: false }, { installed: true, running: true });
  assert.equal(d.target, "local");
});

test("offline with a stopped local model asks to start it; with none, to install one", () => {
  assert.equal(decideChatTarget({ reachable: false }, { installed: true, running: false }).target, "start-local");
  const none = decideChatTarget({ reachable: false }, { installed: false, running: false });
  assert.equal(none.target, "none");
  assert.equal(none.banner, COPY.offlineNone);
  assert.equal(decideChatTarget(null, null).target, "none");
});

test("the offline watch tells the person once, and only when local AI can answer", async () => {
  const toasts = [];
  let cloudUp = true;
  let localUp = true;
  let opened = 0;
  const w = createOfflineWatch({
    tenantHost: () => "garg.aitherium.com",
    probe: async () => ({ reachable: cloudUp, modelOk: cloudUp ? true : null }),
    local: async () => localUp,
    notify: (title, body, onClick) => toasts.push({ title, body, onClick }),
    open: () => { opened += 1; },
  });
  await w.tick();
  assert.equal(toasts.length, 0, "online: silence");
  cloudUp = false;
  await w.tick();
  await w.tick();
  assert.equal(toasts.length, 1, "offline: one toast, not one per tick");
  assert.match(toasts[0].body, /can't see your company documents/);
  toasts[0].onClick();
  assert.equal(opened, 1);
  cloudUp = true;
  await w.tick();
  cloudUp = false;
  localUp = false;
  await w.tick();
  assert.equal(toasts.length, 1, "no local model: no toast that leads nowhere");
});

// --- judging the workspace ----------------------------------------------------------

function fakeFetch(routes) {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, text: async () => "", json: async () => null };
    return { ok: r.status === 200, status: r.status, text: async () => r.body, json: async () => JSON.parse(r.body) };
  };
  impl.seen = seen;
  return impl;
}

test("parseApiBase reads the workspace's own config.js and only trusts https", () => {
  assert.equal(parseApiBase('window.__AITHER_API_BASE__ = "https://garg-api.aitherium.com";'),
    "https://garg-api.aitherium.com");
  assert.equal(parseApiBase('window.__AITHER_API_BASE__ = "http://evil.example";'), null);
  assert.equal(parseApiBase("nothing here"), null);
});

test("probeCloud: the health report's brain_reachable=false means the model is down", async () => {
  const f = fakeFetch({
    "https://garg.aitherium.com/config.js": { status: 200, body: 'window.__AITHER_API_BASE__ = "https://garg-api.aitherium.com";' },
    "https://garg-api.aitherium.com/api/health": { status: 200, body: '{"status":"degraded","brain_reachable":false}' },
  });
  const c = await probeCloud("garg.aitherium.com", { fetchImpl: f });
  assert.deepEqual([c.reachable, c.modelOk, c.apiBase], [true, false, "https://garg-api.aitherium.com"]);
  assert.equal(decideChatTarget(c, { running: true }).target, "local");
});

test("probeCloud: a network failure is unreachable, never a crash", async () => {
  const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  const c = await probeCloud("garg.aitherium.com", { fetchImpl: fakeFetch({ "https://garg.aitherium.com/config.js": err }) });
  assert.equal(c.reachable, false);
  assert.match(c.detail, /ENOTFOUND/);
});

test("probeCloud: a 502 from the API is unreachable", async () => {
  const f = fakeFetch({
    "https://acme.example.com/config.js": { status: 200, body: "" },
    "https://acme.example.com/api/health": { status: 502, body: "bad gateway" },
  });
  const c = await probeCloud("acme.example.com", { fetchImpl: f });
  assert.equal(c.reachable, false);
});

test("probeCloud: no workspace configured is not a request at all", async () => {
  const f = fakeFetch({});
  const c = await probeCloud("", { fetchImpl: f });
  assert.equal(c.reachable, false);
  assert.equal(f.seen.length, 0);
});

// --- running awdk -------------------------------------------------------------------

function fakeRun(script) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    for (const [pattern, result] of script) if (pattern.test([cmd, ...args].join(" "))) return result;
    return { code: 1, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

const PY_OK = [/-c import sys/, { code: 0, stdout: "True\n", stderr: "" }];
const ADK_OK = [/-c import adk\.bonsai_native/, { code: 0, stdout: "", stderr: "" }];

test("status runs adk bonsai-local --status --json and returns its JSON", async () => {
  const report = { installed: false, recommended: "bonsai-8b", sizes: [] };
  const run = fakeRun([PY_OK, ADK_OK,
    [/bonsai-local --status --json/, { code: 0, stdout: `some log\n${JSON.stringify(report)}\n`, stderr: "" }]]);
  const ai = createLocalAi({ run, platform: "win32", env: {} });
  const s = await ai.status();
  assert.equal(s.ok, true);
  assert.equal(s.recommended, "bonsai-8b");
  assert.ok(run.calls.some((c) => c.startsWith("py -3 -m adk bonsai-local --status --json")));
});

test("no Python is a plain sentence, not a stack trace", async () => {
  const ai = createLocalAi({ run: fakeRun([]), platform: "win32", env: {} });
  const s = await ai.status();
  assert.equal(s.ok, false);
  assert.equal(s.reason, "no-python");
  assert.match(s.error, /python\.org/);
});

test("an old awdk triggers one pip upgrade per ten minutes, not one per status poll", async () => {
  let t = 1_000_000;
  const run = fakeRun([PY_OK]); // adk.bonsai_native never imports; pip "fails" (code 1)
  const ai = createLocalAi({ run, platform: "linux", env: {}, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal((await ai.status()).reason, "awdk-too-old");
  assert.equal(run.calls.filter((c) => c.includes("pip install")).length, 1);
  t += 11 * 60 * 1000;
  await ai.status();
  assert.equal(run.calls.filter((c) => c.includes("pip install")).length, 2);
});

test("install refuses a model id the page made up", () => {
  const ai = createLocalAi({ run: fakeRun([]), spawn: () => assert.fail("must not spawn"), env: {} });
  assert.equal(ai.install("bonsai-8b --purge").ok, false);
  assert.equal(ai.install("../evil").ok, false);
  assert.deepEqual([...MODEL_IDS], ["bonsai-1.7b", "bonsai-4b", "bonsai-8b", "bonsai-27b", "bonsai2-27b"]);
});

test("install streams progress lines and finishes with adk's verdict", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let argv = null;
  const ai = createLocalAi({
    run: fakeRun([PY_OK, ADK_OK]), platform: "linux", env: {},
    spawn: (cmd, args) => { argv = [cmd, ...args]; return child; },
  });
  assert.equal(ai.install("bonsai-4b").ok, true);
  assert.equal(ai.install("bonsai-8b").ok, false, "one job at a time");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(argv.slice(-5), ["adk", "bonsai-local", "--model", "bonsai-4b", "--json"]);
  child.stdout.emit("data", "  Downloading Bonsai-4B-Q1_0.gguf: 42% (0.24 of 0.57 GB)\n");
  assert.match(ai.jobStatus().line, /42%/);
  child.stdout.emit("data", '{"ok": true, "model": "bonsai-4b", "port": 8090}\n');
  child.emit("close", 0);
  const j = ai.jobStatus();
  assert.deepEqual([j.running, j.ok], [false, true]);
});

test("a failed install reports adk's own error", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const ai = createLocalAi({ run: fakeRun([PY_OK, ADK_OK]), platform: "linux", env: {}, spawn: () => child });
  ai.install("bonsai2-27b");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  child.stdout.emit("data", '{"ok": false, "error": "Bonsai 2 27B does not fit: needs 12 GB"}\n');
  child.emit("close", 1);
  assert.equal(ai.jobStatus().ok, false);
  assert.match(ai.jobStatus().error, /does not fit/);
});

// --- local chat ---------------------------------------------------------------------

test("chat posts to the loopback model and hides its <think> block", async () => {
  let sent = null;
  const ai = createLocalAi({
    run: fakeRun([]), env: {},
    fetch: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "<think>hmm</think>\nHi Jason." } }] }) };
    },
  });
  const r = await ai.chat([{ role: "system", content: "ignored" }, { role: "user", content: "hello" }], 8090);
  assert.deepEqual(r, { ok: true, text: "Hi Jason." });
  assert.equal(sent.url, "http://127.0.0.1:8090/v1/chat/completions");
  assert.equal(sent.body.model, "bonsai-local");
  assert.deepEqual(sent.body.messages, [{ role: "user", content: "hello" }]);
});

test("chat with the model down says so in plain words", async () => {
  const ai = createLocalAi({ run: fakeRun([]), env: {}, fetch: async () => { throw new TypeError("fetch failed"); } });
  const r = await ai.chat([{ role: "user", content: "hello" }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /not running/);
});

test("visibleText keeps the answer when the template opened <think> in the prompt", () => {
  assert.equal(visibleText("reasoning...</think>\n\nAnswer."), "Answer.");
  assert.equal(visibleText("Plain."), "Plain.");
});

// --- the page's channels (local-ai-window.cjs) --------------------------------------

const { localAiHandlers, fromLocalAiPage } = require("./local-ai-window.cjs");

const pageEvent = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });

test("only the Local AI page may drive installs", async () => {
  const fake = { status: async () => ({ ok: true }), install: () => ({ ok: true }), remove: () => ({ ok: true }),
    jobStatus: () => ({}), chat: async () => ({ ok: true, text: "hi" }) };
  const h = localAiHandlers(fake);
  assert.equal((await h["desk:localai-install"](pageEvent("https://evil.example/"), "bonsai-4b")).ok, false);
  assert.equal((await h["desk:localai-install"](pageEvent("aither://local-ai/"), "bonsai-4b")).ok, true);
  assert.equal(fromLocalAiPage(pageEvent("file:///C:/app/electron/local-ai.html")), true);
  assert.equal(fromLocalAiPage(pageEvent("aither://bricks/")), false);
});

test("route: workspace model down + local running -> the page opens on local chat", async () => {
  const fake = { status: async () => ({ ok: true, installed: true, running: true, port: 8090 }) };
  const h = localAiHandlers(fake, {
    probe: async () => ({ reachable: true, modelOk: false, detail: "model down" }),
    host: () => "garg.aitherium.com",
  });
  const r = await h["desk:localai-route"](pageEvent("aither://local-ai/"));
  assert.equal(r.target, "local");
  assert.equal(r.offline, true);
  assert.equal(r.port, 8090);
  assert.equal(r.workspace, "garg.aitherium.com");
  assert.match(r.localNote, /company documents/);
});
