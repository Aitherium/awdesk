"use strict";

/**
 * universe-client.cjs -- his REAL work as bead-space bodies.
 *
 * The one-app plan, slice 8 (owner 2026-11-24: "individual apps/windows collapsed into
 * aithernet universe nodes/beadspace ... I want to see agent activity and routines and see
 * the system light up like a mind").
 *
 * Three universes already existed and none of them carried the desk's own work:
 *   arc.aitherium.com   the public mesh map (canvas, presentation)
 *   Veil BeadUniverse   the platform graph, mounted only inside the Expedition
 *   desk SpaceView      the platform's six galaxies
 * This module is the data half of the missing one: the desk's apps, its open windows, the
 * agents working in them, and the routines firing -- in bead-space's five-field contract
 * ({id, title, cluster, status, createdAt} + assignee/meta), so the EXISTING engine draws
 * ships (one node), patrols (several), stations (unassigned work) and pulses without a
 * line of new rendering.
 *
 * Pure: every source is injected. main.cjs owns the real readers; the tests own fakes, so
 * "a body count that disagrees with the desk's own state" is a failing test rather than a
 * picture nobody can check.
 *
 * Body rules (what makes the map honest):
 *   - an app body exists whether or not it is open (it is a place, not an event);
 *   - a window body exists exactly while that tab/window is open, and carries its app;
 *   - an agent is a SHIP, not a planet: it is an `assignee` on the bodies it touches, so
 *     the engine draws an orbit (one body) or a patrol (several) -- never a fake planet;
 *   - a routine is a STATION on its own body; unassigned work is the engine's slow station;
 *   - a source that stops answering DIMS (status "unknown"), it never empties the map.
 */

const APP_BODIES = Object.freeze([
  { id: "app:rooms", title: "Rooms", verb: "rooms.toggle" },
  { id: "app:pages", title: "Pages", verb: "pages.open" },
  { id: "app:forge", title: "Media Forge", verb: "forge.open" },
  { id: "app:world", title: "World", verb: "rooms.world" },
  { id: "app:net", title: "AitherNet", verb: "rooms.net" },
  { id: "app:search", title: "Search", verb: "search.web.open" },
  // Spaces (the shells: Living Desktop, Desktop Anywhere, awsh, GobboNet) and Workspaces
  // are places too (owner 2026-11-24: "aithermesh? workspaces? aither spaces?").
  { id: "app:spaces", title: "Spaces", verb: "desktop.shell.living-os" },
  { id: "app:workspaces", title: "Workspaces", verb: "workspace.switch" },
]);

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");

/** The app a tab belongs to, from its url -- the rail's own vocabulary. */
function appOfTab(tab) {
  const url = str(tab && tab.url);
  if (/\/companyroom/i.test(url)) return "app:rooms";
  if (/\/workspace\/(one|room)/i.test(url)) return "app:pages";
  if (/^aither:\/\/search/i.test(url)) return "app:search";
  if (/^aither:\/\/(space|canvas)/i.test(url)) return "app:forge";
  if (/shadowbroker\./i.test(url)) return "app:world";
  if (/arc\.aitherium\.com|aithernet/i.test(url)) return "app:net";
  if (/\/spaces?(\/|$)/i.test(url)) return "app:spaces";
  if (/\/workspaces?(\/|$)/i.test(url)) return "app:workspaces";
  return "app:browse";
}

/**
 * His work as one bead-space universe. Sources (all optional, all arrays):
 *   tabs      [{id,title,url,kind,owner,stage}]   the desk's open tabs/windows
 *   agents    [{id,label,kind,state,source}]      agent-roster-live rows
 *   routines  [{name,state,lastRun,nextDue}]      awrise jobs
 *   platform  {nodes, links}                      the U1 universe (space-client)
 *   pins      [{id,label,lat,lng}]                ShadowBroker pins (world-client)
 */
