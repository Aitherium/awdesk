"use strict";

/**
 * Does the AitherOS taskbar really sit along the browser's bottom? `npm run test:taskbar`
 * -- opens the real Aither Browser window (temp userData) and waits for the taskbar view
 * (browser-taskbar.cjs) to load app.aitherium.com/embed/taskbar. Exit 0 pass, 1 a check
 * failed, 2 the route is not served (could not judge), 3 it hung.
 */
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const bw = require("./browser-window.cjs");

app.setPath("userData", path.join(os.tmpdir(), `awdesk-taskbar-smoke-${process.pid}`));
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 90000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  bw.createBrowserWindow();
  let tb = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const s = bw.getState();
    tb = s && s.rail && s.rail.taskbar;
    if (tb && (tb.status === "ok" || tb.status === "unavailable")) break;
  }
  if (!tb || tb.status === "unavailable") {
    console.log("DEAD the taskbar route was not served: " + JSON.stringify(tb));
    return app.exit(2);
  }
  expect("the taskbar page loads (status ok)", tb.status === "ok", tb);
  // The home page (aitherium.com) draws its own taskbar; an Aither page does not.
  bw.openInternal("search", null);
  for (let i = 0; i < 30 && bw.getState().rail.taskbar.height !== 56; i++) await sleep(300);
  tb = bw.getState().rail.taskbar;
  expect("on an ordinary page it takes the 56 px strip along the bottom", tb.height === 56, tb);
  const s = bw.getState();
  expect("the rail ends above it", s.rail && s.rail.width > 0, s.rail && s.rail.width);

  // One taskbar (owner, 2026-10-04): on the AitherOS Online tab -- which draws its own --
  // the strip STAYS and the page's copy is hidden.
  bw.openInternal("desktop", null);
  let onOnline = null;
  let pageBars = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = bw.getState();
    if (!/app\.aitherium\.com/.test(st.url || "")) continue;
    onOnline = st.rail.taskbar;
    const view = bw.getWindow().contentView.children.find((v) => /app\.aitherium\.com\/(\?|$)/.test(v.webContents.getURL()));
    // A signed-out temp profile shows the boot screen, not the desktop, so the smoke
    // plants Veil's dock shape (dock.tsx Taskbar: [data-os-hit] > div > button
    // [data-launcher-toggle]) and asks the page whether the inserted sheet hides it.
    pageBars = view ? await view.webContents.executeJavaScript(`(() => {
      let bar = document.getElementById("smoke-bar");
      if (!bar) {
        bar = document.createElement("div"); bar.id = "smoke-bar"; bar.setAttribute("data-os-hit", "");
        const box = document.createElement("div"); const btn = document.createElement("button");
        btn.setAttribute("data-launcher-toggle", ""); box.append(btn); bar.append(box); document.body.append(bar);
      }
      return [getComputedStyle(bar).display];
    })()`) : null;
    if (onOnline.height === 56 && pageBars && pageBars.every((d) => d === "none")) break;
  }
  expect("on the Online desktop the strip stays (56 px)", onOnline && onOnline.height === 56, onOnline);
  expect("and the page's own taskbar is hidden", pageBars && pageBars.length > 0 && pageBars.every((d) => d === "none"), pageBars);

  // Full context (owner, 2026-10-04): the pinned Online tab is a desk host -- marked by
  // the overlay's preload, and the desk's state reaches it.
  const ld = require("./living-desktop-window.cjs");
  const hostWcs = bw.deskHostContents();
  expect("the Online tab is a desk host (one webContents)", hostWcs.length === 1, hostWcs.length);
  if (hostWcs.length === 1) {
    const hw = hostWcs[0];
    expect("marked data-aither-host=desk", await hw.executeJavaScript("document.documentElement.getAttribute('data-aither-host')") === "desk", null);
    await hw.executeJavaScript("window.__smokeState = null; window.addEventListener('message', (e) => { if (e.data && e.data.__aither === 'desk-state') window.__smokeState = e.data; }); true");
    ld.setDeskStateProvider(() => ({ browser: { open: true, tabCount: 7 } }));
    ld.setExtraHosts(() => bw.deskHostContents());
    ld.pushDeskState();
    let got = null;
    for (let i = 0; i < 20 && !got; i++) { await sleep(150); got = await hw.executeJavaScript("window.__smokeState"); }
    expect("the desk's state reaches Online in the browser", got && got.browser && got.browser.tabCount === 7, got);
  }
  bw.closeBrowserWindow();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
