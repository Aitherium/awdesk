"use strict";

/**
 * browser-mesh-door.cjs -- the loopback door a private workspace app is reached through.
 *
 * A private app (browser-workspace-policy.cjs `private: {host, port}`) lives on the mesh,
 * not on the internet. There is no VPN: the work session's proxy script (pacScript)
 * sends that app's host name -- and nothing else -- to this door, and the door dials the
 * mesh address the SIGNED policy maps it to.
 *
 *   - listens on 127.0.0.1 only, on a port the OS picks;
 *   - every request needs Proxy-Authorization with a credential made at random for this
 *     launch and held in main's memory (another local process gets 407);
 *   - accepts ONLY a host:port the policy maps (`resolve`), asked again for every
 *     connection, so a policy that stops being in force closes the door at once;
 *   - CONNECT (https, WebSocket) is a plain byte tunnel; an absolute-URI http request is
 *     forwarded with the hop-by-hop and proxy headers taken off;
 *   - every connection is reported to `audit` (host and verdict; never a path or a body).
 *
 * The dial is node's net.connect to the mapped address: the mesh must already be
 * reachable from this computer (an embedded mesh dialler is "not yet").
 *
 * Pure: node:http, node:net, node:crypto. No electron.
 */

const http = require("node:http");
const net = require("node:net");
const nodeCrypto = require("node:crypto");

const REALM = "aither-mesh-door";
const USER = "aither-door";
const DIAL_TIMEOUT_MS = 15_000;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade"]);

/** "host:port" (CONNECT's target) -> {host, port} or null. */
function parseAuthority(value) {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[^:\s/]+):(\d{1,5})$/.exec(String(value || ""));
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[1].replace(/^\[|\]$/g, "").toLowerCase(), port };
}

/**
 * The work session's proxy script: the private hosts go to the door and NOWHERE else
 * (no "; DIRECT" after it), every other host goes direct.
 */
function pacScript(hosts, port) {
  const list = [...new Set((hosts || []).map((h) => String(h).toLowerCase()))].sort();
  const table = JSON.stringify(Object.fromEntries(list.map((h) => [h, 1])));
  return `function FindProxyForURL(url, host) { var p = ${table}; `
    + `if (Object.prototype.hasOwnProperty.call(p, String(host).toLowerCase())) return "PROXY 127.0.0.1:${Number(port)}"; return "DIRECT"; }`;
}

