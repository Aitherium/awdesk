"use strict";

/**
 * command-center.cjs -- the Alt+Space command center (owner 2026-11-13: "Alt+Space
 * integration and all that too: managing and seeing agent runs, agents in the fleet,
 * connected local awdk agents, managed agents, Claude Code, twins etc., and projects
 * and tasks and knowledge and agent runs and context and company brain and routines,
 * schedules, calendar, people, graphed etc.").
 *
 * It is NOT a new aggregator and keeps NO store. It is five more providers on the
 * SAME universal-search registry the launcher already runs (universal-search.cjs
 * register()), each reading a source that already exists:
 *
 *   cc-agents     the harness daemon's unified sessions (Claude Code tabs, awdk/awsh
 *                 sessions; :8362 /sessions/unified), live runs from Atlas presence
 *                 (the Pulse atlas.item board), fleet agents (get_agent_fleet_status),
 *                 local awdk agents (:8362 /agents) and managed twins (managed_twin_list).
 *   cc-work       projects + tasks (tasks_list_projects, the Atlas projects store), the
 *                 2027 roadmap (docs/plans/roadmap/ai-2027-roadmap.yaml) and open PRs
 *                 that need the owner (gh search prs). Decision cards stay on the
 *                 launcher's own card path (launcher-window.cjs) so they answer inline.
 *   cc-knowledge  plans (docs/plans, local + develop on GitHub), agent notebooks
 *                 (~/.aither/notebooks) and memory (awm recall).
 *   cc-time       awrise schedules with their last verdict (~/.aither/awrise/jobs.json),
 *                 routines (AitherOS/config/routines/*.yaml) and calendar events.
 *   cc-people     the workspace directory and contacts.
 *
 * Every snapshot provider answers from a cache refreshed in the background, so the
 * first keystroke never waits on the gateway; only the first-ever load is awaited,
 * briefly. A source that fails is an `errors` row ("<source> -- <why>"), never an
 * empty list that reads as "nothing there".
 *
 * Verbs (act): open, steer, stop, transcript, graph, detail. A verb a row cannot do
 * says WHY (the daemon's own why_not for a session), never a silent no-op. The graph
 * verb joins what these sources already say about one item (a session's project, a
 * run's agent, a task's project and assignee, a person's events) and adds the
 * platform's own graph tools (graph_find, graph_traverse) -- no graph store here.
 *
 * Electron-free: callTool (gateway-mcp.cjs), harness (harness-relay.cjs relayHarness),
 * execFile, fs and the clock are injected; command-center.test.cjs runs it under
 * `node --test`.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CC_KINDS = Object.freeze(new Set([
  "session", "run", "fleet-agent", "local-agent", "twin",
  "project", "task", "roadmap", "pr",
  "plan", "notebook", "memory",
  "schedule", "routine", "event",
  "person",
]));

const GROUPS = Object.freeze([
  Object.freeze({ id: "cc-agents", label: "Agents & runs", priority: 1, boost: 12 }),
  Object.freeze({ id: "cc-work", label: "Work", priority: 2, boost: 8 }),
  Object.freeze({ id: "cc-knowledge", label: "Knowledge", priority: 3, boost: 4 }),
  Object.freeze({ id: "cc-time", label: "Time", priority: 4, boost: 4 }),
  Object.freeze({ id: "cc-people", label: "People", priority: 5, boost: 6 }),
]);

/** Typing the category's word lists all of it (as "screenshot" lists the shots). */
const CATEGORY_WORDS = Object.freeze({
  session: ["sessions", "claude", "claude code", "awsh", "tabs"],
  run: ["runs", "agent runs", "running", "live", "expeditions", "workflows"],
  "fleet-agent": ["agents", "fleet", "fleet agents"],
  "local-agent": ["agents", "awdk", "local agents"],
  twin: ["twins", "managed", "managed agents"],
  project: ["projects"],
  task: ["tasks", "todo"],
  roadmap: ["roadmap", "2027"],
  pr: ["prs", "pull requests", "pr"],
  plan: ["plans", "docs"],
  notebook: ["notebooks"],
  memory: ["memory", "brain", "company brain"],
  schedule: ["schedules", "awrise", "jobs"],
  routine: ["routines"],
  event: ["calendar", "events", "meetings", "agenda"],
  person: ["people", "team", "directory", "contacts"],
});

const SNAPSHOT_TTL_MS = Object.freeze({ fast: 20_000, slow: 10 * 60_000 });
const FIRST_WAIT_MS = 2_500;
const FAILED_RETRY_MS = 30_000;
const TEXT_MAX = 300;
const ID_SAFE = /^[A-Za-z0-9_.:-]{1,128}$/;

function clip(value, n = TEXT_MAX) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function norm(text) {
  return String(text || "").toLowerCase();
}

function parseJson(text) {
  if (text && typeof text === "object") return text;
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

/** "5 min ago" / "in 3 h" from an ISO time, relative to now. */
function ago(iso, now = Date.now()) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "";
  const d = Math.round((now - t) / 60_000);
  const abs = Math.abs(d);
  const span = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return d >= 0 ? `${span} ago` : `in ${span}`;
}

/** True when the query is the category word for `kind` ("agents", "calendar"). */
function wantsCategory(kind, query) {
  const q = norm(query).trim();
  return Boolean(q) && (CATEGORY_WORDS[kind] || []).includes(q);
}

// ── shapers: one source's answer -> records ─────────────────────────────────
// A record: {ref, kind, group, title, subtitle, text (searchable), url?, ...source fields}.

const STATUS_RANK = { "waiting-permission": 0, "waiting-input": 1, "blocked?": 2, working: 3, idle: 4 };
const DEAD_STATUS = new Set(["exited", "dead", "ended"]);
const HARNESS_LABEL = { claude: "Claude Code", "claude-tty": "Claude Code", awdk: "awdk", aither: "Aither",
  codex: "Codex", gemini: "Gemini", opencode: "OpenCode", aider: "Aider", terminal: "Shell", group: "Group" };

