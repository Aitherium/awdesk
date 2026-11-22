"use strict";

/**
 * phone-link -- the phone on the USB cable drives this desk, through a short allowlist.
 *
 * phone-usb.cjs reverses the phone's 127.0.0.1:47937 onto ONE server per cable (port 0,
 * 127.0.0.1 only), so a request on that server came down that cable and no other. Pull the
 * cable and the server is closed: the link dies with it. There is no mesh path.
 *
 * Trust is the one the workspace already has, never a new token:
 *  - every request carries the phone's signed hello (`aither-kvholder-hello/1`, the same
 *    bytes adk.kvholder_workspace.hello_message signs) in X-Aither-Device-Hello, with
 *    relay = `desk-link:<this desk's device id>` so a hello for this desk is useless at
 *    any relay or any other desk; a fresh ts (120 s) and a nonce seen once stop replays;
 *  - the key is the phone's Identity seal key (`adk devices status <id> --json`, the
 *    owner's own device record). A device Identity does not know is refused;
 *  - the owner approves the phone ON THE PC once; its key is then pinned here, so the
 *    link works offline. A device removed in the owner's Devices view is unpinned at its
 *    next check (when Identity answers 404); "Forget this phone" on either side unpins it.
 *
 * What the phone may ask for is ACTIONS below: each maps to a handler main.cjs injects
 * (the same ones the loopback bridge runs). An action not in the list is a 403; nothing
 * here runs a command line.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HELLO_DOMAIN = "aither-kvholder-hello/1";
const CLOCK_SKEW_S = 120;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,96}$/;
const PUB_HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const MAX_BODY = 64 * 1024;
const MAX_FILE_BODY = 24 * 1024 * 1024;
const RECHECK_MS = 10 * 60_000;
const LOOKUP_TTL_MS = 60_000;
/** The desk link on the tailnet (the phone's cable port + 1). */
const MESH_PORT = 47938;
/** A mesh/remote session with no call for this long must say hello again. */
const IDLE_MS = 15 * 60_000;

/** What a linked phone may do. The handler for each comes from main.cjs. */
const ACTIONS = Object.freeze(new Set([
  "state",
  "desktop.show", "desktop.hide",
  "console.open",
  "tab.list", "tab.show", "tab.open",
  "terminal.list", "terminal.read", "terminal.input", "terminal.show",
  "agent.send", "agent.history",
  "command.list", "command.run",
  "clipboard.get", "clipboard.set",
  "file.send", "file.list", "file.get",
]));

function audienceOf(deskId) {
  return `desk-link:${deskId}`.toLowerCase();
}

function helloMessage(relay, deviceId, ts, nonce) {
  return Buffer.from([HELLO_DOMAIN, String(relay).toLowerCase(), deviceId, String(ts), nonce].join("\n"));
}

function verifySig(pubHex, msg, sigB64) {
  if (!PUB_HEX.test(pubHex)) return false;
  try {
    const key = nodeCrypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(pubHex, "hex")]), format: "der", type: "spki",
    });
    return nodeCrypto.verify(null, msg, key, Buffer.from(String(sigB64), "base64"));
  } catch {
    return false;
  }
}

/** The X-Aither-Device-Hello header -> the hello object, or null. */
function parseHelloHeader(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const h = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!h || typeof h !== "object" || h.auth !== "device") return null;
    if (!DEVICE_ID.test(String(h.device_id || "")) || !NONCE.test(String(h.nonce || ""))) return null;
    if (!Number.isInteger(h.ts) || typeof h.sig !== "string" || typeof h.relay !== "string") return null;
    return h;
  } catch {
    return null;
  }
}

/** The phones the owner approved: {deviceId: {pub, model, approvedAt}}, mode 600. */
class PinStore {
  constructor(file) { this.file = file; }
  all() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return d && typeof d === "object" && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  }
  get(id) { return this.all()[id] || null; }
  _save(d) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  pin(id, row) { const d = this.all(); d[id] = row; this._save(d); }
  unpin(id) { const d = this.all(); const had = Boolean(d[id]); delete d[id]; if (had) this._save(d); return had; }
}

