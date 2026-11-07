"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  TunnelClient, FALLBACK_DENY_PORTS, AW_DAEMON_PORTS, checkPort, buildUpArgs, parseStatus, parseUpUrl, capRows, statusLine,
  normalizePort, loadDenyPorts, parseServicesPorts, judgePids, parseProbeLines,
} = require("./tunnel-client.cjs");
const { tunnelHandlers, TUNNEL_CHANNELS, safeUrl } = require("./tunnel-window.cjs");

// REAL output, captured 2026-11-01 by running `awtunnel status` on the owner's
// box (a tunnel recorded earlier whose process had died: exit 1). CRLF as Windows
// Python printed it.
const REAL_STATUS_DEAD = [
  "{",
  '  "pid": 59040,',
  '  "cloudflared_pid": 54360,',
  '  "url": "https://lace-corrected-opposite-clarke.trycloudflare.com",',
  '  "port": 8791,',
  '  "host": "localhost",',
  '  "started": 1793071528.1174507,',
  '  "alive": false',
  "}",
  "",
].join("\r\n");
// REAL: `AWTUNNEL_STATE=<missing file> awtunnel status` and `... down` (exit 1).
const REAL_NONE = "no tunnel recorded\r\n";
// SYNTHETIC (stated): the alive form is the same JSON with alive:true (cli.py
// cmd_status prints {**state, "alive": alive}); not captured because a live
// tunnel publishes a port.
const SYNTH_STATUS_LIVE = REAL_STATUS_DEAD.replace('"alive": false', '"alive": true').replace("8791", "3000");

const HOME = path.join("C:", "Users", "owner");
const DESK_DIR = path.join(HOME, ".awtunnel", "desk");
const CLI_STATE = path.join(HOME, ".awtunnel", "state.json");

test("parseStatus reads the real captured dead-tunnel output", () => {
  const s = parseStatus(REAL_STATUS_DEAD, 1);
  assert.deepEqual(s, {
    recorded: true, alive: false, url: "https://lace-corrected-opposite-clarke.trycloudflare.com",
    port: 8791, host: "localhost", pid: 59040, cloudflaredPid: 54360, startedAt: 1793071528,
  });
});

test("parseStatus reads 'no tunnel recorded', the live form, and rejects garbage", () => {
  assert.deepEqual(parseStatus(REAL_NONE, 1), { recorded: false });
  const live = parseStatus(SYNTH_STATUS_LIVE, 0);
  assert.equal(live.alive, true);
  assert.equal(live.port, 3000);
  assert.equal(parseStatus("Traceback (most recent call last):", 1), null);
  assert.equal(parseStatus("", 0), null);
});

test("parseUpUrl finds the URL awtunnel up prints first", () => {
  assert.equal(parseUpUrl("https://a-b-c.trycloudflare.com\r\n"), "https://a-b-c.trycloudflare.com");
  assert.equal(parseUpUrl("starting\nhttps://x.example.com/\n"), "https://x.example.com/");
  assert.equal(parseUpUrl("DEAD: nope"), null);
});

test("deny list refuses every fleet internal with a named reason", () => {
  assert.deepEqual(Object.keys(FALLBACK_DENY_PORTS).map(Number).sort((a, b) => a - b), [5432, 8001, 8111, 8150, 8151, 8182]);
  for (const port of [8182, 8150, 8151, 8111, 8001, 5432]) {
    const v = checkPort(port, { deny: FALLBACK_DENY_PORTS });
    assert.equal(v.ok, false);
    assert.equal(v.denied, true);
    assert.match(v.reason, new RegExp(`^1 port refused: ${port} is .+ — .*override`));
  }
  assert.match(checkPort(8182).reason, /MCP gateway/);
  assert.match(checkPort(5432).reason, /Postgres/);
});

test("the owner override is explicit: only literal true lets an internal port through", () => {
  assert.deepEqual(checkPort(8182, { allowInternal: true }), { ok: true, port: 8182, overridden: true });
  assert.equal(checkPort(8182, { allowInternal: "true" }).ok, false);
  assert.equal(checkPort(8182, { allowInternal: 1 }).ok, false);
  assert.deepEqual(checkPort("3000", { deny: FALLBACK_DENY_PORTS }), { ok: true, port: 3000 });
});

