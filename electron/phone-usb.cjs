"use strict";

/**
 * phone-usb -- a phone on the USB cable, seen and linked through adb.
 *
 * Owner, 2026-10-29: "what about connecting phone to PC with USB and connecting / syncing
 * / launching the desktop on the PC, but through your phone?" With USB debugging allowed,
 * `adb devices -l` lists the phone; `adb reverse tcp:47937 tcp:<pc port>` makes the
 * phone's own 127.0.0.1:47937 reach this PC's phone-link server down the cable (no
 * network: offline and on another Wi-Fi alike); `am start` opens the Aither app on the
 * link screen. That is ALL this module ever asks adb for: adbArgv() builds exactly four
 * argv shapes and throws on anything else, so no caller can reach `adb shell <anything>`.
 *
 * Every spawn is execFile with windowsHide (CREATE_NO_WINDOW): no console flashes.
 * A pulled cable drops the phone from `adb devices`; the watcher reports it gone and the
 * caller closes that phone's server (the reverse dies with the transport anyway).
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** The port the PHONE dials (its own loopback). Pinned in the app: DeskLink.PORT. */
const PHONE_PORT = 47937;
const APP_COMPONENT = "com.aitherium.aither/.MainActivity";
const LINK_URL = "https://app.aitherium.com/?app=control&tab=pc";
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
/** Single-quoted on the device's sh, so only characters that need no escaping. */
const SAFE_URL = /^https:\/\/app\.aitherium\.com\/[A-Za-z0-9/?=&._-]{0,200}$/;
const POLL_MS = 3000;
const MISSING_RECHECK_MS = 60_000;

/** adb: AWDESK_ADB_BIN, the Android SDK, the WinGet platform-tools package, else PATH. */
function resolveAdb(env = process.env, exists = fs.existsSync, readdir = fs.readdirSync) {
  if (env.AWDESK_ADB_BIN) return env.AWDESK_ADB_BIN;
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (root && exists(path.join(root, "platform-tools", exe))) return path.join(root, "platform-tools", exe);
  }
  if (env.LOCALAPPDATA) {
    const pkgs = path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    try {
      for (const name of readdir(pkgs)) {
        if (!name.startsWith("Google.PlatformTools")) continue;
        const p = path.join(pkgs, name, "platform-tools", exe);
        if (exists(p)) return p;
      }
    } catch { /* no WinGet packages folder */ }
  }
  return "adb";
}

/**
 * The only adb argv this desk runs. kind: devices | reverse | unreverse | launch.
 * Throws on any other kind, a bad serial, a bad port or a URL outside app.aitherium.com.
 */
function adbArgv(kind, { serial = "", pcPort = 0, url = LINK_URL } = {}) {
  if (kind === "devices") return ["devices", "-l"];
  if (!SERIAL.test(String(serial))) throw new Error("bad serial");
  if (kind === "reverse") {
    if (!Number.isInteger(pcPort) || pcPort < 1024 || pcPort > 65535) throw new Error("bad port");
    return ["-s", serial, "reverse", `tcp:${PHONE_PORT}`, `tcp:${pcPort}`];
  }
  if (kind === "unreverse") return ["-s", serial, "reverse", "--remove", `tcp:${PHONE_PORT}`];
  if (kind === "launch") {
    if (!SAFE_URL.test(String(url))) throw new Error("bad url");
    // adb joins shell args into ONE device command line: the URL is single-quoted there.
    return ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW",
      "-n", APP_COMPONENT, "-d", `'${url}'`];
  }
  throw new Error(`adb ${kind} is not allowed`);
}

/** A phone on a USB cable. Wi-Fi debugging (host:port, mDNS) and emulators are not. */
function isUsbSerial(serial, { allowEmulator = false } = {}) {
  if (!SERIAL.test(serial)) return false;
  if (/^emulator-\d+$/.test(serial)) return allowEmulator;
  if (/:\d+$/.test(serial) || serial.includes("._adb-tls-") || serial.includes("_adb._tcp")) return false;
  return true;
}

/**
 * `adb devices -l` -> [{serial, state, model}] for USB phones. state is adb's word:
 * device (debugging allowed), unauthorized (the phone is asking), offline, ...
 */
function parseDevices(text, opts = {}) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    if (!serial || !state || serial === "List" || serial.startsWith("*")) continue;
    if (!isUsbSerial(serial, opts)) continue;
    const model = /(?:^|\s)model:(\S+)/.exec(rest.join(" "));
    out.push({
      serial,
      state: state === "no" ? "no-permissions" : state,
      model: model ? model[1].replace(/_/g, " ").replace(/[^\w .-]/g, "").slice(0, 40) : "Android phone",
    });
  }
  return out;
}

function run(execFileImpl, bin, argv, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFileImpl(bin, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, error, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

/**
 * Watch the cable. onChange({added, removed, phones}) fires when the set of USB phones
 * (or one's state) changes. Returns {stop, phones, reverse, unreverse, launch}.
 */
function createPhoneUsb({ execFileImpl = execFile, bin = resolveAdb(), env = process.env,
  onChange = () => {}, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, pollMs = POLL_MS } = {}) {
  const allowEmulator = env.AWDESK_PHONE_ALLOW_EMULATOR === "1";
  let phones = new Map();
  let timer = null;
  let stopped = false;
  let adbMissing = false;

  const adb = (kind, opts) => run(execFileImpl, bin, adbArgv(kind, opts));

  async function pollOnce() {
    const r = await adb("devices");
    if (!r.ok) {
      adbMissing = Boolean(r.error && r.error.code === "ENOENT");
      if (phones.size) {
        const removed = [...phones.values()];
        phones = new Map();
        onChange({ added: [], removed, phones: [] });
      }
      return;
    }
    adbMissing = false;
    const next = new Map(parseDevices(r.stdout, { allowEmulator }).map((p) => [p.serial, p]));
    const added = [...next.values()].filter((p) => {
      const was = phones.get(p.serial);
      return !was || was.state !== p.state;
    });
    const removed = [...phones.values()].filter((p) => !next.has(p.serial));
    phones = next;
    if (added.length || removed.length) onChange({ added, removed, phones: [...next.values()] });
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeoutImpl(async () => {
      try { await pollOnce(); } catch { /* next tick */ }
      schedule();
    }, adbMissing ? MISSING_RECHECK_MS : pollMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  return {
    pollOnce,
    start() { stopped = false; schedule(); },
    stop() { stopped = true; if (timer) clearTimeoutImpl(timer); },
    phones: () => [...phones.values()],
    adbMissing: () => adbMissing,
    reverse: (serial, pcPort) => adb("reverse", { serial, pcPort }),
    unreverse: (serial) => adb("unreverse", { serial }),
    launch: (serial, url = LINK_URL) => adb("launch", { serial, url }),
  };
}

module.exports = {
  APP_COMPONENT, LINK_URL, PHONE_PORT, adbArgv, createPhoneUsb, isUsbSerial, parseDevices, resolveAdb,
};
