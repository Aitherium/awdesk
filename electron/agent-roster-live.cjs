"use strict";

/**
 * agent-roster-live.cjs -- reads the sources agent-swarm.cjs parses, and merges them
 * into the ONE roster. Every source is injectable (tests use fakes) and every source
 * FAILS SOFT: a dead gateway or a stopped WSL distro empties that source's rows and says
 * so in `sources[name]`, it never throws and never empties the other sources. "Could not
 * look" is reported as a state, not as an empty list.
 *
 * Sources (nothing hardcoded):
 *   discord   podman ps on the fleet host (fleet-distro.cjs argv) -> the awdiscord bot containers
 *   genesis   gateway tools active_agents + agent_roster
 *   sessions  the harness daemon (sessions-client.listSessions)
 *   remote    gateway tool deploy_remote_list
 *   asset     GargBot's goblin (ships with the desk)
 */

const { execFile } = require("node:child_process");
const swarm = require("./agent-swarm.cjs");

const SOURCE_TIMEOUT_MS = 25000;

/**
 * Run an argv (exe first) and resolve its stdout. The fleet argv comes from
 * fleet-distro.cjs fleetPodmanArgv(): `wsl.exe -d <distro> -u root --exec podman ...`, which
 * arrives intact (a `sh -c "..."` string loses its quotes through wsl.exe and fails).
 * A non-zero exit with no output rejects; output with a non-zero exit is still the answer.
 */
function runArgv(argv, { timeoutMs = SOURCE_TIMEOUT_MS, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec(argv[0], argv.slice(1), { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout || "").split(String.fromCharCode(0)).join("");
      if (error && !out.trim()) reject(new Error(String(stderr || error.message || error).split(String.fromCharCode(0)).join("").trim().slice(0, 200)));
      else resolve(out);
    });
  });
}

/** The `name|status` listing of every container on the fleet host. */
const PODMAN_PS = Object.freeze(["ps", "-a", "--format", "{{.Names}}|{{.Status}}"]);

/** One source: run it, parse it, never throw. Returns {rows, status}. */
async function readSource(name, run, parse) {
  const started = Date.now();
  try {
    const raw = await run();
    const rows = parse(raw) || [];
    return { rows, status: { ok: true, count: rows.length, ms: Date.now() - started } };
  } catch (error) {
    return { rows: [], status: { ok: false, count: 0, ms: Date.now() - started, error: String((error && error.message) || error).slice(0, 160) } };
  }
}

/**
 * Build the roster reader.
 *
 * deps:
 *   podman()          -> text of `name|status` lines
 *   callTool(n, a)    -> gateway tool text
 *   listSessions()    -> sessions-client result
 *   readAuthors()     -> cast.json authors{}
 *   listCharacters()  -> installed roster names (Set|Array)
 *   aitherBody()      -> the female/male Aither body name
 *   ttlMs             -> cache lifetime (a refresh inside it is the same answer)
 */
function createRosterReader({
  podman,
  callTool,
  listSessions,
  readAuthors = () => ({}),
  listCharacters = () => null,
  aitherBody = () => "",
  ttlMs = 15000,
  now = Date.now,
  // {remember(key, value), recall(key) -> {value, savedAt}|null}: last-good-cache.cjs in the desk.
  cache = null,
  gatewayTtlMs = 120000,
  gatewayTimeoutMs = 8000,
} = {}) {
  let snapshot = null;
  let cachedAt = 0;
  let inflight = null;

  let gatewayAt = -Infinity;
  // Rows a web overlay registered (registerOverlay): kept between reads, merged by identity.
  const overlays = new Map(); // source -> rows
  const lastRows = new Map(); // source -> {rows, status} from its last read (kept between gateway reads)

  async function readAll() {
    const sources = {};
    const parts = [];
    /** A gateway source not due this round: its last rows and status stand. */
    const keep = (name) => {
      const last = lastRows.get(name);
      if (last) { sources[name] = last.status; parts.push(...last.rows); }
    };
    const take = async (name, run, parse) => {
      const r = await readSource(name, run, parse);
      const key = `swarm-roster-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      if (r.status.ok) {
        try { if (cache) cache.remember(key, r.rows); } catch { /* the memory is a convenience */ }
      } else if (cache) {
        // A wedged distro or a down gateway must not make the bots vanish: show the last
        // good rows, flagged stale, and say why the live read failed.
        let last = null;
        try { last = cache.recall(key); } catch { /* none */ }
        if (last && Array.isArray(last.value) && last.value.length) {
          r.rows = last.value;
          r.status = { ...r.status, stale: true, count: last.value.length, savedAt: last.savedAt };
        }
      }
      sources[name] = r.status;
      lastRows.set(name, { rows: r.rows, status: r.status });
      parts.push(...r.rows);
    };
    // The gateway's tool calls share ONE queued MCP session with every other desk plane, so
    // they are read at most every GATEWAY_TTL_MS, raced against a short timeout, and fall back
    // to the last good rows: a slow gateway must never lag the desk (measured 96 s per call
    // under load on 2026-11-16).
    const gatewayDue = now() - gatewayAt >= gatewayTtlMs;
    const gateway = (name, run, parse) => (gatewayDue
      ? take(name, () => withTimeout(run(), gatewayTimeoutMs, `${name} timed out`), parse)
      : keep(name));
    if (gatewayDue) gatewayAt = now();
    await Promise.all([
      take("discord", () => podman(), (text) => swarm.parseDiscordContainers(text)),
      gateway("genesis.active", () => callTool("active_agents", {}), (t) => swarm.parseActiveAgents(typeof t === "string" ? safeJson(t) : t)),
      gateway("remote", () => callTool("deploy_remote_list", {}), (t) => swarm.parseRemote(typeof t === "string" ? safeJson(t) : t)),
      take("sessions", () => listSessions(), (r) => swarm.parseSessions(r)),
    ]);
    parts.push(swarm.residentRow(), swarm.goblinRow());
    for (const rows of overlays.values()) parts.push(...rows);
    let authors = {};
    let characters = null;
    try { authors = readAuthors() || {}; } catch { /* no cast file: default identities */ }
    try { characters = listCharacters(); } catch { /* unchecked */ }
    let body = "";
    try { body = aitherBody() || ""; } catch { /* default */ }
    const roster = swarm.withIdentity(swarm.mergeRoster(parts), {
      authors, characters: characters ? new Set(characters) : null, aitherBody: body,
    });
    return { roster, sources, at: now() };
  }

  async function read({ force = false } = {}) {
    if (!force && snapshot && now() - cachedAt < ttlMs) return snapshot;
    if (!inflight) {
      inflight = readAll().then((result) => {
        snapshot = result;
        cachedAt = now();
        return result;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  /** GargBot's overlay (or any page in the desk) says which goblin / agents it shows; they join THIS
   *  roster, deduped by agent identity, so there is one cluster. [] forgets the source. */
  function registerOverlay(source, agents) {
    const rows = swarm.parseOverlay(agents, source);
    const key = rows.length ? rows[0].source : String(source || "overlay");
    if (rows.length) overlays.set(key, rows); else overlays.delete(key);
    snapshot = null;
    cachedAt = 0;
    return { ok: true, source: key, count: rows.length };
  }

  return { read, registerOverlay, invalidate: () => { snapshot = null; cachedAt = 0; } };
}

function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = { createRosterReader, runArgv, readSource, PODMAN_PS };