test("normalizePort accepts 1..65535 integers only", () => {
  assert.equal(normalizePort("8080"), 8080);
  assert.equal(normalizePort(65535), 65535);
  for (const bad of [0, 65536, "80abc", "1.5", "", null, "-1"]) assert.equal(normalizePort(bad), null);
  assert.match(checkPort("80abc").reason, /^1 port .* is not a port — give a number/);
});

test("buildUpArgs produces the awtunnel up argv and refuses non-loopback hosts", () => {
  assert.deepEqual(buildUpArgs({ port: "3000", deny: FALLBACK_DENY_PORTS }), {
    ok: true, port: 3000, argv: ["up", "--port", "3000", "--host", "localhost", "--protocol", "http"],
  });
  assert.deepEqual(buildUpArgs({ port: 8443, host: "127.0.0.1", protocol: "HTTPS", deny: FALLBACK_DENY_PORTS }).argv,
    ["up", "--port", "8443", "--host", "127.0.0.1", "--protocol", "https"]);
  const lan = buildUpArgs({ port: 3000, host: "192.168.1.5", deny: FALLBACK_DENY_PORTS });
  assert.equal(lan.ok, false);
  assert.match(lan.reason, /^1 host refused: .* — use localhost/);
  assert.equal(buildUpArgs({ port: 3000, protocol: "ftp", deny: FALLBACK_DENY_PORTS }).ok, false);
  assert.equal(buildUpArgs({ port: 8150 }).denied, true);
  assert.deepEqual(buildUpArgs({ port: 8150, allowInternal: true }).argv.slice(0, 3), ["up", "--port", "8150"]);
});

/** A fake awtunnel: maps AWTUNNEL_STATE -> {status, down} outputs; records every call. */
function fakeExec(states) {
  const calls = [];
  const impl = (file, argv, opts, cb) => {
    calls.push({ file, argv, opts });
    if (file === "taskkill") { setImmediate(() => cb(null, "SUCCESS", "")); return; }
    const st = states[opts.env.AWTUNNEL_STATE];
    const verb = argv[argv.length - 1];
    const out = st ? st[verb] : REAL_NONE;
    const ok = st && st.code === 0;
    const err = ok && verb === "status" ? null : Object.assign(new Error("exit 1"), { code: 1 });
    setImmediate(() => cb(verb === "down" && st && /^stopped/.test(st.down) ? null : err, out, ""));
  };
  return { impl, calls };
}

function fakeFs(files = []) {
  return {
    made: [],
    unlinked: [],
    readdirSync: (dir) => { if (dir !== DESK_DIR) throw new Error("ENOENT"); return files; },
    existsSync: (p) => files.some((f) => path.join(DESK_DIR, f) === p),
    mkdirSync(p) { this.made.push(p); },
    unlinkSync(p) { this.unlinked.push(p); },
  };
}

// The recorded tunnel's own processes (REAL_STATUS_DEAD pids, started before the
// record's `started` 1793071528): what the OS probe answers when nothing was recycled.
const OWN_PROCS = { 59040: { name: "python.exe", startedAt: 1793071500 }, 54360: { name: "cloudflared.exe", startedAt: 1793071510 } };
function procsOf(table) {
  const asked = [];
  const impl = async (pids) => { asked.push(pids); return new Map(pids.filter((p) => table[p]).map((p) => [p, table[p]])); };
  return { impl, asked };
}

function client(extra) {
  return new TunnelClient({
    bin: "awtunnel", python: "python", env: {}, homedir: () => HOME, platform: "win32",
    deny: FALLBACK_DENY_PORTS, processInfoImpl: procsOf(OWN_PROCS).impl, ...extra,
  });
}

test("list asks awtunnel status per state file with windowsHide and the per-port AWTUNNEL_STATE", async () => {
  const live = path.join(DESK_DIR, "port-3000.json");
  const fx = fakeExec({ [live]: { status: SYNTH_STATUS_LIVE, code: 0 }, [CLI_STATE]: { status: REAL_STATUS_DEAD, code: 1 } });
  const res = await client({ execFileImpl: fx.impl, fsImpl: fakeFs(["port-3000.json", "notes.txt"]) }).list();
  assert.equal(res.ok, true);
  assert.equal(res.data.total, 2);
  assert.equal(res.data.alive, 1);
  assert.deepEqual(res.data.tunnels.map((t) => [t.port, t.alive, t.source]), [[3000, true, "desk"], [8791, false, "cli"]]);
  assert.equal(fx.calls.length, 2);
  for (const c of fx.calls) {
    assert.equal(c.opts.windowsHide, true);
    assert.deepEqual(c.argv, ["status"]);
  }
  assert.deepEqual(fx.calls.map((c) => c.opts.env.AWTUNNEL_STATE).sort(), [CLI_STATE, live].sort());
  assert.equal(statusLine(res), "1 public port · 1 stale — Stop clears it");
});

