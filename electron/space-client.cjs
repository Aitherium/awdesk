"use strict";

/**
 * space-client.cjs -- the universe (contract U1) the aither://space/ pane draws.
 *
 * TRANSPORT: Veil's GET https://api.aitherium.com/api/beadspace/universe with the
 * desk's Online bearer (the same door and the same identity as plane-client.cjs),
 * 8 s timeout, If-None-Match on the last etag (a 304 keeps the snapshot).
 *
 * The pane is never blank. In order:
 *   remote     the live universe;
 *   genesis    the SAME universe read straight from Genesis on the fleet host when Veil
 *              (api.aitherium.com) or the desk's sign-in is down: `podman exec
 *              aitheros-genesis-a curl https://localhost:8001/beadspace/universe` over the
 *              WSL hop (a direct in-container socket is an attested platform caller). Live,
 *              not stale -- 2026-10-16 05:00 the lens read "stale / business 0 services"
 *              for hours only because Veil was down while Genesis was fine;
 *   last-good  the last remote answer saved on disk (last-good-cache.cjs), stale;
 *   local      a skeleton built from what the desk alone knows (localSkeleton):
 *              the platform, the six galaxies (health unknown), the fleet galaxy
 *              with the health the desk measures itself, and the fleet GPU.
 *
 * Whatever the source, two things are the DESK's call, never the server's:
 *   - galaxy:fleet's health, when the desk has a FRESH fleet verdict (it sees the host):
 *     at most FLEET_VERDICT_MAX_AGE_MS old and no fleet verb run since it was taken
 *     (deskFleetVerdict). It carries the time it was measured, never "now". A stale
 *     verdict loses: the server's word stands (or "unknown" in the local skeleton);
 *   - every verb's danger (fleet-control.cjs DESTRUCTIVE) and which fleet verbs exist
 *     at all (ACTION_NAMES). A verb the desk cannot run is dropped before any page
 *     sees it; the IPC in space-window.cjs re-checks both on every click anyway.
 */

const { ACTION_NAMES, DESTRUCTIVE, classify, distroName, inFleetHost, summarize } = require("./fleet-control.cjs");
const { PLANE_IDS } = require("./plane-client.cjs");

const API_BASE = "https://api.aitherium.com";
const ROUTE = "/api/beadspace/universe";
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 15000;
/** The desk's own fleet verdict outranks the server's only while it is this fresh. */
const FLEET_VERDICT_MAX_AGE_MS = 120000;
const CACHE_KEY = "space-universe";

/** Genesis instances the local fallback asks, in order (the LB name is haproxy's). */
const LOCAL_GENESIS_CONTAINERS = Object.freeze(["aitheros-genesis-a", "aitheros-genesis-b"]);
const LOCAL_FETCH_TIMEOUT_MS = 30000;
/** universe.py unit verbs: start / park ONE unit (space-window.cjs runs them). */
const UNIT_VERB_RE = /^unit-(start|park):([A-Za-z0-9][A-Za-z0-9_.@-]{0,120})$/;

/** The U1 id grammar. */
const ID_RE = /^(platform|[a-z]+:[A-Za-z0-9._/@:-]{1,160})$/;

const GALAXIES = Object.freeze([
  ["galaxy:fleet", "awnix fleet"],
  ["galaxy:dgx", "DGX"],
  ["galaxy:mesh", "Mesh"],
  ["galaxy:cloud", "Cloud & tunnels"],
  ["galaxy:agents", "Agents"],
  ["galaxy:data", "Data & memory"],
]);

/** The server's verb table for these two kinds (lib/beadspace/universe.py), word for word. */
const FLEET_VERBS = Object.freeze([
  ["fleet-wake", "Wake fleet"], ["verbs-status", "Fleet status"],
  ["fleet-sleep", "Sleep fleet"], ["fleet-critical", "Critical only"],
  ["host-restart", "Restart host"],
]);
const GPU_VERBS = Object.freeze([
  ["gpu-wake", "Wake GPU"], ["models-status", "Model status"], ["gpu-sleep", "Sleep GPU"],
  ["models-pool-fast", "Fast pool"], ["models-pool-lean", "Lean pool"],
]);