function shapeSessions(body) {
  const rows = body && Array.isArray(body.sessions) ? body.sessions : [];
  return rows.filter((s) => s && ID_SAFE.test(String(s.id || "")) && !DEAD_STATUS.has(String(s.status || "")))
    .sort((a, b) => (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5))
    .map((s) => {
      const harness = HARNESS_LABEL[s.harness] || String(s.harness || "session");
      const where = s.cwd ? path.basename(String(s.cwd)) : "";
      const status = String(s.status || "?");
      const actions = s.actions && typeof s.actions === "object" ? s.actions : {};
      return {
        ref: `session:${s.id}`, kind: "session", group: "cc-agents", id: String(s.id),
        title: clip(s.title || `${harness} ${String(s.id).slice(0, 8)}`, 120),
        subtitle: clip([harness, status === "waiting-input" || status === "waiting-permission" ? "needs you" : status,
          where, s.last_activity_summary && s.last_activity_summary !== "(no activity)" ? s.last_activity_summary : ""]
          .filter(Boolean).join(" · "), 200),
        status, harness: String(s.harness || ""), cwd: String(s.cwd || ""),
        actions: { message: actions.message === true, interrupt: actions.interrupt === true, focus: actions.focus === true, input: actions.input === true },
        whyNot: actions.why_not && typeof actions.why_not === "object" ? actions.why_not : {},
        daemonOwned: actions.interrupt === true,
        text: [s.title, harness, status, s.cwd, s.last_activity_summary].join(" "),
      };
    });
}

function shapePresence(data) {
  const agents = data && Array.isArray(data.agents) ? data.agents : [];
  const out = [];
  for (const a of agents) {
    for (const w of Array.isArray(a.work) ? a.work : []) {
      const key = String(w.key || "");
      if (!key) continue;
      const [type, ...rest] = key.split(":");
      const id = rest.join(":");
      out.push({
        ref: `run:${key}`, kind: "run", group: "cc-agents", id, runType: type,
        title: clip(w.title || key, 120),
        subtitle: clip([a.label || a.agent, String(w.state || "").replace(/_/g, " "), w.program].filter(Boolean).join(" · "), 200),
        agent: String(a.agent || ""), state: String(w.state || ""), url: /^https?:\/\//.test(String(w.url || "")) ? String(w.url) : "",
        text: [w.title, a.agent, a.label, w.state, w.program, key].join(" "),
      });
    }
  }
  return out;
}

function shapeFleetAgents(data) {
  const rows = data && Array.isArray(data.agents) ? data.agents : [];
  const order = { working: 0, waiting: 1, idle: 2 };
  return rows.filter((a) => a && a.id)
    .sort((a, b) => (order[a.liveness] ?? 3) - (order[b.liveness] ?? 3))
    .map((a) => ({
      ref: `fleet-agent:${a.id}`, kind: "fleet-agent", group: "cc-agents", id: String(a.id),
      title: String(a.name || a.id),
      subtitle: clip(["Fleet agent", a.liveness, a.live_items ? `${a.live_items} live` : "", a.needs_owner ? `${a.needs_owner} need you` : "",
        a.last_active && a.last_active !== "not measured" ? `last ${a.last_active}` : ""].filter(Boolean).join(" · ")),
      liveness: String(a.liveness || ""),
      text: [a.id, a.name, a.liveness, "fleet agent"].join(" "),
    }));
}

function shapeLocalAgents(body) {
  const rows = body && Array.isArray(body.agents) ? body.agents : [];
  return rows.filter((a) => a && a.id).map((a) => ({
    ref: `local-agent:${a.id}`, kind: "local-agent", group: "cc-agents", id: String(a.id),
    title: `${a.label || a.id} (this PC)`,
    subtitle: clip(`Local awdk agent · ${a.role || ""}`),
    text: [a.id, a.label, a.role, "awdk local"].join(" "),
  }));
}

function shapeTwins(data) {
  const list = Array.isArray(data) ? data : (data && (data.twins || data.agents || (data.result && data.result.twins))) || [];
  return (Array.isArray(list) ? list : []).filter((t) => t && (t.name || t.id || t.agent)).map((t) => {
    const id = String(t.name || t.agent || t.id);
    return {
      ref: `twin:${id}`, kind: "twin", group: "cc-agents", id,
      title: `${id} (managed twin)`,
      subtitle: clip(["Managed agent", t.status, t.model].filter(Boolean).join(" · ")),
      text: [id, t.status, t.model, "managed twin"].join(" "),
    };
  });
}

/** tasks_list_projects is MB-sized: keep names, status and task titles only. */
function shapeProjects(data, now = Date.now()) {
  const projects = data && Array.isArray(data.projects) ? data.projects : [];
  const out = [];
  for (const p of projects) {
    if (!p || !p.project_id) continue;
    const tasks = Array.isArray(p.tasks) ? p.tasks : [];
    const open = tasks.filter((t) => t && !/^(done|completed|cancelled|closed)$/i.test(String(t.status || "")));
    out.push({
      ref: `project:${p.project_id}`, kind: "project", group: "cc-work", id: String(p.project_id),
      title: clip(p.name || p.project_id, 120),
      subtitle: clip(["Project", p.status, `${open.length} open / ${tasks.length} tasks`, p.updated_at ? `updated ${ago(p.updated_at, now)}` : "",
        p.description].filter(Boolean).join(" · ")),
      updatedAt: String(p.updated_at || ""), description: clip(p.description, 600),
      text: [p.name, p.description, p.source].join(" "),
    });
    for (const t of tasks.slice(0, 200)) {
      if (!t || !t.task_id) continue;
      out.push({
        ref: `task:${t.task_id}`, kind: "task", group: "cc-work", id: String(t.task_id),
        title: clip(t.title || t.task_id, 120),
        subtitle: clip(["Task", t.status, t.priority, t.assignee ? `@${t.assignee}` : "", p.name].filter(Boolean).join(" · ")),
        project: String(p.project_id), projectName: String(p.name || ""), assignee: String(t.assignee || ""),
        status: String(t.status || ""), description: clip(t.description, 600),
        text: [t.title, t.status, t.assignee, p.name, t.description].join(" "),
      });
    }
  }
  return out;
}

