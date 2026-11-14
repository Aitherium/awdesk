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
 *     launch and held in main's memory. Another local process gets 407, and that is only
 *     COUNTED: a process knocking in a loop cannot fill or rotate the audit spool;
 *   - accepts ONLY a host:port the policy maps (`resolve`), asked again for every
 *     connection, so a policy that stops being in force closes the door at once;
 *   - never dials this computer itself, a link-local address or the unspecified one --
 *     checked on the address the socket really connected to, so a name that resolves
 *     there is refused too;
 *   - CONNECT (https, WebSocket) is a plain byte tunnel; an absolute-URI http request is
 *     forwarded with the hop-by-hop and proxy headers taken off;
 *   - a connection cap, a short time to send the request head, and no response left
 *     hanging when the peer goes away;
 *   - every admitted or refused (authenticated) connection is reported to `audit` (host
 *     and verdict; never a path or a body).
 *
 * The dial is node's net.connect to the mapped address: the mesh must already be
 * reachable from this computer (an embedded mesh dialler is "not yet").
 *
 * Pure: node:http, node:net, node:crypto. No electron.
 */

const http = require("node:http");
const net = require("node:net");
const nodeCrypto = require("node:crypto");
const { bareHost, forbiddenAddress } = require("./browser-workspace-policy.cjs");

const REALM = "aither-mesh-door";
const USER = "aither-door";
const DIAL_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 128;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade"]);

/** "host:port" (CONNECT's target) -> {host, port} or null. */
function parseAuthority(value) {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[^:\s/]+):(\d{1,5})$/.exec(String(value || ""));
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  const host = bareHost(m[1]);
  return host ? { host, port } : null;
}

/**
 * The work session's proxy script: the private hosts go to the door and NOWHERE else
 * (no "; DIRECT" after it), every other host goes direct. The hosts are a LIST looked up
 * by value (a host called __proto__ or constructor is just a string), and a trailing dot
 * (the same host, fully qualified) is taken off before the lookup.
 */
function pacScript(hosts, port) {
  const list = [...new Set((hosts || []).map(bareHost).filter(Boolean))].sort();
  return `function FindProxyForURL(url, host) { var p = ${JSON.stringify(list)}; var h = String(host).toLowerCase(); `
    + "while (h.length && h.charAt(h.length - 1) === \".\") h = h.slice(0, -1); "
    + `if (p.indexOf(h) !== -1) return "PROXY 127.0.0.1:${Number(port)}"; return "DIRECT"; }`;
}