test("list reports a missing awtunnel with the install remedy", async () => {
  const impl = (_f, _a, _o, cb) => setImmediate(() => cb(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", ""));
  const res = await client({ execFileImpl: impl, fsImpl: fakeFs() }).list();
  assert.equal(res.ok, false);
  assert.match(res.reason, /^1 tool missing: awtunnel is not on PATH — install it: pip install -e/);
});

/** A fake spawn: a child that prints `lines` on stdout (or exits with stderr). */
function fakeSpawn({ url = null, stderr = "", exitCode = 2 } = {}) {
  const calls = [];
  const impl = (file, argv, opts) => {
    calls.push({ file, argv, opts });
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() { this.destroyed = true; } });
    child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    child.unref = () => { child.unrefed = true; };
    child.kill = () => { child.killed = true; };
    child.pid = 7000 + calls.length;
    calls[calls.length - 1].child = child;
    setImmediate(() => {
      if (url) child.stdout.emit("data", Buffer.from(`${url}\r\n`));
      else { child.stderr.emit("data", Buffer.from(stderr)); child.emit("exit", exitCode); }
    });
    return child;
  };
  return { impl, calls };
}

test("start spawns awtunnel up hidden (NOT detached on Windows) and resolves the printed URL", async () => {
  const sp = fakeSpawn({ url: "https://new-port.trycloudflare.com" });
  const fs = fakeFs();
  const c = client({ execFileImpl: fakeExec({}).impl, spawnImpl: sp.impl, fsImpl: fs });
  const res = await c.start({ port: 3000 });
  assert.deepEqual(res, { ok: true, data: { port: 3000, url: "https://new-port.trycloudflare.com", reused: false, source: "desk" } });
  assert.equal(sp.calls.length, 1);
  const call = sp.calls[0];
  assert.equal(call.file, "awtunnel");
  assert.deepEqual(call.argv, ["up", "--port", "3000", "--host", "localhost", "--protocol", "http"]);
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.detached, false);
  assert.equal(call.opts.env.AWTUNNEL_STATE, path.join(DESK_DIR, "port-3000.json"));
  assert.equal(call.child.unrefed, true);
  assert.deepEqual(fs.made, [DESK_DIR]);
});

test("start answers the existing URL when the port is already public, without spawning", async () => {
  const sp = fakeSpawn({ url: "https://never.example.com" });
  const live = path.join(DESK_DIR, "port-3000.json");
  const fx = fakeExec({ [live]: { status: SYNTH_STATUS_LIVE, code: 0 } });
  const res = await client({ execFileImpl: fx.impl, spawnImpl: sp.impl, fsImpl: fakeFs(["port-3000.json"]) }).start({ port: "3000" });
  assert.equal(res.ok, true);
  assert.equal(res.data.reused, true);
  assert.equal(res.data.url, "https://lace-corrected-opposite-clarke.trycloudflare.com");
  assert.equal(sp.calls.length, 0);
});

test("start refuses a fleet internal before spawning anything", async () => {
  const sp = fakeSpawn({ url: "https://never.example.com" });
  const fx = fakeExec({});
  const res = await client({ execFileImpl: fx.impl, spawnImpl: sp.impl, fsImpl: fakeFs() }).start({ port: 8182 });
  assert.equal(res.ok, false);
  assert.equal(res.denied, true);
  assert.equal(sp.calls.length, 0);
  assert.equal(fx.calls.length, 0);
});