/** The roadmap yaml without a YAML dependency: every `- key:` / `title:` pair. */
function shapeRoadmap(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+(?:key|id):\s*["']?([^"'#]+?)["']?\s*$/);
    if (start) { if (cur) out.push(cur); cur = { key: start[1].trim(), fields: {} }; continue; }
    const field = cur && line.match(/^\s+(title|name|quarter|month|when|status|owner|area|lane):\s*["']?(.*?)["']?\s*$/);
    if (field) cur.fields[field[1]] = field[2];
  }
  if (cur) out.push(cur);
  return out.filter((r) => r.fields.title || r.fields.name).map((r) => ({
    ref: `roadmap:${r.key}`, kind: "roadmap", group: "cc-work", id: r.key,
    title: clip(r.fields.title || r.fields.name, 120),
    subtitle: clip(["2027 roadmap", r.fields.quarter || r.fields.month || r.fields.when, r.fields.status, r.fields.owner, r.fields.area || r.fields.lane]
      .filter(Boolean).join(" · ")),
    owner: String(r.fields.owner || ""),
    text: [r.key, ...Object.values(r.fields)].join(" "),
  }));
}

function shapePrs(rows, why) {
  return (Array.isArray(rows) ? rows : []).filter((p) => p && p.url && p.number).map((p) => {
    const repo = (p.repository && (p.repository.nameWithOwner || p.repository.name)) || "";
    return {
      ref: `pr:${repo}#${p.number}`, kind: "pr", group: "cc-work", id: `${repo}#${p.number}`,
      title: clip(`#${p.number} ${p.title}`, 140),
      subtitle: clip([why, repo, p.isDraft ? "draft" : "", p.updatedAt ? `updated ${ago(p.updatedAt)}` : ""].filter(Boolean).join(" · ")),
      url: String(p.url), text: [p.number, p.title, repo, why].join(" "),
    };
  });
}

