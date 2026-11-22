"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const cc = require("./command-center.cjs");
const { createUniversalSearch } = require("./universal-search.cjs");

const SESSIONS = {
  sessions: [
    { id: "s-daemon", harness: "claude", status: "working", title: "review PR #1", cwd: "C:\\AitherOS-Fresh",
      actions: { message: true, interrupt: true, focus: false, why_not: { focus: "no window" } } },
    { id: "s-tab", harness: "claude", status: "waiting-input", title: "Steam publishing", cwd: "C:\\AitherOS-Fresh",
      actions: { message: true, interrupt: false, focus: true, why_not: { interrupt: "this tab was discovered" } } },
    { id: "s-dead", harness: "claude", status: "exited", title: "old", actions: {} },
    { id: "s-pty", harness: "terminal", status: "idle", title: "shell", cwd: "C:\\tmp",
      actions: { message: true, interrupt: true, input: true, focus: false } },
  ],
};
const PRESENCE = { agents: [{ agent: "atlas", label: "Atlas", work: [
  { key: "expedition:exp-1", title: "Seed the roadmap board", state: "working", program: "aitheros" }] }] };
const FLEET = { agents: [{ id: "atlas", name: "Atlas", liveness: "working", live_items: 1 }, { id: "iris", name: "Iris", liveness: "idle" }] };
const PROJECTS = { projects: [{ project_id: "proj_1", name: "Launch Dec 1", status: "active", updated_at: "2026-11-13T00:00:00Z",
  tasks: [{ task_id: "task_1", title: "Ship the Alt+Space command center", status: "todo", assignee: "david" }] }] };
const EVENTS = { events: [{ event_id: "ev_1", title: "Founders weekly (David + Jason)", start_time: "2026-11-14T02:00:00Z" }] };
const MEMBERS = { members: [{ user_id: "david", email: "david@aitherium.com", role: "owner", display_name: "David" }] };
const CONTACTS = { contacts: [{ name: "Jason Morse", email: "jason@example.com", tags: ["founder"] }] };

function fakeDeps({ graphFind, failTools = [] } = {}) {
  const harnessCalls = [];
  const toolCalls = [];
  const answers = {
    atlas_presence: PRESENCE, get_agent_fleet_status: FLEET, managed_twin_list: { ok: false, error: { message: "Genesis 403" } },
    tasks_list_projects: PROJECTS, calendar_list_events: EVENTS, workspace_directory_list_members: MEMBERS, contacts_list: CONTACTS,
    graph_find: graphFind || { result: { graphs_answered: ["CodeGraph:svc"], per_graph: { "CodeGraph:svc": [{ id: "m1", name: "command_center" }] } } },
    graph_traverse: { node_id: "x", neighbors: [] },
    expedition_steer: { ok: true }, expedition_cancel: { ok: true },
  };
  const files = {
    [path.join("H", ".aither", "awrise", "jobs.json")]: JSON.stringify({ jobs: {
      "hourly-digest": { enabled: true, every: "1h", last_state: "ok", consecutive_failures: 0, last_finished_at: "2026-11-13T00:00:00Z" },
      "board-sync": { enabled: true, every: "30m", last_state: "failed", consecutive_failures: 3 },
    } }),
    [path.join("R", "AitherOS", "config", "routines", "boards.yaml")]:
      "routines:\n- id: github_project_boards\n  name: GitHub project boards\n  enabled: true\n  schedule:\n    type: interval\n    interval_minutes: 30\n",
  };
  const dirs = {
    [path.join("R", "docs", "plans")]: ["2026-11-13-davids-raw-roadmap.md", "README.txt"],
    [path.join("H", ".aither", "notebooks")]: [],
    [path.join("R", "AitherOS", "config", "routines")]: ["boards.yaml"],
  };
  const fsImpl = {
    readFileSync: (p) => { if (p in files) return files[p]; const e = new Error(`ENOENT ${p}`); e.code = "ENOENT"; throw e; },
    readdirSync: (p) => { if (p in dirs) return dirs[p]; throw new Error(`ENOENT ${p}`); },
  };
  const execFile = (file, args, _opts, cb) => {
    if (file === "gh" && args[0] === "search") return cb(null, JSON.stringify([{ number: 7, title: "feat: command center", url: "https://github.com/Aitherium/awdesk/pull/7", repository: { nameWithOwner: "Aitherium/awdesk" } }]), "");
    if (file === "gh" && args[0] === "api" && String(args[1]).includes("contents/docs/plans?")) return cb(null, "2026-11-09-roadmap.md\n", "");
    if (file === "gh") return cb(Object.assign(new Error("HTTP 404: Not Found"), { code: 1 }), "", "HTTP 404: Not Found");
    if (file === "awm") return cb(null, JSON.stringify([{ scope: "s", key: "owner-roadmap-drip", value: "one focus at a time" }]), "");
    return cb(new Error(`unexpected ${file}`));
  };
  const deps = {
    callTool: async (name, args) => {
      toolCalls.push([name, args]);
      if (failTools.includes(name)) throw new Error("gateway timeout");
      if (!(name in answers)) throw new Error(`Unknown tool: ${name}`);
      return JSON.stringify(answers[name]);
    },
    harness: async (msg) => {
      harnessCalls.push(msg);
      if (msg.path === "/sessions/unified") return { ok: true, status: 200, data: SESSIONS };
      if (msg.path === "/agents") return { ok: true, status: 200, data: { agents: [{ id: "aither", label: "Aither", role: "architect" }] } };
      if (/\/transcript\?since=999999999999$/.test(msg.path)) return { ok: true, data: { size: 100000, events: [] } };
      if (/\/transcript\?since=/.test(msg.path)) return { ok: true, data: { events: [{ kind: "turn.started", text: "hello" }, { kind: "text", text: "working on it" }] } };
      if (msg.path === "/sessions/s-pty/message") return { ok: false, status: 400, data: { detail: "the terminal harness does not drain the steering mailbox -- use its input instead" } };
      if (/\/(message|interrupt|focus|input)$/.test(msg.path)) return { ok: true, status: 200, data: {} };
      return { ok: false, status: 404, error: "nope" };
    },
    execFile, fsImpl, repoRoot: "R", home: "H", env: {}, now: () => Date.parse("2026-11-13T12:00:00Z"),
  };
  return { deps, harnessCalls, toolCalls };
}

