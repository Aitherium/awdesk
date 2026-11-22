"use strict";

// The mesh door, over real sockets: a local server stands in for a mesh peer. Only the
// host the policy maps gets through, only with this launch's credential, and a policy
// that stops mapping it closes the door for the next connection and cuts the open ones.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { REALM, createMeshDoor, pacScript, pacUrl, parseAuthority } = require("./browser-mesh-door.cjs");

function peer() {
  return new Promise((done) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, proxyAuth: req.headers["proxy-authorization"] || null });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`private app says hello to ${req.url}`);
    });
    server.listen(0, "127.0.0.1", () => done({ server, seen, port: server.address().port }));
  });
}

/** A raw request to the door; resolves with everything the door sent back until it closed or `until` matched. */
function raw(port, text, until = null) {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let got = "";
    const finish = () => { socket.destroy(); done(got); };
    socket.on("data", (chunk) => { got += chunk.toString("latin1"); if (until && until.test(got)) finish(); });
    socket.on("close", () => done(got));
    socket.on("error", () => done(got));
    socket.on("connect", () => socket.write(text));
    setTimeout(finish, 4000).unref();
  });
}

const basic = (c) => `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`;

async function setup() {
  const app = await peer();
  const rows = [];
  let mapped = true;
  const door = createMeshDoor({
    resolve: (host, port) => (mapped && host === "wiki.corp.test" && port === 80 ? { host: "127.0.0.1", port: app.port, origin: "http://wiki.corp.test" } : null),
    audit: (row) => rows.push(row),
    allowLoopback: true, // the stand-in peer is on 127.0.0.1; the app never sets this
  });
  const port = await door.start();
  return { app, door, port, rows, unmap: () => { mapped = false; }, close: async () => { await door.stop(); app.server.close(); } };
}