function buildUniverse({ tabs = [], agents = [], routines = [], platform = null, pins = [], now = Date.now } = {}) {
  const at = new Date(now()).toISOString();
  const nodes = [];
  const links = [];
  const seen = new Set();

  const push = (node) => {
    if (!node || !node.id || seen.has(node.id)) return false;
    seen.add(node.id);
    nodes.push(node);
    return true;
  };

  // ── apps: the places. Always on the map. ────────────────────────────────────
  const tabList = Array.isArray(tabs) ? tabs.filter(isObj) : [];
  for (const app of APP_BODIES) {
    const open = tabList.filter((t) => appOfTab(t) === app.id).length;
    push({
      id: app.id, title: app.title, cluster: "apps",
      status: open ? "active" : "idle", createdAt: at,
      meta: { kind: "app", verb: app.verb, open },
    });
  }

  // ── windows: one body per open tab, under its app ──────────────────────────
  for (const tab of tabList) {
    const id = `win:${str(tab.id) || str(tab.url)}`;
    const parent = appOfTab(tab);
    const title = str(tab.title) || str(tab.url) || "Untitled";
    if (push({
      id, title, cluster: "windows",
      status: tab.kind === "hosted" ? "active" : "idle", createdAt: at,
      meta: { kind: "window", app: parent, url: str(tab.url), tabId: str(tab.id), owner: str(tab.owner) },
    })) links.push({ source: parent, target: id, kind: "parent-child" });
  }

  // ── agents: SHIPS. An assignee on the bodies it works, never a planet. ─────
  const assignees = new Map(); // body id -> Set(agent)
  const agentRows = (Array.isArray(agents) ? agents : []).filter(isObj);
  for (const row of agentRows) {
    const agentId = str(row.id) || str(row.label);
    if (!agentId) continue;
    // What it is working on: a window whose title or url names it, else the app it is in.
    const label = str(row.label).toLowerCase();
    const targets = tabList
      .filter((t) => label && (`${str(t.title)} ${str(t.url)}`).toLowerCase().includes(label))
      .map((t) => `win:${str(t.id) || str(t.url)}`);
    const list = targets.length ? targets : ["app:rooms"];
    for (const target of list) {
      if (!seen.has(target)) continue;
      if (!assignees.has(target)) assignees.set(target, new Set());
      assignees.get(target).add(agentId);
    }
  }

  // ── routines: STATIONS on their own bodies ─────────────────────────────────
  for (const job of (Array.isArray(routines) ? routines : []).filter(isObj)) {
    const name = str(job.name) || str(job.id);
    if (!name) continue;
    const state = str(job.state).toLowerCase();
    push({
      id: `routine:${name}`, title: name, cluster: "routines",
      status: state === "starved" || state === "failed" ? "blocked" : state === "running" ? "active" : "idle",
      createdAt: str(job.lastRun) || at,
      meta: { kind: "routine", state, nextDue: str(job.nextDue), unassigned: true },
    });
  }

  // ── the platform's own galaxies: the outer ring, unchanged ─────────────────
  if (isObj(platform) && Array.isArray(platform.nodes)) {
    for (const n of platform.nodes) {
      if (!isObj(n) || !str(n.id)) continue;
      push({ ...n, cluster: str(n.cluster) || "platform", meta: { ...(isObj(n.meta) ? n.meta : {}), kind: str((n.meta || {}).kind) || "platform" } });
    }
    for (const l of Array.isArray(platform.links) ? platform.links : []) {
      if (isObj(l) && seen.has(str(l.source)) && seen.has(str(l.target))) links.push(l);
    }
  }

  // ── the World: ShadowBroker pins, if any were read ────────────────────────
  for (const pin of (Array.isArray(pins) ? pins : []).filter(isObj)) {
    const id = `world:${str(pin.id) || str(pin.label)}`;
    push({
      id, title: str(pin.label) || "Pin", cluster: "world", status: "active",
      createdAt: str(pin.at) || at,
      meta: { kind: "pin", lat: Number(pin.lat), lng: Number(pin.lng) },
    });
  }

  // Ships ride the nodes they touch: the engine draws an orbit for one, a patrol for many.
  for (const [target, who] of assignees) {
    const node = nodes.find((n) => n.id === target);
    if (node) node.assignee = [...who][0];   // bead-space's assignee is one owner
    if (who.size > 1) node.meta = { ...(node.meta || {}), crew: [...who] };
  }

  return { nodes, links };
}

/**
 * The awrise doc (`~/.aither/awrise/jobs.json`) -> routine rows for buildUniverse.
 * A job that is failing becomes "starved" (the engine draws a slow station); a
 * disabled one is kept and marked, because a paused routine is a decision, not a death.
 */
function routinesFromJobs(doc) {
  // The real file is {schema, jobs: {...}} (127 jobs on this host, measured 2026-11-24);
  // the bare map is accepted too so a test and an older host both work.
  const jobs = doc && typeof doc === "object" && doc.jobs && typeof doc.jobs === "object" ? doc.jobs : doc;
  const out = [];
  for (const [name, j] of Object.entries(jobs && typeof jobs === "object" ? jobs : {})) {
    if (!j || typeof j !== "object") continue;
    const failing = Number(j.consecutive_failures) > 0;
    out.push({
      name,
      state: j.enabled === false ? "disabled" : failing ? "starved" : "idle",
      lastRun: j.last_finished_at || null,
      nextDue: j.next_due || null,
    });
  }
  return out;
}