async function searchAll(center, query) {
  const u = createUniversalSearch({ execFile: () => {}, platform: "linux", fsImpl: { readdirSync: () => [] },
    actionRows: () => [], roots: () => [], screenshotDir: () => "nowhere", searchClient: { discover: async () => ({ ok: false, error: "off" }) } });
  for (const p of center.providers()) u.register(p);
  return u.run(query, { phase: "all" });
}

test("shapeSessions drops dead rows, puts needs-you first and keeps the daemon's verdicts", () => {
  const rows = cc.shapeSessions(SESSIONS);
  assert.deepEqual(rows.map((r) => r.id), ["s-tab", "s-daemon", "s-pty"]);
  assert.match(rows[0].subtitle, /needs you/);
  assert.equal(rows[1].actions.interrupt, true);
  assert.equal(rows[0].whyNot.interrupt, "this tab was discovered");
});

test("every category answers through the universal registry, and the category word lists all of it", async () => {
  const { deps } = fakeDeps();
  const center = cc.createCommandCenter(deps);
  await center.warmAll();
  const health = Object.fromEntries(center.health().map((h) => [h.source, h]));
  assert.equal(health.twins.error, "Genesis 403", "a failing source says why, never an empty list");
  assert.match(health.roadmap.error, /not on develop yet/);
  const groups = (r) => Object.fromEntries(r.groups.map((g) => [g.id, g.items]));
  const agents = groups(await searchAll(center, "agents"));
  assert.ok(agents["cc-agents"].some((i) => i.kind === "fleet-agent" && i.title === "Atlas"));
  assert.ok(agents["cc-agents"].some((i) => i.kind === "local-agent"));
  const steam = groups(await searchAll(center, "steam"));
  assert.equal(steam["cc-agents"][0].kind, "session");
  const work = groups(await searchAll(center, "command center"));
  assert.ok(work["cc-work"].some((i) => i.kind === "task"));
  assert.ok(work["cc-work"].some((i) => i.kind === "pr"));
  const time = groups(await searchAll(center, "schedules"));
  assert.equal(time["cc-time"][0].title, "board-sync", "a failing schedule leads");
  assert.match(time["cc-time"][0].subtitle, /failing ×3/);
  const cal = groups(await searchAll(center, "founders"));
  assert.ok(cal["cc-time"].some((i) => i.kind === "event"));
  const people = groups(await searchAll(center, "jason"));
  assert.ok(people["cc-people"].some((i) => i.title === "Jason Morse"));
  const know = groups(await searchAll(center, "roadmap"));
  assert.ok(know["cc-knowledge"].some((i) => i.kind === "plan" && /davids raw roadmap/.test(i.title)));
  assert.ok(know["cc-knowledge"].some((i) => i.kind === "memory"));
});

test("steer and stop on a session use the daemon's verbs, and refuse with its reason", async () => {
  const { deps, harnessCalls } = fakeDeps();
  const center = cc.createCommandCenter(deps);
  await center.warmAll();
  const steered = await center.act("session:s-daemon", "steer", "wrap up");
  assert.equal(steered.ok, true);
  assert.deepEqual(harnessCalls.find((m) => m.path === "/sessions/s-daemon/message").body, { text: "wrap up" });
  const stopped = await center.act("session:s-daemon", "stop");
  assert.equal(stopped.ok, true);
  assert.ok(harnessCalls.some((m) => m.method === "POST" && m.path === "/sessions/s-daemon/interrupt"));
  const refused = await center.act("session:s-tab", "stop");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /discovered/);
  const empty = await center.act("session:s-daemon", "steer", "  ");
  assert.equal(empty.ok, false);
  const pty = await center.act("session:s-pty", "steer", "echo hi");
  assert.equal(pty.ok, true, "a shell that refuses the mailbox is steered through its input");
  assert.deepEqual(harnessCalls.find((m) => m.path === "/sessions/s-pty/input").body, { text: "echo hi", submit: true });
  const tail = await center.act("session:s-daemon", "transcript");
  assert.match(tail.text, /working on it/);
});

