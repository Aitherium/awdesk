"use strict";

/**
 * Wires device enrollment and "Lend memory" into Desk's main process. Kept apart from
 * main.cjs so main gains three lines: start it, route desk://enroll to it, show its summary.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DeviceIdentity, parseEnrollUrl } = require("./device-identity.cjs");
const { KvLend, holderJsPath } = require("./kv-lend.cjs");

const IDLE_S = 300; // "idle": no input for 5 minutes

function startKvLend({ app, BrowserWindow, ipcMain, powerMonitor, notify = () => {}, log = console.log }) {
  const dir = path.join(app.getPath("userData"), "device");
  const identity = new DeviceIdentity(dir);
  const engineJs = holderJsPath();
  const pageJs = path.join(__dirname, "kv-lend-page.js");

  const makeWindow = () => {
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: {
        preload: path.join(__dirname, "kv-lend-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false, // hidden on purpose: its socket must keep answering
      },
    });
    win.webContents.on("did-finish-load", () => {
      let js;
      try {
        js = [engineJs, pageJs].map((f) => fs.readFileSync(f, "utf8")).join("\n;\n");
      } catch (e) {
        log(`kv-lend: engine missing (${e.message}); not lending`);
        return;
      }
      win.webContents.executeJavaScript(js).catch((e) => log(`kv-lend: page failed: ${e.message}`));
    });
    win.loadFile(path.join(__dirname, "kv-lend.html"));
    return win;
  };

  const gamingLock = path.join(os.homedir(), ".aither", "gaming.lock");
  const probe = () => ({
    onBattery: !!(powerMonitor.isOnBatteryPower && powerMonitor.isOnBatteryPower()),
    idle: powerMonitor.getSystemIdleTime() >= IDLE_S,
    gaming: fs.existsSync(gamingLock),
  });

  const lend = new KvLend({
    identity,
    settingsFile: path.join(app.getPath("userData"), "kv-lend.json"),
    makeWindow,
    probe,
    log,
  });

  const fromPage = (event) => lend.win && event.sender === lend.win.webContents;
  ipcMain.handle("kvlend:config", (event) => (fromPage(event) ? lend.pageConfig() : null));
  ipcMain.handle("kvlend:hello", (event) => (fromPage(event) ? lend.hello() : null));
  ipcMain.on("kvlend:status", (event, st) => {
    if (fromPage(event)) lend.onStatus(st);
  });

  for (const ev of ["on-ac", "on-battery", "lock-screen", "unlock-screen", "resume"]) {
    powerMonitor.on(ev, () => lend.evaluate());
  }
  const timer = setInterval(() => lend.evaluate(), 30_000);
  timer.unref?.();
  lend.evaluate();

  /** desk://enroll?c=&d=&i= -> confirm the owner's code; true when the URL was an enroll link. */
  async function enrollFromUrl(raw) {
    const req = parseEnrollUrl(raw);
    if (!req) return false;
    const r = await identity.enroll(req);
    if (r.ok) {
      log(`kv-lend: enrolled as ${r.deviceId}`);
      notify("This computer is connected", `It joined your workspace as ${r.deviceId}.`);
    } else {
      log(`kv-lend: enrollment refused (${r.status})`);
      notify("Could not connect this computer",
        r.status === 400 ? "The link expired. Open Connect this device again." : `Identity said ${r.status}.`);
    }
    lend.evaluate();
    return true;
  }

  return { identity, lend, enrollFromUrl };
}

module.exports = { IDLE_S, startKvLend };