test("start reports awtunnel's DEAD line with a remedy when the tunnel never comes up", async () => {
  const sp = fakeSpawn({ stderr: "DEAD: cloudflared not found on PATH\n" });
  const res = await client({ execFileImpl: fakeExec({}).impl, spawnImpl: sp.impl, fsImpl: fakeFs() }).start({ port: 3000 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "1 tunnel did not come up: DEAD: cloudflared not found on PATH — install cloudflared and retry");
});

test("stop runs awtunnel down against the desk file for that port", async () => {
  const live = path.join(DESK_DIR, "port-3000.json");
  const fx = fakeExec({ [live]: { status: SYNTH_STATUS_LIVE, down: "stopped\r\n", code: 0 } });
  const res = await client({ execFileImpl: fx.impl, fsImpl: fakeFs(["port-3000.json"]) }).stop(3000);
  assert.deepEqual(res, { ok: true, data: { port: 3000, stopped: true, cleared: 0 } });
  const down = fx.calls.find((c) => c.argv[0] === "down");
  assert.equal(down.opts.env.AWTUNNEL_STATE, live);
  assert.equal(down.opts.windowsHide, true);
});

test("stop with nothing on the port says so with the remedy", async () => {
  const res = await client({ execFileImpl: fakeExec({}).impl, fsImpl: fakeFs() }).stop(4000);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "0 tunnels on port 4000 — nothing to stop; Refresh to see what is public");
});

