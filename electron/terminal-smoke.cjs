"use strict";

/**
 * Does the awsh layer really work end to end? `npm run test:terminal` -- an Electron
 * run against the REAL awsh harness daemon (127.0.0.1:8362): open aither://terminal,
 * press "+ New" -> Shell, see the shell's prompt drawn by xterm, type a command, see
 * its output, close the tab and see the daemon end the session.
 *
 * Own entry point: no single-instance lock, a HIDDEN window (never steals focus), a
 * temp userData. Exit 0 all pass, 1 a check failed, 2 the run broke or the daemon is
 * down (could not judge), 3 it hung.
 */
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, protocol, session } = require("electron");
const internal = require("./browser-internal.cjs");
const { ensureTerminalIpc } = require("./terminal-window.cjs");
const { createTerminalClient } = require("./terminal-client.cjs");

internal.registerPrivilegedScheme(protocol);
app.setPath("userData", path.join(os.tmpdir(), `awdesk-terminal-smoke-${process.pid}`));
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 120000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(wc, expr, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await wc.executeJavaScript(expr).catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  return null;
}

app.whenReady().then(async () => {
  const client = createTerminalClient();
  const health = await client.harnesses();
  if (!health.ok) {
    console.log("DEAD the awsh daemon did not answer: " + health.error);
    return app.exit(2);
  }
  internal.installInternalProtocol(session.fromPartition(internal.INTERNAL_PARTITION), { rendererUrl: "" });
  ensureTerminalIpc();
  const win = new BrowserWindow({ show: false, width: 1100, height: 700,
    webPreferences: internal.tabPreferences("internal", { webPartition: "persist:terminal-smoke" }) });
  await win.loadURL("aither://terminal/");
  const wc = win.webContents;
  expect("the bridge is there", await wc.executeJavaScript("typeof window.aitherTerminal") === "object");
  expect("xterm loaded past the page CSP", await wc.executeJavaScript("typeof window.Terminal") === "function");

  await wc.executeJavaScript(`document.getElementById("add").click()`);
  const shell = await until(wc, `[...document.querySelectorAll("#menu button")].find((b) => b.textContent === "Shell") ? true : null`, 15000);
  expect("+ New lists the Shell harness", Boolean(shell));
  const before = new Set(((await client.list()).sessions || []).map((s) => s.id));
  await wc.executeJavaScript(`[...document.querySelectorAll("#menu button")].find((b) => b.textContent === "Shell").click()`);
  const tab = await until(wc, `document.querySelectorAll(".tab").length`, 30000);
  expect("a tab opened", tab === 1, tab);
  const prompt = await until(wc, `((document.querySelector(".pane:not([hidden]) .xterm-rows") || {}).textContent || "").trim() || null`, 40000);
  expect("the shell drew output into xterm", Boolean(prompt && prompt.trim()), prompt);

  const fresh = ((await client.list()).sessions || []).find((s) => !before.has(s.id));
  expect("the daemon runs the new session", Boolean(fresh), fresh);
  if (fresh) {
    await sleep(2500); // let the shell finish its banner before typing
    await client.input(fresh.id, "echo desk-smoke-$((6*7))\r");
    await client.input(fresh.id, "echo desk-smoke-42\r");
    const echoed = await until(wc, `((document.querySelector(".pane:not([hidden]) .xterm-rows") || {}).textContent || "").includes("desk-smoke-42") || null`, 30000);
    expect("typed input round-trips through the pty to the screen", Boolean(echoed));
    await wc.executeJavaScript(`document.querySelector(".tab .x").click()`);
    await sleep(2500);
    const after = ((await client.list()).sessions || []).find((s) => s.id === fresh.id);
    expect("closing the tab ends the session", !after || after.state === "exited", after);
  }
  win.destroy();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