/** fleet-control classify() word -> U1 health state. */
const HEALTH_OF_CLASS = Object.freeze({
  UP: "ok", MIXED: "degraded", DOWN: "down", "GPU QUIET": "parked", UNKNOWN: "unknown",
});
const STATUS_OF_HEALTH = Object.freeze({
  down: "blocked", degraded: "blocked", starting: "in_progress", parked: "deferred", ok: "open", unknown: "open",
});

function errorText(error) {
  return String((error && error.message) || error || "unknown error");
}

/**
 * The desk's fleet verdict when it may outrank the server, else null and why not.
 * `snapshot` is {verdict, at, changedAt}: fleet-control's lastStatus, lastStatusAt
 * and lastChangeAt (the end of the last fleet verb that can change state).
 */
function deskFleetVerdict(snapshot, nowMs = Date.now(), maxAgeMs = FLEET_VERDICT_MAX_AGE_MS) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.verdict) {
    return { verdict: null, at: 0, why: "the desk has not probed the fleet yet" };
  }
  const at = Number(snapshot.at) || 0;
  if (!at) return { verdict: null, at: 0, why: "the desk's fleet verdict carries no time" };
  if ((Number(snapshot.changedAt) || 0) > at) {
    return { verdict: null, at, why: "a fleet verb ran after the desk's last probe" };
  }
  const age = nowMs - at;
  if (age > maxAgeMs) {
    return { verdict: null, at, why: `the desk's last fleet probe is ${Math.round(age / 60000)} min old` };
  }
  return { verdict: snapshot.verdict, at, why: "" };
}

/**
 * What the desk itself measured about the fleet host, as a U1 health, stamped with
 * WHEN it was measured (`atMs`), never the time it is read.
 */
function fleetHealth(status, atMs = Date.now(), whyUnknown = "the desk has not probed the fleet yet") {
  let word;
  try { word = status ? classify(status) : "UNKNOWN"; } catch { word = "UNKNOWN"; }
  const state = HEALTH_OF_CLASS[word] || "unknown";
  let reason;
  try { reason = status ? summarize(status).replace(/^Fleet:\s*/, "") : whyUnknown; } catch { reason = ""; }
  return { state, reason: String(reason).slice(0, 240), source: "desk", at: new Date(atMs).toISOString() };
}

function verbRow(id, label, primary) {
  const v = { id, label, danger: DESTRUCTIVE.has(id) ? "confirm" : "none", transport: "fleet" };
  if (primary) v.primary = true;
  return v;
}

function fleetVerbs(state) {
  const asleep = state === "down" || state === "parked";
  return FLEET_VERBS.map(([id, label]) => verbRow(id, label,
    (id === "fleet-wake") === asleep && (id === "fleet-wake" || id === "verbs-status")));
}

function gpuVerbs(state) {
  const down = state === "down";
  return GPU_VERBS.map(([id, label]) => verbRow(id, label,
    (id === "gpu-wake") === down && (id === "gpu-wake" || id === "models-status")));
}

function containerExplore(title) {
  return [{ label: "Explore with Aither", prompt: `Summarise ${title}: what is unhealthy and the one thing to do.` }];
}

/**
 * A U1 universe from what the desk alone knows. Never empty: the platform and the six
 * galaxies are always there, the fleet galaxy carries the desk's own verdict.
 * `fleet.at` is when that verdict was measured; `fleet.why` says why there is none.
 */
