"use strict";

/**
 * Does the overlay preload really HOST AitherOS Online's page protocol? A real
 * Electron run (`npm run test:overlay-host`): a page loaded with the real
 * living-desktop-preload.cjs posts the same messages Veil's overlay-host.ts posts,
 * and the replies must come back -- while a message from a CHILD frame is ignored.
 * The desk's ipcMain side is stubbed here (main.cjs would take the running desk's
 * instance lock); overlay-browser-host.test.cjs covers what main does with them.
 *
 * Exit 0 all pass, 1 a check failed, 2 the run broke, 3 it hung.
 */
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { app, BrowserWindow, ipcMain } = require("electron");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-overlay-host-smoke-${process.pid}`));
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 45000);

const PAGE = `<!doctype html><title>os</title><iframe id="child" srcdoc="<script>
  parent.postMessage({ __aither: 'os→page', reqId: 'evil', action: 'click', selector: '#x' }, '*');
</script>"></iframe><script>
  window.got = [];
  window.addEventListener('message', (e) => { if (e.data && e.data.__aither && e.data.__aither !== 'os→page'
    && e.data.__aither !== 'os-page-context-request' && e.data.__aither !== 'desk-command') window.got.push(e.data); });
</script>`;

app.whenReady().then(async () => {
  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };
  const seen = { page: [], commands: [] };
  ipcMain.handle("living-desktop:host-page", (_e, msg) => { seen.page.push(msg); return { ok: true, text: `did ${msg.action}` }; });
  ipcMain.handle("living-desktop:host-context", () => ({ url: "https://a.test/", host: "a.test", title: "A", text: "" }));
  ipcMain.on("living-desktop:desk-command", (_e, id) => seen.commands.push(id));

  const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, "living-desktop-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const wc = win.webContents;
  await new Promise((r) => setTimeout(r, 400));

  expect("the document is marked as hosted by the desk", await wc.executeJavaScript("document.documentElement.getAttribute('data-aither-host')") === "desk");
  expect("a child frame's os→page is NOT relayed", !seen.page.some((m) => m.selector === "#x"), seen.page);

  await wc.executeJavaScript("window.postMessage({ __aither: 'os→page', reqId: 'r1', action: 'read' }, location.origin)");
  await wc.executeJavaScript("window.postMessage({ __aither: 'os-page-context-request' }, location.origin)");
  // No user gesture: a page script alone must NOT reach the desk.
  await wc.executeJavaScript("window.postMessage({ __aither: 'desk-command', id: 'browser.handback' }, location.origin)", false);
  // With a gesture (a real click is what sets transient activation).
  await wc.executeJavaScript("window.postMessage({ __aither: 'desk-command', id: 'browser.open' }, location.origin)", true);
  await new Promise((r) => setTimeout(r, 400));
  const got = await wc.executeJavaScript("window.got");
  const reply = got.find((m) => m.__aither === "page→os");
  expect("os→page is answered as page→os with the same reqId", reply && reply.reqId === "r1" && reply.ok === true && reply.text === "did read", got);
  const ctx = got.find((m) => m.__aither === "os-page-context");
  expect("a context request is answered with os-page-context", ctx && ctx.context && ctx.context.host === "a.test", got);
  expect("a desk-command from a real click reaches main", seen.commands.includes("browser.open"), seen.commands);
  expect("a desk-command with no user gesture is dropped", !seen.commands.includes("browser.handback"), seen.commands);

  server.close();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
});