function pacUrl(hosts, port) {
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacScript(hosts, port), "utf8").toString("base64")}`;
}

/**
 * @param {object} opts
 * @param {(host: string, port: number) => ({host: string, port: number, origin?: string} | null)} opts.resolve the policy's mapping
 * @param {(row: {host: string, port: number, origin: string, verdict: "allow"|"deny", reason: string}) => void} [opts.audit]
 * @param {(target: {host: string, port: number}) => import("node:net").Socket} [opts.dial]
 */
function createMeshDoor({ resolve, audit = () => {}, dial = (target) => net.connect({ host: target.host, port: target.port }) } = {}) {
  const secret = nodeCrypto.randomBytes(32).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`${USER}:${secret}`).toString("base64")}`);
  const sockets = new Set();
  let server = null;
  let port = 0;

  const note = (row) => { try { audit(row); } catch { /* the audit never breaks the door */ } };

  function authorized(req) {
    const got = Buffer.from(String(req.headers["proxy-authorization"] || ""));
    return got.length === expected.length && nodeCrypto.timingSafeEqual(got, expected);
  }

  function track(socket) {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }

  function reply(socket, status, text, extra = "") {
    try { socket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  }

  const CHALLENGE = `Proxy-Authenticate: Basic realm="${REALM}"\r\n`;

  /** Who is asked for, and whether the policy lets it through. */
  function admit(req, wanted) {
    if (!authorized(req)) return { ok: false, status: 407, text: "Proxy Authentication Required", extra: CHALLENGE, reason: "no credential" };
    if (!wanted) return { ok: false, status: 400, text: "Bad Request", reason: "not a proxy request" };
    let target;
    try { target = resolve(wanted.host, wanted.port); } catch { target = null; }
    if (!target) return { ok: false, status: 403, text: "Forbidden", reason: "not a private workspace app" };
    return { ok: true, target };
  }

  function onConnect(req, client, head) {
    track(client);
    client.on("error", () => {});
    const wanted = parseAuthority(req.url);
    const verdict = admit(req, wanted);
    const row = { host: wanted ? wanted.host : "", port: wanted ? wanted.port : 0, origin: "" };
    if (!verdict.ok) {
      // A caller without the credential is not told (or logged) what it asked for.
      if (verdict.status !== 407) note({ ...row, verdict: "deny", reason: verdict.reason });
      else note({ host: "", port: 0, origin: "", verdict: "deny", reason: verdict.reason });
      return reply(client, verdict.status, verdict.text, verdict.extra || "");
    }
    const upstream = track(dial(verdict.target));
    upstream.setTimeout(DIAL_TIMEOUT_MS, () => upstream.destroy(new Error("timeout")));
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      note({ ...row, origin: verdict.target.origin || "", verdict: "allow", reason: "" });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => { if (!client.writableEnded) reply(client, 502, "Bad Gateway"); client.destroy(); });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    return undefined;
  }

  const audited = new WeakMap(); // client socket -> the hosts already reported on it (keep-alive)

  function onRequest(req, res) {
    track(req.socket);
    let url;
    try { url = /^http:\/\//i.test(req.url) ? new URL(req.url) : null; } catch { url = null; }
    const wanted = url ? { host: url.hostname.toLowerCase(), port: Number(url.port) || 80 } : null;
    const verdict = admit(req, wanted);
    if (!verdict.ok) {
      note({ host: verdict.status === 407 || !wanted ? "" : wanted.host, port: verdict.status === 407 || !wanted ? 0 : wanted.port,
        origin: "", verdict: "deny", reason: verdict.reason });
      res.writeHead(verdict.status, verdict.status === 407 ? { "proxy-authenticate": `Basic realm="${REALM}"`, connection: "close" } : { connection: "close" });
      res.end();
      return;
    }
    const seen = audited.get(req.socket) || new Set();
    audited.set(req.socket, seen);
    const key = `${wanted.host}:${wanted.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      note({ host: wanted.host, port: wanted.port, origin: verdict.target.origin || "", verdict: "allow", reason: "" });
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(name)) headers[name] = value;
    headers.host = url.host; // the app sees the name it is known by, not the mesh address
    const upstream = http.request({ host: verdict.target.host, port: verdict.target.port, method: req.method,
      path: `${url.pathname}${url.search}`, headers, agent: false, timeout: DIAL_TIMEOUT_MS,
      createConnection: () => track(dial(verdict.target)) }, (back) => {
      const out = {};
      for (const [name, value] of Object.entries(back.headers)) if (!HOP_HEADERS.has(name)) out[name] = value;
      res.writeHead(back.statusCode || 502, out);
      back.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { connection: "close" }); res.end(); });
    req.pipe(upstream);
  }

  /** Listen on 127.0.0.1 (a port the OS picks). Resolves with the port. */
  function start() {
    if (server) return Promise.resolve(port);
    return new Promise((done, fail) => {
      const s = http.createServer(onRequest);
      s.on("connect", onConnect);
      // Anything that is not CONNECT or a plain request (an Upgrade sent straight at the door) is closed.
      s.on("upgrade", (_req, socket) => socket.destroy());
      s.on("clientError", (_e, socket) => socket.destroy());
      s.once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        server = s;
        port = s.address().port;
        done(port);
      });
    });
  }

  /** Cut every open tunnel and request (the policy changed: nothing rides an old decision). */
  function dropAll() {
    for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* gone */ } }
    sockets.clear();
  }

  function stop() {
    dropAll();
    const s = server;
    server = null;
    port = 0;
    return new Promise((done) => (s ? s.close(() => done()) : done()));
  }

  return {
    REALM, USER,
    /** The per-launch credential, for the work session's proxy login ONLY. */
    credential: () => ({ username: USER, password: secret }),
    dropAll, port: () => port, start, stop,
  };
}

module.exports = { HOP_HEADERS, REALM, USER, createMeshDoor, pacScript, pacUrl, parseAuthority };
