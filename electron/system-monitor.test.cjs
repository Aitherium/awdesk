"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  PsWorker, computeCpu, createSystemMonitor, descendants, parseProcessSample, probe,
  redactCommandLine, refusalFor, shapeNetwork, systemToolCall, throughput, WINDOWS_ONLY,
} = require("./system-monitor.cjs");
const { systemHandlers } = require("./system-monitor-window.cjs");

// A captured-shape "procs" answer (fields exactly as WORKER_SCRIPT emits them).
function procsFixture({ ticks = 1e7, idle = 0, notepad = 0, rx = 1000, tx = 500 } = {}) {
  return {
    id: "r1", ok: true, ticks, cores: 4, totalKb: 16 * 1024 * 1024, freeKb: 4 * 1024 * 1024,
    procs: [
      { pid: 0, ppid: 0, name: "System Idle Process", t: idle, priv: 0, ws: 8192, prio: 0, exe: "", cmd: "" },
      { pid: 4, ppid: 0, name: "System", t: 0, priv: 200000, ws: 1, prio: 8, exe: "", cmd: "" },
      { pid: 700, ppid: 4, name: "csrss.exe", t: 0, priv: 1, ws: 1, prio: 13, exe: "", cmd: "" },
      { pid: 900, ppid: 4, name: "vmmemWSL", t: 0, priv: 1, ws: 1, prio: 8, exe: "", cmd: "" },
      { pid: 1200, ppid: 1100, name: "explorer.exe", t: 0, priv: 50 * 2 ** 20, ws: 1, prio: 8,
        exe: "C:\\Windows\\explorer.exe", cmd: "C:\\Windows\\Explorer.EXE" },
      { pid: 4321, ppid: 1200, name: "notepad.exe", t: notepad, priv: 12 * 2 ** 20, ws: 1, prio: 10,
        exe: "C:\\Windows\\notepad.exe", cmd: "notepad.exe --token=hunter2secret C:\\notes.txt" },
    ],
    nics: [{ id: "{nic-1}", name: "Ethernet", desc: "Intel I225-V", status: "Up", type: "Ethernet",
      mac: "A1B2C3D4E5F6", speed: 2500000000, rx, tx, ips: ["192.168.1.20", "fe80::1"] }],
  };
}

const NET_FIXTURE = {
  id: "r2", ok: true,
  tcp: [
    { la: "127.0.0.1", lp: 8182, ra: "0.0.0.0", rp: 0, state: "Listen", pid: 52824 },
    { la: "0.0.0.0", lp: 445, ra: "0.0.0.0", rp: 0, state: "Listen", pid: 4 },
    { la: "0.0.0.0", lp: 445, ra: "0.0.0.0", rp: 0, state: "Listen", pid: 4 }, // dual-listed: kept once
    { la: "10.0.0.5", lp: 50001, ra: "140.82.112.3", rp: 443, state: "Established", pid: 1300 },
    { la: "10.0.0.5", lp: 50002, ra: "140.82.112.4", rp: 443, state: "Established", pid: 1300 },
    { la: "127.0.0.1", lp: 50003, ra: "127.0.0.1", rp: 8182, state: "Established", pid: 4321 },
    { la: "10.0.0.5", lp: 50004, ra: "1.1.1.1", rp: 443, state: "TimeWait", pid: 0 },
  ],
  udp: [{ la: "0.0.0.0", lp: 5353, pid: 2000 }],
  names: [{ pid: 52824, name: "pythonw" }, { pid: 1300, name: "chrome" }, { pid: 4321, name: "notepad" }, { pid: 2000, name: "svchost" }],
  nics: [],
};

/** A worker double: answers each verb from a queue of fixtures. */
function fakeWorker(answers) {
  const calls = [];
  return {
    calls,
    request: async (verb) => {
      calls.push(verb);
      const list = answers[verb];
      if (!list || !list.length) throw new Error(`no fixture for ${verb}`);
      return list.length > 1 ? list.shift() : list[0];
    },
    stop() {},
  };
}