function localSkeleton(fleetStatus, nowMs = Date.now(), fleet0 = {}) {
  const at = new Date(nowMs).toISOString();
  const unknown = (reason) => ({ state: "unknown", reason, source: "desk", at });
  const fleet = fleetStatus ? fleetHealth(fleetStatus, fleet0.at || nowMs)
    : fleetHealth(null, nowMs, fleet0.why || undefined);
  const node = (id, title, level, parent, health, extra = {}) => ({
    id, title, level, parent, cluster: parent || "platform", status: STATUS_OF_HEALTH[health.state] || "open",
    createdAt: at, health, verbs: [], explore: [], meta: {}, ...extra,
  });
  const nodes = [node("platform", "Aither", "universe", null, unknown("local view: the platform universe is not reachable"),
    { explore: containerExplore("Aither") })];
  const links = [];
  for (const [id, title] of GALAXIES) {
    const health = id === "galaxy:fleet" ? fleet : unknown("local view: not measured from this desk");
    const extra = { explore: containerExplore(title) };
    if (id === "galaxy:fleet") extra.verbs = fleetVerbs(health.state);
    nodes.push(node(id, title, "galaxy", "platform", health, extra));
    links.push({ source: "platform", target: id, kind: "parent-child", rel: "hosts" });
  }
  const gpuState = fleet.state === "parked" ? "parked" : fleet.state === "down" ? "down" : "unknown";
  const gpuHealth = gpuState === "unknown" ? unknown("local view: the GPU is read through the platform")
    : { state: gpuState, reason: fleet.reason, source: "desk", at: fleet.at };
  nodes.push(node("gpu:fleet/0", "Fleet GPU", "system", "galaxy:fleet", gpuHealth, {
    verbs: gpuVerbs(gpuState),
    explore: [{ label: "Explore with Aither", prompt: "What is Fleet GPU serving and is it healthy?" }],
    meta: { gpu: 0 },
  }));
  links.push({ source: "galaxy:fleet", target: "gpu:fleet/0", kind: "parent-child", rel: "hosts" });
  return {
    universe_version: 1,
    generated_at: at,
    etag: `local-${fleet.state}`,
    nodes,
    links,
    meta: { sources: { desk: "ok", platform: "unavailable: local view" }, counts: { nodes: nodes.length, links: links.length }, ttl_s: 15 },
  };
}

/** A verb the desk can run, with the desk's danger; null when it must be dropped. */
function normaliseVerb(verb) {
  if (!verb || typeof verb !== "object") return null;
  const id = typeof verb.id === "string" ? verb.id : "";
  const label = typeof verb.label === "string" && verb.label ? verb.label.slice(0, 60) : "";
  if (!id || !label) return null;
  if (verb.transport === "fleet") {
    if (!ACTION_NAMES.includes(id)) return null;
  } else if (verb.transport === "open") {
    const m = /^open-plane:([a-z]+)$/.exec(id);
    if (!m || !PLANE_IDS.includes(m[1])) return null;
  } else if (verb.transport === "unit") {
    if (!UNIT_VERB_RE.test(id)) return null;
  } else {
    return null;
  }
  const risky = DESTRUCTIVE.has(id) || id.startsWith("unit-park:");
  const out = { id, label, danger: risky ? "confirm" : "none", transport: verb.transport };
  if (verb.primary === true) out.primary = true;
  return out;
}

/**
 * The universe as the pane may see it: danger re-derived, unknown verbs dropped and,
 * when the desk has a (fresh -- the caller judges) fleet verdict, galaxy:fleet's health
 * replaced by the desk's, stamped `atMs` (when it was measured).
 * Returns a new object; `universe` is not touched.
 */
function normaliseUniverse(universe, fleetStatus, atMs = Date.now()) {
  const fleet = fleetStatus ? fleetHealth(fleetStatus, atMs) : null;
  const nodes = universe.nodes
    .filter((n) => n && typeof n === "object" && typeof n.id === "string" && ID_RE.test(n.id))
    .map((n) => {
      const copy = { ...n, verbs: (Array.isArray(n.verbs) ? n.verbs : []).map(normaliseVerb).filter(Boolean) };
      if (n.id === "galaxy:fleet" && fleet) {
        copy.health = { ...fleet, ...(n.health && n.health.rollup ? { rollup: n.health.rollup } : {}) };
        copy.status = STATUS_OF_HEALTH[fleet.state] || "open";
      }
      return copy;
    });
  return { ...universe, nodes };
}

function isUniverse(body) {
  return Boolean(body && typeof body === "object" && body.universe_version === 1
    && Array.isArray(body.nodes) && body.nodes.length > 0 && Array.isArray(body.links));
}

/**
 * The default transport: one GET to Veil with the desk's Online bearer.
 * Resolves {notModified:true} on a 304, else {universe, etag}; throws on anything else.
 */