/** A file name from a phone: one plain segment, no path, no device names. */
function safeFileName(name) {
  const base = String(name || "").replace(/[\\/]/g, "_").replace(/[<>:"|?*\x00-\x1f]/g, "_").trim().slice(0, 120);
  if (!base || base === "." || base === ".." || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) return null;
  return base.replace(/^\.+/, "_");
}

/** Phone -> PC and PC -> phone files: an inbox the phone writes and an outbox it reads. */
function createFileShelf({ inbox, outbox }) {
  return {
    send({ name, data } = {}) {
      const n = safeFileName(name);
      if (!n) return { ok: false, error: "bad file name" };
      if (typeof data !== "string" || !data) return { ok: false, error: "empty file" };
      const bytes = Buffer.from(data, "base64");
      fs.mkdirSync(inbox, { recursive: true });
      const ext = path.extname(n);
      const stem = n.slice(0, n.length - ext.length);
      let target = path.join(inbox, n);
      for (let i = 1; fs.existsSync(target) && i < 1000; i += 1) target = path.join(inbox, `${stem} (${i})${ext}`);
      fs.writeFileSync(target, bytes, { flag: "wx" });
      return { ok: true, saved: path.basename(target), bytes: bytes.length, folder: inbox };
    },
    list() {
      let names = [];
      try { names = fs.readdirSync(outbox, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { /* none yet */ }
      return { ok: true, folder: outbox, files: names.slice(0, 200).map((n) => ({ name: n, bytes: fs.statSync(path.join(outbox, n)).size })) };
    },
    get({ name } = {}) {
      // only a name the outbox lists: never a path the phone composed
      const listed = this.list().files.find((f) => f.name === name);
      if (!listed) return { ok: false, error: "no such file in the outbox" };
      if (listed.bytes > MAX_FILE_BODY * 0.7) return { ok: false, error: "file too large for the cable link (16 MB)" };
      return { ok: true, name: listed.name, data: fs.readFileSync(path.join(outbox, listed.name)).toString("base64") };
    },
  };
}

/**
 * The link. enrollment(deviceId) -> {status: "enrolled", pub} | {status: "removed"} |
 * {status: "unknown", error}; approve({deviceId, model}) -> Promise<boolean> (the PC
 * dialog); actions: {name: async (args) => result}.
 */
function createPhoneLink({ dataDir, deskId, deskName = "", enrollment, approve, actions = {},
  onChange = () => {}, now = () => Date.now(), listenHost = "127.0.0.1" }) {
  const pins = new PinStore(path.join(dataDir, "phone-link", "phones.json"));
  const nonces = new Map();
  const servers = new Map(); // serial -> {server, port, model, deviceId}
  const pending = new Map(); // deviceId -> Promise
  const refused = new Set(); // `${serial}|${deviceId}`: "Not now" holds for this cable session
  const checkedAt = new Map();
  const lookups = new Map(); // unpinned deviceId -> {e, at}
  const sessions = new Map(); // mesh/remote: deviceId -> {at, transport}
  let mesh = null; // {server, host, port}

  function rememberNonce(n) {
    const t = now();
    for (const [k, exp] of nonces) if (exp < t) nonces.delete(k);
    if (nonces.has(n)) return false;
    nonces.set(n, t + 2 * CLOCK_SKEW_S * 1000);
    return true;
  }

  /** Who signed this request: {deviceId, pinned} or {error, status}. */
  async function authenticate(header) {
    const h = parseHelloHeader(header);
    if (!h) return { status: 401, error: "a signed device hello is required" };
    if (String(h.relay).toLowerCase() !== audienceOf(deskId())) return { status: 401, error: "hello is for another desk" };
    if (Math.abs(now() / 1000 - h.ts) > CLOCK_SKEW_S) return { status: 401, error: "phone clock is off (or the hello is old)" };
    const id = h.device_id;
    const pinned = pins.get(id);
    let pub = pinned ? pinned.pub : "";
    const due = !pinned || now() - (checkedAt.get(id) || 0) > RECHECK_MS;
    if (due) {
      // the unsigned header names the device, so an unpinned id's Identity answer is cached
      // (60 s, 32 ids): a phone app spraying made-up ids cannot spawn adk per request
      const hit = !pinned && lookups.get(id);
      const e = hit && now() - hit.at < LOOKUP_TTL_MS ? hit.e : await enrollment(id);
      if (!pinned && !(hit && hit.e === e)) {
        if (lookups.size >= 32) lookups.delete(lookups.keys().next().value);
        lookups.set(id, { e, at: now() });
      }
      checkedAt.set(id, now());
      if (e.status === "removed") {
        if (pins.unpin(id)) onChange();
        return { status: 403, error: "this phone was removed from the workspace" };
      }
      if (e.status === "enrolled") {
        if (pinned && pinned.pub !== e.pub) {
          // re-enrolled with a new key: the owner approves the new key again
          pins.unpin(id);
          onChange();
        }
        pub = e.pub;
      } else if (!pinned) {
        return { status: 403, error: `cannot confirm this phone is enrolled (${e.error || "identity unreachable"}); link it once while online` };
      }
    }
    if (!verifySig(pub, helloMessage(h.relay, id, h.ts, h.nonce), h.sig)) return { status: 401, error: "bad device signature" };
    if (!rememberNonce(h.nonce)) return { status: 401, error: "replayed hello" };
    const still = pins.get(id);
    return { deviceId: id, pub, pinned: Boolean(still && still.pub === pub) };
  }

  function ask(serial, deviceId, pub, model) {
    if (pending.has(deviceId)) return;
    const p = Promise.resolve()
      .then(() => approve({ deviceId, model }))
      .then((yes) => {
        if (yes) pins.pin(deviceId, { pub, model, approvedAt: new Date(now()).toISOString() });
        else refused.add(`${serial}|${deviceId}`);
      })
      .catch(() => refused.add(`${serial}|${deviceId}`))
      .finally(() => { pending.delete(deviceId); onChange(); });
    pending.set(deviceId, p);
  }

  /**
   * One request on any transport. ctx.kind "cable" (ctx.serial: this USB phone's server)
   * or "mesh" (the desk's tailnet listener; the Aither tunnel proxies onto it and says
   * so with x-aither-via: tunnel, which only changes the label). The rules differ in two
   * places: only the cable may ASK the owner for a new phone, and a mesh/remote session
   * idles out after IDLE_MS without a call.
   */
  async function handle(ctx, req, res) {
    const transport = ctx.kind === "cable" ? "cable" : req.headers["x-aither-via"] === "tunnel" ? "remote" : "mesh";
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-aither-transport": transport });
      res.end(JSON.stringify(body));
    };
    // The app's native bridge sends no Origin. A web page on the phone that found this
    // port does: it gets nothing, not even /link/info.
    if (req.headers.origin) return send(403, { error: "browser pages cannot use the desk link" });
    const route = String(req.url || "").split("?")[0];
    const entry = ctx.kind === "cable" ? servers.get(ctx.serial) : null;
    if (req.method === "GET" && route === "/link/info") {
      // `desk_id` is the contract: DeskLinkBridge.remember reads exactly this field
      return send(200, { v: 1, desk_id: deskId(), transport,
        ...(ctx.kind === "cable" ? { name: deskName, linked: Boolean(entry && entry.deviceId) } : {}) });
    }
    if (req.method !== "POST" || !["/link/hello", "/link/do", "/link/revoke"].includes(route)) {
      return send(404, { error: "not a desk link route" });
    }
    const limit = route === "/link/do" ? MAX_FILE_BODY : MAX_BODY;
    let body;
    try {
      body = await readJson(req, limit);
    } catch (e) {
      return send(e.status || 400, { error: e.message });
    }
    const who = await authenticate(req.headers["x-aither-device-hello"]);
    if (who.error) return send(who.status, { error: who.error });
    if (entry && entry.deviceId && entry.deviceId !== who.deviceId) {
      return send(409, { error: "another phone is linked on this cable" });
    }
    if (route === "/link/revoke") {
      forget(who.deviceId);
      return send(200, { ok: true, state: "forgotten" });
    }
    if (route === "/link/hello") {
      if (who.pinned) {
        if (entry) entry.deviceId = who.deviceId;
        else sessions.set(who.deviceId, { at: now(), transport });
        onChange();
        const where = meshAddress();
        return send(200, { state: "approved", desk_id: deskId(), name: deskName, transport, ...(where ? { mesh: where } : {}) });
      }
      if (ctx.kind !== "cable") {
        return send(403, { error: "approve this phone on the PC over the USB cable first" });
      }
      if (refused.has(`${ctx.serial}|${who.deviceId}`)) return send(200, { state: "refused" });
      const model = String((body && body.model) || (entry && entry.model) || "phone").slice(0, 40);
      ask(ctx.serial, who.deviceId, who.pub, model);
      return send(200, { state: "pending", message: "Approve this phone on the PC" });
    }
    // /link/do
    if (!who.pinned) return send(403, { error: "this phone is not linked: POST /link/hello and approve it on the PC" });
    if (entry) {
      if (entry.deviceId !== who.deviceId) return send(403, { error: "this phone is not linked: POST /link/hello first" });
    } else {
      const sess = sessions.get(who.deviceId);
      if (!sess || now() - sess.at > IDLE_MS) {
        sessions.delete(who.deviceId);
        return send(403, { error: "idle: the remote session timed out, say hello again", idle: true });
      }
      sess.at = now();
    }
    const action = String((body && body.action) || "");
    if (!ACTIONS.has(action) || typeof actions[action] !== "function") {
      return send(403, { error: `action not allowed: ${action.slice(0, 40)}` });
    }
    try {
      const out = await actions[action]((body && typeof body.args === "object" && body.args) || {});
      return send(200, out === undefined ? { ok: true } : out);
    } catch (e) {
      return send(500, { ok: false, error: String((e && e.message) || e).slice(0, 300) });
    }
  }

  /** Revocation from any side: the pin goes, and so does every transport's session. */
  function forget(deviceId) {
    const had = pins.unpin(deviceId);
    for (const s of servers.values()) if (s.deviceId === deviceId) s.deviceId = "";
    sessions.delete(deviceId);
    onChange();
    return had;
  }

  function meshAddress() {
    return mesh ? { addr: mesh.host, port: mesh.port } : null;
  }

  /**
   * The desk on the mesh (its tailnet address, MESH_PORT): reachable from a phone on the
   * tailnet and from the Aither tunnel's proxy. Approved phones only.
   */
  function openMesh(host, port = MESH_PORT) {
    if (mesh) return Promise.resolve(mesh.port);
    const server = http.createServer((req, res) => {
      handle({ kind: "mesh" }, req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* gone */ } });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        mesh = { server, host, port: server.address().port };
        onChange();
        resolve(mesh.port);
      });
    });
  }

  function closeMesh() {
    if (!mesh) return false;
    mesh.server.close();
    if (typeof mesh.server.closeAllConnections === "function") mesh.server.closeAllConnections();
    mesh = null;
    sessions.clear();
    onChange();
    return true;
  }

  /** One server for one cable. Resolves the PC port to reverse the phone's 47937 onto. */
  function openFor(serial, model) {
    const have = servers.get(serial);
    if (have) return Promise.resolve(have.port);
    const server = http.createServer((req, res) => {
      handle({ kind: "cable", serial }, req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* gone */ } });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, listenHost, () => {
        const port = server.address().port;
        servers.set(serial, { server, port, model, deviceId: "" });
        onChange();
        resolve(port);
      });
    });
  }

  /** The cable is gone (or the owner unlinked): close that server. */
  function closeFor(serial) {
    const s = servers.get(serial);
    if (!s) return false;
    servers.delete(serial);
    for (const k of refused) if (k.startsWith(`${serial}|`)) refused.delete(k);
    s.server.close();
    if (typeof s.server.closeAllConnections === "function") s.server.closeAllConnections();
    onChange();
    return true;
  }

  return {
    openFor,
    closeFor,
    forget,
    openMesh,
    closeMesh,
    meshAddress,
    sessions: () => [...sessions.entries()].map(([deviceId, x]) => ({ deviceId, transport: x.transport, at: x.at })),
    links: () => [...servers.entries()].map(([serial, s]) => ({ serial, port: s.port, model: s.model, deviceId: s.deviceId })),
    pinned: () => pins.all(),
    closeAll: () => { for (const serial of [...servers.keys()]) closeFor(serial); closeMesh(); },
  };
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error("body too large");
        e.status = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { const e = new Error("body is not JSON"); e.status = 400; reject(e); }
    });
    req.on("error", reject);
  });
}

