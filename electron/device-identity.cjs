"use strict";

/**
 * device-identity — this computer as a device of the owner's workspace, with no terminal.
 *
 * The owner clicks "Connect this device" on aitherium.com, which mints a single-use identity
 * pairing code (POST /v1/nodes/pairing/init, 5 minutes) and hands Desk a link:
 *
 *   desk://enroll?c=<code>&d=<device id>&i=https://idp.aitherium.com
 *
 * Desk then makes an Ed25519 key that never leaves this machine and confirms the code
 * (POST /v1/nodes/pairing/confirm) with the public half as `seal_pubkey`. That record is the
 * device: the KV relay verifies every hello against it, and removing the device in the
 * owner's Devices view revokes it. The same signed hello as adk.kvholder_workspace
 * (`aither-kvholder-hello/1`) is produced here, so a Python, Android and Desk holder are
 * interchangeable.
 *
 * Nothing secret is logged. The private key and the register response live in Desk's
 * user-data folder, readable by this OS user only.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HELLO_DOMAIN = "aither-kvholder-hello/1";
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const CODE = /^[A-Z0-9]{4,16}$/;

/** Identity hosts a link may point at: a link from anywhere else is refused, so a crafted
 *  desk:// link cannot make Desk register its key with someone else's identity service. */
function identityAllowed(url, env = process.env) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const extra = String(env.AITHER_ENROLL_BASE || "").replace(/\/+$/, "");
  if (extra && url.replace(/\/+$/, "") === extra) return true;
  return u.protocol === "https:" && (u.hostname === "aitherium.com" || u.hostname.endsWith(".aitherium.com"));
}

/** `desk://enroll?...` -> {code, deviceId, identity} or null. */
function parseEnrollUrl(raw, env = process.env) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const action = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action !== "enroll") return null;
  const code = String(u.searchParams.get("c") || "").trim().toUpperCase();
  const identity = String(u.searchParams.get("i") || "https://idp.aitherium.com").replace(/\/+$/, "");
  let deviceId = String(u.searchParams.get("d") || "").trim();
  if (!deviceId) deviceId = defaultDeviceId();
  if (!CODE.test(code) || !DEVICE_ID.test(deviceId) || !identityAllowed(identity, env)) return null;
  return { code, deviceId, identity };
}

function defaultDeviceId() {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "pc";
  return `desk-${host}-${nodeCrypto.randomBytes(2).toString("hex")}`;
}

class DeviceIdentity {
  constructor(dir) {
    this.dir = dir;
    this.keyFile = path.join(dir, "ed25519.pem");
    this.stateFile = path.join(dir, "device.json");
  }

  _write(file, text) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** The device key, made once. */
  key() {
    if (!this._key) {
      let pem;
      try {
        pem = fs.readFileSync(this.keyFile, "utf8");
      } catch {
        const { privateKey } = nodeCrypto.generateKeyPairSync("ed25519");
        pem = privateKey.export({ type: "pkcs8", format: "pem" });
        this._write(this.keyFile, pem);
      }
      this._key = nodeCrypto.createPrivateKey(pem);
    }
    return this._key;
  }

  publicHex() {
    const der = nodeCrypto.createPublicKey(this.key()).export({ type: "spki", format: "der" });
    return der.subarray(der.length - 32).toString("hex");
  }

  state() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return null;
    }
  }

  enrolled() {
    const st = this.state();
    return st && st.deviceId ? st : null;
  }

  /** Confirm the owner's pairing code. Returns {ok, deviceId} or {ok:false, status, error}. */
  async enroll({ code, deviceId, identity }, { fetchImpl = globalThis.fetch } = {}) {
    const body = {
      code,
      node_id: deviceId,
      hostname: deviceId,
      platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
      node_class: "laptop",
      seal_pubkey: this.publicHex(),
      cpu_count: os.cpus().length,
      ram_mb: Math.round(os.totalmem() / 1048576),
      capabilities: ["kvholder"],
    };
    let res;
    try {
      res = await fetchImpl(`${identity}/v1/nodes/pairing/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Aither Desktop)" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, status: 0, error: `identity unreachable: ${e && e.message ? e.message : e}` };
    }
    const text = await res.text();
    if (res.status !== 200) {
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    let reg;
    try {
      reg = JSON.parse(text);
    } catch {
      reg = {};
    }
    // keep what later steps need (the command channel key among it); never log it
    this._write(this.stateFile, JSON.stringify({
      deviceId,
      identity,
      enrolledAt: Date.now(),
      publicKey: this.publicHex(),
      register: reg,
    }));
    return { ok: true, deviceId };
  }

  /** The signed fields a holder adds to its hello (adk.kvholder_workspace.sign_hello). */
  hello(relayHost, deviceId = (this.enrolled() || {}).deviceId) {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = nodeCrypto.randomBytes(12).toString("base64url");
    const relay = String(relayHost).toLowerCase();
    const msg = Buffer.from([HELLO_DOMAIN, relay, deviceId, String(ts), nonce].join("\n"));
    const sig = nodeCrypto.sign(null, msg, this.key()).toString("base64");
    return { auth: "device", device_id: deviceId, relay, ts, nonce, sig };
  }
}

module.exports = { DeviceIdentity, HELLO_DOMAIN, defaultDeviceId, identityAllowed, parseEnrollUrl };
