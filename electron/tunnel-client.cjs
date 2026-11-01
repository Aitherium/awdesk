"use strict";

/**
 * tunnel-client.cjs — "give this local port a public URL" in one click: the
 * desk's door onto the `awtunnel` CLI (AitherOS/packages/awtunnel).
 *
 * The desk owns none of the tunnel logic. awtunnel runs cloudflared, writes a
 * state file and answers `status` / `down` against it. What the CLI knows
 * (measured from its source and `awtunnel <verb> --help`, 2026-11-01):
 *
 *   awtunnel up --port N [--host H] [--protocol http|https]
 *       FOREGROUND: prints the public URL as its first stdout line, writes the
 *       state file {pid, cloudflared_pid, url, port, host, started}, then runs
 *       until killed. Exit 2 = "DEAD: tunnel did not come up" on stderr.
 *   awtunnel status   -> pretty JSON {...state, alive} (exit 0 alive, 1 dead),
 *                        or "no tunnel recorded" (exit 1).
 *   awtunnel down     -> "stopped" (exit 0) | "nothing was running; state
 *                        cleared" (exit 1) | "no tunnel recorded" (exit 1).
 *
 * The CLI records ONE tunnel per state file, and the file is `AWTUNNEL_STATE`
 * (default ~/.awtunnel/state.json). So the desk gives every port its own file,
 * ~/.awtunnel/desk/port-<N>.json, and passes it as AWTUNNEL_STATE: several ports
 * can be public at once, and a tunnel the owner started by hand with the bare
 * CLI (the default file) is still listed and can still be stopped.
 *
 * Fleet internals are refused by default (denyPorts(): every port declared in
 * AitherOS/config/services.yaml, plus the local aw* daemons, each with its named
 * reason; FALLBACK_DENY_PORTS when the file cannot be read, e.g. a packaged
 * desk). The override is explicit — `allowInternal: true` — and is never inferred.
 *
 * A recorded pid is never trusted on its own: Windows recycles pids fast, and
 * `awtunnel down` runs `taskkill /T /F` on whatever owns the recorded pids. So
 * before any `down` (and before calling a port "already public") the desk asks
 * the OS who owns each pid: the wrapper must be python/awtunnel and cloudflared
 * must be cloudflared, both started no later than the record. A dead record is
 * cleared by the desk itself and never reaches `down`.
 *
 * Nothing reaches a shell: every child is execFile/spawn with an argv and
 * windowsHide:true. On Windows `up` is NOT detached: DETACHED_PROCESS leaves the
 * wrapper with no console, and the cloudflared.exe it starts then gets a new
 * VISIBLE console (PQ040); windowsHide alone gives the wrapper a hidden console
 * that cloudflared inherits. All I/O (execFile, spawn, fs, homedir, env, the
 * process probe, kill, platform) is injected so `node --test` runs this file with
 * no awtunnel and no network.
 *
 * Failure is a rendered state: every verb resolves {ok:true, data} or
 * {ok:false, reason[, denied]} and never rejects.
 */

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");

/** The floor when services.yaml cannot be read: the ports that publish the platform outright. */
const FALLBACK_DENY_PORTS = Object.freeze({
  8182: "the AitherOS MCP gateway (every fleet tool, bearer-gated)",
  8150: "MicroScheduler (every LLM call routes through it)",
  8151: "MicroScheduler's Claude Bridge",
  8111: "AitherSecrets, the platform vault",
  8001: "Genesis, the orchestrator API",
  5432: "Postgres",
});

/** Local aw* control planes that services.yaml does not declare. */
const AW_DAEMON_PORTS = Object.freeze({
  8286: "awrouter, the local model router",
  9001: "the awdk daemon",
  8362: "the awsh harness daemon",
  8369: "hookd, the Claude Code hook daemon",
  47933: "the awnode hub",
});

/**
 * Every service port declared in services.yaml's `services:` section.
 *
 * A line scanner, not a YAML parser: the file's shape is fixed (two-space
 * service names, four-space `port:` / `description:`), and the desk ships no
 * YAML dependency. Returns {port: [{name, description}]}; port 0 is skipped.
 */
