"use strict";

/**
 * Does the Connect panel WORK, not just parse? A real Electron run
 * (`npm run test:connect-panel`): the real connect-panel.html, with a stub
 * aitherAssist behind it, clicked through Chat (question, quick action, history),
 * Do it, Open in Chrome and Downloads -- and a hostile reply must render as text.
 * Exit 0 all pass, 1 a check failed, 2 the run broke, 3 it hung.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-connect-smoke-${process.pid}`));
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 45000);

// A stub preload: the same aitherAssist shape, recording every call.
const STUB = [
  'const { contextBridge } = require("electron");',
  "const calls = [];",
  "let listener = null;",
  'const state = { url: "https://shop.test/cart", title: "Cart", tabs: [{ id: 1, by: "you", active: true }],',
  '  agent: { driving: false, paused: true, handoff: { reason: "Tick the captcha." } },',
  '  downloads: [{ id: 1, filename: "invoice.pdf", url: "https://shop.test/i.pdf", state: "completed", received: 1, total: 1 },',
  '              { id: 2, filename: "tool.exe", url: "https://x.test/t", state: "blocked", received: 0, total: 0 }] };',
  'contextBridge.exposeInMainWorld("aitherAssist", {',
  "  state: async () => state,",
  '  ask: async (q, extra) => { calls.push(["ask", q, extra]); return { ok: true, reply: q === "evil" ? "<img src=x onerror=alert(1)>" : "Answer to " + q }; },',
  '  selection: async () => ({ ok: true, text: "the selected words" }),',
  '  task: async (t) => { calls.push(["task", t]); return { ok: true, reply: "Filled 3 fields; left Send for you." }; },',
  '  openExternal: async () => { calls.push(["external"]); return { ok: true }; },',
  '  clearDownloads: () => calls.push(["clear"]),',
  '  showDownload: (id) => calls.push(["show", id]),',
  "  onState: (fn) => { listener = fn; },",
  "});",
  'contextBridge.exposeInMainWorld("__smoke", { calls: () => JSON.parse(JSON.stringify(calls)),',
  "  push: (s) => listener && listener(Object.assign({}, state, s)) });",
].join("\n");

app.whenReady().then(async () => {
  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };
  const stubFile = path.join(app.getPath("userData"), "stub-preload.cjs");
  fs.mkdirSync(path.dirname(stubFile), { recursive: true });
  fs.writeFileSync(stubFile, STUB);
  const win = new BrowserWindow({ show: false, width: 360, height: 800,
    webPreferences: { preload: stubFile, contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(__dirname, "connect-panel.html"));
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (q) => js(`document.getElementById('q').value = ${JSON.stringify(q)}; document.getElementById('send').click()`);
  const lastAsk = async () => (await js("window.__smoke.calls()")).filter((c) => c[0] === "ask").pop();
  await wait(300);

  const head = await js("document.getElementById('title').textContent + '|' + document.getElementById('who').textContent");
  expect("header shows the page and whose tab it is", head === "Cart|yours", head);
  expect("a hand-off shows as Your turn", /Your turn: Tick the captcha\./.test(await js("document.getElementById('status').textContent")));

  await send("what is the total?");
  await wait(300);
  const thread = await js("Array.from(document.querySelectorAll('#thread .msg')).map((m) => m.className + ':' + m.textContent)");
  expect("a question and its answer appear in the thread",
    thread.includes("msg me:what is the total?") && thread.includes("msg ai:Answer to what is the total?"), thread);

  await js("document.querySelector('.chips button[data-sel=\"1\"]').click()");
  await wait(300);
  const sel = await lastAsk();
  expect("Explain selection sends the selection AND the earlier turn as history",
    sel[2].selection === "the selected words" && sel[2].history.length === 1 && sel[2].history[0].q === "what is the total?", sel);

  await send("evil");
  await wait(300);
  const imgs = await js("document.querySelectorAll('#thread img').length");
  const last = await js("document.querySelector('#thread .msg.ai:last-child').textContent");
  expect("a hostile reply renders as TEXT, not HTML", imgs === 0 && last.includes("<img"), { imgs, last });

  await js("window.__smoke.push({ url: 'https://other.test/', title: 'Other' })");
  await wait(100);
  await send("and here?");
  await wait(300);
  const fresh = await lastAsk();
  expect("a new page starts a new conversation (no history carried over)", fresh[2].history.length === 0, fresh);

  await js("document.getElementById('t-task').click(); document.getElementById('task').value = 'fill the form'; document.getElementById('go').click()");
  await wait(300);
  const calls = await js("window.__smoke.calls()");
  const report = await js("document.getElementById('taskOut').textContent");
  expect("Do it hands the task to an agent and shows its report",
    calls.some((c) => c[0] === "task" && c[1] === "fill the form") && report === "Filled 3 fields; left Send for you.", { report });

  await js("document.getElementById('chrome').click()");
  await js("document.getElementById('t-dl').click()");
  await wait(150);
  const dl = await js("Array.from(document.querySelectorAll('#dllist .dl')).map((d) => d.className + ':' + d.textContent)");
  expect("downloads list both rows, the agent's as blocked", dl.length === 2 && dl.some((d) => d.startsWith("dl blocked")), dl);
  await js("document.querySelector('#dllist .dl button').click(); document.getElementById('dlclear').click()");
  const after = await js("window.__smoke.calls()");
  expect("Open in Chrome, Show and Clear reach the desk", ["external", "show", "clear"].every((k) => after.some((c) => c[0] === k)), after);

  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
});
