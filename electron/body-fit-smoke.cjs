"use strict";
/**
 * Body size and fit, end to end, in a HIDDEN offscreen window (never on screen).
 * Regression for owner 2026-11-17 (P0): a session body rendered ~3x the others, and a stage
 * showed a body sliced in half at the window edge.
 *
 *   npx vite build && npx electron electron/body-fit-smoke.cjs [shot.png]
 * Needs dist/assets/model.vrm, dist/assets/model-fit-tall.vrm (a model whose head bone stands
 * well above 1.6 m) and dist/assets/model-fit-norm.vrm (an ordinary one); all gitignored.
 * Exit 0 pass, 1 violation, 2 could not judge.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, process.env.AWDESK_SMOKE_DIST || "dist");
const W = 900;
const H = 640;
const SHOT = process.argv.find((a) => a.endsWith(".png")) || "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of ["index.html", "assets/model.vrm", "assets/model-fit-tall.vrm", "assets/model-fit-norm.vrm"]) {
  if (!fs.existsSync(path.join(DIST, f))) {
    console.error(`body-fit-smoke: needs dist/${f} -- could not judge`);
    process.exit(2);
  }
}

app.whenReady().then(async () => {
  ipcMain.handle("desk:get-snapshot", () => ({}));
  ipcMain.on("desk:set-interactive", () => {});
  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setFrameRate(60);
  const wc = win.webContents;
  const send = (e) => wc.send("desk:event", e);
  const bounds = () => wc.executeJavaScript("window.__deskPick ? window.__deskPick.bounds() : {}");
  try {
    await win.loadFile(path.join(DIST, "index.html"));
    await wait(4000);
    send({ type: "spawn-avatar", slotId: "slot1", modelUrl: "./assets/model-fit-tall.vrm" });
    send({ type: "spawn-avatar", slotId: "slot2", modelUrl: "./assets/model-fit-norm.vrm" });
    let b = {};
    for (let i = 0; i < 60; i += 1) {
      await wait(500);
      b = await bounds();
      if (b.slot1 && b.slot2) break;
    }
    if (!b.slot1 || !b.slot2) { console.error("bodies never registered -- could not judge", JSON.stringify(b)); app.exit(2); return; }
    // The swarm's grow: bodies arrive small at the centre (the camera frames THAT), then the
    // tween carries them out to the stage edges -- the drift that sliced a body in half. The
    // tall body also carries a 3x stored scale.
    send({ type: "place-avatar", slotId: "slot1", position: [0, 0, 0], scale: 0.3, yaw: 0 });
    send({ type: "place-avatar", slotId: "slot2", position: [0.2, 0, 0], scale: 0.3, yaw: 0 });
    await wait(2500);
    send({ type: "place-avatar", slotId: "slot1", position: [-2, 0, 0], scale: 3, yaw: 0 });
    send({ type: "place-avatar", slotId: "slot2", position: [2, 0, 0], scale: 1, yaw: 0 });
    await wait(4000);
    b = await bounds();
    if (SHOT) fs.writeFileSync(SHOT, (await wc.capturePage()).toPNG());
    // A body with no bounds at all is entirely outside the frame: the worst clip there is.
    const clipped = ["slot0", "slot1", "slot2"].filter((k) => {
      const v = b[k];
      return !v || v.x <= 1 || v.y <= 1 || v.x + v.w >= W - 1 || v.y + v.h >= H - 1;
    });
    const ratio = b.slot1 && b.slot2 ? b.slot1.h / b.slot2.h : Infinity;
    console.log(JSON.stringify({ bounds: b, clipped, tallOverNorm: Number(ratio.toFixed(3)) }));
    // the 1.1 band x the 1.25 scale ceiling (raised arms included in the box): never 3x.
    const ok = clipped.length === 0 && ratio < 1.6;
    console.log(ok ? "PASS: no body clipped at the edge; the tall body is clamped" : "FAIL");
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error("could not judge:", error && error.message);
    app.exit(2);
  }
});