test("parseProcessSample types the worker's CIM answer", () => {
  const s = parseProcessSample(procsFixture());
  assert.equal(s.procs.length, 6);
  assert.equal(s.cores, 4);
  assert.equal(s.totalBytes, 16 * 2 ** 30);
  assert.equal(s.freeBytes, 4 * 2 ** 30);
  const notepad = s.procs.find((p) => p.pid === 4321);
  assert.equal(notepad.name, "notepad.exe");
  assert.equal(notepad.ppid, 1200);
  assert.equal(notepad.privateBytes, 12 * 2 ** 20);
  assert.equal(notepad.exe, "C:\\Windows\\notepad.exe");
  assert.equal(s.nics[0].mac, "A1:B2:C3:D4:E5:F6");
  assert.equal(s.nics[0].speedBps, 2.5e9);
  assert.deepEqual(s.nics[0].ips, ["192.168.1.20", "fe80::1"]);
  // A single object (ConvertTo-Json of a one-row array) still parses as one row.
  assert.equal(parseProcessSample({ ...procsFixture(), procs: procsFixture().procs[5] }).procs.length, 1);
});

test("CPU % is the kernel+user tick delta over elapsed ticks x cores; machine CPU = 100 - idle", () => {
  const a = parseProcessSample(procsFixture({ ticks: 0, idle: 0, notepad: 0 }));
  // 1 s later on 4 cores = 4e7 ticks of capacity. notepad used 2e6 (5 %), idle 3e7 (75 %).
  const b = parseProcessSample(procsFixture({ ticks: 1e7, idle: 3e7, notepad: 2e6 }));
  const cpu = computeCpu(a, b);
  assert.equal(cpu.perPid.get(4321), 5);
  assert.equal(cpu.total, 25);
  assert.equal(cpu.perPid.has(0), false, "idle is not a process row");
  // No previous sample: no numbers, never zeros that read as "idle".
  assert.equal(computeCpu(null, b).total, null);
  assert.equal(computeCpu(null, b).perPid.size, 0);
  // A pid reused under the same name with a LOWER counter is skipped, not negative.
  const reused = parseProcessSample(procsFixture({ ticks: 2e7, idle: 6e7, notepad: 1e5 }));
  assert.equal(computeCpu(b, reused).perPid.has(4321), false);
});

test("throughput is the byte-counter delta per second; a reset reads 0, not negative", () => {
  const a = parseProcessSample(procsFixture({ rx: 1000, tx: 500 })).nics;
  const b = parseProcessSample(procsFixture({ rx: 5000, tx: 2500 })).nics;
  const r = throughput(a, b, 2).get("{nic-1}");
  assert.deepEqual(r, { rxBps: 2000, txBps: 1000 });
  const reset = throughput(b, a, 2).get("{nic-1}");
  assert.deepEqual(reset, { rxBps: 0, txBps: 0 });
  assert.equal(throughput(a, b, 0).size, 0);
});

test("system-critical processes are refused with a stated reason", () => {
  assert.match(refusalFor({ pid: 700, name: "csrss.exe" }), /csrss\.exe is protected: .*blue-screens/);
  assert.match(refusalFor({ pid: 900, name: "vmmemWSL" }), /kills the whole AitherOS fleet/);
  assert.match(refusalFor({ pid: 901, name: "vmmem" }), /fleet/);
  for (const name of ["lsass.exe", "wininit.exe", "smss.exe", "services.exe", "winlogon.exe", "System"]) {
    assert.ok(refusalFor({ pid: 1000, name }), `${name} must be refused`);
  }
  assert.match(refusalFor({ pid: 4, name: "whatever" }), /protected/);
  assert.match(refusalFor({ pid: 55, name: "electron.exe" }, { selfPids: [55] }), /the desk itself/);
  assert.equal(refusalFor({ pid: 4321, name: "notepad.exe" }), null);
});