test("capRows shows five and keeps the real total", () => {
  const r = capRows([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(r, { visible: [1, 2, 3, 4, 5], more: 2, total: 7 });
  assert.equal(statusLine({ ok: true, data: { total: 0, alive: 0 } }), "0 public ports — type a port and press Make public");
});

test("IPC handlers forward only named fields and the literal override", async () => {
  const seen = [];
  const fake = { start: async (o) => { seen.push(o); return { ok: true, data: o }; }, list: async () => ({ ok: true }), stop: async (p) => ({ ok: true, data: { p } }) };
  const copied = [];
  const h = tunnelHandlers(fake, { clipboard: { writeText: (t) => copied.push(t) }, shell: { openExternal: async () => {} } });
  await h[TUNNEL_CHANNELS.start]({}, { port: "3000", allowInternal: "yes", evil: "x" });
  assert.deepEqual(seen[0], { port: "3000", host: undefined, protocol: undefined, allowInternal: false });
  const denied = await h[TUNNEL_CHANNELS.check]({}, { port: 8111 });
  assert.equal(denied.denied, true);
  assert.equal((await h[TUNNEL_CHANNELS.check]({}, { port: 8111, allowInternal: true })).ok, true);
  assert.equal((await h[TUNNEL_CHANNELS.copy]({}, "https://a.trycloudflare.com")).ok, true);
  assert.deepEqual(copied, ["https://a.trycloudflare.com"]);
  assert.equal((await h[TUNNEL_CHANNELS.open]({}, "javascript:alert(1)")).ok, false);
  assert.equal(safeUrl("file:///C:/x"), null);
});

test("the preload spells exactly the TUNNEL_CHANNELS the window registers", () => {
  const src = require("node:fs").readFileSync(path.join(__dirname, "tunnel-preload.cjs"), "utf8");
  const used = [...src.matchAll(/"(desk:tunnel-[a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, Object.values(TUNNEL_CHANNELS).sort());
});

// ── Review fixes (2026-11-01): each test below fails against the pre-fix client. ──

/** A fake spawn whose child never prints a URL (the timeout path). */
function hangingSpawn() {
  const calls = [];
  const impl = (file, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    child.unref = () => {};
    child.kill = () => { child.killed = true; };
    child.pid = 4242;
    calls.push({ file, argv, opts, child });
    return child;
  };
  return { impl, calls };
}

test("stop on a stale record whose cloudflared pid was RECYCLED clears the file and never runs down or taskkill", async () => {
  const stale = path.join(DESK_DIR, "port-8791.json");
  const fx = fakeExec({ [stale]: { status: REAL_STATUS_DEAD, down: "stopped\r\n", code: 1 } });
  const fs = fakeFs(["port-8791.json"]);
  // 59040 (wrapper) is dead; 54360 now belongs to the owner's editor, started after the record.
  const procs = procsOf({ 54360: { name: "Code.exe", startedAt: 1793080000 } });
  const res = await client({ execFileImpl: fx.impl, fsImpl: fs, processInfoImpl: procs.impl }).stop(8791);
  assert.deepEqual(res, { ok: true, data: { port: 8791, stopped: false, cleared: 1 } });
  assert.deepEqual(fx.calls.filter((c) => c.argv[0] === "down" || c.file === "taskkill"), []);
  assert.deepEqual(fs.unlinked, [stale]);
  assert.deepEqual(procs.asked, [[59040, 54360]]);
});

test("stop on a stale record whose REAL cloudflared is still running kills that tree, not via down", async () => {
  const stale = path.join(DESK_DIR, "port-8791.json");
  const fx = fakeExec({ [stale]: { status: REAL_STATUS_DEAD, down: "stopped\r\n", code: 1 } });
  const fs = fakeFs(["port-8791.json"]);
  const procs = procsOf({ 54360: OWN_PROCS[54360] });
  const res = await client({ execFileImpl: fx.impl, fsImpl: fs, processInfoImpl: procs.impl }).stop(8791);
  assert.deepEqual(res, { ok: true, data: { port: 8791, stopped: true, cleared: 1 } });
  const kills = fx.calls.filter((c) => c.file === "taskkill");
  assert.deepEqual(kills.map((c) => c.argv), [["/PID", "54360", "/T", "/F"]]);
  assert.equal(kills[0].opts.windowsHide, true);
  assert.equal(fx.calls.some((c) => c.argv[0] === "down"), false);
});

test("stop never deletes a stale record outside the desk folder (an AWTUNNEL_STATE override)", async () => {
  const elsewhere = path.join("D:", "elsewhere", "state.json");
  const fx = fakeExec({ [elsewhere]: { status: REAL_STATUS_DEAD, down: "stopped\r\n", code: 1 } });
  const fs = fakeFs();
  const res = await client({ execFileImpl: fx.impl, fsImpl: fs, env: { AWTUNNEL_STATE: elsewhere }, processInfoImpl: procsOf({}).impl }).stop(8791);
  assert.equal(res.ok, false);
  assert.equal(res.reason, `1 stale record not cleared: ${elsewhere} — delete that file (its pids belong to other processes now)`);
  assert.deepEqual(fs.unlinked, []);
  assert.equal(fx.calls.some((c) => c.argv[0] === "down"), false);
});

test("start does not reuse a 'live' record whose wrapper pid was recycled and whose cloudflared is gone", async () => {
  const sp = fakeSpawn({ url: "https://fresh.trycloudflare.com" });
  const live = path.join(DESK_DIR, "port-3000.json");
  const fx = fakeExec({ [live]: { status: SYNTH_STATUS_LIVE, code: 0 } });
  const procs = procsOf({ 59040: { name: "explorer.exe", startedAt: 1793090000 } });
  const res = await client({ execFileImpl: fx.impl, spawnImpl: sp.impl, fsImpl: fakeFs(["port-3000.json"]), processInfoImpl: procs.impl }).start({ port: 3000 });
  assert.deepEqual(res, { ok: true, data: { port: 3000, url: "https://fresh.trycloudflare.com", reused: false, source: "desk" } });
  assert.equal(sp.calls.length, 1);
});

test("an unreadable state file is counted in the status line and listed with its port", async () => {
  const bad = path.join(DESK_DIR, "port-4000.json");
  const fx = fakeExec({ [bad]: { status: "Traceback (most recent call last):\r\n  KeyError: pid\r\n", code: 1 } });
  const res = await client({ execFileImpl: fx.impl, fsImpl: fakeFs(["port-4000.json"]) }).list();
  assert.equal(res.ok, true);
  assert.equal(res.data.errors.length, 1);
  assert.equal(res.data.errors[0].port, 4000);
  assert.equal(res.data.errors[0].path, bad);
  assert.equal(res.data.line, "1 state file unreadable — run awtunnel status; a port may still be public");
  assert.equal(statusLine(res), res.data.line);
});

test("start refuses to spawn over an unreadable desk state file for that port", async () => {
  const sp = fakeSpawn({ url: "https://never.example.com" });
  const bad = path.join(DESK_DIR, "port-4000.json");
  const fx = fakeExec({ [bad]: { status: "garbage", code: 1 } });
  const res = await client({ execFileImpl: fx.impl, spawnImpl: sp.impl, fsImpl: fakeFs(["port-4000.json"]) }).start({ port: 4000 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, `1 state file unreadable for port 4000 — run awtunnel status with AWTUNNEL_STATE=${bad} in a terminal; the port may already be public`);
  assert.equal(sp.calls.length, 0);
});

test("up is detached only on POSIX (its own process group); on Windows windowsHide alone", async () => {
  const sp = fakeSpawn({ url: "https://posix.trycloudflare.com" });
  await client({ platform: "linux", execFileImpl: fakeExec({}).impl, spawnImpl: sp.impl, fsImpl: fakeFs() }).start({ port: 3000 });
  assert.equal(sp.calls[0].opts.detached, true);
  assert.equal(sp.calls[0].opts.windowsHide, true);
});

test("the up timeout kills the whole tree: taskkill /T /F on Windows, the process group on POSIX", async () => {
  const fx = fakeExec({});
  const sp = hangingSpawn();
  const res = await client({ execFileImpl: fx.impl, spawnImpl: sp.impl, fsImpl: fakeFs(), upTimeoutMs: 20 }).start({ port: 3000 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /^1 tunnel timed out: no URL after 0 s — check cloudflared/);
  await new Promise((r) => setImmediate(r));
  const kill = fx.calls.find((c) => c.file === "taskkill");
  assert.deepEqual(kill.argv, ["/PID", "4242", "/T", "/F"]);
  assert.equal(kill.opts.windowsHide, true);
  assert.equal(sp.calls[0].child.killed, undefined);

  const killed = [];
  const sp2 = hangingSpawn();
  await client({ platform: "linux", execFileImpl: fakeExec({}).impl, spawnImpl: sp2.impl, fsImpl: fakeFs(), upTimeoutMs: 20,
    killImpl: (pid, sig) => killed.push([pid, sig]) }).start({ port: 3000 });
  assert.deepEqual(killed, [[-4242, "SIGTERM"]]);
});

test("the deny map is built from the REAL services.yaml plus the aw* daemons, named reasons kept", (t) => {
  const { ports, source } = loadDenyPorts({ env: {} });
  // services.yaml belongs to the AitherOS checkout, not to this repo: CI runners have
  // neither it nor C:\AitherOS-Fresh, so there is nothing to read. The FALLBACK map
  // (same aw* daemons, named reasons) is asserted by the next test.
  if (!source) return t.skip("AitherOS/config/services.yaml is not on this machine (owner checkout only)");
  assert.ok(source.endsWith(path.join("config", "services.yaml")), `services.yaml found: ${source}`);
  assert.ok(Object.keys(ports).length > 100);
  for (const port of [8286, 9001, 8362, 8369, 47933]) assert.equal(ports[port], AW_DAEMON_PORTS[port]);
  assert.match(ports[8199], /AitherGym/);
  assert.match(ports[8182], /MCP gateway/);
  assert.match(ports[5432], /Postgres/);
  // The default checkPort (no injected map) now refuses awrouter: it was published before.
  const v = checkPort(8286);
  assert.equal(v.denied, true);
  assert.equal(v.reason, "1 port refused: 8286 is awrouter, the local model router — a public URL would publish fleet internals; tick the owner override to expose it anyway");
});

test("the deny map falls back to the named ports when services.yaml cannot be read", () => {
  const { ports, source } = loadDenyPorts({ env: {}, fsImpl: { readFileSync: () => { throw new Error("ENOENT"); } } });
  assert.equal(source, null);
  assert.deepEqual(Object.keys(ports).map(Number).sort((a, b) => a - b), [5432, 8001, 8111, 8150, 8151, 8182, 8286, 8362, 8369, 9001, 47933]);
});

test("parseServicesPorts reads only the services: section", () => {
  const yaml = ["settings:", "  bootloader_port: 8001", "models:", "  x:", "    port: 1111", "services:",
    "  AitherA:", "    port: 2222", "    description: The A service", "  AitherB:", "    port: 2222", "groups:", "  g:", "    port: 3333"].join("\r\n");
  assert.deepEqual(parseServicesPorts(yaml), { 2222: [{ name: "AitherA", description: "The A service" }, { name: "AitherB", description: "" }] });
});

test("judgePids names a recycled pid 'foreign' by image and by a start after the record", () => {
  const rec = { pid: 1, cloudflaredPid: 2, startedAt: 1000 };
  assert.deepEqual(judgePids(rec, parseProbeLines("1|python.exe|990\r\n2|cloudflared.exe|995\r\n")), { wrapper: "ok", cloudflared: "ok" });
  assert.deepEqual(judgePids(rec, parseProbeLines("1|Code.exe|990\n2|cloudflared.exe|1500\n")), { wrapper: "foreign", cloudflared: "foreign" });
  assert.deepEqual(judgePids(rec, new Map()), { wrapper: "dead", cloudflared: "dead" });
});