test("the proxy script sends the private hosts to the door with no DIRECT fallback, everything else direct", () => {
  const script = pacScript(["Wiki.corp.test", "git.corp.test"], 4567);
  const find = new Function(`${script}; return FindProxyForURL;`)();
  assert.equal(find("http://wiki.corp.test/x", "wiki.corp.test"), "PROXY 127.0.0.1:4567");
  assert.equal(find("https://GIT.corp.test/", "GIT.corp.test"), "PROXY 127.0.0.1:4567");
  assert.equal(find("https://example.com/", "example.com"), "DIRECT");
  assert.equal(find("http://evil.wiki.corp.test/", "evil.wiki.corp.test"), "DIRECT");
  assert.equal(find("http://x/", "constructor"), "DIRECT", "an object's own names are not hosts");
  // Review finding 9: the same host fully qualified, and a host called __proto__.
  assert.equal(find("http://wiki.corp.test./x", "wiki.corp.test."), "PROXY 127.0.0.1:4567", "a trailing dot is the same host");
  assert.equal(find("http://wiki.corp.test../x", "WIKI.corp.test.."), "PROXY 127.0.0.1:4567");
  const odd = new Function(`${pacScript(["__proto__", "wiki.corp.test."], 9)}; return FindProxyForURL;`)();
  assert.equal(odd("http://__proto__/", "__proto__"), "PROXY 127.0.0.1:9", "a listed host called __proto__ goes to the door");
  assert.equal(odd("http://wiki.corp.test/", "wiki.corp.test"), "PROXY 127.0.0.1:9", "a host listed with its dot matches without it");
  assert.equal(find("http://__proto__/", "__proto__"), "DIRECT", "and one that is not listed does not");
  assert.equal(find("http://x/", "hasOwnProperty"), "DIRECT");
  assert.equal(find("http://x/", ""), "DIRECT");
  assert.ok(!/PROXY[^"]*;\s*DIRECT/.test(script), "no fallback after the door");
  assert.ok(pacUrl(["wiki.corp.test"], 1).startsWith("data:application/x-ns-proxy-autoconfig;base64,"));
  assert.equal(pacScript([], 1).includes("PROXY 127.0.0.1:1"), true, "the script is still well formed with no host");
  assert.equal(new Function(`${pacScript([], 1)}; return FindProxyForURL;`)()("http://a/", "a"), "DIRECT");
});

test("CONNECT's target is host:port and nothing else", () => {
  assert.deepEqual(parseAuthority("Wiki.corp.test:443"), { host: "wiki.corp.test", port: 443 });
  assert.deepEqual(parseAuthority("[fd00::1]:8443"), { host: "fd00::1", port: 8443 });
  assert.deepEqual(parseAuthority("wiki.corp.test.:80"), { host: "wiki.corp.test", port: 80 }, "the trailing dot is taken off");
  for (const bad of ["wiki.corp.test", "wiki.corp.test:0", "wiki.corp.test:99999", "http://wiki.corp.test:80", "a b:80", "", null]) assert.equal(parseAuthority(bad), null, String(bad));
});

test("the door listens on loopback only, and its credential is new for every launch", async () => {
  const a = await setup();
  const b = await setup();
  assert.notEqual(a.door.credential().password, b.door.credential().password);
  assert.ok(a.door.credential().password.length >= 64);
  assert.ok(a.port > 0 && a.port !== b.port);
  await a.close();
  await b.close();
  assert.equal(a.door.port(), 0);
});

test("a plain-http request for the private host reaches the mapped peer, with the credential", async () => {
  const s = await setup();
  const got = await raw(s.port, `GET http://wiki.corp.test/page?q=1 HTTP/1.1\r\nHost: wiki.corp.test\r\nProxy-Authorization: ${basic(s.door.credential())}\r\nConnection: close\r\n\r\n`);
  assert.match(got, /^HTTP\/1\.1 200 /);
  assert.match(got, /private app says hello to \/page\?q=1/);
  assert.deepEqual(s.app.seen, [{ url: "/page?q=1", host: "wiki.corp.test", proxyAuth: null }], "the app sees its own name and never the door's credential");
  assert.deepEqual(s.rows, [{ host: "wiki.corp.test", port: 80, origin: "http://wiki.corp.test", verdict: "allow", reason: "" }]);
  assert.ok(!JSON.stringify(s.rows).includes("page"), "no path in the audit");
  await s.close();
});

test("another local process without the credential is refused, for every way of asking", async () => {
  const s = await setup();
  const none = await raw(s.port, "GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki.corp.test\r\n\r\n");
  assert.match(none, /^HTTP\/1\.1 407 /);
  assert.match(none, new RegExp(`proxy-authenticate: Basic realm="${REALM}"`, "i"));
  const wrong = await raw(s.port, `GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki.corp.test\r\nProxy-Authorization: ${basic({ username: "aither-door", password: "guess" })}\r\n\r\n`);
  assert.match(wrong, /^HTTP\/1\.1 407 /);
  const asAuth = await raw(s.port, `GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki.corp.test\r\nAuthorization: ${basic(s.door.credential())}\r\n\r\n`);
  assert.match(asAuth, /^HTTP\/1\.1 407 /, "the credential in the wrong header is no credential");
  const tunnel = await raw(s.port, "CONNECT wiki.corp.test:80 HTTP/1.1\r\nHost: wiki.corp.test:80\r\n\r\n");
  assert.match(tunnel, /^HTTP\/1\.1 407 /);
  const direct = await raw(s.port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  assert.match(direct, /^HTTP\/1\.1 407 /, "the door is not a web server");
  assert.equal(s.app.seen.length, 0, "nothing reached the private app");
  // Review finding 5: a refusal for want of the credential is counted, never written down.
  assert.deepEqual(s.rows, [], "no audit row for a caller without the credential");
  assert.equal(s.door.stats().unauthenticated, 5);
  for (let i = 0; i < 200; i += 1) await raw(s.port, "GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki.corp.test\r\n\r\n");
  assert.deepEqual(s.rows, [], "a process knocking in a loop writes nothing");
  assert.equal(s.door.stats().unauthenticated, 205);
  await s.close();
});

test("with the credential, only the mapped host and port get through", async () => {
  const s = await setup();
  const auth = `Proxy-Authorization: ${basic(s.door.credential())}\r\n`;
  const otherHost = await raw(s.port, `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n${auth}\r\n`);
  assert.match(otherHost, /^HTTP\/1\.1 403 /);
  const otherPort = await raw(s.port, `GET http://wiki.corp.test:8080/ HTTP/1.1\r\nHost: wiki.corp.test:8080\r\n${auth}\r\n`);
  assert.match(otherPort, /^HTTP\/1\.1 403 /);
  const loop = await raw(s.port, `CONNECT 127.0.0.1:${s.app.port} HTTP/1.1\r\nHost: x\r\n${auth}\r\n`);
  assert.match(loop, /^HTTP\/1\.1 403 /, "the door is not a way to this computer's own ports");
  const notProxy = await raw(s.port, `GET /etc HTTP/1.1\r\nHost: wiki.corp.test\r\n${auth}\r\n`);
  assert.match(notProxy, /^HTTP\/1\.1 400 /);
  assert.equal(s.app.seen.length, 0);
  assert.deepEqual(s.rows.map((r) => r.verdict), ["deny", "deny", "deny", "deny"]);
  await s.close();
});

test("CONNECT is a byte tunnel to the mapped peer", async () => {
  const s = await setup();
  const got = await raw(s.port, `CONNECT wiki.corp.test:80 HTTP/1.1\r\nHost: wiki.corp.test:80\r\nProxy-Authorization: ${basic(s.door.credential())}\r\n\r\n`
    + "GET /through-the-tunnel HTTP/1.1\r\nHost: wiki.corp.test\r\nConnection: close\r\n\r\n", /hello to \/through-the-tunnel/);
  assert.match(got, /^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
  assert.match(got, /private app says hello to \/through-the-tunnel/);
  assert.equal(s.app.seen[0].host, "wiki.corp.test");
  assert.deepEqual(s.rows.map((r) => [r.host, r.verdict]), [["wiki.corp.test", "allow"]]);
  await s.close();
});

test("a policy that stops mapping the host closes the door, and dropAll cuts an open tunnel", async () => {
  const s = await setup();
  const auth = `Proxy-Authorization: ${basic(s.door.credential())}\r\n`;
  const socket = net.connect({ host: "127.0.0.1", port: s.port });
  const opened = await new Promise((done) => {
    let got = "";
    socket.on("data", (c) => { got += c; if (/200 Connection Established/.test(got)) done(true); });
    socket.on("connect", () => socket.write(`CONNECT wiki.corp.test:80 HTTP/1.1\r\nHost: x\r\n${auth}\r\n`));
    setTimeout(() => done(false), 3000).unref();
  });
  assert.equal(opened, true);
  const closed = new Promise((done) => socket.once("close", () => done(true)));
  s.unmap();
  s.door.dropAll();
  assert.equal(await Promise.race([closed, new Promise((d) => setTimeout(() => d(false), 3000).unref())]), true, "the open tunnel is cut");
  const after = await raw(s.port, `GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki.corp.test\r\n${auth}\r\n`);
  assert.match(after, /^HTTP\/1\.1 403 /, "the next connection is refused");
  await s.close();
});

test("a mesh peer that is not there answers 502, not a hang", async () => {
  const dead = await new Promise((done) => { const t = net.createServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => done(p)); }); });
  const door = createMeshDoor({ resolve: () => ({ host: "127.0.0.1", port: dead }) });
  const port = await door.start();
  const auth = `Proxy-Authorization: ${basic(door.credential())}\r\n`;
  assert.match(await raw(port, `GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki.corp.test\r\n${auth}\r\n`), /^HTTP\/1\.1 502 /);
  assert.match(await raw(port, `CONNECT wiki.corp.test:443 HTTP/1.1\r\nHost: x\r\n${auth}\r\n`), /^HTTP\/1\.1 502 /);
  await door.stop();
});

// ---------------------------------------------------------------- security review

/** A peer that sends a response head and half a body, then cuts the connection. */
function halfPeer() {
  return new Promise((done) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\nhalf of it");
        setTimeout(() => socket.destroy(), 100);
      });
    });
    server.listen(0, "127.0.0.1", () => done({ server, port: server.address().port }));
  });
}

