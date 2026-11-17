"use strict";
/**
 * Right-click on the desktop avatar, end to end, in a HIDDEN offscreen window (never on screen).
 * Regression for owner 2026-11-16 (P0): a right-click on the head and shoulders opened the Windows
 * desktop menu. The real preload + the built renderer; the OS click-through is simulated from the
 * renderer's own desk:set-interactive reports: a press while the window says "click-through" is a
 * press the desktop would have taken.
 *
 *   npx vite build && npx electron electron/avatar-rightclick-smoke.cjs
 * Needs dist/assets/model.vrm (gitignored). Exit 0 pass, 1 violation, 2 could not judge.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, process.env.AWDESK_SMOKE_DIST || "dist");
const W = 616;
const H = 761;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(DIST, "index.html")) || !fs.existsSync(path.join(DIST, "assets", "model.vrm"))) {
  console.error("avatar-rightclick-smoke: needs a build with dist/assets/model.vrm -- could not judge");
  process.exit(2);
}

app.whenReady().then(async () => {
  let interactive = true;
  const got = [];
  ipcMain.on("desk:set-interactive", (_e, v) => { interactive = v === true; });
  ipcMain.on("desk:avatar-context-menu", (_e, slot) => got.push(`avatar:${slot}`));
  ipcMain.on("desk:context-menu", () => got.push("deck"));
  ipcMain.handle("desk:get-snapshot", () => ({}));
  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    // offscreen: a hidden on-screen window gets ~2 animation frames a second; offscreen keeps 60.
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setFrameRate(60);
  const wc = win.webContents;
  try {
    await win.loadFile(path.join(DIST, "index.html"));
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      await wait(500);
      ready = await wc.executeJavaScript("Boolean(window.__deskPick && window.__deskPick.slots().length)");
    }
    if (!ready) { console.error("no body registered -- could not judge"); app.exit(2); return; }
    await wait(3000);
    const grid = await wc.executeJavaScript("window.__deskPick.grid(40)");
    const cells = grid.filter((c) => c.slot);
    if (cells.length < 10) { console.error(`only ${cells.length} body cells -- could not judge`); app.exit(2); return; }
    const tally = { bodyFellThrough: 0, openedNothing: 0, avatarMenu: 0, deck: 0, gapPassed: 0, gapCaught: 0 };
    const rclick = async (x, y) => {
      got.length = 0;
      wc.sendInputEvent({ type: "mouseMove", x, y });
      await wait(600); // the cursor RESTS while the idle sways the body under it
      const exact = await wc.executeJavaScript(`window.__deskPick.pickAt(${x}, ${y})`);
      if (!interactive) { if (exact) tally.bodyFellThrough += 1; else tally.gapPassed += 1; return; }
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "right", clickCount: 1 });
      await wait(80);
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "right", clickCount: 1 });
      wc.sendInputEvent({ type: "contextMenu", x, y, button: "right" });
      await wait(200);
      if (!got.length) tally.openedNothing += 1;
      else if (got[0].startsWith("avatar:")) tally.avatarMenu += 1;
      else tally.deck += 1;
      if (!exact) tally.gapCaught += 1;
    };
    for (const c of cells) await rclick(c.x, c.y);
    for (const [x, y] of [[30, H / 2], [W - 30, H - 120], [30, H - 30]]) await rclick(x, y);
    console.log(JSON.stringify({ cells: cells.length, ...tally }));
    const ok = tally.bodyFellThrough === 0 && tally.openedNothing === 0 && tally.gapPassed >= 1;
    console.log(ok ? "PASS: every right-click on the body opened a menu; empty space passed through" : "FAIL");
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error("could not judge:", error && error.message);
    app.exit(2);
  }
});