test("an expedition run steers and cancels through the expedition tools", async () => {
  const { deps, toolCalls } = fakeDeps();
  const center = cc.createCommandCenter(deps);
  await center.warmAll();
  assert.equal((await center.act("run:expedition:exp-1", "steer", "focus on Atlas")).ok, true);
  assert.deepEqual(toolCalls.find(([n]) => n === "expedition_steer")[1], { expedition_id: "exp-1", instruction: "focus on Atlas" });
  assert.equal((await center.act("run:expedition:exp-1", "stop")).ok, true);
  assert.ok(toolCalls.some(([n]) => n === "expedition_cancel"));
  const noStop = await center.act("task:task_1", "stop");
  assert.equal(noStop.ok, false);
});

test("the graph joins the desk's own sources and the platform graph, each edge naming its source", async () => {
  const { deps } = fakeDeps();
  const center = cc.createCommandCenter(deps);
  await center.warmAll();
  const g = await center.graph("task:task_1");
  assert.equal(g.ok, true);
  const byRef = Object.fromEntries(g.edges.map((e) => [e.ref, e]));
  assert.equal(byRef["project:proj_1"].label, "in project");
  assert.equal(byRef["project:proj_1"].source, "desk sources");
  assert.ok(g.edges.some((e) => e.source === "graph_find · CodeGraph:svc"));
  const person = await center.graph("person:david@aitherium.com");
  assert.ok(person.edges.some((e) => e.ref === "event:ev_1"), "a person links to the meeting naming them");
  const run = await center.graph("run:expedition:exp-1");
  assert.ok(run.edges.some((e) => e.ref === "fleet-agent:atlas" && e.label === "run by"));
});

test("fleet agents fall back to active_agents when the fleet status times out", async () => {
  const { deps } = fakeDeps({ failTools: ["get_agent_fleet_status"] });
  deps.callTool = ((inner) => async (name, args) => (name === "active_agents"
    ? JSON.stringify({ agents: [{ agent_id: "atlas", status: "working", live_items: 4 }] }) : inner(name, args)))(deps.callTool);
  const center = cc.createCommandCenter(deps);
  await center.warmAll();
  const fleet = center.health().find((h) => h.source === "fleet");
  assert.equal(fleet.error, null);
  assert.equal(fleet.rows, 1);
});

test("the roadmap and routine parsers read the yaml shapes without a YAML dependency", () => {
  const rows = cc.shapeRoadmap("items:\n  - key: q1-bonsai\n    title: Bonsai 2 default\n    quarter: 2027-Q1\n    owner: david\n");
  assert.equal(rows[0].title, "Bonsai 2 default");
  assert.match(rows[0].subtitle, /2027-Q1/);
  const routines = cc.shapeRoutineFile("x.yaml", "routines:\n- id: a\n  name: A routine\n  enabled: false\n  schedule:\n    type: interval\n    interval_minutes: 60\n");
  assert.match(routines[0].subtitle, /every 60 min · disabled/);
});

test("steer never falls back to typing after a /message that failed for another reason", async () => {
  const { deps, harnessCalls } = fakeDeps();
  const inner = deps.harness;
  deps.harness = async (msg) => (msg.path === "/sessions/s-daemon/message" ? { ok: false, error: "awsh did not answer in time" } : inner(msg));
  const center = cc.createCommandCenter(deps);
  await center.warmAll();
  const r = await center.act("session:s-daemon", "steer", "wrap up");
  assert.equal(r.ok, false);
  assert.ok(!harnessCalls.some((m) => m.path === "/sessions/s-daemon/input"), "a timed-out message may have landed: no second delivery");
});

test("open never sends the search term as a message, and the graph hands out opaque node ids", async () => {
  const { deps } = fakeDeps();
  const center = cc.createCommandCenter(deps);
  await center.warmAll();
  const open = await center.act("project:proj_1", "open", "");
  assert.match(open.chat, /Show me the project/);
  const g = await center.graph("task:task_1");
  assert.ok(g.nodes.every((n) => /^n\d+$/.test(n.id) && !("ref" in n)));
});

test("the pty events route is main-only, never in the shared ROUTES", () => {
  const relay = require("./harness-relay.cjs");
  assert.equal(relay.allowedRoute("GET", "/sessions/abc/events?since=0"), false);
  assert.equal(relay.allowedRoute("GET", "/sessions/abc/events?since=0", relay.MAIN_ONLY_ROUTES), true);
  assert.equal(relay.allowedRoute("GET", "/sessions/abc/events?since=0&x=1", relay.MAIN_ONLY_ROUTES), false);
});
