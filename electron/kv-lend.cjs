"use strict";

/**
 * kv-lend — "Lend memory": this computer holds part of the owner's model context.
 *
 * The engine is holder.js, the same code the phone page and the Android app run, loaded in a
 * hidden window (WebGPU when the GPU allows it, else the CPU engine). It dials the workspace
 * relay OUTBOUND (wss://kv.aitherium.com/holder) and signs each dial with this computer's
 * device key (device-identity.cjs), so nothing listens on this machine and no token is
 * copied. Whether the relay accepts it is the owner's decision there (household kv_lend /
 * the relay's allow-list); this module decides only WHEN this computer offers: by default on
 * AC power and while the user is idle, never while a game runs.
 *
 * Policy is a pure function (`shouldLend`) so it is tested without Electron.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_RELAY = "wss://kv.aitherium.com/holder";
const DEFAULTS = Object.freeze({ enabled: true, maxMb: 2048, onlyOnAc: true, onlyIdle: true, gpu: "high-performance" });
// which GPU lends (holder.js resolvePower): the fast one, the integrated one, or the
// integrated one only while the laptop runs on battery
const GPU_CHOICES = Object.freeze(["high-performance", "low-power", "battery"]);
const MB_CHOICES = Object.freeze([512, 1024, 2048, 4096, 8192, 16384]);

/** "" = lend now; otherwise the reason it does not. */
function whyNot(settings, { enrolled, onBattery, idle, gaming }) {
  if (!settings.enabled) return "off (Lend memory is switched off)";
  if (!enrolled) return "this computer is not connected to your workspace yet";
  if (gaming) return "waiting: a game is running";
  if (settings.onlyOnAc && onBattery) return "waiting: on battery";
  if (settings.onlyIdle && !idle) return "waiting: in use";
  return "";
}

function shouldLend(settings, env) {
  return whyNot(settings, env) === "";
}

function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  s.enabled = s.enabled !== false;
  s.onlyOnAc = s.onlyOnAc !== false;
  s.onlyIdle = s.onlyIdle !== false;
  const mb = Number(s.maxMb);
  s.maxMb = MB_CHOICES.includes(mb) ? mb : DEFAULTS.maxMb;
  if (!GPU_CHOICES.includes(s.gpu)) s.gpu = DEFAULTS.gpu;
  return s;
}

/** holder.js is VENDORED at electron/kvholder/holder.js (the public awdesk mirror carries
 *  only this tree); kv-lend.test.cjs fails when it drifts from awdk's copy. */
function holderJsPath({ here = __dirname } = {}) {
  return path.join(here, "kvholder", "holder.js");
}

class KvLend {
  /**
   * @param {object} deps
   *   identity        DeviceIdentity
   *   settingsFile    path to kv-lend.json
   *   makeWindow      () => BrowserWindow-like (hidden, preload kv-lend-preload.cjs)
   *   probe           () => {onBattery, idle, gaming}
   *   relay           wss URL
   */
  constructor({ identity, settingsFile, makeWindow, probe, relay = DEFAULT_RELAY, log = () => {} }) {
    this.identity = identity;
    this.settingsFile = settingsFile;
    this.makeWindow = makeWindow;
    this.probe = probe;
    this.relay = relay;
    this.log = log;
    this.win = null;
    this.status = {};
    this.reason = "starting";
  }

  settings() {
    try {
      return normalize(JSON.parse(fs.readFileSync(this.settingsFile, "utf8")));
    } catch {
      return normalize(null);
    }
  }

  setSettings(patch) {
    const next = normalize({ ...this.settings(), ...patch });
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(next, null, 1));
    this.evaluate();
    return next;
  }

  /** What the page needs: the relay, this device and how much to lend. No secrets. */
  pageConfig() {
    const st = this.identity.enrolled() || {};
    const s = this.settings();
    return { relay: this.relay, deviceId: st.deviceId || "", mb: s.maxMb, gpu: s.gpu };
  }

  /** Called by the page for each dial: a fresh signature, made here; the key stays in main. */
  hello() {
    return this.identity.hello(new URL(this.relay.replace(/^wss:/, "https:")).hostname);
  }

  evaluate() {
    const env = { enrolled: !!this.identity.enrolled(), ...this.probe() };
    const why = whyNot(this.settings(), env);
    if (why === "" && !this.win) {
      this.win = this.makeWindow();
      this.reason = "lending";
      this.log("kv-lend: lending");
    } else if (why !== "" && this.win) {
      try {
        this.win.destroy();
      } catch {
        /* already gone */
      }
      this.win = null;
      this.status = {};
      this.log(`kv-lend: stopped (${why})`);
    }
    if (why !== "") this.reason = why;
    return why;
  }

  onStatus(st) {
    const prev = this.status || {};
    this.status = st && typeof st === "object" ? st : {};
    const attachedNow = this.status.state === "attached" && prev.state !== "attached";
    if (attachedNow || (this.status.error || "") !== (prev.error || "")) {
      this.log(`kv-lend: ${this.status.state || "?"}` + (this.status.engine ? ` (${this.status.engine})` : "") +
        (this.status.error ? ` - ${this.status.error}` : ""));
    }
    if (this.status.error && /allowed|lending for this|another relay|workspace/.test(this.status.error)) {
      this.reason = `the owner has not let this computer lend yet (${this.status.error})`;
    } else if (this.win) {
      this.reason = "lending";
    }
  }

  /** One line for the tray / Devices panel. */
  summary() {
    const s = this.settings();
    if (!this.win) return `Lend memory: ${this.reason}`;
    const st = this.status;
    const link = st.state === "attached" ? "attached" : st.state || "connecting";
    return `Lend memory: ${link}, up to ${s.maxMb >= 1024 ? s.maxMb / 1024 + " GB" : s.maxMb + " MB"}` +
      (st.engine ? ` (${st.engine})` : "") + (this.reason !== "lending" ? ` - ${this.reason}` : "");
  }
}

module.exports = { DEFAULTS, DEFAULT_RELAY, GPU_CHOICES, KvLend, MB_CHOICES, holderJsPath, normalize, shouldLend, whyNot };