test("End process re-reads the pid, demands confirm, refuses protected trees, then kills", async () => {
  const killed = [];
  const taskkills = [];
  const mon = createSystemMonitor({
    platform: "win32",
    worker: fakeWorker({ procs: [procsFixture()] }),
    readGpu: async () => ({ holders: [] }),
    selfPids: () => [99999],
    kill: (pid) => killed.push(pid),
    execFile: (file, args, _opts, cb) => { taskkills.push([file, ...args]); cb(null, "", ""); },
  });
  assert.match((await mon.endProcess({ pid: 4321, name: "notepad.exe" })).reason, /not confirmed/);
  const refused = await mon.endProcess({ pid: 900, name: "vmmemWSL", confirm: true });
  assert.equal(refused.refused, true);
  assert.match(refused.reason, /fleet/);
  // System's tree contains csrss: refused before anything is ended.
  const tree = await mon.endProcess({ pid: 1200, name: "explorer.exe", tree: false, confirm: true });
  assert.equal(tree.ok, true);
  const csrssTree = await mon.endProcess({ pid: 4, name: "System", tree: true, confirm: true });
  assert.equal(csrssTree.ok, false);
  const moved = await mon.endProcess({ pid: 4321, name: "chrome.exe", confirm: true });
  assert.match(moved.reason, /is now notepad\.exe/);
  const ok = await mon.endProcess({ pid: 4321, name: "notepad.exe", confirm: true });
  assert.deepEqual(ok, { ok: true, ended: [4321], name: "notepad.exe" });
  const whole = await mon.endProcess({ pid: 1200, name: "explorer.exe", tree: true, confirm: true });
  assert.deepEqual(whole.ended, [1200, 4321]);
  assert.deepEqual(taskkills, [["taskkill.exe", "/PID", "1200", "/T", "/F"]]);
  assert.deepEqual(killed, [1200, 4321]);
});

test("a tree that contains a protected child is refused and names it", async () => {
  const fx = procsFixture();
  fx.procs.push({ pid: 950, ppid: 1200, name: "vmmemWSL", t: 0, priv: 1, ws: 1, prio: 8, exe: "", cmd: "" });
  const mon = createSystemMonitor({ platform: "win32", worker: fakeWorker({ procs: [fx] }), readGpu: async () => ({ holders: [] }),
    selfPids: () => [], kill: () => assert.fail("must not kill"), execFile: () => assert.fail("must not taskkill") });
  const r = await mon.endProcess({ pid: 1200, name: "explorer.exe", tree: true, confirm: true });
  assert.equal(r.refused, true);
  assert.match(r.reason, /includes vmmemWSL \(950\)/);
  assert.deepEqual(descendants(parseProcessSample(fx).procs, 1200).map((p) => p.pid).sort(), [4321, 950]);
});

test("set priority maps names to os levels and never offers realtime", async () => {
  const set = [];
  const mon = createSystemMonitor({ platform: "win32", worker: fakeWorker({ procs: [procsFixture()] }),
    readGpu: async () => ({ holders: [] }), setPriority: (pid, p) => set.push([pid, p]) });
  assert.deepEqual(await mon.setPriority({ pid: 4321, name: "notepad.exe", level: "below" }), { ok: true, pid: 4321, level: "below" });
  assert.deepEqual(set, [[4321, require("node:os").constants.priority.PRIORITY_BELOW_NORMAL]]);
  assert.match((await mon.setPriority({ pid: 4321, level: "realtime" })).reason, /realtime is never offered/);
  assert.equal((await mon.setPriority({ pid: 700, level: "high" })).refused, true);
});

test("snapshot shapes rows, summary, GPU attribution and the refusal per row", async () => {
  let ticks = 0;
  const answers = { procs: [procsFixture({ ticks: 0 }), procsFixture({ ticks: 1e7, idle: 2e7, notepad: 4e6, rx: 3000, tx: 1500 })] };
  const mon = createSystemMonitor({ platform: "win32", worker: fakeWorker(answers),
    readGpu: async () => ({ holders: [{ pid: 4321, name: "notepad", gib: 1.5 }] }), now: () => 1_000_000 + (ticks += 20_000) });
  await mon.snapshot();
  await new Promise((r) => setImmediate(r)); // let the GPU read land
  const s = await mon.snapshot();
  assert.equal(s.ok, true);
  assert.equal(s.summary.count, 5, "pid 0 is not a process row");
  assert.equal(s.summary.cpuPct, 50);
  assert.equal(s.summary.memPct, 75);
  assert.equal(s.summary.netRxBps, 2000);
  assert.equal(s.summary.netTxBps, 1000);
  const np = s.processes.find((p) => p.pid === 4321);
  assert.equal(np.cpu, 10);
  assert.equal(np.gpuGib, 1.5);
  assert.equal(np.priority, "above");
  assert.equal(np.refusal, null);
  assert.match(s.processes.find((p) => p.pid === 900).refusal, /fleet/);
  assert.equal(s.processes.find((p) => p.pid === 1200).children, 1);
  // The chat line is redacted and names the parent chain.
  const line = mon.askLine(4321);
  assert.match(line, /notepad\.exe \(pid 4321\): 10% CPU/);
  assert.match(line, /parent explorer\.exe\(1200\)/);
  assert.doesNotMatch(line, /hunter2secret/);
});

