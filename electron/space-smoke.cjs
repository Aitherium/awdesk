"use strict";

/**
 * Does aither://space/ RENDER and ANSWER? A real Electron run that exits by itself
 * (`npm run test:space`, and deploy_desk_local --smoke). Modelled on console-smoke.cjs:
 * the REAL console window, the BUILT renderer bundle (dist/index.html?space=1) with the
 * real preload, and the REAL space IPC (space-window.cjs) over the REAL client
 * (space-client.cjs) whose route is offline -- so what it draws is the desk's own local
 * skeleton, which is exactly the "never blank" promise.
 *
 *   1. open the console on Space;
 *   2. wait for the space=1 frame;
 *   3. a canvas or an svg is drawn and window.deskBridge.space is defined;
 *   4. __space.select('galaxy:fleet');
 *   5. the panel shows a primary action;
 *   6. toggle 2D/3D: the selection is kept.
 *
 * main.cjs is not loaded (it would take the running desk's instance lock); the pieces
 * it wires are. A throwaway userData; nothing touches ~/.aither and no verb runs.
 * Exit 0 all pass, 1 a check failed, 2 the run broke, 3 it hung.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, ipcMain } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-space-smoke-"));
app.setPath("userData", path.join(tmp, "userData"));
setTimeout(() => { process.stdout.write("TIMEOUT\n"); app.exit(3); }, 90000);

const { showConsole, PANES } = require("./console-window.cjs");
const { ensureSpaceIpc } = require("./space-window.cjs");
const { createSpaceClient } = require("./space-client.cjs");
const { createLastGoodCache } = require("./last-good-cache.cjs");

const results = [];
let judged = true;
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || "" });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `fn` until it returns truthy (or the budget runs out); returns the last value. */
async function until(fn, { tries = 40, every = 250 } = {}) {
  let value;
  for (let i = 0; i < tries; i += 1) {
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    await sleep(every);
  }
  return value;
}