// Finding 10: the address the socket really reached is checked, not only the policy's text.
test("the door never dials this computer: a loopback target is refused, by address and by name", async () => {
  const app = await peer();
  const rows = [];
  for (const host of ["127.0.0.1", "localhost"]) {
    const door = createMeshDoor({ resolve: () => ({ host, port: app.port, origin: "http://wiki.corp.test" }), audit: (r) => rows.push(r) });
    const port = await door.start();
    const auth = `Proxy-Authorization: ${basic(door.credential())}\r\n`;
    assert.match(await raw(port, `GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki.corp.test\r\n${auth}\r\n`), /^HTTP\/1\.1 502 /, host);
    const tunnel = await raw(port, `CONNECT wiki.corp.test:80 HTTP/1.1\r\nHost: x\r\n${auth}\r\nGET /x HTTP/1.1\r\nHost: a\r\n\r\n`);
    assert.match(tunnel, /^HTTP\/1\.1 502 /, host);
    assert.ok(!/Connection Established/.test(tunnel), host);
    await door.stop();
  }
  assert.deepEqual(app.seen, [], "not one byte reached the local port");
  assert.ok(!rows.some((r) => r.verdict === "allow" && r.host === "" ), "sanity");
  app.server.close();
});

// Finding 8.
test("a peer that dies in the middle of its answer closes the browser's side; it is not left hanging", async () => {
  const half = await halfPeer();
  const door = createMeshDoor({ resolve: () => ({ host: "127.0.0.1", port: half.port }), allowLoopback: true });
  const port = await door.start();
  const t0 = Date.now();
  const closed = await new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let got = "";
    socket.on("data", (c) => { got += c; });
    socket.on("close", () => done({ got, ms: Date.now() - t0 }));
    socket.on("error", () => {});
    socket.on("connect", () => socket.write(`GET http://wiki.corp.test/big HTTP/1.1\r\nHost: wiki.corp.test\r\nProxy-Authorization: ${basic(door.credential())}\r\n\r\n`));
    setTimeout(() => done({ got, ms: -1 }), 4000).unref();
  });
  assert.ok(closed.ms >= 0 && closed.ms < 3000, `closed after ${closed.ms} ms`);
  assert.match(closed.got, /half of it/);
  await door.stop();
  half.server.close();
});