test("off Windows every verb is {ok:false, reason}, never an empty list", async () => {
  const mon = createSystemMonitor({ platform: "linux", worker: fakeWorker({}) });
  for (const r of [await mon.snapshot(), await mon.network(), await mon.startup(), await mon.agent.processes(), await mon.agent.ports({ port: 1 })]) {
    assert.deepEqual(r, { ok: false, reason: WINDOWS_ONLY });
  }
});

test("shapeNetwork maps listeners and connections to their process", () => {
  const n = shapeNetwork(NET_FIXTURE);
  assert.deepEqual(n.listening.map((l) => `${l.protocol}:${l.port}:${l.name}`), ["tcp:445:System", "udp:5353:svchost", "tcp:8182:pythonw"]);
  const gw = n.listening.find((l) => l.port === 8182);
  assert.equal(gw.pid, 52824);
  assert.equal(gw.exposed, false);
  assert.equal(n.listening.find((l) => l.port === 445).exposed, true);
  assert.equal(n.establishedTotal, 3, "TimeWait is not established");
  assert.equal(n.connections[0].name, "chrome");
  assert.equal(n.connections[0].count, 2);
  assert.deepEqual(n.connections[0].remotes, ["140.82.112.3:443", "140.82.112.4:443"]);
});

test("agent tools are read-only, redacted, and answer 'what is on :8182'", async () => {
  const mon = createSystemMonitor({ platform: "win32", sleep: async () => {},
    worker: fakeWorker({ procs: [procsFixture({ ticks: 0 }), procsFixture({ ticks: 1e7, idle: 3e7, notepad: 2e6 })], net: [NET_FIXTURE] }),
    readGpu: async () => ({ holders: [] }) });
  assert.equal(typeof mon.agent.kill, "undefined");
  assert.ok(Object.isFrozen(mon.agent));
  const procs = JSON.parse((await systemToolCall(mon.agent, "system_processes", { limit: 2 })).content[0].text);
  assert.equal(procs.ok, true);
  assert.equal(procs.processes[0].name, "notepad.exe");
  assert.equal(procs.processes[0].cpu_pct, 5);
  assert.equal(procs.shown, 2);
  assert.equal(procs.total, 5);
  assert.match(procs.processes[0].cmd, /--token=\*\*\*/);
  assert.doesNotMatch(procs.processes[0].cmd, /hunter2secret/);
  const ports = JSON.parse((await systemToolCall(mon.agent, "system_ports", { port: 8182 })).content[0].text);
  assert.deepEqual(ports.listening.map((l) => [l.port, l.name, l.pid]), [[8182, "pythonw", 52824]]);
  const conns = JSON.parse((await systemToolCall(mon.agent, "system_connections", { name: "chrome" })).content[0].text);
  assert.equal(conns.connections[0].count, 2);
  const unknown = await systemToolCall(mon.agent, "system_kill", { pid: 1 });
  assert.equal(unknown.isError, true);
});

test("redactCommandLine masks credential-shaped values and keeps the rest", () => {
  const out = redactCommandLine('node relay.cjs --relay-token abc123def456 --api-key="k e y" GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx --port 8182 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x sk-ant-api03-ABCDEFGHIJKL');
  assert.doesNotMatch(out, /abc123def456|k e y|ghp_x|eyJhbGci|ABCDEFGHIJKL/);
  assert.match(out, /--relay-token \*\*\*/);
  assert.match(out, /--port 8182/);
  assert.match(out, /node relay\.cjs/);
});