/**
 * The live planes as motion on the map (plane-client.cjs snapshots in, signals out).
 *
 *   flux /stats, /services  -> `ping`: a body that just carried work pulses
 *   pulse /disk/status      -> `dim`: headroom gone squeezes the whole platform
 *   watch /plugins/alerts   -> `dim`: an alerting plugin dims the service it names
 *
 * Only nodes that are ON the map are named, so a signal can never invent a body. A read
 * that failed is reported in `notes` -- silence about a plane nobody could read is how
 * a dead observability lane looks healthy.
 */
function signalsFromPlanes(nodes, planes = {}) {
  const ids = new Set((Array.isArray(nodes) ? nodes : []).map((n) => n && n.id).filter(Boolean));
  const ping = new Set();
  const dim = new Set();
  const notes = [];
  const reads = (planeId) => {
    const snap = planes[planeId];
    return snap && Array.isArray(snap.reads) ? snap.reads : [];
  };
  const read = (planeId, id) => reads(planeId).find((r) => r && r.id === id);

  const stats = read("flux", "stats");
  if (stats && stats.ok) {
    if (ids.has("platform")) ping.add("platform");
    if (stats.stale) notes.push({ plane: "flux", note: "stats are the last good copy" });
  } else if (stats) notes.push({ plane: "flux", note: String(stats.error || "unreadable") });

  const services = read("flux", "services");
  if (services && services.ok && services.data) {
    const rows = services.data.services || services.data;
    const names = Array.isArray(rows) ? rows.map((r) => (r && (r.name || r.service)) || r) : Object.keys(rows || {});
    for (const name of names) {
      const id = `svc:${String(name).toLowerCase()}`;
      if (ids.has(id)) ping.add(id);
    }
  }

  const disk = read("pulse", "disk");
  if (disk && disk.ok && disk.data) {
    const level = String(disk.data.status || disk.data.level || disk.data.state || "ok").toLowerCase();
    if (level !== "ok" && level !== "healthy" && ids.has("platform")) dim.add("platform");
  } else if (disk) notes.push({ plane: "pulse", note: String(disk.error || "disk unreadable") });

  const alerts = read("watch", "alerts");
  if (alerts && alerts.ok && alerts.data) {
    const list = Array.isArray(alerts.data.alerts) ? alerts.data.alerts : [];
    for (const a of list) {
      const who = String((a && (a.service || a.plugin || a.name)) || "").toLowerCase();
      const id = who ? `svc:${who}` : "";
      if (id && ids.has(id)) dim.add(id);
    }
    if (list.length && ids.has("platform")) dim.add("platform");
  } else if (alerts) notes.push({ plane: "watch", note: String(alerts.error || "alerts unreadable") });

  return { ping: [...ping], dim: [...dim], notes };
}

/**
 * Chronicle (the append-only ledger) as a TRAIL on the map: what just happened, in order.
 *
 * Each event names a service and an event_type; a body that is on the map gets a trail
 * point, and an event whose service is not a body is COUNTED (`dropped`), never hidden --
 * a trail that silently forgets half the system reads as a quiet system.
 */
function trailFromEvents(events, nodes) {
  const ids = new Set((Array.isArray(nodes) ? nodes : []).map((n) => n && n.id).filter(Boolean));
  const trail = [];
  let dropped = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") { dropped += 1; continue; }
    const service = String(e.service || e.source || "").toLowerCase();
    const type = String((e.data && e.data.event_type) || e.event_type || e.type || "").trim();
    const body = service ? `svc:${service}` : "";
    const at = String(e.timestamp || e.at || e.time || "");
    if (!body || !ids.has(body) || !type) { dropped += 1; continue; }
    trail.push({ body, at, type, level: String(e.level || "") });
  }
  trail.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { trail, dropped };
}

/** What a source failing must look like: the last good bodies, dimmed -- never an empty map. */
function dim(last, source, error) {
  if (!isObj(last) || !Array.isArray(last.nodes)) return { nodes: [], links: [], degraded: [{ source, error: str(error) }] };
  return {
    nodes: last.nodes.map((n) => ({ ...n, status: "unknown" })),
    links: Array.isArray(last.links) ? last.links : [],
    degraded: [{ source, error: str(error) }],
  };
}

module.exports = { buildUniverse, dim, appOfTab, APP_BODIES, routinesFromJobs, signalsFromPlanes, trailFromEvents };
