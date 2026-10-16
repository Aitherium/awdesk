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
 *   3. the REAL bead-space engine drew it (its .bead-space root, planets as g.bs-node,
 *      sprites from the vendored Kenney set) and window.deskBridge.space is defined;
 *   4. __space.select('galaxy:fleet');
 *   5. the panel shows a primary action;
 *   6. drill into galaxy:fleet: the engine redraws that level (update()) -- one ring, so
 *      the planet holding the probe ask's GPU is on screen with the gold ask ring, its hover
 *      card speaks the owner's words (no raw id, no engine status), and the breadcrumb
 *      (with its back arrow) leads back up.
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

  // 3. Drawn BY THE ENGINE, and the bridge reached the frame.
  const drawn = await until(() => frame.executeJavaScript(
    "(() => { const root = document.querySelector('[data-space=\"ready\"] .bead-space');"
    + " const d = window.__space && window.__space.drawn(); if (!root || !d || !d.planets) return null;"
    + " const img = root.querySelector('image.bs-planet-sprite');"
    + " return { bridge: typeof (window.deskBridge && window.deskBridge.space), engine: typeof window.BeadSpace,"
    + " planets: d.planets, nodes: d.nodes, sprite: img ? img.getAttribute('href') : '',"
    + " hook: typeof window.__space,"
    + " badge: (document.querySelector('[data-space-badge]') || {}).textContent || '',"
    + " pill: [...document.querySelectorAll('button')].map((b) => b.textContent).find((t) => /need/.test(t)) || '' }; })()"),
  { tries: 60 });
  check("the bead-space engine drew the planets", drawn && drawn.engine === "object" && drawn.planets > 0
    && drawn.planets === drawn.nodes, JSON.stringify(drawn));
  check("planets use the vendored Kenney sprites",
    drawn && /^\.\/bead-space\/kenney-simple-space\/meteor_/.test(drawn.sprite), JSON.stringify(drawn));
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
    + " return b ? { primary: b.textContent, selected: window.__space.selected() } : null; })()"));
  check("selecting galaxy:fleet shows the panel with a primary action", panel && panel.primary && panel.selected === "galaxy:fleet",
    JSON.stringify(panel));

  // 6. Drill into the fleet galaxy: the engine redraws that level through update().
  await frame.executeJavaScript("window.__space.descend('galaxy:fleet')");
  // Polled until the engine has taken the new level (the root planet gone, an asking planet there).
  const after = await until(() => frame.executeJavaScript(
    "(() => { if (window.__space.focus() !== 'galaxy:fleet') return null; const d = window.__space.drawn();"
    + " const gs = [...document.querySelectorAll('g.bs-node')];"
    + " const ids = gs.map((g) => g.__data__ && g.__data__.id);"
    + " const asking = gs.find((g) => g.classList.contains('desk-asking'));"
    + " if (!d || !asking || ids.includes('platform')) return null;"
    + " asking.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: 400, clientY: 300 }));"
    + " const tip = document.querySelector('.bs-tooltip');"
    // The desk rewrites the card from a MutationObserver: read it after that ran.
    + " return new Promise((r) => setTimeout(r, 60)).then(() => ({ planets: d.planets, ships: d.ships, top: ids.includes('platform'), asking: asking.__data__.id,"
    + " ring: Boolean(asking.querySelector('.desk-ask-ring')), badge: (asking.querySelector('.desk-ask-badge text') || {}).textContent || '',"
    + " rim: asking.querySelectorAll('.desk-health-track').length,"
    + " chips: [...document.querySelectorAll('[data-space-ask-target]')].map((b) => b.textContent),"
    + " tip: tip ? tip.innerText : '',"
    + " back: Boolean(document.querySelector('[data-space-back]')),"
    + " crumbs: [...document.querySelectorAll('[data-space-path] button:not([data-space-back])')].map((b) => b.textContent) })); })()"));
  check("drilling into galaxy:fleet redraws that level with the asking planet on it", after && after.planets > 0 && !after.top,
    JSON.stringify(after));
  check("the asking planet wears the gold ask ring and its count badge, and no ship covers it",
    after && after.ring && after.badge === "1" && after.ships === 0, JSON.stringify(after));
  check("planets carry the desk health rim", after && after.rim === 1, JSON.stringify(after));
  check("the asks bar names where the ask is", after && after.chips.length === 1 && /GPU/.test(after.chips[0]),
    JSON.stringify(after));
  check("the hover card speaks the owner's words", after && /Aither asks: Space smoke probe|needs you/.test(after.tip)
    && !after.tip.includes(after.asking) && !/in progress|crew /.test(after.tip), JSON.stringify(after));
  check("the breadcrumb leads back up", after && after.crumbs.length === 2 && after.back, JSON.stringify(after));
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