test("PsWorker correlates replies by id and fails pending calls when PowerShell dies", async () => {
  const spawned = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", null);
    child.stdin.on("data", (buf) => {
      for (const line of String(buf).split("\n").filter(Boolean)) {
        const [id, verb] = line.split(" ");
        if (verb === "die") { child.emit("exit", 1); continue; }
        // Split a reply across chunks and prefix noise: the parser must not care.
        const json = JSON.stringify({ id, ok: true, verb });
        child.stdout.write(`WARNING: noise\r\n${json.slice(0, 5)}`);
        child.stdout.write(`${json.slice(5)}\r\n`);
      }
    });
    spawned.push({ file, args, opts });
    return child;
  };
  const w = new PsWorker({ spawn });
  const [a, b] = await Promise.all([w.request("procs"), w.request("net")]);
  assert.equal(a.verb, "procs");
  assert.equal(b.verb, "net");
  assert.equal(spawned.length, 1, "one PowerShell for every request");
  assert.equal(spawned[0].file, "powershell.exe");
  assert.equal(spawned[0].opts.windowsHide, true, "a console must never flash");
  assert.ok(spawned[0].args.includes("-EncodedCommand"));
  await assert.rejects(w.request("die"), /exited/);
  assert.equal((await w.request("startup")).verb, "startup");
  assert.equal(spawned.length, 2, "a dead worker is replaced on the next call");
  w.stop();
});

test("probe reports ok+ms for a listener and the error for a closed port", async (t) => {
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const up = await probe({ id: "x", label: "x", host: "127.0.0.1", port, tls: false });
  assert.equal(up.ok, true);
  assert.ok(Number.isFinite(up.ms));
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const deadPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const down = await probe({ id: "y", label: "y", host: "127.0.0.1", port: deadPort, tls: false });
  assert.equal(down.ok, false);
  assert.equal(down.error, "ECONNREFUSED");
});

test("window handlers: Ask posts the redacted line, reveal opens the exe, refusals pass through", async () => {
  const posted = [];
  const revealed = [];
  const mon = createSystemMonitor({ platform: "win32", worker: fakeWorker({ procs: [procsFixture()] }), readGpu: async () => ({ holders: [] }) });
  await mon.snapshot();
  const h = systemHandlers({ monitor: mon, shell: { showItemInFolder: (p) => revealed.push(p) },
    handOff: async (text) => { posted.push(text); return { ok: true }; } });
  const ask = await h["desk:sys-ask"]({}, 4321);
  assert.equal(ask.ok, true);
  assert.match(posted[0], /notepad\.exe \(pid 4321\)/);
  assert.doesNotMatch(posted[0], /hunter2secret/);
  assert.deepEqual(await h["desk:sys-reveal"]({}, 4321), { ok: true, revealed: "C:\\Windows\\notepad.exe" });
  assert.deepEqual(revealed, ["C:\\Windows\\notepad.exe"]);
  assert.match((await h["desk:sys-reveal"]({}, 900)).reason, /no file path/);
  const end = await h["desk:sys-end"]({}, { pid: 700, name: "csrss.exe", confirm: true, smuggled: "x" });
  assert.equal(end.refused, true);
});

test("the desk MCP server registers the three system_* tools read-only, with no kill tool", async (t) => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { createBridgeServer } = require("./bridge-server.cjs");
  const { createDeskMcpHandler } = require("./mcp-server.cjs");
  const mon = createSystemMonitor({ platform: "win32", sleep: async () => {},
    worker: fakeWorker({ procs: [procsFixture({ ticks: 0 }), procsFixture({ ticks: 1e7, idle: 3e7, notepad: 2e6 })], net: [NET_FIXTURE] }),
    readGpu: async () => ({ holders: [] }) });
  const bridge = createBridgeServer({ port: 0, onEvent: () => {}, mcpHandler: createDeskMcpHandler({
    onAnimation: () => true, onWindowAction: () => true, getStatus: () => ({}), systemInfo: mon.agent }) });
  const address = await bridge.listen();
  const client = new Client({ name: "desk-test-system", version: "1.0.0" });
  t.after(async () => { await client.close(); await bridge.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const tools = (await client.listTools()).tools.filter((x) => x.name.startsWith("system_"));
  assert.deepEqual(tools.map((x) => x.name).sort(), ["system_connections", "system_ports", "system_processes"]);
  assert.ok(tools.every((x) => x.annotations.readOnlyHint === true && x.annotations.destructiveHint === false));
  const r = await client.callTool({ name: "system_ports", arguments: { port: 8182 } });
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(r.content[0].text).listening[0].name, "pythonw");
});