function veilUniverseFetcher({ token, fetchImpl = globalThis.fetch, apiBase = API_BASE, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return async function fetchUniverse({ etag = null } = {}) {
    let bearer;
    try { bearer = token ? await token() : null; } catch { bearer = null; }
    if (!bearer) throw new Error("signed out: sign in on the desk to see the whole platform");
    const headers = { Authorization: `Bearer ${bearer}`, Accept: "application/json" };
    if (etag) headers["If-None-Match"] = etag;
    let res;
    try {
      res = await fetchImpl(`${apiBase}${ROUTE}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`universe route unreachable: ${errorText(error)}`, { cause: error });
    }
    if (res.status === 304) return { notModified: true };
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("HTTP 401: the desk session is not signed in (or expired)");
    if (res.status === 403) throw new Error("HTTP 403: platform operator only");
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.trim().slice(0, 160)}` : ""}`);
    let body;
    try { body = JSON.parse(text); } catch { throw new Error("universe route: unparseable answer"); }
    if (!isUniverse(body)) throw new Error("universe route: not a U1 universe");
    const header = res.headers && typeof res.headers.get === "function" ? res.headers.get("etag") : null;
    return { universe: body, etag: header || body.etag || null };
  };
}

/**
 * argv to read the universe straight from ONE Genesis instance on the fleet host. No shell
 * anywhere: `wsl.exe -e` executes podman directly, and every argument is a literal here.
 */
function localGenesisArgv(container, { distro = distroName(), local = inFleetHost() } = {}) {
  if (!LOCAL_GENESIS_CONTAINERS.includes(container)) throw new Error(`not a Genesis instance: ${container}`);
  const inner = ["podman", "exec", container, "curl", "-sk", "--max-time", "20",
    "-H", "X-Caller-Type: platform", "-H", "Accept: application/json",
    "https://localhost:8001/beadspace/universe"];
  if (local) return { file: inner[0], args: inner.slice(1) };
  return { file: "wsl.exe", args: ["-d", distro, "-u", "root", "-e", ...inner] };
}

/**
 * The fallback transport: Genesis on the fleet host, -a then -b. Resolves
 * {universe, etag}; throws with every instance's reason when none answers a U1 universe.
 */
function localGenesisFetcher({ execFile = require("node:child_process").execFile, containers = LOCAL_GENESIS_CONTAINERS,
  argvOf = localGenesisArgv, timeoutMs = LOCAL_FETCH_TIMEOUT_MS } = {}) {
  return async function fetchLocal() {
    const why = [];
    for (const container of containers) {
      let cmd;
      try { cmd = argvOf(container); } catch (error) { why.push(errorText(error)); continue; }
      const out = await new Promise((resolve) => {
        execFile(cmd.file, cmd.args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout) => resolve({ error, text: String(stdout || "") }));
      });
      if (!out.text.trim()) {
        why.push(`${container}: ${out.error ? errorText(out.error).slice(0, 120) : "no answer"}`);
        continue;
      }
      let body;
      try { body = JSON.parse(out.text); } catch { why.push(`${container}: unparseable answer`); continue; }
      if (!isUniverse(body)) {
        const detail = body && typeof body === "object" && body.detail ? String(body.detail).slice(0, 120) : "not a U1 universe";
        why.push(`${container}: ${detail}`);
        continue;
      }
      return { universe: body, etag: body.etag || null };
    }
    throw new Error(`local Genesis: ${why.join("; ") || "no instance"}`);
  };
}

/** The local fallback this desk can use: on the Windows host or inside the fleet host. */
function defaultLocalFetcher({ platform = process.platform, env = process.env } = {}) {
  if (env.AWDESK_SPACE_LOCAL === "0") return null;
  return platform === "win32" || env.AWDESK_FLEET_LOCAL === "1" ? localGenesisFetcher() : null;
}

/** The desk's Online bearer, resolved lazily so requiring this module needs no Electron. */
function deskToken() {
  return require("./browser-window.cjs").onlineToken();
}

/**
 * @param {object} opts
 * @param {(o:{etag:string|null}) => Promise<{notModified?:boolean, universe?:object, etag?:string|null}>} [opts.fetchUniverse]
 * @param {{remember:Function, recall:Function}|null} [opts.store]  last-good-cache.cjs
 * @param {() => {verdict:object|null, at:number, changedAt?:number}|null} [opts.fleetStatus]
 *        fleet-control's last verdict with its time (never a probe); deskFleetVerdict judges it
 * @param {number} [opts.fleetMaxAgeMs]  how old that verdict may be and still win
 */
function createSpaceClient({
  fetchUniverse = veilUniverseFetcher({ token: deskToken }),
  // main.cjs passes defaultLocalFetcher(); null here so a test never spawns wsl.exe
  fetchLocal = null,
  store = null,
  fleetStatus = () => null,
  now = () => Date.now(),
  ttlMs = CACHE_TTL_MS,
  fleetMaxAgeMs = FLEET_VERDICT_MAX_AGE_MS,
} = {}) {
  let snapshot = null; // the last REMOTE universe, raw
  let etag = null;
  let last = null; // { at, source, error, savedAt }
  let handed = null; // the last universe handed out, normalised -- what the IPC re-reads

  const statusNow = () => {
    try { return fleetStatus() || null; } catch { return null; }
  };

  function finish(source, raw, extra = {}) {
    const fleet = deskFleetVerdict(statusNow(), now(), fleetMaxAgeMs);
    const universe = raw ? normaliseUniverse(raw, fleet.verdict, fleet.at)
      : localSkeleton(fleet.verdict, now(), fleet);
    handed = universe;
    const out = { ok: true, universe, stale: source !== "remote" && source !== "genesis", source };
    if (extra.error) out.error = extra.error;
    if (extra.savedAt) out.savedAt = extra.savedAt;
    return out;
  }

  function fromLast() {
    if (last.source === "remote") return finish("remote", snapshot);
    if (last.source === "genesis") return finish("genesis", last.raw, last);
    if (last.source === "last-good") return finish("last-good", last.raw, last);
    return finish("local", null, last);
  }

  async function get({ fresh = false } = {}) {
    if (!fresh && last && now() - last.at < ttlMs) return fromLast();
    try {
      const answer = await fetchUniverse({ etag: snapshot ? etag : null });
      if (answer && answer.notModified) {
        if (!snapshot) throw new Error("universe route answered 304 to a first read");
      } else if (answer && isUniverse(answer.universe)) {
        snapshot = answer.universe;
        etag = answer.etag || snapshot.etag || null;
        if (store) {
          try { store.remember(CACHE_KEY, snapshot); } catch { /* memory still holds it */ }
        }
      } else {
        throw new Error("universe route: not a U1 universe");
      }
      last = { at: now(), source: "remote" };
      return fromLast();
    } catch (error) {
      let why = errorText(error).slice(0, 240);
      if (typeof fetchLocal === "function") {
        try {
          const answer = await fetchLocal();
          if (answer && isUniverse(answer.universe)) {
            if (store) {
              try { store.remember(CACHE_KEY, answer.universe); } catch { /* memory still holds it */ }
            }
            last = { at: now(), source: "genesis", raw: answer.universe, error: why };
            return fromLast();
          }
        } catch (localError) {
          why = `${why}; ${errorText(localError)}`.slice(0, 400);
        }
      }
      let saved = null;
      if (store) {
        try { saved = store.recall(CACHE_KEY); } catch { saved = null; }
      }
      if (saved && isUniverse(saved.value)) {
        last = { at: now(), source: "last-good", raw: saved.value, savedAt: saved.savedAt, error: why };
      } else if (snapshot) {
        last = { at: now(), source: "last-good", raw: snapshot, error: why };
      } else {
        last = { at: now(), source: "local", error: why };
      }
      return fromLast();
    }
  }

  return {
    get,
    /** The universe last handed to a page (normalised), or null before the first get(). */
    current: () => handed,
  };
}

module.exports = {
  createSpaceClient,
  veilUniverseFetcher,
  localGenesisFetcher,
  localGenesisArgv,
  defaultLocalFetcher,
  LOCAL_GENESIS_CONTAINERS,
  UNIT_VERB_RE,
  localSkeleton,
  normaliseUniverse,
  normaliseVerb,
  fleetHealth,
  deskFleetVerdict,
  isUniverse,
  API_BASE,
  ROUTE,
  CACHE_KEY,
  CACHE_TTL_MS,
  FLEET_VERDICT_MAX_AGE_MS,
  FETCH_TIMEOUT_MS,
  FLEET_VERBS,
  GPU_VERBS,
  GALAXIES,
  ID_RE,
};