/**
 * Identity's word on a device, through `adk devices status <id> --json` (the owner's
 * signed-in adk; GET /v1/nodes/{id}). runAdk(argv) -> {ok, data, error} (link-client.cjs).
 */
async function adkEnrollment(runAdk, deviceId) {
  if (!DEVICE_ID.test(deviceId)) return { status: "unknown", error: "bad device id" };
  const r = await runAdk(["devices", "status", deviceId, "--json"]);
  const n = r && r.data;
  if (r && r.ok && n && n.node_id === deviceId) {
    const pub = String(n.seal_pubkey || "");
    return PUB_HEX.test(pub) ? { status: "enrolled", pub } : { status: "unknown", error: "no device key on record" };
  }
  // adk prints a refusal as "x HTTP <status> from GET <url>" (adk/devices.py _print_refusal)
  if (r && /^x HTTP 404 /m.test(String(r.stdout || ""))) return { status: "removed" };
  return { status: "unknown", error: String((r && r.error) || "identity did not answer").slice(0, 120) };
}

/** This PC's tailnet (CGNAT 100.64.0.0/10) IPv4 from os.networkInterfaces(), or null. */
function meshAddressOf(ifaces) {
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      const [x, y] = String(a.address).split(".").map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address;
    }
  }
  return null;
}