async function run() {
  const ran = [];
  // The REAL client, with the platform route offline: the pane must still draw.
  const client = createSpaceClient({
    fetchUniverse: async () => { throw new Error("smoke: the platform route is offline"); },
    store: createLastGoodCache({ dir: path.join(tmp, "page-cache") }),
    fleetStatus: () => ({ verdict: { fleet: { running: 3, masked: 0, units: 5 } }, at: Date.now(), changedAt: 0 }),
  });
  ensureSpaceIpc({
    getControl: () => ({ run: async (id) => { ran.push(id); return { ok: true }; } }),
    client,
    askAgent: async () => ({ ok: true, reply: "smoke" }),
    openInternal: () => true,
  });
  // The deck feed main would send: one probe ask on the fleet GPU, so the space has
  // something to glow and the Next pill has something to say.
  ipcMain.handle("desk:deck-get-state", () => ({
    decisions: [{
      id: "d-spaceprobe", title: "Space smoke probe", summary: "", kind: "decision", urgency: "normal",
      createdAt: 0, options: [{ key: "ok", label: "OK", recommended: true }], defaultKey: "ok",
      tab: "", cwd: "", agent: "", subject: "gpu:fleet/0",
    }],
    openCount: 1, deskVisible: false, slots: [], agents: [], characters: [], characterModels: {},
    activeCharacter: "", agentCharacters: {}, relay: [], relayChannel: "#agents", room: [], roomStatus: "ok",
    wakes: null,
  }));

  const opened = [];
  const win = showConsole({
    autoShow: false,
    commands: { list: () => [], run: () => {} },
    rendererUrl: pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href,
    windows: Object.fromEntries(PANES.map((p) => [p.id, {
      open: () => opened.push(p.id), close: () => {}, isOpen: () => false,
    }])),
    urls: { desktop: () => "about:blank" },
  });
  // 1. Open the console ON Space (it is also the first rail row).
  win.webContents.once("dom-ready", () => {
    win.webContents.send("desk:console-focus", { pane: "space", param: null });
  });
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));

  // 2. The space=1 frame, matched by its URL (console-smoke's framesInSubtree rule).
  const frame = await until(() => win.webContents.mainFrame.framesInSubtree
    .filter((f) => f !== win.webContents.mainFrame)
    .find((f) => String(f.url || "").includes("space=1")));
  if (!frame) {
    const urls = win.webContents.mainFrame.framesInSubtree.map((f) => String(f.url || "<blank>").slice(-50));
    check("the space=1 frame exists", false, `saw [${urls.join(", ")}]`);
    return;
  }
  check("the space=1 frame exists", true, String(frame.url).slice(-60));

  // 3. Drawn, and the bridge reached the frame.
  const drawn = await until(() => frame.executeJavaScript(
    "(document.querySelector('[data-space=\"ready\"]') && document.querySelector('[data-space=\"ready\"] canvas, [data-space=\"ready\"] svg'))"
    + " ? ({ bridge: typeof (window.deskBridge && window.deskBridge.space), canvas: !!document.querySelector('canvas'),"
    + " svg: !!document.querySelector('svg'), hook: typeof window.__space,"
    + " badge: (document.querySelector('[data-space-badge]') || {}).textContent || '',"
    + " pill: [...document.querySelectorAll('button')].map((b) => b.textContent).find((t) => /need/.test(t)) || '' }) : null"),
  { tries: 60 });
  check("a canvas or an svg is drawn", drawn && (drawn.canvas || drawn.svg), JSON.stringify(drawn));
  check("window.deskBridge.space reached the frame", drawn && drawn.bridge === "object", JSON.stringify(drawn));
  check("the test hook is installed", drawn && drawn.hook === "object", JSON.stringify(drawn));
  check("an offline platform draws the local view, badged", drawn && /local view/.test(drawn.badge), JSON.stringify(drawn));
  check("the probe ask is counted by the Next pill (it glows, nothing flew)", drawn && /^1 thing needs you/.test(drawn.pill),
    JSON.stringify(drawn));
  const before = await frame.executeJavaScript("window.__space ? window.__space.selected() : 'no hook'");
  check("a new ask selects nothing on its own", before === null, String(before));

  // 4 + 5. Select the fleet galaxy: the panel shows its one obvious action.
  await frame.executeJavaScript("window.__space.select('galaxy:fleet')");
  const panel = await until(() => frame.executeJavaScript(
    "(() => { const p = document.querySelector('[data-node=\"galaxy:fleet\"]'); if (!p) return null;"
    + " const b = p.querySelector('[data-block=\"verbs\"] button, [data-block=\"ask\"] button');"
    + " return b ? { primary: b.textContent, selected: window.__space.selected(), mode: window.__space.mode() } : null; })()"));
  check("selecting galaxy:fleet shows the panel with a primary action", panel && panel.primary && panel.selected === "galaxy:fleet",
    JSON.stringify(panel));

  // 6. Toggle 2D/3D: the selection is kept.
  const from = panel ? panel.mode : "3d";
  await frame.executeJavaScript(`window.__space.setMode('${from === "3d" ? "2d" : "3d"}')`);
  await sleep(800);
  const after = await until(() => frame.executeJavaScript(
    "(() => { const p = document.querySelector('[data-node=\"galaxy:fleet\"]');"
    + " return p ? { selected: window.__space.selected(), mode: window.__space.mode(),"
    + " drawn: !!document.querySelector('[data-space=\"ready\"] canvas, [data-space=\"ready\"] svg') } : null; })()"));
  check("toggling 2D/3D keeps the selection and the panel", after && after.selected === "galaxy:fleet" && after.drawn,
    `${from} -> ${JSON.stringify(after)}`);
  check("no verb ran during the smoke", ran.length === 0, ran.join(","));
}

app.whenReady().then(run).catch((error) => {
  judged = false;
  check("smoke run completed", false, String((error && error.stack) || error));
}).finally(() => {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    process.stdout.write(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` -- ${r.detail}` : ""}\n`);
  }
  process.stdout.write(`\nSPACE SMOKE: ${failed.length || !results.length ? "FAIL" : "ok"} `
    + `(${results.length - failed.length}/${results.length})\n`);
  // 2 = could not judge, never 0 on silence.
  app.exit(!judged || !results.length ? 2 : failed.length ? 1 : 0);
});
