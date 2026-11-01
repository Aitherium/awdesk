"use strict";

/**
 * system-monitor.cjs — the System window's backend: processes, ports,
 * connections, adapters, startup apps and fleet reachability, from the
 * Windows host. Electron-free (the window and the desk MCP server both sit on
 * it), so every parser and guard is testable under `node --test`.
 *
 * Owner, 2026-11-01: "stop using Windows Task Manager, Resource Monitor and
 * netstat". Two audiences, the files-access.cjs split:
 *
 *   OWNER (system-monitor-window.cjs): the full list with command lines, End
 *     process / End tree / Set priority / Open file location / Ask Aither.
 *   AGENTS (desk MCP system_processes / system_ports / system_connections):
 *     READ-ONLY, command lines redacted. There is no kill tool, by design.
 *
 * 🚩 ONE PowerShell, kept alive. Measured 2026-11-01 on the owner's box (1,971
 * processes, host under load): powershell.exe startup alone 3.4 s,
 * Win32_PerfFormattedData_PerfProc_Process 3.9 s, Win32_Process 0.8 s,
 * Get-NetAdapterStatistics 3.1 s. A spawn per 2 s refresh would never finish
 * before the next one, so a single hidden worker (windowsHide, no console
 * flash -- never wscript/Exec) answers line-delimited requests on stdin, and
 * the slow sources are replaced by equivalent fast ones:
 *   - CPU % is the delta of Win32_Process KernelModeTime+UserModeTime (100 ns
 *     ticks) between two samples, over elapsed ticks x logical cores -- the
 *     same arithmetic the formatted perf counter does, without its 3.9 s.
 *   - Adapter bytes come from .NET NetworkInterface.GetIPStatistics(), the
 *     counters Get-NetAdapterStatistics reads, in milliseconds.
 * Machine CPU is 100 - the System Idle Process's (pid 0) share, so a process
 * that exited between samples does not make the box look idle.
 *
 * Off Windows every verb answers {ok:false, reason}: never an empty list that
 * reads as "nothing running".
 */

const childProcess = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const tls = require("node:tls");

const WINDOWS_ONLY = "the System window reads Windows counters; on this platform use Activity Monitor or htop";

