"use strict";

/**
 * Does a credential ask REACH the owner with .popup-off present, without
 * stealing focus? A real Electron run (`npm run test:needs-you`, and
 * deploy_desk_local --smoke): the REAL watcher (decision-cards.cjs) on a temp
 * store that holds .popup-off, the REAL bridge (/needs-you), a REAL tray menu
 * built from needs-you.cjs trayRows, the REAL chip (createChip), and the BUILT
 * deck (dist/index.html?deck=1) with the real preload.
 *
 *   1. drop the probe credential card (secret OWNER_ASK_PROBE) into the store;
 *   2. within 10 s GET /needs-you[0].id is the probe, tray item 0 names
 *      OWNER_ASK_PROBE, and NO window gained focus (the chip is focusable:false
 *      and shown inactive);
 *   3. the deck lists the needs-you cards first; sent 'deck:focus-card' (what
 *      main.openInbox(id) sends an open deck) it opens the probe in place; loaded
 *      with ?card=<id> it starts with the probe open.
 *
 * main.cjs itself is not started (it would take the running desk's instance
 * lock and speak); the pieces it wires are. Nothing touches ~/.aither.
 * Exit 0 all pass, 1 a check failed, 2 the run broke, 3 it hung.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-needs-you-smoke-"));
app.setPath("userData", path.join(tmp, "userData"));
const STORE = path.join(tmp, "decisions");
fs.mkdirSync(STORE, { recursive: true });
process.env.AITHER_DECISIONS_DIR = STORE;
process.env.AWDESK_DECISIONS_SOURCE = "local"; // never the gateway in a smoke
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 60000);

const decisionCards = require("./decision-cards.cjs");
const needsYouLib = require("./needs-you.cjs");
const { createBridgeServer } = require("./bridge-server.cjs");

const PROBE_ID = "d-ownerprobe";
const PROBE_SECRET = "OWNER_ASK_PROBE";
const now = () => Date.now() / 1000;

function writeCard(id, extra) {
  fs.writeFileSync(path.join(STORE, `${id}.json`), JSON.stringify({
    id, status: "open", title: `Card ${id}`, created_at: now(), urgency: "normal", ...extra,
  }));
}

function getJson(port, route) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: route }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };

  // The owner's kill switch is PRESENT for the whole run.
  fs.writeFileSync(path.join(STORE, ".popup-off"), "");
  // A queue the probe must outrank: 12 high-urgency reviews + an FYI digest.
  for (let i = 0; i < 12; i += 1) {
    writeCard(`d-review${i}`, { urgency: "high", created_at: now() - 3600 + i, options: [{ key: "ok", label: "OK" }] });
  }
  writeCard("d-digest", { kind: "info", urgency: "critical", created_at: now() - 7200 });

  const focused = [];
  app.on("browser-window-focus", (_e, w) => focused.push(w.getTitle()));
  let opened = [];
  let latest = [];
  let needsYou = [];
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const tray = new Tray(fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
  let menu = null;
  const chip = needsYouLib.createChip({ BrowserWindow, screen, onOpen: (id) => opened.push(id) });

  const stop = decisionCards.watch({
    dir: STORE,
    onChange: (cards) => {
      latest = cards;
      needsYou = decisionCards.partitionCards(cards).needsYou;
      menu = Menu.buildFromTemplate([...needsYouLib.trayRows(needsYou, (id) => opened.push(id)),
        { label: "Open the console" }]);
      tray.setContextMenu(menu);
      void chip.sync(needsYou);
    },
  });
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    // No daemon in a smoke: the local read, labelled stale -- the fallback path.
    decisionsProvider: () => decisionCards.bridgeQueue({
      fetchOpen: async () => { throw new Error("no daemon in the smoke"); },
      localOpen: () => latest,
    }),
    needsYouProvider: () => decisionCards.bridgeNeedsYou({
      fetchOpen: async () => { throw new Error("no daemon in the smoke"); },
      localOpen: () => latest,
    }),
  });
  const address = await bridge.listen();
  const port = address.port;
  await sleep(600);

  // 1. the probe lands
  const droppedAt = Date.now();
  writeCard(PROBE_ID, {
    kind: "credential", urgency: "normal", title: "Smoke probe credential",
    secret_name: PROBE_SECRET, credential_scope: "platform",
    credential_description: "A smoke probe; never stored",
    source: { agent: "needs-you-smoke", session_id: "smoke-0001", branch: "develop" },
  });
  let ny = null;
  while (Date.now() - droppedAt < 10_000) {
    ny = await getJson(port, "/needs-you");
    if (ny && ny.needs_you && ny.needs_you[0] && ny.needs_you[0].id === PROBE_ID) break;
    await sleep(250);
  }
  const elapsed = Date.now() - droppedAt;
  expect(`/needs-you[0] is the probe within 10 s (${elapsed} ms)`, ny && ny.needs_you[0] && ny.needs_you[0].id === PROBE_ID, ny);
  expect("/needs-you labels the local fallback stale", ny && ny.stale === true && ny.source === "local", ny && { source: ny.source, stale: ny.stale });
  const all = await getJson(port, "/decisions");
  expect("/decisions leads with the probe and counts the whole queue", all.decisions[0].id === PROBE_ID && all.count === 14, { first: all.decisions[0] && all.decisions[0].id, count: all.count });
  expect("tray item 0 names the secret", menu && menu.items[0] && menu.items[0].label.includes(PROBE_SECRET), menu && menu.items[0] && menu.items[0].label);
  await sleep(800); // the chip's load + showInactive
  const chipWin = chip.window();
  expect("the chip is on screen", chipWin && chipWin.isVisible(), chipWin ? "hidden" : "no chip");
  expect("the chip can never take focus", chipWin && chipWin.isFocusable() === false, null);
  expect("no window gained focus (.popup-off honoured)", focused.length === 0, focused);
  expect("nothing opened the Inbox by itself", opened.length === 0, opened);
  menu.items[0].click();
  expect("a tray click opens THAT card", opened[0] === PROBE_ID, opened);

  // 3. the built deck focuses the card it is told to show
  const dist = path.join(__dirname, "..", "dist", "index.html");
  if (!fs.existsSync(dist)) {
    console.log("FAIL the deck is not built (npm run build) -- cannot judge the focus");
    fails.push("deck not built");
  } else {
    const flipper = decisionCards.partitionCards(latest);
    const second = decisionCards.cardFromRaw({ id: "d-ownerprobe0", status: "open", kind: "credential", created_at: 1, secret_name: "FIRST" });
    const decisions = [second, ...latest];
    const state = {
      decisions, openCount: flipper.decisions.length + 1, totalCount: decisions.length,
      needsYouIds: [second.id, ...flipper.needsYou.map((c) => c.id)], fyiIds: flipper.fyi.map((c) => c.id),
      deskVisible: false, slots: [], agents: [], characters: [], characterModels: {}, activeCharacter: "",
      agentCharacters: {}, relay: [], relayChannel: "#agents", room: [], roomStatus: "smoke", wakes: null,
    };
    ipcMain.handle("desk:deck-get-state", () => state);
    for (const ch of ["system", "voice", "vision", "desktop", "connect"]) {
      ipcMain.handle(`desk:${ch}-snapshot`, () => ({ ok: false, reason: "smoke" }));
    }
    // The open card of the Needs-you list (redesign 2026-10-28: a list, not a pager).
    const current = async (w) => w.webContents.executeJavaScript(
      "(document.querySelector('[aria-label=\"Needs you\"]')||{dataset:{}}).dataset.currentCard || ''");
    const firstRow = async (w) => w.webContents.executeJavaScript(
      "(document.querySelector('[data-ny-id]')||{dataset:{}}).dataset.nyId || ''");
    const load = async (query, ready = current) => {
      const w = new BrowserWindow({ show: false, title: "deck-smoke", webPreferences: {
        preload: path.join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await w.loadURL(pathToFileURL(dist).href + query);
      for (let i = 0; i < 40 && !(await ready(w)); i += 1) await sleep(100);
      return w;
    };
    const deck = await load("?deck=1", firstRow);
    expect("the deck lists the needs-you cards first", (await firstRow(deck)) === second.id, await firstRow(deck));
    deck.webContents.send("desk:event", { type: "deck:focus-card", id: PROBE_ID });
    let shown = "";
    for (let i = 0; i < 30 && shown !== PROBE_ID; i += 1) { await sleep(100); shown = await current(deck); }
    expect("after openInbox(id) the deck's current card is the probe", shown === PROBE_ID, shown);
    const count = await deck.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"Needs you\"] .deck-section-count')?.textContent || ''");
    expect("the Needs-you count is decisions only (FYI collapsed)", count.trim() === String(state.openCount), count);
    const rowText = await deck.webContents.executeJavaScript("document.querySelector('.deck-card-credential')?.innerText || ''");
    expect("the credential row shows What/Why/Asked by/Goes to + Later + Not needed",
      ["What", "Why", "Asked by", "Goes to", "Later", "Not needed", PROBE_SECRET].every((t) => rowText.includes(t)), rowText);
    deck.destroy();
    const viaQuery = await load(`?deck=1&card=${PROBE_ID}`);
    expect("?card=<id> opens the deck on that card", (await current(viaQuery)) === PROBE_ID, await current(viaQuery));
    viaQuery.destroy();
  }

  stop();
  tray.destroy();
  bridge.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
});