function pacUrl(hosts, port) {
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacScript(hosts, port), "utf8").toString("base64")}`;
}

/**
 * @param {object} opts
 * @param {(host: string, port: number) => ({host: string, port: number, origin?: string} | null)} opts.resolve the policy's mapping
 * @param {(row: {host: string, port: number, origin: string, verdict: "allow"|"deny", reason: string}) => void} [opts.audit]
 * @param {(target: {host: string, port: number}) => import("node:net").Socket} [opts.dial]
 * @param {boolean} [opts.allowLoopback] the tests' and the live proof's seam (their stand-in peer is on 127.0.0.1). Never set in the app.
 * @param {number} [opts.headersTimeoutMs] how long a client has to send its request head
 * @param {number} [opts.maxConnections]
 */
function createMeshDoor({ resolve, audit = () => {}, dial = (target) => net.connect({ host: target.host, port: target.port }),
  allowLoopback = false, headersTimeoutMs = HEADERS_TIMEOUT_MS, maxConnections = MAX_CONNECTIONS } = {}) {
  const secret = nodeCrypto.randomBytes(32).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`${USER}:${secret}`).toString("base64")}`);
  const sockets = new Set();
  let server = null;
  let port = 0;
  /** Requests that came without this launch's credential. Counted, never written down. */
  let unauthenticated = 0;

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

  /** Dial the mapped address; a socket that turns out to be on a forbidden address is destroyed before a byte goes over it. */
  function open(target) {
    const upstream = track(dial(target));
    upstream.once("connect", () => {
      const why = allowLoopback ? "" : forbiddenAddress(upstream.remoteAddress || "");
      if (why) upstream.destroy(new Error(`the mesh address is ${why}`));
    });
    return upstream;
  }

  function reply(socket, status, text, extra = "") {
    try { socket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  }

  const CHALLENGE = `Proxy-Authenticate: Basic realm="${REALM}"\r\n`;

  /** Who is asked for, and whether the policy lets it through. */
  function admit(req, wanted) {
    if (!authorized(req)) {
      unauthenticated += 1;
      return { ok: false, status: 407, text: "Proxy Authentication Required", extra: CHALLENGE, reason: "no credential" };
    }
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
      if (verdict.status !== 407) note({ ...row, verdict: "deny", reason: verdict.reason });
      return reply(client, verdict.status, verdict.text, verdict.extra || "");
    }
    const upstream = open(verdict.target);
    upstream.setTimeout(DIAL_TIMEOUT_MS, () => upstream.destroy(new Error("timeout")));
    upstream.once("connect", () => {
      if (upstream.destroyed) return; // a forbidden address (open)
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
    const wanted = url ? { host: bareHost(url.hostname), port: Number(url.port) || 80 } : null;
    const verdict = admit(req, wanted);
    if (!verdict.ok) {
      if (verdict.status !== 407) note({ host: wanted ? wanted.host : "", port: wanted ? wanted.port : 0, origin: "", verdict: "deny", reason: verdict.reason });
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
    // The request rides OUR socket (open: tracked, and checked for a forbidden address). An
    // agent of its own, because http ignores createConnection when it is given `agent: false`.
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => open(verdict.target);
    const upstream = http.request({ host: verdict.target.host, port: verdict.target.port, method: req.method,
      path: `${url.pathname}${url.search}`, headers, agent, timeout: DIAL_TIMEOUT_MS }, (back) => {
      const out = {};
      for (const [name, value] of Object.entries(back.headers)) if (!HOP_HEADERS.has(name)) out[name] = value;
      res.writeHead(back.statusCode || 502, out);
      back.pipe(res);
      // The peer went away in the middle of its answer: the browser's side is closed, not left waiting.
      back.on("aborted", () => res.destroy());
      back.on("error", () => res.destroy());
      back.on("close", () => { if (!back.complete) res.destroy(); });
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { connection: "close" });
      res.end();
    });
    // The browser went away: the mesh side is not left open.
    res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  }

  /** Listen on 127.0.0.1 (a port the OS picks). Resolves with the port. */
  function start() {
    if (server) return Promise.resolve(port);
    return new Promise((done, fail) => {
      const s = http.createServer({ connectionsCheckingInterval: Math.max(250, Math.min(1000, headersTimeoutMs)) }, onRequest);
      // A client gets a few seconds to send its request head, and there is a cap on how many may be connected.
      s.headersTimeout = headersTimeoutMs;
      s.requestTimeout = 0; // a long upload to the app is not cut; the head is what is timed
      s.keepAliveTimeout = headersTimeoutMs;
      s.maxConnections = maxConnections;
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
    return new Promise((done) => {
      if (!s) { done(); return; }
      if (typeof s.closeAllConnections === "function") s.closeAllConnections();
      // The port is released at once; a connection that will not die does not keep the caller waiting.
      const giveUp = setTimeout(done, 1500);
      s.close(() => { clearTimeout(giveUp); done(); });
      s.unref();
    });
  }

  return {
    REALM, USER,
    /** The per-launch credential, for the work session's proxy login ONLY. */
    credential: () => ({ username: USER, password: secret }),
    dropAll, port: () => port, start, stop,
    stats: () => ({ unauthenticated, open: sockets.size }),
  };
}

module.exports = { HEADERS_TIMEOUT_MS, HOP_HEADERS, MAX_CONNECTIONS, REALM, USER, createMeshDoor, pacScript, pacUrl, parseAuthority };