function parseServicesPorts(text) {
  const out = {};
  let inServices = false;
  let current = null;
  for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
    if (/^services:\s*(#.*)?$/.test(raw)) { inServices = true; continue; }
    if (!inServices) continue;
    if (/^[^\s#]/.test(raw)) break; // the next top-level section
    const head = raw.match(/^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/);
    if (head) { current = { name: head[1], description: "" }; continue; }
    if (!current) continue;
    const port = raw.match(/^ {4}port:\s*(\d{1,5})\b/);
    if (port) {
      const n = normalizePort(port[1]);
      if (n !== null) (out[n] = out[n] || []).push(current);
      continue;
    }
    const desc = raw.match(/^ {4}description:\s*(.+)$/);
    if (desc) current.description = desc[1].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Where services.yaml may be: an explicit override, the repo root, then this checkout. */
function servicesYamlCandidates(env = process.env) {
  const list = [];
  if (env.AWDESK_SERVICES_YAML) list.push(env.AWDESK_SERVICES_YAML);
  if (env.AITHEROS_REPO_ROOT) list.push(nodePath.join(env.AITHEROS_REPO_ROOT, "AitherOS", "config", "services.yaml"));
  list.push(nodePath.resolve(__dirname, "..", "..", "..", "AitherOS", "config", "services.yaml"));
  list.push(nodePath.join("C:\\AitherOS-Fresh", "AitherOS", "config", "services.yaml"));
  return [...new Set(list)];
}

/** "AitherX (what it does)" or "AitherX, AitherY +2 more" for one port's services. */
function describeServices(services) {
  if (services.length === 1) {
    const { name, description } = services[0];
    const what = description ? ` (${description.slice(0, 80).replace(/\s+\S*$/, "")})` : "";
    return `${name}${what}, a fleet service in services.yaml`;
  }
  const names = services.map((s) => s.name);
  const shown = names.slice(0, 3).join(", ");
  return `the port of ${shown}${names.length > 3 ? ` +${names.length - 3} more` : ""} (fleet services in services.yaml)`;
}

/**
 * Build the deny map: services.yaml ports, then the aw* daemons, then the named
 * fallback reasons (a named reason always wins over the generic yaml one).
 *
 * Returns {ports: frozen {port: reason}, source: path | null}.
 */
function loadDenyPorts({ env = process.env, fsImpl = fs } = {}) {
  const ports = {};
  let source = null;
  for (const file of servicesYamlCandidates(env)) {
    let text;
    try { text = fsImpl.readFileSync(file, "utf8"); } catch { continue; }
    const parsed = parseServicesPorts(text);
    if (!Object.keys(parsed).length) continue;
    for (const [port, services] of Object.entries(parsed)) ports[port] = describeServices(services);
    source = file;
    break;
  }
  Object.assign(ports, AW_DAEMON_PORTS, FALLBACK_DENY_PORTS);
  return { ports: Object.freeze(ports), source };
}

let cachedDeny = null;
/** The process-wide deny map, read once (services.yaml does not change under a running desk). */
function denyPorts() {
  if (!cachedDeny) cachedDeny = loadDenyPorts().ports;
  return cachedDeny;
}

/** Only this machine's loopback: "a LOCAL port". A LAN host is someone else's box. */
const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);
const PROTOCOLS = Object.freeze(["http", "https"]);
const STATUS_TIMEOUT_MS = 15_000;
const DOWN_TIMEOUT_MS = 30_000;
/** cloudflared quick tunnels usually answer in 5-15 s; the connector's own cap is higher. */
const UP_TIMEOUT_MS = 90_000;
const URL_RE = /https?:\/\/[^\s"']+/;
const STATE_RE = /^port-(\d{1,5})\.json$/;
const INSTALL_REMEDY = "install it: pip install -e AitherOS/packages/awtunnel";
const PROBE_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 15_000;
/** Seconds of clock slack between a process start and the record's `started`. */
const START_SLACK_S = 2;
/** The image that owns a record's `pid` (os.getpid() of `awtunnel up`). */
const WRAPPER_IMAGE_RE = /^(python[\d.]*w?|py|awtunnel)(\.exe)?$/i;
const CLOUDFLARED_IMAGE_RE = /^cloudflared(\.exe)?$/i;

function awtunnelBin(env = process.env) {
  if (env.AWDESK_AWTUNNEL_BIN) return env.AWDESK_AWTUNNEL_BIN;
  try {
    return require("./command-agent.cjs").resolveBin("awtunnel", "AWDESK_AWTUNNEL_BIN");
  } catch {
    return "awtunnel";
  }
}

/** The interpreter for the `python -m awtunnel` fallback (same rule as link-client.cjs). */
function pythonBin(env = process.env) {
  return env.AITHER_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

/** A spawn that never STARTED (vs. awtunnel that ran and failed). */
function spawnFailed(error) {
  return Boolean(error && ["UNKNOWN", "EACCES", "ENOENT", "EPERM"].includes(error.code));
}

/**
 * A port as an integer 1..65535, or null. Accepts "8080" and 8080; rejects
 * "80abc", 0, 70000, 1.5.
 */
function normalizePort(port) {
  const text = String(port ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * May this port get a public URL?
 *
 * Args: port; {allowInternal, deny} — allowInternal is the explicit owner override
 * for the deny map (default denyPorts()).
 * Returns {ok:true, port[, overridden]} or {ok:false, denied, reason}.
 */
function checkPort(port, { allowInternal = false, deny = null } = {}) {
  const n = normalizePort(port);
  if (n === null) return { ok: false, denied: false, reason: `1 port "${String(port ?? "").slice(0, 16)}" is not a port — give a number from 1 to 65535` };
  const what = (deny || denyPorts())[n];
  if (what && allowInternal !== true) {
    return {
      ok: false,
      denied: true,
      port: n,
      reason: `1 port refused: ${n} is ${what} — a public URL would publish fleet internals; tick the owner override to expose it anyway`,
    };
  }
  return what ? { ok: true, port: n, overridden: true } : { ok: true, port: n };
}

/**
 * The argv for `awtunnel up`, validated. Nothing here touches a shell.
 *
 * Args: {port, host="localhost", protocol="http", allowInternal=false}.
 * Returns {ok:true, port, argv} or {ok:false, reason[, denied]}.
 */
function buildUpArgs({ port, host = "localhost", protocol = "http", allowInternal = false, deny = null } = {}) {
  const verdict = checkPort(port, { allowInternal, deny });
  if (!verdict.ok) return verdict;
  const h = String(host || "localhost").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.includes(h)) {
    return { ok: false, denied: true, reason: `1 host refused: "${h.slice(0, 64)}" is not this machine — use localhost, 127.0.0.1 or ::1` };
  }
  const p = String(protocol || "http").trim().toLowerCase();
  if (!PROTOCOLS.includes(p)) {
    return { ok: false, denied: false, reason: `1 protocol "${p.slice(0, 16)}" is not supported — use http or https` };
  }
  return { ok: true, port: verdict.port, argv: ["up", "--port", String(verdict.port), "--host", h, "--protocol", p] };
}

/**
 * Parse `awtunnel status` stdout (+ its exit code when known).
 *
 * Returns {recorded:false} for "no tunnel recorded", a tunnel record
 * {recorded:true, alive, url, port, host, pid, cloudflaredPid, startedAt} for
 * the JSON form, or null when the text is neither (the caller reports it).
 */
function parseStatus(stdout, exitCode = null) {
  const text = String(stdout || "").replace(/\r/g, "").trim();
  if (!text) return null;
  if (/^no tunnel recorded\b/i.test(text)) return { recorded: false };
  const at = text.indexOf("{");
  if (at < 0) return null;
  let raw;
  try { raw = JSON.parse(text.slice(at)); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const url = typeof raw.url === "string" && URL_RE.test(raw.url) ? raw.url : null;
  const alive = typeof raw.alive === "boolean" ? raw.alive : exitCode === 0;
  const started = Number(raw.started);
  return {
    recorded: true,
    alive,
    url,
    port: normalizePort(raw.port),
    host: typeof raw.host === "string" ? raw.host : null,
    pid: Number.isInteger(raw.pid) ? raw.pid : null,
    cloudflaredPid: Number.isInteger(raw.cloudflared_pid) ? raw.cloudflared_pid : null,
    startedAt: Number.isFinite(started) && started > 0 ? Math.floor(started) : null,
  };
}

/** The public URL in `awtunnel up`'s stdout, or null. */
function parseUpUrl(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.trim().match(URL_RE);
    if (m) return m[0];
  }
  return null;
}

/** The last line of stderr, cleaned, for a reason string (never the whole dump). */
function tail(stderr) {
  const lines = String(stderr || "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || "").slice(0, 300);
}

/**
 * Parse the process probe's lines "pid|image|startUnixSeconds" into a Map
 * pid -> {name, startedAt}. Lines that do not fit are skipped.
 */
function parseProbeLines(stdout) {
  const map = new Map();
  for (const line of String(stdout || "").replace(/\r/g, "").split("\n")) {
    const m = line.trim().match(/^(\d+)\|([^|]+)\|(\d+)$/);
    if (m) map.set(Number(m[1]), { name: m[2].trim(), startedAt: Number(m[3]) });
  }
  return map;
}

/**
 * Judge one record's pids against what the OS says owns them.
 *
 * Args: record {pid, cloudflaredPid, startedAt}; procs = Map pid -> {name, startedAt}.
 * Returns {wrapper: "ok"|"dead"|"foreign", cloudflared: "ok"|"dead"|"foreign"|"none"}.
 * "foreign" = the pid is alive but is NOT this tunnel's process (wrong image, or
 * started after the record was written: a recycled pid).
 */
function judgePids(record, procs) {
  const judge = (pid, imageRe) => {
    if (!pid) return "none";
    const p = procs.get(pid);
    if (!p) return "dead";
    if (!imageRe.test(p.name)) return "foreign";
    if (!record.startedAt || !Number.isFinite(p.startedAt) || p.startedAt > record.startedAt + START_SLACK_S) return "foreign";
    return "ok";
  };
  const wrapper = judge(record.pid, WRAPPER_IMAGE_RE);
  return { wrapper: wrapper === "none" ? "dead" : wrapper, cloudflared: judge(record.cloudflaredPid, CLOUDFLARED_IMAGE_RE) };
}

/**
 * The client. Every dependency is injected; the defaults are the real ones.
 *
 * opts: {execFileImpl, spawnImpl, bin, python, env, homedir, fsImpl, upTimeoutMs,
 *        processInfoImpl, killImpl, platform, deny}
 *   processInfoImpl(pids) -> Promise<Map pid -> {name, startedAt}> | null when
 *   the OS cannot be asked; killImpl = process.kill; deny = a {port: reason} map.
 */
class TunnelClient {
  constructor({
    execFileImpl = execFile,
    spawnImpl = spawn,
    bin = null,
    python = null,
    env = process.env,
    homedir = os.homedir,
    fsImpl = fs,
    upTimeoutMs = UP_TIMEOUT_MS,
    processInfoImpl = null,
    killImpl = null,
    platform = process.platform,
    deny = null,
  } = {}) {
    this.execFileImpl = execFileImpl;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this._bin = bin;
    this.python = python || pythonBin(env);
    this.homedir = homedir;
    this.fs = fsImpl;
    this.upTimeoutMs = upTimeoutMs;
    this.processInfoImpl = processInfoImpl;
    this.killImpl = killImpl || ((pid, sig) => process.kill(pid, sig));
    this.platform = platform;
    this._deny = deny;
    this._starting = new Map();
  }

  /** The deny map this client enforces. */
  get deny() {
    if (!this._deny) this._deny = denyPorts();
    return this._deny;
  }

  /** The CLI's default state file (not an AWTUNNEL_STATE override). */
  get defaultCliStatePath() {
    return nodePath.join(this.homedir(), ".awtunnel", "state.json");
  }

  /** A plain hidden execFile (no awtunnel env) -> {error, stdout, stderr}. */
  _exec(file, argv, timeoutMs) {
    return new Promise((resolve) => {
      try {
        this.execFileImpl(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
          (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") }));
      } catch (error) {
        resolve({ error, stdout: "", stderr: "" });
      }
    });
  }

  /**
   * Who owns these pids right now. Returns Map pid -> {name, startedAt (unix s)}
   * (a pid absent from the map is dead), or null when the OS could not be asked.
   */
  async processInfo(pids) {
    const ids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
    if (!ids.length) return new Map();
    if (this.processInfoImpl) {
      try { return await this.processInfoImpl(ids); } catch { return null; }
    }
    if (this.platform === "win32") {
      // ids are validated integers: nothing user-typed reaches the script.
      const filter = ids.map((id) => `ProcessId=${id}`).join(" OR ");
      const script = `foreach($p in @(Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction Stop)){ '{0}|{1}|{2}' -f $p.ProcessId,$p.Name,([DateTimeOffset]$p.CreationDate).ToUnixTimeSeconds() }`;
      const run = await this._exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], PROBE_TIMEOUT_MS);
      if (run.error) return null;
      return parseProbeLines(run.stdout);
    }
    const run = await this._exec("ps", ["-o", "pid=,etimes=,comm=", "-p", ids.join(",")], PROBE_TIMEOUT_MS);
    if (run.error && (run.stdout.trim() || !Number.isInteger(run.error.code))) return null;
    const now = Math.floor(Date.now() / 1000);
    const map = new Map();
    for (const line of run.stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (m) map.set(Number(m[1]), { name: nodePath.basename(m[3].trim()), startedAt: now - Number(m[2]) });
    }
    return map;
  }

  /** Judge a record's pids; null when the OS could not be asked. */
  async verify(record) {
    const procs = await this.processInfo([record.pid, record.cloudflaredPid]);
    return procs ? judgePids(record, procs) : null;
  }

  /**
   * Kill one process TREE: `taskkill /T /F` on Windows (child.kill() would end the
   * wrapper and orphan its cloudflared), the process group (then the pid) on POSIX.
   */
  async _killTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (this.platform === "win32") {
      const run = await this._exec("taskkill", ["/PID", String(pid), "/T", "/F"], KILL_TIMEOUT_MS);
      return !run.error;
    }
    try { this.killImpl(-pid, "SIGTERM"); return true; } catch { /* not a group leader */ }
    try { this.killImpl(pid, "SIGTERM"); return true; } catch { return false; }
  }

  /**
   * Delete a dead record the desk owns: a desk file (inside stateDir, named
   * port-<N>.json) or the CLI's DEFAULT file. Never any other path.
   */
  _clearRecord(statePath) {
    const inDesk = nodePath.dirname(statePath) === this.stateDir && STATE_RE.test(nodePath.basename(statePath));
    if (!inDesk && statePath !== this.defaultCliStatePath) return false;
    try { this.fs.unlinkSync(statePath); return true; } catch { return false; }
  }

  get bin() {
    if (!this._bin) this._bin = awtunnelBin(this.env);
    return this._bin;
  }

  /** The directory of desk-owned state files. */
  get stateDir() {
    return nodePath.join(this.homedir(), ".awtunnel", "desk");
  }

  /** The CLI's own state file (what a bare `awtunnel up` writes). */
  get cliStatePath() {
    return this.env.AWTUNNEL_STATE || nodePath.join(this.homedir(), ".awtunnel", "state.json");
  }

  /** The desk's state file for one port. */
  statePathFor(port) {
    return nodePath.join(this.stateDir, `port-${normalizePort(port)}.json`);
  }

  _childEnv(statePath) {
    return { ...this.env, AWTUNNEL_STATE: statePath, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
  }

  _execOnce(file, argv, statePath, timeoutMs) {
    return new Promise((resolve) => {
      try {
        this.execFileImpl(file, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, env: this._childEnv(statePath) },
          (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") }));
      } catch (error) {
        resolve({ error, stdout: "", stderr: "" });
      }
    });
  }

  /** Run one awtunnel verb against one state file; falls back to `python -m awtunnel`. */
  async _run(argv, statePath, timeoutMs) {
    let run = await this._execOnce(this.bin, argv, statePath, timeoutMs);
    if (spawnFailed(run.error)) {
      const viaPython = await this._execOnce(this.python, ["-m", "awtunnel", ...argv], statePath, timeoutMs);
      if (!spawnFailed(viaPython.error) && !/No module named/i.test(viaPython.stderr)) run = viaPython;
    }
    const code = run.error ? (Number.isInteger(run.error.code) ? run.error.code : null) : 0;
    const missing = spawnFailed(run.error);
    return { ...run, code, missing };
  }

  /** `awtunnel status` for one state file -> {ok, data: record} | {ok:false, reason}. */
  async statusOf(statePath) {
    const run = await this._run(["status"], statePath, STATUS_TIMEOUT_MS);
    if (run.missing) return { ok: false, reason: `1 tool missing: awtunnel is not on PATH — ${INSTALL_REMEDY}` };
    const parsed = parseStatus(run.stdout, run.code);
    if (!parsed) {
      return { ok: false, reason: `1 status unreadable: awtunnel status said "${tail(run.stderr || run.stdout) || `exit ${run.code}`}" — run awtunnel status in a terminal` };
    }
    return { ok: true, data: { ...parsed, statePath } };
  }

  /** Every state file worth asking about: the CLI's own, then the desk's per-port files. */
  _statePaths() {
    const paths = [{ path: this.cliStatePath, source: "cli" }];
    let names = [];
    try { names = this.fs.readdirSync(this.stateDir); } catch { /* no desk tunnels yet */ }
    for (const name of names.sort()) {
      if (STATE_RE.test(name)) paths.push({ path: nodePath.join(this.stateDir, name), source: "desk" });
    }
    return paths;
  }

  /**
   * Every recorded tunnel, alive first, plus every state file awtunnel could not
   * read (an unreadable file may still be a PUBLIC port: never hidden).
   * Returns {ok:true, data:{tunnels:[{port, url, alive, source, ...}], total, alive,
   * errors:[{path, source, port, reason}], line}} or {ok:false, reason} when
   * awtunnel itself cannot be asked.
   */
  async list() {
    const entries = this._statePaths();
    const results = await Promise.all(entries.map((e) => this.statusOf(e.path).then((r) => ({ ...r, source: e.source, path: e.path }))));
    const missing = results.find((r) => !r.ok && /not on PATH/.test(r.reason));
    if (missing) return { ok: false, reason: missing.reason };
    const tunnels = [];
    const errors = [];
    for (const r of results) {
      if (!r.ok) {
        const m = nodePath.basename(r.path).match(STATE_RE);
        errors.push({ path: r.path, source: r.source, port: r.source === "desk" && m ? normalizePort(m[1]) : null, reason: r.reason });
        continue;
      }
      if (r.data.recorded) tunnels.push({ ...r.data, source: r.source });
    }
    tunnels.sort((a, b) => Number(b.alive) - Number(a.alive) || (a.port || 0) - (b.port || 0));
    const data = { tunnels, total: tunnels.length, alive: tunnels.filter((t) => t.alive).length, errors };
    data.line = statusLine({ ok: true, data });
    return { ok: true, data };
  }

  /**
   * The live record for a port, from either the desk file or the CLI file.
   * "Live" means the recorded cloudflared pid is alive AND is cloudflared started
   * no later than the record — a recycled wrapper pid is not a live tunnel.
   * Refuses (ok:false) when the port's desk file is unreadable or the OS cannot be
   * asked: spawning over either would orphan a public cloudflared.
   */
  async findLive(port) {
    const n = normalizePort(port);
    const listed = await this.list();
    if (!listed.ok) return listed;
    const unreadable = listed.data.errors.find((e) => e.port === n);
    if (unreadable) {
      return { ok: false, reason: `1 state file unreadable for port ${n} — run awtunnel status with AWTUNNEL_STATE=${unreadable.path} in a terminal; the port may already be public` };
    }
    for (const t of listed.data.tunnels.filter((x) => x.port === n && x.url)) {
      const v = await this.verify(t);
      if (!v) return { ok: false, reason: `1 tunnel unconfirmed on port ${n}: could not ask Windows who owns pid ${t.cloudflaredPid || t.pid} — Refresh and retry` };
      if (v.cloudflared === "ok") return { ok: true, data: t };
    }
    return { ok: true, data: null };
  }

  /**
   * Give one local port a public URL. Idempotent: a port already public answers
   * its existing URL. Concurrent clicks on the same port share one start.
   *
   * Args: {port, host, protocol, allowInternal}.
   * Returns {ok:true, data:{port, url, reused, overridden}} or {ok:false, reason[, denied]}.
   */
  async start(opts = {}) {
    const built = buildUpArgs({ ...opts, deny: this.deny });
    if (!built.ok) return built;
    const port = built.port;
    if (this._starting.has(port)) return this._starting.get(port);
    const job = (async () => {
      const live = await this.findLive(port);
      if (!live.ok) return live;
      if (live.data) return { ok: true, data: { port, url: live.data.url, reused: true, source: live.data.source } };
      try { this.fs.mkdirSync(this.stateDir, { recursive: true }); } catch (error) {
        return { ok: false, reason: `1 folder unwritable: ${this.stateDir} — ${String(error.message || error).slice(0, 120)}` };
      }
      const statePath = this.statePathFor(port);
      let up = await this._spawnUp(this.bin, built.argv, statePath);
      if (up.missing) up = await this._spawnUp(this.python, ["-m", "awtunnel", ...built.argv], statePath);
      if (up.missing) return { ok: false, reason: `1 tool missing: awtunnel is not on PATH — ${INSTALL_REMEDY}` };
      if (!up.ok) return up;
      const overridden = Boolean(this.deny[port]);
      return { ok: true, data: { port, url: up.url, reused: false, source: "desk", ...(overridden ? { overridden } : {}) } };
    })();
    this._starting.set(port, job);
    try {
      return await job;
    } finally {
      this._starting.delete(port);
    }
  }

  /**
   * Spawn the foreground `awtunnel up` hidden, and resolve on the first URL it
   * prints. The child outlives this call (and the desk): the tunnel stays public
   * until stop(port). Detached on POSIX only (own process group, killable as one);
   * on Windows detached = DETACHED_PROCESS, whose cloudflared child would open a
   * visible console. On timeout the whole TREE is killed, never just the wrapper.
   * Resolves {ok, url} | {ok:false, reason, missing}.
   */
  _spawnUp(file, argv, statePath) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(file, argv, {
          detached: this.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: this._childEnv(statePath),
        });
      } catch (error) {
        resolve({ ok: false, missing: spawnFailed(error), reason: `1 tunnel not started — ${String(error.message || error).slice(0, 200)}` });
        return;
      }
      let out = "";
      let err = "";
      let done = false;
      const finish = (verdict) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(verdict);
      };
      const timer = setTimeout(() => {
        if (Number.isInteger(child.pid)) void this._killTree(child.pid);
        else { try { child.kill(); } catch { /* already gone */ } }
        finish({ ok: false, reason: `1 tunnel timed out: no URL after ${Math.round(this.upTimeoutMs / 1000)} s — check cloudflared can reach the internet, then retry` });
      }, this.upTimeoutMs);
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
        const url = parseUpUrl(out);
        if (url) {
          // Let go: the child keeps running on its own (it prints nothing more
          // until it is stopped), and the desk's event loop is not held by it.
          try { child.stdout.destroy(); child.stderr?.destroy(); } catch { /* fine */ }
          try { child.unref(); } catch { /* fine */ }
          finish({ ok: true, url });
        }
      });
      child.stderr?.on("data", (chunk) => { err = (err + String(chunk)).slice(-4096); });
      child.on("error", (error) => finish({ ok: false, missing: spawnFailed(error), reason: `1 tunnel not started — ${String(error.message || error).slice(0, 200)}` }));
      child.on("exit", (code) => {
        const why = tail(err) || `awtunnel exited ${code}`;
        const remedy = /cloudflared/i.test(why) ? "install cloudflared and retry" : "run awtunnel up in a terminal to see why";
        finish({ ok: false, reason: `1 tunnel did not come up: ${why} — ${remedy}` });
      });
    });
  }

  /**
   * Take a port's public URL away. Stops the desk's tunnel for that port, or the
   * CLI's default one when that is the port it carries.
   *
   * `awtunnel down` force-kills the TREE of every recorded pid that is alive, so
   * it runs only when the wrapper pid is verified as this tunnel's process. A dead
   * record is cleared by the desk; a recycled pid is never killed:
   *   wrapper ok, cloudflared ok/dead     -> awtunnel down
   *   wrapper ok, cloudflared foreign     -> kill the wrapper's tree, clear
   *   wrapper dead/foreign, cloudflared ok -> kill the orphan cloudflared, clear
   *   wrapper dead/foreign, otherwise     -> clear only
   * Returns {ok:true, data:{port, stopped, cleared}} or {ok:false, reason}.
   */
  async stop(port) {
    const n = normalizePort(port);
    if (n === null) return { ok: false, reason: `1 port "${String(port ?? "").slice(0, 16)}" is not a port — give a number from 1 to 65535` };
    const targets = [];
    const deskPath = this.statePathFor(n);
    if (this.fs.existsSync(deskPath)) {
      const desk = await this.statusOf(deskPath);
      if (!desk.ok) return { ok: false, reason: `1 state file unreadable for port ${n} — run awtunnel status with AWTUNNEL_STATE=${deskPath} in a terminal` };
      if (desk.data.recorded) targets.push(desk.data);
    }
    const cli = await this.statusOf(this.cliStatePath);
    if (cli.ok && cli.data.recorded && cli.data.port === n) targets.push(cli.data);
    if (!targets.length) return { ok: false, reason: `0 tunnels on port ${n} — nothing to stop; Refresh to see what is public` };
    let stopped = false;
    let cleared = 0;
    for (const record of targets) {
      const v = await this.verify(record);
      if (!v) return { ok: false, reason: `1 tunnel not stopped: could not ask Windows who owns pid ${record.pid} — Refresh and retry` };
      if (v.wrapper === "ok" && v.cloudflared !== "foreign") {
        const run = await this._run(["down"], record.statePath, DOWN_TIMEOUT_MS);
        if (run.missing) return { ok: false, reason: `1 tool missing: awtunnel is not on PATH — ${INSTALL_REMEDY}` };
        const said = run.stdout.replace(/\r/g, "").trim();
        if (/^stopped\b/i.test(said)) stopped = true;
        else if (!/nothing was running|no tunnel recorded/i.test(said)) {
          return { ok: false, reason: `1 tunnel not stopped: ${tail(run.stderr || said) || `exit ${run.code}`} — run awtunnel down in a terminal` };
        }
        continue;
      }
      if (v.wrapper === "ok") stopped = (await this._killTree(record.pid)) || stopped;
      else if (v.cloudflared === "ok") stopped = (await this._killTree(record.cloudflaredPid)) || stopped;
      if (this._clearRecord(record.statePath)) cleared += 1;
      else return { ok: false, reason: `1 stale record not cleared: ${record.statePath} — delete that file (its pids belong to other processes now)` };
    }
    return { ok: true, data: { port: n, stopped, cleared } };
  }
}

/**
 * Cap a list for display (UX law 4): the first `cap` rows plus the real hidden
 * count. Cap presentation, never data.
 */
function capRows(rows, cap = 5) {
  const all = Array.isArray(rows) ? rows : [];
  return { visible: all.slice(0, cap), more: Math.max(0, all.length - cap), total: all.length };
}

/** The one-line status for the panel's top bar (UX law 3). */
function statusLine(listing) {
  if (!listing || !listing.ok) return listing?.reason || "tunnels unavailable — Refresh";
  const { total, alive } = listing.data;
  const bad = Array.isArray(listing.data.errors) ? listing.data.errors.length : 0;
  // An unreadable state file may be a live public port: it leads, never hides.
  const unreadable = bad ? `${bad} state file${bad === 1 ? "" : "s"} unreadable — run awtunnel status; a port may still be public` : "";
  if (!total) return unreadable || "0 public ports — type a port and press Make public";
  const stale = total - alive;
  const counts = `${alive} public port${alive === 1 ? "" : "s"}${stale ? ` · ${stale} stale — Stop clears ${stale === 1 ? "it" : "them"}` : ""}`;
  return unreadable ? `${unreadable} · ${counts}` : counts;
}

module.exports = {
  TunnelClient,
  FALLBACK_DENY_PORTS,
  AW_DAEMON_PORTS,
  denyPorts,
  loadDenyPorts,
  parseServicesPorts,
  servicesYamlCandidates,
  judgePids,
  parseProbeLines,
  LOOPBACK_HOSTS,
  normalizePort,
  checkPort,
  buildUpArgs,
  parseStatus,
  parseUpUrl,
  capRows,
  statusLine,
  spawnFailed,
};