// ---------------------------------------------------------------------------
// The worker's script. One request per stdin line ("<id> <verb>"), one JSON
// line back carrying the same id. stdin closing (the desk exiting) ends it.
// ---------------------------------------------------------------------------
const WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$cores = [Environment]::ProcessorCount
function Emit($o) { [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject $o)); [Console]::Out.Flush() }
function Nics {
  foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ([string]$n.NetworkInterfaceType -eq 'Loopback') { continue }
    $s = $null; try { $s = $n.GetIPStatistics() } catch { }
    $ips = @(); try { $ips = @($n.GetIPProperties().UnicastAddresses | ForEach-Object { $_.Address.ToString() }) } catch { }
    [pscustomobject]@{ id = [string]$n.Id; name = [string]$n.Name; desc = [string]$n.Description;
      status = [string]$n.OperationalStatus; type = [string]$n.NetworkInterfaceType;
      mac = [string]$n.GetPhysicalAddress().ToString(); speed = [long]$n.Speed;
      rx = [long]$s.BytesReceived; tx = [long]$s.BytesSent; ips = $ips }
  }
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(' ', 2); $id = $parts[0]; $verb = $parts[1]
  try {
    switch ($verb) {
      'procs' {
        $t = [DateTime]::UtcNow.Ticks
        $p = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,PrivatePageCount,WorkingSetSize,CommandLine,ExecutablePath,Priority |
          ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name;
            t = ([long]$_.KernelModeTime + [long]$_.UserModeTime); priv = [long]$_.PrivatePageCount; ws = [long]$_.WorkingSetSize;
            prio = [int]$_.Priority; exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine } })
        $os = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory
        Emit ([pscustomobject]@{ id = $id; ok = $true; ticks = $t; cores = $cores;
          totalKb = [long]$os.TotalVisibleMemorySize; freeKb = [long]$os.FreePhysicalMemory; procs = $p; nics = @(Nics) })
      }
      'net' {
        $tcp = @(Get-NetTCPConnection | ForEach-Object { [pscustomobject]@{ la = [string]$_.LocalAddress; lp = [int]$_.LocalPort;
          ra = [string]$_.RemoteAddress; rp = [int]$_.RemotePort; state = [string]$_.State; pid = [int]$_.OwningProcess } })
        $udp = @(Get-NetUDPEndpoint | ForEach-Object { [pscustomobject]@{ la = [string]$_.LocalAddress; lp = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })
        $names = @(Get-Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.Id; name = [string]$_.ProcessName } })
        Emit ([pscustomobject]@{ id = $id; ok = $true; tcp = $tcp; udp = $udp; names = $names; nics = @(Nics) })
      }
      'startup' {
        $rows = @()
        foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')) {
          $item = Get-Item -LiteralPath $k
          if ($item) { foreach ($n in $item.GetValueNames()) { if ($n -ne '') { $rows += [pscustomobject]@{ source = $k; name = [string]$n; command = [string]$item.GetValue($n) } } } }
        }
        foreach ($f in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
          if ($f -and (Test-Path -LiteralPath $f)) {
            Get-ChildItem -LiteralPath $f -File | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object { $rows += [pscustomobject]@{ source = $f; name = [string]$_.Name; command = [string]$_.FullName } }
          }
        }
        Emit ([pscustomobject]@{ id = $id; ok = $true; items = $rows })
      }
      default { Emit ([pscustomobject]@{ id = $id; ok = $false; error = ('unknown verb ' + $verb) }) }
    }
  } catch { Emit ([pscustomobject]@{ id = $id; ok = $false; error = [string]$_.Exception.Message }) }
}
`;

function encodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * The long-lived hidden PowerShell. request(verb) resolves the parsed JSON line
 * or rejects with a reason; a dead or wedged worker is replaced on the next call.
 */
class PsWorker {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.spawn]  child_process.spawn (test seam)
   * @param {number}   [opts.idleMs] stop the worker after this long without a request
   */
  constructor({ spawn = childProcess.spawn, idleMs = 120_000 } = {}) {
    this.spawnImpl = spawn;
    this.idleMs = idleMs;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.buffer = "";
    this.idleTimer = null;
  }

  start() {
    if (this.child) return this.child;
    const child = this.spawnImpl("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(WORKER_SCRIPT)],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    if (child.stderr) child.stderr.on("data", () => { /* PowerShell noise; verdicts come on stdout */ });
    const gone = (why) => {
      if (this.child !== child) return;
      this.child = null;
      for (const [, waiter] of this.pending) waiter.reject(new Error(why));
      this.pending.clear();
    };
    child.on("exit", (code) => gone(`PowerShell reader exited (code ${code})`));
    child.on("error", (error) => gone(`PowerShell reader failed to start: ${error.message}`));
    if (child.stdin && typeof child.stdin.on === "function") child.stdin.on("error", () => gone("PowerShell reader closed its input"));
    return child;
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const waiter = this.pending.get(String(parsed.id));
      if (!waiter) continue;
      this.pending.delete(String(parsed.id));
      waiter.resolve(parsed);
    }
  }

  request(verb, { timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.start(); } catch (error) { reject(error); return; }
      const id = `r${++this.seq}`;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`PowerShell reader did not answer "${verb}" in ${Math.round(timeoutMs / 1000)} s`));
        this.stop(); // wedged: the next request gets a fresh one
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.touch();
      try { child.stdin.write(`${id} ${verb}\n`); } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  stop() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const child = this.child;
    if (!child) return;
    this.child = null;
    for (const [, waiter] of this.pending) waiter.reject(new Error("PowerShell reader stopped"));
    this.pending.clear();
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Pure shaping
// ---------------------------------------------------------------------------

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v && typeof v === "object" ? [v] : [];
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** The worker's "procs" answer -> a typed sample. */
function parseProcessSample(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const procs = asArray(r.procs)
    .map((p) => ({
      pid: num(p.pid, -1),
      ppid: num(p.ppid, 0),
      name: String(p.name || ""),
      cpuTicks: num(p.t),
      privateBytes: num(p.priv),
      workingSet: num(p.ws),
      basePriority: num(p.prio),
      exe: String(p.exe || ""),
      cmd: String(p.cmd || ""),
    }))
    .filter((p) => Number.isInteger(p.pid) && p.pid >= 0);
  return {
    ticks: num(r.ticks),
    cores: Math.max(1, num(r.cores, 1)),
    totalBytes: num(r.totalKb) * 1024,
    freeBytes: num(r.freeKb) * 1024,
    procs,
    nics: parseNics(r.nics),
  };
}

function parseNics(raw) {
  return asArray(raw).map((n) => ({
    id: String(n.id || n.name || ""),
    name: String(n.name || ""),
    description: String(n.desc || ""),
    status: String(n.status || ""),
    type: String(n.type || ""),
    mac: formatMac(n.mac),
    speedBps: num(n.speed),
    rx: num(n.rx),
    tx: num(n.tx),
    ips: asArray(n.ips).map(String).filter(Boolean),
  })).filter((n) => n.id);
}

function formatMac(mac) {
  const hex = String(mac || "").replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return "";
  return hex.match(/../g).join(":").toUpperCase();
}

const procKey = (p) => `${p.pid}|${p.name}`;

/**
 * CPU % per process between two samples, normalised to the whole machine
 * (100 % = every logical core busy), plus the machine total.
 * @returns {{perPid: Map<number, number>, total: number|null}}
 */
function computeCpu(prev, cur) {
  const perPid = new Map();
  if (!prev || !cur) return { perPid, total: null };
  const dt = cur.ticks - prev.ticks;
  if (!(dt > 0)) return { perPid, total: null };
  const capacity = dt * cur.cores;
  const before = new Map(prev.procs.map((p) => [procKey(p), p.cpuTicks]));
  let busy = 0;
  let idle = null;
  for (const p of cur.procs) {
    const was = before.get(procKey(p));
    if (was === undefined) continue; // new since the last sample: no interval to judge
    const delta = p.cpuTicks - was;
    if (delta < 0) continue; // pid reused under the same name
    const pct = Math.min(100, (delta / capacity) * 100);
    if (p.pid === 0) { idle = pct; continue; }
    perPid.set(p.pid, round1(pct));
    busy += pct;
  }
  const total = idle === null ? Math.min(100, busy) : Math.max(0, Math.min(100, 100 - idle));
  return { perPid, total: round1(total) };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Bytes per second per adapter between two adapter readings. A counter that
 * went backwards (adapter reset, sleep) reads 0, never a negative spike.
 */
function throughput(prevNics, curNics, seconds) {
  const out = new Map();
  if (!(seconds > 0)) return out;
  const before = new Map(asArray(prevNics).map((n) => [n.id, n]));
  for (const n of asArray(curNics)) {
    const p = before.get(n.id);
    if (!p) continue;
    const rx = n.rx - p.rx;
    const tx = n.tx - p.tx;
    out.set(n.id, { rxBps: rx >= 0 ? Math.round(rx / seconds) : 0, txBps: tx >= 0 ? Math.round(tx / seconds) : 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The kill guard
// ---------------------------------------------------------------------------

const FLEET_REASON = "it hosts the WSL2 VM -- ending it kills the whole AitherOS fleet";
const CRITICAL = Object.freeze({
  system: "the Windows kernel",
  "system idle process": "not a process -- it is the CPU's idle time",
  idle: "not a process -- it is the CPU's idle time",
  registry: "the kernel's registry process",
  "memory compression": "the kernel's memory manager",
  "secure system": "the kernel's secure world",
  smss: "the session manager -- Windows halts",
  csrss: "the client/server runtime -- Windows blue-screens",
  wininit: "Windows init -- Windows blue-screens",
  winlogon: "the logon process -- the session ends",
  services: "the service control manager -- Windows halts",
  lsass: "the security authority -- Windows reboots",
  lsaiso: "credential guard -- Windows reboots",
  vmmem: FLEET_REASON,
  vmmemwsl: FLEET_REASON,
  vmwp: FLEET_REASON,
  vmcompute: FLEET_REASON,
  wslservice: FLEET_REASON,
});

function baseName(name) {
  return String(name || "").trim().toLowerCase().replace(/\.exe$/, "");
}

/**
 * Why this process may not be ended or reprioritised from the desk, or null.
 * @param {{pid:number, name:string}} proc
 * @param {{selfPids?: number[]}} [opts] the desk's own processes
 */
function refusalFor(proc, { selfPids = [process.pid] } = {}) {
  if (!proc) return "that process is not running any more";
  const pid = Number(proc.pid);
  if (pid === 0 || pid === 4) return `${proc.name || `pid ${pid}`} is protected: ${CRITICAL.system}`;
  const why = CRITICAL[baseName(proc.name)];
  if (why) return `${proc.name} is protected: ${why}`;
  if (selfPids.includes(pid)) return `${proc.name} is the desk itself -- quit it from the tray instead`;
  return null;
}

/** The pid and every descendant, from a sample's process list. */
function descendants(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const stack = [...(kids.get(rootPid) || [])];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    stack.push(...(kids.get(p.pid) || []));
  }
  return out;
}

/** name(pid) <- parent(pid) <- ... up to 12 levels; stops on a missing or looping parent. */
function ancestry(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = [];
  const seen = new Set();
  let cur = byPid.get(pid);
  while (cur && chain.length < 12 && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    chain.push({ pid: cur.pid, name: cur.name });
    cur = cur.ppid !== cur.pid ? byPid.get(cur.ppid) : null;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Redaction for the agent audience (and anything posted to the chat)
// ---------------------------------------------------------------------------

const SECRET_FLAG = /((?:^|\s)--?[\w.-]*(?:token|secret|password|passwd|pwd|apikey|api[-_]key|bearer|auth|credential|cookie)[\w.-]*(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_ENV = /(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*=)("[^"]*"|\S+)/g;
const SECRET_SHAPES = /\b(?:sk-ant-|sk-|ghp_|ghs_|gho_|github_pat_|xox[abposr]-|sk_live_|pk_live_|AKIA)[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** A command line with credential-shaped values masked. */
function redactCommandLine(cmd) {
  return String(cmd || "")
    .replace(SECRET_FLAG, (_m, flag) => `${flag}***`)
    .replace(SECRET_ENV, (_m, k) => `${k}***`)
    .replace(BEARER, (_m, b) => `${b}***`)
    .replace(SECRET_SHAPES, "***");
}

// ---------------------------------------------------------------------------
// Networking shaping
// ---------------------------------------------------------------------------

const WILDCARD = new Set(["0.0.0.0", "::", ""]);

/** The worker's "net" answer -> listening ports + established connections per process. */
function shapeNetwork(raw, { nameOf = null } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const names = new Map(asArray(r.names).map((n) => [num(n.pid, -1), String(n.name || "")]));
  const name = (pid) => names.get(pid) || (nameOf && nameOf(pid)) || (pid === 4 ? "System" : `pid ${pid}`);
  const tcp = asArray(r.tcp).map((c) => ({
    localAddress: String(c.la || ""), localPort: num(c.lp), remoteAddress: String(c.ra || ""),
    remotePort: num(c.rp), state: String(c.state || ""), pid: num(c.pid),
  }));
  const listening = [];
  const seen = new Set();
  for (const c of tcp) {
    if (c.state !== "Listen") continue;
    const key = `tcp|${c.localAddress}|${c.localPort}|${c.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listening.push({ protocol: "tcp", address: c.localAddress, port: c.localPort, pid: c.pid, name: name(c.pid),
      exposed: WILDCARD.has(c.localAddress) });
  }
  for (const u of asArray(r.udp)) {
    const entry = { protocol: "udp", address: String(u.la || ""), port: num(u.lp), pid: num(u.pid), name: name(num(u.pid)) };
    entry.exposed = WILDCARD.has(entry.address);
    const key = `udp|${entry.address}|${entry.port}|${entry.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listening.push(entry);
  }
  listening.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));

  const byPid = new Map();
  for (const c of tcp) {
    if (c.state !== "Established") continue;
    if (!byPid.has(c.pid)) byPid.set(c.pid, { pid: c.pid, name: name(c.pid), count: 0, remotes: [] });
    const g = byPid.get(c.pid);
    g.count += 1;
    g.remotes.push(`${c.remoteAddress}:${c.remotePort}`);
  }
  const connections = [...byPid.values()].sort((a, b) => b.count - a.count);
  for (const g of connections) g.remotes = [...new Set(g.remotes)].sort();
  return { listening, connections, establishedTotal: connections.reduce((a, g) => a + g.count, 0) };
}

// ---------------------------------------------------------------------------
// Fleet reachability
// ---------------------------------------------------------------------------

const FLEET_PROBES = Object.freeze([
  Object.freeze({ id: "gateway", label: "MCP gateway", host: "127.0.0.1", port: 8182, tls: false }),
  Object.freeze({ id: "microscheduler", label: "MicroScheduler", host: "127.0.0.1", port: 8150, tls: true }),
  Object.freeze({ id: "aitherium", label: "api.aitherium.com", host: "api.aitherium.com", port: 443, tls: true }),
]);

/**
 * One reachability probe. A TLS target must complete a handshake, because a
 * loopback forwarder (wsl socat) ACCEPTS TCP even when nothing answers behind
 * it. Nothing is sent: the socket closes after the handshake, and `trusted`
 * reports whether the certificate verified (internal CA for loopback).
 */
function probe(target, { timeoutMs = 4000, now = () => Date.now(), connect = net.connect, tlsConnect = tls.connect, ca } = {}) {
  return new Promise((resolve) => {
    const started = now();
    let socket;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.destroy(); } catch { /* closed */ }
      resolve({ id: target.id, label: target.label, host: target.host, port: target.port, ms: now() - started, ...result });
    };
    try {
      if (target.tls) {
        socket = tlsConnect({ host: target.host, port: target.port, servername: net.isIP(target.host) ? undefined : target.host,
          rejectUnauthorized: false, ...(ca ? { ca } : {}) });
        socket.once("secureConnect", () => done({ ok: true, trusted: socket.authorized === true,
          note: socket.authorized ? undefined : `certificate not verified (${socket.authorizationError || "unknown"})` }));
      } else {
        socket = connect({ host: target.host, port: target.port });
        socket.once("connect", () => done({ ok: true }));
      }
      socket.once("error", (error) => done({ ok: false, error: error.code || error.message }));
      socket.setTimeout(timeoutMs, () => done({ ok: false, error: `no answer in ${timeoutMs} ms` }));
    } catch (error) {
      done({ ok: false, error: String(error.message || error) });
    }
  });
}

// ---------------------------------------------------------------------------
// The monitor: stateful sampler + owner actions + the agent's read-only half
// ---------------------------------------------------------------------------

const PRIORITY_LEVELS = Object.freeze({
  idle: os.constants.priority.PRIORITY_LOW,
  below: os.constants.priority.PRIORITY_BELOW_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  above: os.constants.priority.PRIORITY_ABOVE_NORMAL,
  high: os.constants.priority.PRIORITY_HIGH,
});

/** Win32_Process.Priority (base priority) -> the level name the window shows. */
function priorityName(base) {
  const b = Number(base);
  if (b >= 24) return "realtime";
  if (b >= 13) return "high";
  if (b >= 10) return "above";
  if (b >= 8) return "normal";
  if (b >= 6) return "below";
  if (b > 0) return "idle";
  return "";
}

const HISTORY = 30;

/**
 * @param {object} [deps]
 * @param {string}   [deps.platform]
 * @param {PsWorker} [deps.worker]
 * @param {Function} [deps.readGpu]   () => Promise<{holders, error}> (gpu-holders.cjs readGpuHolders)
 * @param {Function} [deps.selfPids]  () => number[] -- the desk's own processes
 * @param {Function} [deps.kill]      (pid) => void (process.kill)
 * @param {Function} [deps.execFile]  child_process.execFile (taskkill for a tree)
 * @param {Function} [deps.setPriority] os.setPriority
 * @param {Function} [deps.probeImpl] probe
 * @param {Function} [deps.sleep]     ms => Promise
 */
function createSystemMonitor({
  platform = process.platform,
  worker = null,
  readGpu = null,
  selfPids = () => [process.pid],
  kill = (pid) => process.kill(pid),
  execFile = childProcess.execFile,
  setPriority = os.setPriority,
  probeImpl = probe,
  caOptions = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const supported = platform === "win32";
  let ps = worker;
  const reader = () => (ps || (ps = new PsWorker()));
  const gpuRead = readGpu || (() => require("./gpu-holders.cjs").readGpuHolders());
  let prev = null;
  let last = null; // { sample, cpu, at }
  let gpu = { holders: [], error: null, at: 0 };
  let gpuInflight = null;
  const history = new Map(); // nic id -> [{rxBps, txBps}]

  const unsupported = () => ({ ok: false, reason: WINDOWS_ONLY });

  function refreshGpu() {
    if (gpuInflight || now() - gpu.at < 10_000) return;
    gpuInflight = Promise.resolve()
      .then(() => gpuRead())
      .then((r) => { gpu = { holders: (r && r.holders) || [], error: (r && r.error) || null, at: now() }; })
      .catch((e) => { gpu = { holders: [], error: String(e.message || e), at: now() }; })
      .finally(() => { gpuInflight = null; });
  }

  async function sampleOnce() {
    const raw = await reader().request("procs");
    if (!raw || raw.ok === false) throw new Error((raw && raw.error) || "PowerShell answered nothing");
    const sample = parseProcessSample(raw);
    const cpu = computeCpu(prev, sample);
    if (prev) {
      const rates = throughput(prev.nics, sample.nics, (sample.ticks - prev.ticks) / 1e7);
      for (const [id, rate] of rates) {
        const h = history.get(id) || [];
        h.push(rate);
        while (h.length > HISTORY) h.shift();
        history.set(id, h);
      }
    }
    prev = sample;
    last = { sample, cpu, at: now() };
    return last;
  }

  /** A sample with CPU numbers: one more 1 s sample when there is no fresh previous one. */
  async function sampleWithCpu() {
    if (!last || now() - last.at > 10_000) {
      await sampleOnce();
      await sleep(1000);
    }
    return sampleOnce();
  }

  function rows({ sample, cpu }) {
    const gpuByPid = new Map(gpu.holders.map((h) => [h.pid, h.gib]));
    const kids = new Map();
    for (const p of sample.procs) kids.set(p.ppid, (kids.get(p.ppid) || 0) + 1);
    const self = selfPids();
    return sample.procs.filter((p) => p.pid !== 0).map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      cpu: cpu.perPid.has(p.pid) ? cpu.perPid.get(p.pid) : null,
      privateBytes: p.privateBytes,
      workingSet: p.workingSet,
      gpuGib: gpuByPid.has(p.pid) ? gpuByPid.get(p.pid) : null,
      priority: priorityName(p.basePriority),
      exe: p.exe,
      cmd: p.cmd,
      children: kids.get(p.pid) || 0,
      refusal: refusalFor(p, { selfPids: self }),
    }));
  }

  function summaryOf({ sample, cpu }) {
    let rxBps = 0;
    let txBps = 0;
    for (const n of sample.nics) {
      const h = history.get(n.id);
      if (h && h.length) { rxBps += h[h.length - 1].rxBps; txBps += h[h.length - 1].txBps; }
    }
    const used = sample.totalBytes - sample.freeBytes;
    return {
      count: sample.procs.filter((p) => p.pid !== 0).length,
      cores: sample.cores,
      cpuPct: cpu.total,
      memUsedBytes: used,
      memTotalBytes: sample.totalBytes,
      memPct: sample.totalBytes > 0 ? round1((used / sample.totalBytes) * 100) : null,
      netRxBps: history.size ? rxBps : null,
      netTxBps: history.size ? txBps : null,
    };
  }

  async function guard(fn) {
    if (!supported) return unsupported();
    try {
      return await fn();
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error) };
    }
  }

  async function snapshot() {
    return guard(async () => {
      refreshGpu();
      const s = await sampleOnce();
      return { ok: true, at: s.at, summary: summaryOf(s), processes: rows(s), gpuError: gpu.error };
    });
  }

  async function network() {
    return guard(async () => {
      const raw = await reader().request("net");
      if (!raw || raw.ok === false) throw new Error((raw && raw.error) || "PowerShell answered nothing");
      const byPid = last ? new Map(last.sample.procs.map((p) => [p.pid, p.name])) : new Map();
      const shaped = shapeNetwork(raw, { nameOf: (pid) => byPid.get(pid) });
      const adapters = parseNics(raw.nics).map((n) => ({ ...n, history: history.get(n.id) || [] }))
        .sort((a, b) => (a.status === "Up" ? 0 : 1) - (b.status === "Up" ? 0 : 1) || a.name.localeCompare(b.name));
      return { ok: true, ...shaped, adapters };
    });
  }

  async function probes() {
    const ca = caOptions ? caOptions() : (() => { try { return require("./internal-ca.cjs").internalCaOptions().ca; } catch { return undefined; } })();
    const results = await Promise.all(FLEET_PROBES.map((t) => probeImpl(t, { ca: t.host === "127.0.0.1" ? ca : undefined })));
    return { ok: true, probes: results };
  }

  async function startup() {
    return guard(async () => {
      const raw = await reader().request("startup");
      if (!raw || raw.ok === false) throw new Error((raw && raw.error) || "PowerShell answered nothing");
      const items = asArray(raw.items).map((i) => ({ source: String(i.source || ""), name: String(i.name || ""), command: String(i.command || "") }));
      return { ok: true, items };
    });
  }

  /** Resolve a pid against a FRESH sample: the name must still match what the owner saw. */
  async function fresh(pid, name) {
    const s = await sampleOnce();
    const p = s.sample.procs.find((x) => x.pid === pid);
    if (!p) return { error: `pid ${pid} is not running any more` };
    if (name && baseName(p.name) !== baseName(name)) return { error: `pid ${pid} is now ${p.name}, not ${name} -- refresh and pick again` };
    return { proc: p, sample: s.sample };
  }

  /** End one process or its whole tree. `confirm:true` is the UI's explicit second click. */
  async function endProcess({ pid, name, tree = false, confirm = false } = {}) {
    return guard(async () => {
      const id = Number(pid);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "bad pid" };
      if (confirm !== true) return { ok: false, reason: "not confirmed -- the window asks first" };
      const f = await fresh(id, name);
      if (f.error) return { ok: false, reason: f.error };
      const self = selfPids();
      const why = refusalFor(f.proc, { selfPids: self });
      if (why) return { ok: false, refused: true, reason: why };
      if (tree) {
        const below = descendants(f.sample.procs, id);
        for (const d of below) {
          const r = refusalFor(d, { selfPids: self });
          if (r) return { ok: false, refused: true, reason: `the tree under ${f.proc.name} includes ${d.name} (${d.pid}): ${r}` };
        }
        await new Promise((resolve, reject) => {
          execFile("taskkill.exe", ["/PID", String(id), "/T", "/F"], { windowsHide: true, timeout: 10_000 },
            (error, _stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve()));
        });
        return { ok: true, ended: [id, ...below.map((d) => d.pid)], name: f.proc.name };
      }
      kill(id);
      return { ok: true, ended: [id], name: f.proc.name };
    });
  }

  async function setProcessPriority({ pid, name, level } = {}) {
    return guard(async () => {
      const id = Number(pid);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "bad pid" };
      if (!Object.prototype.hasOwnProperty.call(PRIORITY_LEVELS, level)) {
        return { ok: false, reason: `level must be one of ${Object.keys(PRIORITY_LEVELS).join(", ")} (realtime is never offered)` };
      }
      const f = await fresh(id, name);
      if (f.error) return { ok: false, reason: f.error };
      const why = refusalFor(f.proc, { selfPids: [] }); // the desk may lower/raise itself
      if (why) return { ok: false, refused: true, reason: why };
      setPriority(id, PRIORITY_LEVELS[level]);
      return { ok: true, pid: id, level };
    });
  }

  /** The newest sample's row for a pid (exe path, ancestry) -- the window's detail/reveal/ask. */
  function lookup(pid) {
    if (!last) return null;
    const p = last.sample.procs.find((x) => x.pid === Number(pid));
    if (!p) return null;
    return { ...p, cpu: last.cpu.perPid.get(p.pid) ?? null, ancestry: ancestry(last.sample.procs, p.pid),
      gpuGib: (gpu.holders.find((h) => h.pid === p.pid) || {}).gib ?? null };
  }

  /** One line for the chat: what it is, what it costs, where it came from. Redacted. */
  function askLine(pid) {
    const p = lookup(pid);
    if (!p) return null;
    const mem = `${(p.privateBytes / 2 ** 30).toFixed(2)} GiB private`;
    const cpu = p.cpu == null ? "CPU not sampled yet" : `${p.cpu}% CPU`;
    const gpuPart = p.gpuGib != null ? `, ${p.gpuGib} GiB GPU` : "";
    const parents = p.ancestry.slice(1, 4).map((a) => `${a.name}(${a.pid})`).join(" <- ");
    const cmd = redactCommandLine(p.cmd).slice(0, 200);
    return `🖥️ The owner asks about ${p.name} (pid ${p.pid}): ${cpu}, ${mem}${gpuPart}` +
      `${parents ? `; parent ${parents}` : ""}${cmd ? `; cmd: ${cmd}` : ""}. What is it, and should it be running?`;
  }

  // -- the agent's half: read-only, redacted -------------------------------
  const SORTS = {
    cpu: (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1),
    memory: (a, b) => b.privateBytes - a.privateBytes,
    gpu: (a, b) => (b.gpuGib ?? -1) - (a.gpuGib ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
  };

  const agent = Object.freeze({
    async processes({ sort = "cpu", limit = 15, filter = "" } = {}) {
      return guard(async () => {
        refreshGpu();
        if (gpuInflight && !gpu.at) await gpuInflight; // first call: let the GPU column land once
        const s = await sampleWithCpu();
        const q = String(filter || "").toLowerCase();
        let list = rows(s).filter((r) => !q || r.name.toLowerCase().includes(q) || String(r.pid) === q);
        list.sort(SORTS[sort] || SORTS.cpu);
        const total = list.length;
        list = list.slice(0, Math.max(1, Math.min(200, Number(limit) || 15)));
        return {
          ok: true, summary: summaryOf(s), total, shown: list.length, sort,
          processes: list.map((r) => ({ pid: r.pid, ppid: r.ppid, name: r.name, cpu_pct: r.cpu,
            private_mib: Math.round(r.privateBytes / 2 ** 20), gpu_gib: r.gpuGib, priority: r.priority,
            cmd: redactCommandLine(r.cmd).slice(0, 300) })),
          note: "cpu_pct is the share of the whole machine (100 = every core busy).",
        };
      });
    },
    async ports({ port, protocol } = {}) {
      const r = await network();
      if (!r.ok) return r;
      let list = r.listening;
      if (port !== undefined && port !== null && port !== "") list = list.filter((l) => l.port === Number(port));
      if (protocol) list = list.filter((l) => l.protocol === protocol);
      return { ok: true, total: list.length, listening: list.slice(0, 300),
        note: port !== undefined && list.length === 0 ? `nothing is listening on :${port}` : undefined };
    },
    async connections({ pid, name, limit = 20 } = {}) {
      const r = await network();
      if (!r.ok) return r;
      let list = r.connections;
      if (pid !== undefined && pid !== null) list = list.filter((c) => c.pid === Number(pid));
      if (name) list = list.filter((c) => c.name.toLowerCase().includes(String(name).toLowerCase()));
      return { ok: true, establishedTotal: r.establishedTotal, total: list.length,
        connections: list.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)))
          .map((c) => ({ ...c, remotes: c.remotes.slice(0, 50) })) };
    },
  });

  return {
    supported, snapshot, network, probes, startup, endProcess, setPriority: setProcessPriority,
    lookup, askLine, agent, stop: () => { if (ps) ps.stop(); },
  };
}

/** MCP tool result wrapper for the agent half (files-access.cjs agentToolCall shape). */
async function systemToolCall(agent, name, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const done = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: value.ok === false });
  try {
    if (name === "system_processes") return done(await agent.processes({ sort: a.sort, limit: a.limit, filter: a.filter }));
    if (name === "system_ports") return done(await agent.ports({ port: a.port, protocol: a.protocol }));
    if (name === "system_connections") return done(await agent.connections({ pid: a.pid, name: a.name, limit: a.limit }));
    return done({ ok: false, reason: `unknown system tool ${name}` });
  } catch (error) {
    return done({ ok: false, reason: String((error && error.message) || error) });
  }
}

module.exports = {
  CRITICAL, FLEET_PROBES, PRIORITY_LEVELS, PsWorker, WINDOWS_ONLY, WORKER_SCRIPT,
  ancestry, computeCpu, createSystemMonitor, descendants, encodedCommand, formatMac,
  parseNics, parseProcessSample, priorityName, probe, redactCommandLine, refusalFor,
  shapeNetwork, systemToolCall, throughput,
};