/**
 * The tray rows for the phones on the cable: "Phone connected: <model>" and the one
 * click, "Use this phone with Aither"; once linked, "Unlink" and "Forget this phone".
 */
function trayItems(phones, links, { use, unlink, forget }) {
  const rows = [];
  for (const p of phones) {
    const link = links.find((l) => l.serial === p.serial);
    if (p.state === "unauthorized") {
      rows.push({ label: `Phone connected: ${p.model} (allow USB debugging on the phone)`, enabled: false });
    } else if (p.state !== "device") {
      rows.push({ label: `Phone connected: ${p.model} (${p.state})`, enabled: false });
    } else if (link && link.deviceId) {
      rows.push({ label: `Phone linked: ${p.model}`, enabled: false },
        { label: "Unlink this phone", click: () => unlink(p.serial) },
        { label: "Forget this phone", click: () => forget(link.deviceId, p.serial) });
    } else if (link) {
      rows.push({ label: `Phone connected: ${p.model} (open Aither on the phone)`, enabled: false },
        { label: "Stop offering this phone", click: () => unlink(p.serial) });
    } else {
      rows.push({ label: `Phone connected: ${p.model}`, enabled: false },
        { label: "Use this phone with Aither", click: () => use(p.serial) });
    }
  }
  return rows.length ? [{ type: "separator" }, ...rows] : [];
}

module.exports = {
  ACTIONS, IDLE_MS, MESH_PORT, meshAddressOf, trayItems, CLOCK_SKEW_S, HELLO_DOMAIN, PinStore, adkEnrollment, audienceOf, createFileShelf,
  createPhoneLink, helloMessage, parseHelloHeader, safeFileName, verifySig,
};