function shapePlans(localNames, remoteNames, repoRoot) {
  const seen = new Set();
  const out = [];
  const add = (name, where) => {
    if (!/\.md$/i.test(name) || seen.has(name)) return;
    seen.add(name);
    const title = name.replace(/\.md$/i, "").replace(/^(\d{4}-\d{2}-\d{2})-/, "").replace(/-/g, " ");
    const date = (name.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
    out.push({
      ref: `plan:${name}`, kind: "plan", group: "cc-knowledge", id: name,
      title: clip(title, 120), subtitle: clip(["Plan", date, where === "remote" ? "develop" : "this PC"].filter(Boolean).join(" · ")),
      url: where === "remote" ? `https://github.com/Aitherium/AitherOS/blob/develop/docs/plans/${encodeURIComponent(name)}` : "",
      file: where === "local" ? path.join(repoRoot, "docs", "plans", name) : "",
      text: `${title} ${name} plan`,
    });
  };
  for (const n of remoteNames || []) add(n, "remote");
  for (const n of localNames || []) add(n, "local");
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

function shapeNotebook(file, json) {
  const nb = parseJson(json);
  if (!nb || !Array.isArray(nb.cells)) return null;
  const meta = (nb.metadata && nb.metadata.aitheros) || {};
  const id = String(meta.notebook_id || path.basename(file, ".ipynb"));
  const first = nb.cells.find((c) => c && c.cell_type === "markdown");
  const src = first ? (Array.isArray(first.source) ? first.source.join("\n") : String(first.source || "")) : "";
  const heading = (src.match(/^#+\s*(.+)$/m) || [])[1] || id;
  return {
    ref: `notebook:${id}`, kind: "notebook", group: "cc-knowledge", id,
    title: clip(heading, 120), subtitle: clip(`Notebook · ${id} · ${nb.cells.length} cells`), file,
    text: `${heading} ${id} notebook ${src.slice(0, 400)}`,
  };
}

function shapeMemory(rows) {
  return (Array.isArray(rows) ? rows : []).filter((m) => m && m.key).map((m) => {
    let value = m.value;
    if (typeof value !== "string") value = JSON.stringify(value);
    return {
      ref: `memory:${m.scope || ""}:${m.key}`, kind: "memory", group: "cc-knowledge", id: String(m.key),
      title: clip(String(m.key).replace(/[-_]/g, " "), 120), subtitle: clip(`Memory · ${value}`, 200),
      detail: String(value).slice(0, 4000), scope: String(m.scope || ""),
      text: `${m.key} ${String(value).slice(0, 500)}`, score: 45,
    };
  });
}

function shapeSchedules(jobs, now = Date.now()) {
  const out = [];
  for (const [name, j] of Object.entries(jobs && typeof jobs === "object" ? jobs : {})) {
    if (!j || typeof j !== "object") continue;
    const failing = Number(j.consecutive_failures) > 0;
    const verdict = !j.enabled ? "disabled" : failing ? `failing ×${j.consecutive_failures}` : (j.last_state || "never ran");
    out.push({
      ref: `schedule:${name}`, kind: "schedule", group: "cc-time", id: name,
      title: name,
      subtitle: clip(["awrise", j.every || j.at || "", `last: ${verdict}`, j.last_finished_at ? ago(j.last_finished_at, now) : "",
        j.next_due && j.enabled ? `next ${ago(j.next_due, now)}` : ""].filter(Boolean).join(" · ")),
      failing, enabled: j.enabled !== false, detail: JSON.stringify({ ...j, run: undefined }, null, 2).slice(0, 4000),
      text: `${name} ${j.last_state || ""} ${verdict} schedule`,
    });
  }
  return out.sort((a, b) => Number(b.failing) - Number(a.failing) || a.id.localeCompare(b.id));
}

/** Routine YAML -> [{id, name, schedule}] by line pattern (no YAML dependency). */
function shapeRoutineFile(file, text) {
  const out = [];
  let cur = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const id = line.match(/^- id:\s*["']?([A-Za-z0-9_.-]+)/);
    if (id) { if (cur) out.push(cur); cur = { id: id[1], name: "", schedule: [], enabled: true }; continue; }
    if (!cur) continue;
    const name = line.match(/^ {2}name:\s*(.+)$/);
    if (name) cur.name = name[1].replace(/^["']|["']$/g, "");
    const en = line.match(/^ {2}enabled:\s*(\w+)/);
    if (en) cur.enabled = en[1] !== "false";
    const sch = line.match(/^ {4}(interval_minutes|cron|time|at|type):\s*(.+)$/);
    if (sch) cur.schedule.push(sch[1] === "interval_minutes" ? `every ${sch[2]} min` : sch[1] === "type" ? "" : sch[2]);
  }
  if (cur) out.push(cur);
  return out.map((r) => ({
    ref: `routine:${r.id}`, kind: "routine", group: "cc-time", id: r.id,
    title: clip(r.name || r.id, 120),
    subtitle: clip(["Routine", r.schedule.filter(Boolean).join(" "), r.enabled ? "" : "disabled", path.basename(file)].filter(Boolean).join(" · ")),
    file, text: `${r.id} ${r.name} routine`,
  }));
}

function shapeEvents(data, now = Date.now()) {
  const list = data && Array.isArray(data.events) ? data.events : [];
  return list.filter((e) => e && e.event_id).map((e) => {
    const start = e.start_time || e.start || "";
    const when = Number.isFinite(Date.parse(start)) ? new Date(start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    return {
      ref: `event:${e.event_id}`, kind: "event", group: "cc-time", id: String(e.event_id),
      title: clip(e.title || "Event", 120),
      subtitle: clip(["Calendar", when, ago(start, now), e.location].filter(Boolean).join(" · ")),
      start, detail: clip(e.description, 2000),
      text: `${e.title} ${e.description || ""} ${e.location || ""} calendar`,
    };
  }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

function shapePeople(members, contacts) {
  const out = [];
  const seen = new Set();
  const add = (p, source) => {
    const email = String(p.email || p.mail || "").toLowerCase();
    const name = String(p.display_name || p.name || p.cn || p.user_id || email || "");
    if (!name) return;
    const key = email || name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      ref: `person:${key}`, kind: "person", group: "cc-people", id: key,
      title: clip(name, 100),
      subtitle: clip([source, p.role, email, p.relay_nick ? `relay @${p.relay_nick}` : "",
        Array.isArray(p.tags) ? p.tags.slice(0, 3).join(", ") : ""].filter(Boolean).join(" · ")),
      email, nick: String(p.relay_nick || p.user_id || ""), detail: clip(p.notes, 1500),
      text: [name, email, p.role, p.user_id, Array.isArray(p.tags) ? p.tags.join(" ") : "", p.notes].join(" "),
    });
  };
  for (const m of (members && Array.isArray(members.members) ? members.members : [])) add(m, "Team");
  for (const c of (contacts && Array.isArray(contacts.contacts) ? contacts.contacts : [])) add(c, "Contact");
  return out;
}

// ── the command center ──────────────────────────────────────────────────────

/**
 * @param {{callTool?: (name: string, args?: object) => Promise<string>,
 *   harness?: (msg: {method: string, path: string, body?: object}) => Promise<{ok: boolean, status?: number, data?: any, error?: string}>,
 *   execFile?: Function, fsImpl?: typeof fs, env?: object, now?: () => number, repoRoot?: string, home?: string}} [deps]
 */
function createCommandCenter({
  callTool = (name, args) => require("./gateway-mcp.cjs").callTool(name, args),
  harness = (msg) => {
    const relay = require("./harness-relay.cjs");
    return relay.relayHarness(msg, { extraRoutes: relay.MAIN_ONLY_ROUTES });
  },
  execFile = require("node:child_process").execFile,
  fsImpl = fs,
  env = process.env,
  now = () => Date.now(),
  repoRoot = env.AITHER_REPO_ROOT || "C:\\AitherOS-Fresh",
  home = os.homedir(),
} = {}) {
  /** ref -> record, across every source, for act()/graph(). */
  const records = new Map();
  const sources = new Map(); // name -> {at, loading, records, error}

  const run = (file, args, { cwd, timeoutMs = 20_000 } = {}) => new Promise((resolve) => {
    try {
      execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
        (error, stdout, stderr) => resolve(error ? { ok: false, error: clip(stderr || error.message, 200) } : { ok: true, stdout: String(stdout || "") }));
    } catch (error) {
      resolve({ ok: false, error: clip(error && error.message, 200) });
    }
  });

  const tool = async (name, args = {}) => {
    const text = await callTool(name, args);
    const data = parseJson(text);
    if (data == null) throw new Error(clip(text, 160) || `${name} answered nothing`);
    if (data && data.ok === false && data.error) {
      const e = data.error;
      throw new Error(clip(typeof e === "string" ? e : (e.message || JSON.stringify(e)), 160));
    }
    if (data && typeof data.error === "string" && !Array.isArray(data.agents)) throw new Error(clip(data.error, 160));
    return data;
  };

  const readJson = (file) => parseJson(fsImpl.readFileSync(file, "utf8"));

  /** name -> {group, ttl, label, load: async () => records[]} */
  const LOADERS = {
    sessions: { group: "cc-agents", ttl: SNAPSHOT_TTL_MS.fast, label: "Sessions (awsh :8362)", load: async () => {
      const r = await harness({ method: "GET", path: "/sessions/unified" });
      if (!r || !r.ok) throw new Error((r && (r.error || (r.data && r.data.detail))) || `daemon answered ${r && r.status}`);
      return shapeSessions(r.data);
    } },
    runs: { group: "cc-agents", ttl: SNAPSHOT_TTL_MS.fast, label: "Live runs (Atlas presence)", load: async () => shapePresence(await tool("atlas_presence")) },
    fleet: { group: "cc-agents", ttl: 60_000, label: "Fleet agents", load: async () => {
      try {
        return shapeFleetAgents(await tool("get_agent_fleet_status"));
      } catch (error) {
        // Measured 2026-11-13: get_agent_fleet_status can pass the desk's 15 s socket
        // bound under load; active_agents reads the same presence board in ~2 s.
        const data = await tool("active_agents");
        const rows = (data && Array.isArray(data.agents) ? data.agents : []).map((a) => ({ id: a.agent_id, name: a.agent_id,
          liveness: a.status, live_items: a.live_items, needs_owner: a.needs_owner }));
        if (!rows.length) throw error;
        return shapeFleetAgents({ agents: rows });
      }
    } },
    local: { group: "cc-agents", ttl: SNAPSHOT_TTL_MS.slow, label: "Local awdk agents", load: async () => {
      const r = await harness({ method: "GET", path: "/agents" });
      if (!r || !r.ok) throw new Error((r && r.error) || `daemon answered ${r && r.status}`);
      return shapeLocalAgents(r.data);
    } },
    twins: { group: "cc-agents", ttl: SNAPSHOT_TTL_MS.slow, label: "Managed twins", load: async () => shapeTwins(await tool("managed_twin_list")) },
    projects: { group: "cc-work", ttl: SNAPSHOT_TTL_MS.slow, label: "Projects & tasks", load: async () => shapeProjects(await tool("tasks_list_projects"), now()) },
    roadmap: { group: "cc-work", ttl: SNAPSHOT_TTL_MS.slow, label: "2027 roadmap", load: async () => {
      const local = path.join(repoRoot, "docs", "plans", "roadmap", "ai-2027-roadmap.yaml");
      let text = null;
      try { text = fsImpl.readFileSync(local, "utf8"); } catch { /* not on this tree: ask develop */ }
      if (text == null) {
        const r = await run("gh", ["api", "-H", "Accept: application/vnd.github.raw", "repos/Aitherium/AitherOS/contents/docs/plans/roadmap/ai-2027-roadmap.yaml?ref=develop"]);
        if (!r.ok) throw new Error(/404|Not Found/i.test(r.error) ? "docs/plans/roadmap/ai-2027-roadmap.yaml is not on develop yet" : r.error);
        text = r.stdout;
      }
      return shapeRoadmap(text);
    } },
    prs: { group: "cc-work", ttl: 5 * 60_000, label: "PRs (gh)", load: async () => {
      const fields = "number,title,repository,url,isDraft,updatedAt";
      const [review, mine] = await Promise.all([
        run("gh", ["search", "prs", "--owner", "Aitherium", "--state", "open", "--review-requested=@me", "--json", fields, "--limit", "30"]),
        run("gh", ["search", "prs", "--owner", "Aitherium", "--state", "open", "--author=@me", "--json", fields, "--limit", "40"]),
      ]);
      if (!review.ok && !mine.ok) throw new Error(review.error || mine.error);
      return [...shapePrs(review.ok ? parseJson(review.stdout) : [], "Review requested"),
        ...shapePrs(mine.ok ? parseJson(mine.stdout) : [], "Yours, open")];
    } },
    plans: { group: "cc-knowledge", ttl: SNAPSHOT_TTL_MS.slow, label: "Plans", load: async () => {
      let local = [];
      try { local = fsImpl.readdirSync(path.join(repoRoot, "docs", "plans")); } catch { /* none here */ }
      const r = await run("gh", ["api", "repos/Aitherium/AitherOS/contents/docs/plans?ref=develop", "--jq", ".[].name"]);
      const remote = r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
      if (!local.length && !remote.length) throw new Error(r.error || "no docs/plans here or on develop");
      return shapePlans(local, remote, repoRoot);
    } },
    notebooks: { group: "cc-knowledge", ttl: 60_000, label: "Notebooks", load: async () => {
      const dir = path.join(home, ".aither", "notebooks");
      let names;
      try { names = fsImpl.readdirSync(dir).filter((n) => /\.ipynb$/i.test(n)); } catch { return []; }
      return names.map((n) => { try { return shapeNotebook(path.join(dir, n), fsImpl.readFileSync(path.join(dir, n), "utf8")); } catch { return null; } })
        .filter(Boolean);
    } },
    schedules: { group: "cc-time", ttl: 30_000, label: "awrise schedules", load: async () => {
      const data = readJson(path.join(home, ".aither", "awrise", "jobs.json"));
      if (!data) throw new Error("~/.aither/awrise/jobs.json unreadable");
      return shapeSchedules(data.jobs && typeof data.jobs === "object" ? data.jobs : data, now());
    } },
    routines: { group: "cc-time", ttl: SNAPSHOT_TTL_MS.slow, label: "Routines", load: async () => {
      const dir = path.join(repoRoot, "AitherOS", "config", "routines");
      const names = fsImpl.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n));
      const out = [];
      for (const n of names) { try { out.push(...shapeRoutineFile(path.join(dir, n), fsImpl.readFileSync(path.join(dir, n), "utf8"))); } catch { /* skip */ } }
      return out;
    } },
    calendar: { group: "cc-time", ttl: 5 * 60_000, label: "Calendar", load: async () => shapeEvents(await tool("calendar_list_events"), now()) },
    people: { group: "cc-people", ttl: SNAPSHOT_TTL_MS.slow, label: "People", load: async () => {
      const [members, contacts] = await Promise.allSettled([tool("workspace_directory_list_members"), tool("contacts_list")]);
      if (members.status === "rejected" && contacts.status === "rejected") throw members.reason;
      return shapePeople(members.status === "fulfilled" ? members.value : null, contacts.status === "fulfilled" ? contacts.value : null);
    } },
  };

  function refresh(name) {
    const def = LOADERS[name];
    const s = sources.get(name) || { at: -Infinity, loading: null, records: [], error: null };
    sources.set(name, s);
    if (s.loading) return s.loading;
    // A failed load retries after FAILED_RETRY_MS, not the source's full TTL.
    if (now() - s.at < (s.error ? Math.min(def.ttl, FAILED_RETRY_MS) : def.ttl)) return null;
    s.loading = Promise.resolve().then(() => def.load())
      .then((rows) => {
        // A session that ended or a run that finished is no longer actionable.
        for (const old of s.records) records.delete(old.ref);
        s.records = Array.isArray(rows) ? rows : [];
        s.error = null;
      })
      .catch((error) => { s.error = clip((error && error.message) || error, 200); })
      .finally(() => {
        s.at = now();
        s.loading = null;
        for (const r of s.records) records.set(r.ref, r);
      });
    return s.loading;
  }

  /** The records of `names`, awaiting a first-ever load at most FIRST_WAIT_MS. */
  async function snapshot(names, { firstWaitMs = FIRST_WAIT_MS } = {}) {
    const pending = names.map((n) => {
      const p = refresh(n);
      return sources.get(n).at === -Infinity ? p : null;
    }).filter(Boolean);
    if (pending.length && firstWaitMs > 0) {
      let timer;
      await Promise.race([Promise.allSettled(pending), new Promise((r) => { timer = setTimeout(r, firstWaitMs); if (timer.unref) timer.unref(); })]);
      clearTimeout(timer);
    }
    const rows = [];
    const errors = [];
    for (const n of names) {
      const s = sources.get(n);
      rows.push(...s.records);
      if (s.error) errors.push(`${LOADERS[n].label}: ${s.error}`);
      else if (s.at === -Infinity) errors.push(`${LOADERS[n].label}: still loading`);
    }
    return { rows, errors };
  }

  /** Records -> universal-search rows; the category word lists everything of its kind. */
  function toRows(rows, query) {
    const q = norm(query).trim();
    const words = q.split(/\s+/).filter(Boolean);
    return rows.map((r, i) => {
      const hay = norm(`${r.title} ${r.text || ""}`);
      let score = r.score || 0;
      if (wantsCategory(r.kind, q)) score = 90 - i / 1000;
      else if (words.length && words.every((w) => hay.includes(w))) score = Math.max(score, norm(r.title).includes(q) ? 50 : 35);
      else if (r.score == null) score = 0;
      return { title: r.title, subtitle: r.subtitle, kind: r.kind, target: r.ref, score };
    });
  }

  const PROVIDER_SOURCES = {
    "cc-agents": ["sessions", "runs", "fleet", "local", "twins"],
    "cc-work": ["projects", "roadmap", "prs"],
    "cc-knowledge": ["plans", "notebooks"],
    "cc-time": ["schedules", "routines", "calendar"],
    "cc-people": ["people"],
  };

  /** awm recall per query (memory is a search, not a snapshot). */
  async function recallMemory(query, { signal = null } = {}) {
    const q = String(query || "").trim();
    if (q.length < 3) return { rows: [] };
    if (signal && signal.aborted) return { rows: [] };
    const r = await run("awm", ["recall", "--query", q, "--limit", "6", "--json"], { cwd: repoRoot, timeoutMs: 12_000 });
    if (!r.ok) return { rows: [], error: `Memory (awm recall): ${r.error}` };
    const rows = shapeMemory(parseJson(r.stdout));
    for (const m of rows) records.set(m.ref, m);
    return { rows };
  }

  function providers() {
    return GROUPS.map((g) => ({
      id: g.id, label: g.label, priority: 10 + g.priority, fast: g.id !== "cc-knowledge",
      search: async (query, { signal = null } = {}) => {
        const { rows, errors } = await snapshot(PROVIDER_SOURCES[g.id]);
        let all = toRows(rows, query);
        const errs = [...errors];
        if (g.id === "cc-knowledge") {
          const mem = await recallMemory(query, { signal });
          all = all.concat(toRows(mem.rows, query));
          if (mem.error) errs.push(mem.error);
        }
        const live = errs.filter((e) => !/still loading/.test(e));
        if (!all.some((r) => r.score > 0) && live.length && all.length === 0) return { ok: false, reason: live.join("; ") };
        return { ok: true, items: all, ...(errs.length ? { note: errs.join("; ") } : {}) };
      },
    }));
  }

  /** Live "Working now" for the empty box: sessions needing the owner or working, and live runs. */
  async function workingNow({ cap = 6 } = {}) {
    const { rows } = await snapshot(["sessions", "runs"], { firstWaitMs: 1_500 });
    const hot = rows.filter((r) => (r.kind === "session" && /^(waiting|working|blocked)/.test(r.status))
      || (r.kind === "run" && /working|running|waiting/.test(r.state)));
    return hot.slice(0, Math.max(cap, 1) * 4);
  }

  function record(ref) {
    return records.get(String(ref || "")) || null;
  }

  function ok(did, extra = {}) { return { ok: true, did, ...extra }; }
  function no(error) { return { ok: false, error }; }

  const sessionPath = (r, tail = "") => `/sessions/${encodeURIComponent(r.id)}${tail}`;

  async function transcript(r) {
    if (r.kind !== "session") return no(`1 ${r.kind} has no transcript here — open it instead`);
    const head = await harness({ method: "GET", path: `${sessionPath(r, "/transcript")}?since=999999999999` });
    if (!head || !head.ok) return no(`1 transcript did not load — ${(head && head.error) || `daemon answered ${head && head.status}`}`);
    const size = Number(head.data && head.data.size) || 0;
    const tail = await harness({ method: "GET", path: `${sessionPath(r, "/transcript")}?since=${Math.max(0, size - 60_000)}` });
    if (!tail || !tail.ok) return no(`1 transcript did not load — ${(tail && tail.error) || "no answer"}`);
    let events = Array.isArray(tail.data && tail.data.events) ? tail.data.events : [];
    if (!events.length) {
      // A pty harness (the shell) writes its output as text.delta EVENTS, not transcript turns.
      const ev = await harness({ method: "GET", path: `${sessionPath(r, "/events")}?since=0` });
      events = ev && ev.ok && Array.isArray(ev.data && ev.data.events) ? ev.data.events : [];
    }
    // eslint-disable-next-line no-control-regex
    const plain = (t) => String(t || "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
    const lines = events.filter((e) => e && plain(e.text).trim()).slice(-40)
      .map((e) => `[${String(e.kind || "").replace(/^turn\./, "")}${e.tool ? ` ${e.tool}` : ""}] ${clip(plain(e.text), 600)}`);
    return ok("transcript", { title: `${r.title} — transcript (last ${lines.length})`, text: lines.join("\n\n") || "(no events in the last 60 KB)" });
  }

  /**
   * Do `verb` to the record `ref`. Returns {ok, did, url?, chat?, file?, title?, text?}
   * for the window to carry out (open a URL / a file / show text / ask chat), or
   * {ok:false, error} as "<count> <thing> — <why>".
   */
  async function act(ref, verb = "open", text = "") {
    const r = record(ref);
    if (!r) return no("1 result is gone — search again");
    const body = String(text || "").trim();
    if (verb === "transcript") return transcript(r);
    if (verb === "detail") {
      return ok("detail", { title: r.title, text: [r.subtitle, r.detail || r.description || ""].filter(Boolean).join("\n\n") });
    }
    if (verb === "steer") {
      if (!body) return no("0 words to steer with — type the message, then press Ctrl+Enter");
      if (r.kind === "session") {
        let res = null;
        if (r.actions.message) {
          res = await harness({ method: "POST", path: sessionPath(r, "/message"), body: { text: body } });
          if (res && res.ok) return ok(`steered ${r.title}`);
        }
        // A pty harness (the shell) "does not drain the steering mailbox -- use its input
        // instead" (measured 2026-11-13): type the line into its keyboard and submit it.
        // Never after a /message that failed any other way: a timeout may already have
        // delivered it, and a waiting-permission prompt must not get typed text submitted.
        const pointsToInput = res && /use its input/i.test(String((res.data && res.data.detail) || res.error || ""));
        if (r.actions.input && (!r.actions.message || pointsToInput) && r.status !== "waiting-permission") {
          res = await harness({ method: "POST", path: sessionPath(r, "/input"), body: { text: body, submit: true } });
          if (res && res.ok) return ok(`steered ${r.title} (typed into its input)`);
        }
        if (!res) return no(`1 session cannot be messaged — ${r.whyNot.message || "the daemon did not offer it"}`);
        return no(`1 steer failed — ${(res.error || (res.data && res.data.detail)) || `daemon answered ${res.status}`}`);
      }
      if (r.kind === "run" && r.runType === "expedition") {
        try { await tool("expedition_steer", { expedition_id: r.id, instruction: body }); } catch (error) { return no(`1 steer failed — ${clip(error.message, 200)}`); }
        return ok(`steered ${r.title}`);
      }
      if (r.kind === "twin") {
        try { await tool("dispatch_managed_twin", { agent: r.id, task: body }); } catch (error) { return no(`1 dispatch failed — ${clip(error.message, 200)}`); }
        return ok(`sent to ${r.id}`);
      }
      if (r.kind === "fleet-agent" || r.kind === "local-agent") return ok("asked Aither", { chat: `Ask the ${r.id} agent: ${body}` });
      return no(`1 ${r.kind} cannot be steered — only sessions, runs, agents and twins take a message`);
    }
    if (verb === "stop") {
      if (r.kind === "session") {
        if (r.actions.interrupt) {
          const res = await harness({ method: "POST", path: sessionPath(r, "/interrupt"), body: {} });
          return res && res.ok ? ok(`interrupted ${r.title}`) : no(`1 stop failed — ${(res && res.error) || "no answer"}`);
        }
        return no(`1 session cannot be stopped from here — ${r.whyNot.interrupt || "the daemon did not offer it"}`);
      }
      if (r.kind === "run" && r.runType === "expedition") {
        try { await tool("expedition_cancel", { expedition_id: r.id }); } catch (error) { return no(`1 stop failed — ${clip(error.message, 200)}`); }
        return ok(`cancelled ${r.title}`);
      }
      return no(`1 ${r.kind} has no stop — only sessions and expedition runs stop`);
    }
    if (verb === "graph") return graph(ref);
    // open
    if (r.url) return ok(`opened ${r.title}`, { url: r.url });
    if (r.kind === "session") {
      if (r.actions.focus) {
        const res = await harness({ method: "POST", path: sessionPath(r, "/focus"), body: {} });
        if (res && res.ok) return ok(`focused ${r.title}`);
      }
      return transcript(r);
    }
    if (r.file) return ok(`opened ${r.title}`, { file: r.file });
    if (r.kind === "fleet-agent" || r.kind === "local-agent" || r.kind === "twin") {
      return ok("asked Aither", { chat: body ? `Ask the ${r.id} agent: ${body}` : `What is the ${r.id} agent doing right now?` });
    }
    if (r.kind === "project" || r.kind === "task" || r.kind === "roadmap") {
      return ok("asked Aither", { chat: body || `Show me the ${r.kind} "${r.title}" (${r.id}) and what is next on it.` });
    }
    return act(ref, "detail");
  }

  // ── graphed ────────────────────────────────────────────────────────────────

  function joins(r) {
    const all = [...records.values()];
    const edges = [];
    const link = (other, label) => { if (other && other.ref !== r.ref) edges.push({ to: other, label, source: "desk sources" }); };
    const mentions = (rec, name) => name && name.length >= 3 && norm(`${rec.title} ${rec.text || ""}`).includes(norm(name));
    if (r.kind === "session") {
      for (const o of all) if (o.kind === "session" && o.cwd && o.cwd === r.cwd) link(o, "same project");
      const proj = path.basename(r.cwd || "");
      for (const o of all) if (o.kind === "project" && proj && mentions(o, proj)) link(o, "project");
    }
    if (r.kind === "run") {
      for (const o of all) if ((o.kind === "fleet-agent" || o.kind === "local-agent") && o.id === r.agent) link(o, "run by");
      for (const o of all) if (o.kind === "run" && o.agent === r.agent) link(o, "same agent");
    }
    if (r.kind === "fleet-agent" || r.kind === "local-agent") {
      for (const o of all) if (o.kind === "run" && o.agent === r.id) link(o, "runs");
      for (const o of all) if (o.kind === "task" && o.assignee === r.id) link(o, "assigned");
      for (const o of all) if (o.kind === "fleet-agent" && o.id === r.id && r.kind === "local-agent") link(o, "fleet twin");
    }
    if (r.kind === "task") {
      for (const o of all) if (o.kind === "project" && o.id === r.project) link(o, "in project");
      for (const o of all) if ((o.kind === "fleet-agent" || o.kind === "person") && r.assignee && (o.id === r.assignee || o.nick === r.assignee)) link(o, "assignee");
    }
    if (r.kind === "project") {
      for (const o of all) if (o.kind === "task" && o.project === r.id) link(o, "task");
    }
    if (r.kind === "person") {
      const first = r.title.split(/\s+/)[0];
      for (const o of all) if ((o.kind === "event" || o.kind === "roadmap" || o.kind === "task" || o.kind === "project") && (mentions(o, r.title) || mentions(o, first))) link(o, o.kind === "event" ? "meeting" : "mentioned in");
    }
    if (r.kind === "event" || r.kind === "roadmap" || r.kind === "plan") {
      for (const o of all) if (o.kind === "person" && (mentions(r, o.title.split(/\s+/)[0]) || mentions(r, o.title))) link(o, "with");
    }
    // At most 14 joined neighbours: the closest kinds first, and no one kind may
    // crowd out the rest (measured: 40 tasks naming "Jason" hid his meeting).
    const RANK = { event: 0, "fleet-agent": 1, "local-agent": 1, person: 1, project: 2, roadmap: 2, session: 3, run: 3, task: 4, plan: 5 };
    const seen = new Set();
    const perKind = {};
    return edges.filter((e) => (seen.has(e.to.ref) ? false : (seen.add(e.to.ref), true)))
      .sort((a, b) => (RANK[a.to.kind] ?? 6) - (RANK[b.to.kind] ?? 6))
      .filter((e) => { perKind[e.to.kind] = (perKind[e.to.kind] || 0) + 1; return perKind[e.to.kind] <= 6; })
      .slice(0, 14);
  }

  /** graph_find hits on the item's title, one node per hit, labelled by the graph that answered. */
  async function platformGraph(r) {
    const edges = [];
    const notes = [];
    const q = clip(r.title.replace(/^#\d+\s+/, ""), 80);
    try {
      const data = await tool("graph_find", { query: q, limit: 4 });
      const res = (data && data.result) || data || {};
      for (const [graphName, hits] of Object.entries(res.per_graph || {})) {
        if (!Array.isArray(hits)) continue;
        // Code symbols say nothing about a person, a meeting or a schedule.
        if (/^CodeGraph/.test(graphName) && /^(person|event|schedule|routine)$/.test(r.kind)) continue;
        for (const h of hits.slice(0, 3)) {
          const name = h.name || h.title || h.id || h.event_type;
          // A bare event type ("EventType.CUSTOM") names no neighbour.
          if (!name || h.type === "document_answer" || String(name).startsWith("EventType.") || /^evt_/.test(String(name))) continue;
          edges.push({ to: { ref: `graph:${graphName}:${h.id || name}`, kind: "graph", title: clip(name, 60), subtitle: graphName }, label: "mentions", source: `graph_find · ${graphName}` });
        }
      }
      notes.push(`graph_find answered from ${(res.graphs_answered || []).length} graphs`);
    } catch (error) {
      notes.push(`graph_find: ${clip(error.message, 120)}`);
    }
    try {
      const data = await tool("graph_traverse", { node_id: r.id, max_hops: 1 });
      for (const n of (data && Array.isArray(data.neighbors) ? data.neighbors : []).slice(0, 6)) {
        const name = n.name || n.id || String(n);
        edges.push({ to: { ref: `graph:traverse:${name}`, kind: "graph", title: clip(name, 60), subtitle: n.relation || "neighbour" }, label: n.relation || "edge", source: "graph_traverse" });
      }
      notes.push(`graph_traverse: ${(data && data.neighbors || []).length} neighbours`);
    } catch (error) {
      notes.push(`graph_traverse: ${clip(error.message, 120)}`);
    }
    return { edges: edges.slice(0, 10), notes };
  }

  /** The selected item's neighbourhood: {ok, center, nodes, edges, notes}. */
  async function graph(ref) {
    const r = record(ref);
    if (!r) return no("1 result is gone — search again");
    const local = joins(r);
    const platform = await platformGraph(r);
    // One node per neighbour: a platform hit that is also a desk join is drawn once.
    const seenRefs = new Set([r.ref]);
    const all = [...local, ...platform.edges].filter((e) => (seenRefs.has(e.to.ref) ? false : (seenRefs.add(e.to.ref), true)));
    // The renderer gets opaque node ids, never a ref (an email, a session id, a file name).
    const ids = new Map();
    const idOf = (ref) => { if (!ids.has(ref)) ids.set(ref, `n${ids.size}`); return ids.get(ref); };
    const node = (x) => ({ id: idOf(x.ref), kind: x.kind, title: x.title, subtitle: x.subtitle || "" });
    return ok(`graph: ${all.length} neighbours of ${r.title}`, {
      center: node(r),
      nodes: all.map((e) => node(e.to)),
      edges: all.map((e) => ({ to: idOf(e.to.ref), ref: e.to.ref, label: e.label, source: e.source })),
      notes: [`${local.length} from the desk's own sources`, ...platform.notes],
      // The full view of the same question: aither://explore's Graph tab, searched for
      // this item's title (the typed verb `graph <words>` lands there too).
      explore: { tab: "graph", q: clip(r.title, 120) },
    });
  }

  /** Every source's state, for the status line and the self-test. */
  function health() {
    return Object.keys(LOADERS).map((n) => {
      const s = sources.get(n);
      return { source: n, label: LOADERS[n].label, rows: s ? s.records.length : 0, error: s ? s.error : null, loaded: Boolean(s && s.at > -Infinity) };
    });
  }

  async function warmAll() {
    await Promise.allSettled(Object.keys(LOADERS).map((n) => refresh(n) || Promise.resolve()));
    return health();
  }

  return { providers, act, graph, record, workingNow, health, warmAll, snapshot, LOADERS };
}

let shared = null;
/** The one command center main's launcher uses. */
function sharedCommandCenter(deps) {
  if (!shared) shared = createCommandCenter(deps);
  return shared;
}

module.exports = {
  CC_KINDS, GROUPS, CATEGORY_WORDS, ago, clip, createCommandCenter, sharedCommandCenter, wantsCategory,
  shapeSessions, shapePresence, shapeFleetAgents, shapeLocalAgents, shapeTwins, shapeProjects, shapeRoadmap, shapePrs,
  shapePlans, shapeNotebook, shapeMemory, shapeSchedules, shapeRoutineFile, shapeEvents, shapePeople,
};

if (require.main === module) {
  // Live self-check: warm every source once and print rows / errors per source.
  (async () => {
    const cc = createCommandCenter();
    const h = await cc.warmAll();
    for (const s of h) console.log(`${s.error ? "DOWN" : "ok  "} ${s.label.padEnd(28)} ${String(s.rows).padStart(5)} rows${s.error ? ` — ${s.error}` : ""}`);
    process.exit(h.every((s) => s.error) ? 1 : 0);
  })();
}
