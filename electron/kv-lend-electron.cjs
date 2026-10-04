"use strict";

/**
 * Wires device enrollment and "Lend memory" into Desk's main process. Kept apart from
 * main.cjs so main gains three lines: start it, route desk://enroll to it, show its summary.
 */

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DeviceIdentity, defaultDeviceId, parseEnrollUrl } = require("./device-identity.cjs");
const { steamGameRunning } = require("./linux-integration.cjs");
const { KvLend, holderJsPath } = require("./kv-lend.cjs");

const IDLE_S = 300; // "idle": no input for 5 minutes

/**
 * @param external  optional (settings) => ChildProcess|null: run the engine in a separate
 *                  process instead of a hidden window here (lendProcessSpawner); null = here.
 * @param dataDir   where the device key and kv-lend.json live (default: userData)
 */
function startKvLend({ app, BrowserWindow, ipcMain, powerMonitor, notify = () => {}, log = console.log,
  external = null, dataDir = app.getPath("userData"), probeOverride = null, onEnrolled = () => {} }) {
  const dir = path.join(dataDir, "device");
  const identity = new DeviceIdentity(dir);
  const engineJs = holderJsPath();
  const pageJs = path.join(__dirname, "kv-lend-page.js");

  const makeWindow = () => {
    const child = external ? external(lend.settings()) : null;
    if (child) {
      // the engine in its own process: its status lines come back on stdout
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith("KVLEND ")) {
            try { lend.onStatus(JSON.parse(line.slice(7))); } catch { /* partial line */ }
          }
        }
      });
      child.on("exit", (code) => log(`kv-lend: engine process exited (${code})`));
      return { destroy: () => child.kill(), webContents: null };
    }
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
  const probe = probeOverride || (() => ({
    onBattery: !!(powerMonitor.isOnBatteryPower && powerMonitor.isOnBatteryPower()),
    idle: powerMonitor.getSystemIdleTime() >= IDLE_S,
    gaming: fs.existsSync(gamingLock) || (process.platform === "linux" && steamGameRunning()),
  }));

  const lend = new KvLend({
    identity,
    settingsFile: path.join(dataDir, "kv-lend.json"),
    makeWindow,
    probe,
    log,
  });

  const fromPage = (event) => lend.win && lend.win.webContents && event.sender === lend.win.webContents;
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
    await enroll(req);
    return true;
  }

  /** A code typed into "Connect this computer" (device-connect.cjs). */
  function enrollCode(code) {
    return enroll({ code, deviceId: defaultDeviceId(), identity: "https://idp.aitherium.com" });
  }

  async function enroll(req) {
    const r = await identity.enroll(req);
    if (r.ok) {
      log(`kv-lend: enrolled as ${r.deviceId}`);
      notify("This computer is connected", `It joined your workspace as ${r.deviceId}.`);
      try { onEnrolled(r); } catch (e) { log(`kv-lend: after-connect step failed: ${e && e.message}`); }
    } else {
      log(`kv-lend: enrollment refused (${r.status})`);
      notify("Could not connect this computer",
        r.status === 400 ? "The link expired. Open Connect this device again." : `Identity said ${r.status}.`);
    }
    lend.evaluate();
    return r;
  }

  return { identity, lend, enrollFromUrl, enrollCode };
}

const LEND_PROCESS_ARG = "--kv-lend-process=";
const DISCRETE = "GpuPreference=2;";
const PREF_KEY = ["HKCU", "Software", "Microsoft", "DirectX", "UserGpuPreferences"].join(String.fromCharCode(92));

/**
 * Windows pins Desk.exe to the integrated GPU (present-policy.cjs: presenting on the dGPU stalls
 * the avatar), and Windows applies that per EXECUTABLE PATH, so no Chromium switch moves WebGPU
 * off it (measured 2026-10-03: force_high_performance_gpu and use-webgpu-power-preference both
 * still gave the AMD iGPU). The lender therefore runs as a second process from a hard link of
 * the same executable ("Desk Lend.exe", no copy, same folder) that Windows lets use the
 * discrete GPU. It draws nothing on screen, so the stall that pinned Desk does not apply.
 */
function lendProcessSpawner({ app, dataDir, log = console.log }) {
  const exe = process.execPath;
  const link = path.join(path.dirname(exe), "Desk Lend" + path.extname(exe));
  return (settings) => {
    if (settings && settings.gpu === "low-power") return null; // the integrated GPU: stay in-process
    try {
      if (!fs.existsSync(link)) fs.linkSync(exe, link);
    } catch (e) {
      log(`kv-lend: no lend executable (${e.message}); using the integrated GPU`);
    }
    const bin = fs.existsSync(link) ? link : exe;
    if (bin === link) {
      execFile("reg", ["add", PREF_KEY, "/v", link, "/t", "REG_SZ", "/d", DISCRETE, "/f"],
        { windowsHide: true }, () => {});
    }
    const args = app.isPackaged ? [] : [app.getAppPath()];
    args.push(LEND_PROCESS_ARG + dataDir);
    return spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  };
}

/** True when this process is the lender started by lendProcessSpawner. */
function isLendProcess(argv = process.argv) {
  return argv.some((a) => a.startsWith(LEND_PROCESS_ARG));
}

/** The lender's whole life: the engine window, always on (the parent decides when), status
 *  lines on stdout, gone with its parent. */
function runLendProcess({ app, BrowserWindow, ipcMain, powerMonitor }) {
  const dataDir = process.argv.find((a) => a.startsWith(LEND_PROCESS_ARG)).slice(LEND_PROCESS_ARG.length);
  app.setPath("userData", path.join(dataDir, "lend-process"));
  app.on("window-all-closed", (e) => e.preventDefault());
  app.whenReady().then(() => {
    const rt = startKvLend({
      app, BrowserWindow, ipcMain, powerMonitor, dataDir,
      probeOverride: () => ({ onBattery: false, idle: true, gaming: false }),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    rt.lend.setSettings = () => rt.lend.settings(); // settings belong to the parent
    const report = rt.lend.onStatus.bind(rt.lend);
    rt.lend.onStatus = (st) => {
      report(st);
      process.stdout.write(`KVLEND ${JSON.stringify(st)}\n`);
    };
    rt.lend.evaluate();
  });
  const ppid = process.ppid;
  setInterval(() => {
    try { process.kill(ppid, 0); } catch { app.exit(0); } // the parent is gone
  }, 5000).unref?.();
}

module.exports = { IDLE_S, isLendProcess, lendProcessSpawner, runLendProcess, startKvLend };