test("a client that never finishes its request head is cut off, and there is a connection cap", async () => {
  const s = await setup();
  await s.close();
  const door = createMeshDoor({ resolve: () => null, headersTimeoutMs: 300, maxConnections: 3 });
  const port = await door.start();
  const t0 = Date.now();
  const slow = await new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("close", () => done(Date.now() - t0));
    socket.on("error", () => {});
    socket.on("connect", () => socket.write("GET http://wiki.corp.test/ HTTP/1.1\r\nHost: wiki")); // and then nothing
    setTimeout(() => done(-1), 5000).unref();
  });
  assert.ok(slow >= 0 && slow < 4000, `cut off after ${slow} ms`);
  // Three idle connections are held; the fourth is dropped at once.
  const idle = [];
  for (let i = 0; i < 3; i += 1) idle.push(await new Promise((done) => { const c = net.connect({ host: "127.0.0.1", port }, () => done(c)); c.on("error", () => {}); }));
  const fourth = await new Promise((done) => {
    const c = net.connect({ host: "127.0.0.1", port });
    c.on("close", () => done("dropped"));
    c.on("error", () => {});
    setTimeout(() => done("held"), 1500).unref();
  });
  assert.equal(fourth, "dropped");
  for (const c of idle) c.destroy();
  await door.stop();
  const { HEADERS_TIMEOUT_MS, MAX_CONNECTIONS } = require("./browser-mesh-door.cjs");
  assert.ok(HEADERS_TIMEOUT_MS <= 10_000 && MAX_CONNECTIONS <= 256, "the shipped caps are small");
});
