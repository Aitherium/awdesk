"use strict";

// What the Alt+Space box answers, category by category (owner 2026-11-13: "file search /
// app search / agent prompting / web search / context search / tools / skills /
// AitherOS apps vs host OS apps"). The live half is launcher-search-smoke.cjs; these
// are the rules it rests on, under `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./launcher-core.cjs");
const us = require("./universal-search.cjs");
const registry = require("./command-registry.cjs");
const searchWindow = require("./search-window.cjs");
const cc = require("./command-center.cjs");
const { createLauncher } = require("./launcher-window.cjs");

// ── AitherOS apps vs host OS apps ───────────────────────────────────────────

test("every AitherOS app id is a real palette row that runs on Enter, and every osApp row is one", () => {
  const palette = new Map(registry.paletteRows({}).map((r) => [r.id, r]));
  for (const id of registry.AITHER_APP_IDS) {
    assert.ok(palette.has(id), `${id} is listed as an AitherOS app but is not a palette row`);
    assert.ok(!palette.get(id).prompt, `${id} prompts for text; it cannot be an app row`);
  }
  const osApps = registry.COMMANDS.filter((c) => c.osApp);
  assert.ok(osApps.length >= 10, "the registry lost its osApp rows");
  for (const c of osApps) assert.equal(registry.isAitherApp(c), true, c.id);
  assert.equal(registry.isAitherApp(registry.byId("orb.toggle")), false, "a toggle is a desk action, not an app");
  assert.equal(registry.isAitherApp(null), false);
});

test("AitherOS apps are their own group: named without the ellipsis, never repeated as a desk action", () => {
  const apps = us.aitherAppsProvider().search("x");
  const actions = us.actionsProvider().search("x");
  const sprite = apps.find((r) => r.target === "osapp.sprite");
  assert.deepEqual(sprite, { title: "Sprite", subtitle: "AitherOS app · AitherOS Online", kind: "osapp", target: "osapp.sprite" });
  const strata = apps.find((r) => r.target === "strata.open");
  assert.deepEqual(strata, { title: "Strata storage", subtitle: "AitherOS app · this desk", kind: "osapp", target: "strata.open" });
  const appIds = new Set(apps.map((r) => r.target));
  assert.equal(actions.filter((r) => appIds.has(r.target)).length, 0, "an app row is also listed under Desk actions");
  assert.ok(actions.some((r) => r.target === "snip.region" || /Snip/.test(r.title)), "desk actions lost their verbs");
  assert.equal(us.appTitle("Files…  (Ctrl+Alt+F)"), "Files");
  assert.equal(us.appTitle("Aither Control…"), "Aither Control");
});

test("a host app says which OS it belongs to, and an AitherOS app of the same name ranks first", async () => {
  const reg = us.createProviderRegistry();
  reg.register(us.aitherAppsProvider({ rows: () => [{ id: "files.open", label: "Files…" }], isApp: () => true, where: () => "this desk" }));
  const fsImpl = { readdirSync: () => [{ name: "Files.lnk", isDirectory: () => false, isFile: () => true }] };
  reg.register(us.appsProvider({ dirs: () => ["C:\\sm"], fsImpl, platform: "win32" }));
  const r = await us.runProviders(reg, "files", { phase: "fast" });
  assert.deepEqual(r.groups.map((g) => [g.id, g.label]), [["osapps", "AitherOS apps"], ["apps", "Apps on this PC"]]);
  assert.equal(r.groups[0].items[0].kind, "osapp");
  assert.equal(r.groups[1].items[0].subtitle, "Windows app · Start menu");
  assert.equal(us.hostAppLabel("darwin"), "Mac app");
  assert.equal(us.hostAppLabel("linux"), "Linux app");
});

test("an AitherOS app row runs through the action runner by its command id; nothing else becomes launchable", async () => {
  searchWindow.__forget();
  searchWindow.publicRun({ ok: true, query: "sprite", phase: "fast", total: 1, groups: [
    { id: "osapps", label: "AitherOS apps", total: 1, items: [{ key: "o1", kind: "osapp", title: "Sprite", subtitle: "", target: "osapp.sprite", score: 100 }] }] });
  const ran = [];
  const ok = await searchWindow.launchItem("o1", "sprite", { shell: {}, clipboard: {}, action: async (id) => { ran.push(id); } });
  assert.deepEqual(ok, { ok: true, did: "opened Sprite" });
  assert.deepEqual(ran, ["osapp.sprite"]);
  const refused = await searchWindow.launchItem("o1", "", { shell: {}, clipboard: {}, action: async () => ({ ok: false, error: "not signed in" }) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not signed in/);
  const unwired = await searchWindow.launchItem("o1", "", { shell: {}, clipboard: {}, action: null });
  assert.equal(unwired.ok, false);
});

test("the host label never hides a row from the exclusions: a game is still dropped by its Start-menu folder", async () => {
  const { compile, DEFAULTS } = require("./search-exclusions.cjs");
  const entry = (name, dir) => ({ name, isDirectory: () => dir, isFile: () => !dir });
  const fsImpl = { readdirSync: (d) => (/Steam$/.test(d) ? [entry("Scarlet Skips.lnk", false)] : [entry("Steam", true), entry("Paint.lnk", false)]) };
  const rules = compile(DEFAULTS);
  assert.ok(rules.folders.has("steam"), "the default rules no longer exclude the Steam folder; pick another excluded folder for this test");
  const p = us.appsProvider({ dirs: () => ["C:\\sm"], fsImpl, platform: "win32", exclusionRules: () => rules });
  const rows = await p.search("x");
  assert.deepEqual(rows.map((r) => [r.title, r.subtitle]), [["Paint", "Windows app · Start menu"]]);
});

// ── tools, skills, agents ───────────────────────────────────────────────────

const CARDS = [
  { domain: "tools", name: "git_status", oneLine: "working tree", score: 0.9 },
  { domain: "skills", name: "code-review", oneLine: "review a diff", score: 0.8 },
  { domain: "agents", name: "hydra", oneLine: "reviewer", score: 0.7 },
  { domain: "packs", name: "review-pack", oneLine: "", score: 0.5 },
];

test("a discover row carries its own kind, and a scope keeps only the asked domain", async () => {
  const asked = [];
  const p = us.agentsProvider({ discover: async (q, o) => { asked.push(o); return { ok: true, cards: CARDS }; } });
  const all = await p.search("review");
  assert.deepEqual(all.map((r) => [r.kind, r.title]), [["tool", "git_status"], ["skill", "code-review"], ["agent", "hydra"], ["pack", "review-pack"]]);
  const tools = await p.search("review", { scope: { domains: ["tools"] } });
  assert.deepEqual(tools.map((r) => r.title), ["git_status"]);
  const skills = await p.search("review", { scope: { domains: ["skills"] } });
  assert.deepEqual(skills.map((r) => [r.kind, r.subtitle]), [["skill", "Skill · review a diff"]]);
  assert.equal(asked[0].k, undefined);
  assert.equal(asked[1].k, 30, "a filtered ask reads more of the index");
  const off = await us.agentsProvider({ discover: async () => ({ ok: false, error: "adk is not installed" }) }).search("x", { scope: { domains: ["tools"] } });
  assert.deepEqual(off, { ok: false, reason: "adk is not installed" });
});

test("every discover kind goes to chat naming what it is", async () => {
  searchWindow.__forget();
  searchWindow.publicRun({ ok: true, query: "review", phase: "all", total: 2, groups: [{ id: "agents", label: "Agents, tools & skills", total: 2, items: [
    { key: "t1", kind: "tool", title: "git_status", subtitle: "", target: "tools:git_status", score: 60 },
    { key: "s1", kind: "skill", title: "code-review", subtitle: "", target: "skills:code-review", score: 50 }] }] });
  const sent = [];
  const chat = async (t) => { sent.push(t); return { ok: true }; };
  assert.equal((await searchWindow.launchItem("t1", "what changed", { shell: {}, clipboard: {}, chat })).ok, true);
  assert.equal((await searchWindow.launchItem("s1", "", { shell: {}, clipboard: {}, chat })).ok, true);
  assert.deepEqual(sent, ["what changed\n\n(Use the tool \"git_status\".)", "Use the skill \"code-review\"."]);
  for (const kind of us.DISCOVER_KINDS) assert.ok(["agent", "tool", "skill", "pack", "lane"].includes(kind));
});

// ── scope words ─────────────────────────────────────────────────────────────

test("a scope word narrows the box only with words after it, and never shadows a prefix or a verb", () => {
  const scoped = (t) => { const s = core.parseScope(t); return s ? [s.id, s.term] : null; };
  assert.deepEqual(scoped("app notepad"), ["app", "notepad"]);
  assert.deepEqual(scoped("Apps  Visual   Studio"), ["app", "Visual Studio"]);
  assert.deepEqual(scoped("file invoice 2026"), ["file", "invoice 2026"]);
  assert.deepEqual(scoped("tool git"), ["tool", "git"]);
  assert.deepEqual(scoped("skills review"), ["skill", "review"]);
  assert.deepEqual(scoped("agent hydra"), ["agent", "hydra"]);
  for (const word of ["mem", "memory", "context", "knowledge"]) assert.deepEqual(scoped(`${word} roadmap`), ["mem", "roadmap"], word);
  assert.deepEqual(scoped("web aitherium"), ["web", "aitherium"]);
  assert.deepEqual(scoped("action snip"), ["action", "snip"]);
  // A scope word alone stays the ordinary search ("agents" lists the fleet, "memory" the brain).
  for (const bare of ["agents", "memory", "files", "app", "web ", "tools", ""]) assert.equal(core.parseScope(bare), null, JSON.stringify(bare));
  for (const prefixed of ["> tool git", "?tool git", "@file x", "!private x", "notepad file"]) assert.equal(core.parseScope(prefixed), null, prefixed);
  assert.deepEqual(core.parseScope("tool git").only, ["agents"]);
  assert.deepEqual(core.parseScope("tool git").domains, ["tools"]);
  assert.deepEqual(core.parseScope("app x").only, ["osapps", "apps"]);
  assert.deepEqual(core.parseScope("mem x").only, ["cc-knowledge"]);
  assert.equal(core.scopeChip(core.parseScope("file x")), "Files only");
  // The words the desk's and the browser's verbs own are not scopes, and the reverse.
  const desk = require("./desk-verbs.cjs").ALIASES;
  const browser = require("./browser-verbs.cjs");
  for (const word of Object.keys(core.SCOPE_WORDS)) {
    assert.equal(desk[word], undefined, `${word} is a desk verb`);
    assert.equal(browser.parseBrowserVerb(`${word} something here`), null, `${word} is a browser verb`);
  }
  for (const s of Object.values(core.SCOPES)) {
    for (const id of s.only) assert.ok(core.SOURCES.some((src) => src.id === id), `${s.id} narrows to an unknown provider ${id}`);
  }
});

test("runProviders narrows to `only` and hands every provider the scope", async () => {
  const reg = us.createProviderRegistry();
  const seen = [];
  const make = (id, fast) => reg.register({ id, label: id, fast, search: (q, o) => { seen.push([id, o.scope && o.scope.id]); return [{ title: `${q} ${id}`, target: id }]; } });
  make("apps", true); make("files", false); make("agents", false);
  const r = await us.runProviders(reg, "git", { phase: "all", only: ["agents"], scope: { id: "tool", domains: ["tools"] } });
  assert.deepEqual(r.groups.map((g) => g.id), ["agents"]);
  assert.deepEqual(seen, [["agents", "tool"]]);
  const fast = await us.runProviders(reg, "git", { phase: "fast", only: ["files"] });
  assert.deepEqual(fast.groups, [], "a slow-only scope has nothing in the fast phase");
  const everything = await us.runProviders(reg, "git", { phase: "all" });
  assert.equal(everything.groups.length, 3);
});

// ── the idle line, the ask row, the down rows ───────────────────────────────

test("the idle line names every source the box registers, and the page shows the same line", () => {
  const ids = new Set([...us.GROUPS.map((g) => g.id), "web", ...cc.GROUPS.map((g) => g.id)]);
  for (const id of ids) {
    const src = core.SOURCES.find((s) => s.id === id);
    assert.ok(src, `provider ${id} is not named on the idle line (launcher-core.cjs SOURCES)`);
    assert.ok(core.IDLE_STATUS.includes(src.name), `${id}: “${src.name}” is missing from the idle line`);
  }
  for (const s of core.SOURCES) assert.ok(ids.has(s.id), `the idle line names ${s.id}, which nothing registers`);
  for (const word of ["app", "file", "agent", "tool", "skill", "mem", "web", ">", "?", "@"]) assert.ok(core.IDLE_STATUS.includes(word), word);
  const html = fs.readFileSync(path.join(__dirname, "launcher.html"), "utf8");
  assert.ok(html.includes(`const IDLE = ${JSON.stringify(core.IDLE_STATUS)};`), "launcher.html's IDLE drifted from launcher-core.cjs IDLE_STATUS");
  for (const kind of ["osapp", "tool", "skill", "ask", "down"]) assert.match(html, new RegExp(`\\b${kind}: "`), `launcher.html has no glyph for ${kind}`);
  assert.match(html, /osapp: "AitherOS app", app: "PC app"/);
  // The line painted before the first answer is the same one (HTML-escaped).
  const escaped = core.IDLE_STATUS.replace(/&/g, "&amp;").replace(/>/g, "&gt;");
  assert.ok(html.includes(`<div id="status" role="status">${escaped}</div>`), "the status line's first paint drifted from IDLE_STATUS");
});

test("a source that is down or partial becomes a row with its reason and a remedy", () => {
  assert.equal(core.issuesGroup([], []), null);
  assert.equal(core.issuesGroup([], [{ group: "cc-work", label: "Work", note: "Projects: still loading" }]), null, "warming up is not down");
  assert.equal(core.issuesGroup([{ group: "files", label: "Files", reason: "superseded by a newer search" }], []), null);
  const g = core.issuesGroup(
    [{ group: "web", label: "Web", reason: "Web took over 16 s" },
      { group: "cc-people", label: "People", reason: "People: fetch failed" }],
    [{ group: "cc-knowledge", label: "Knowledge", note: "Plans: still loading; Memory (awm recall): awm took over 15 s — this PC is busy" },
      { group: "cc-agents", label: "Agents & runs", note: "Managed twins: Genesis GET /v1/agent/managed/twins: HTTP 403: {\"detail\":\"Authentication required\"}" }]);
  assert.equal(g.id, "issues");
  assert.equal(g.label, "Not answering");
  assert.deepEqual(g.items.map((i) => [i.key, i.kind, i.title]), [
    ["issue:web", "down", "Web did not answer"],
    ["issue:cc-people", "down", "People did not answer"],
    ["issue:cc-knowledge", "down", "Knowledge answered only in part"],
    ["issue:cc-agents", "down", "Agents & runs answered only in part"],
  ]);
  assert.match(g.items[0].subtitle, /took over 16 s — this PC is busy; search again$/);
  assert.match(g.items[1].subtitle, /fetch failed — the AitherOS gateway \(127\.0\.0\.1:8182\) is not answering/);
  assert.equal(g.items[2].subtitle, "Memory (awm recall): awm took over 15 s — this PC is busy", "a reason that carries its remedy is not given a second");
  assert.match(g.items[3].subtitle, /Authentication required.* — sign in/);
  assert.equal(core.remedyFor("something odd"), "");
});

test("the ask row repeats what was typed, clipped, and an empty box has none", () => {
  assert.equal(core.askGroup(""), null);
  assert.equal(core.askGroup("   "), null);
  const g = core.askGroup("  what is   on my calendar ");
  assert.deepEqual(g.items.map((i) => [i.key, i.kind, i.title]), [["ask:query", "ask", "Ask Aither: what is on my calendar"]]);
  assert.ok(core.askGroup("x".repeat(300)).items[0].title.length < 100);
});

// ── the launcher itself, over a fake universal search ───────────────────────

function launcher(answer) {
  const calls = [];
  const asked = [];
  const sent = [];
  const electron = {
    BrowserWindow: class {}, ipcMain: { handle() {}, on() {} },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, shell: {}, clipboard: {},
  };
  const fake = { registry: null, run: async (term, opts) => { calls.push([term, opts.phase, opts.only || null, opts.scope || null]); return answer(term, opts); } };
  const l = createLauncher({ electron, registry: { byId: () => null }, quickMenu: {}, run: async () => ({ ok: true }),
    ask: async (t) => { asked.push(t); return { ok: true }; }, universalSearch: () => fake });
  // The slow phase is pushed to the page; with no window it goes nowhere, so read it from the fake.
  return { l, calls, asked, sent };
}

const hit = (id, label, kind, title) => ({ id, label, total: 1, items: [{ key: `${kind}:${title}`, group: id, kind, title, subtitle: "", target: title, score: 80 }] });

test("plain text always ends in an Ask Aither row, and Enter on it asks with the typed words", async () => {
  const { l, asked } = launcher((term) => ({ ok: true, query: term, phase: "fast", groups: [hit("apps", "Apps on this PC", "app", "Notepad")], errors: [], notes: [], total: 1 }));
  const r = await l.search("notepad");
  assert.deepEqual(r.groups.map((g) => g.id), ["apps", "ask"]);
  assert.equal(r.groups[1].shown[0].title, "Ask Aither: notepad");
  const none = launcher((term) => ({ ok: true, query: term, phase: "fast", groups: [], errors: [], notes: [], total: 0 }));
  const empty = await none.l.search("why is the fleet slow today");
  assert.deepEqual(empty.groups.map((g) => g.id), ["ask"], "with no match the ask row is the top row, so Enter asks");
  const done = await none.l.runRow(empty.groups[0].shown[0].key, "page text is not trusted");
  assert.equal(done.ok, true);
  assert.deepEqual(none.asked, ["why is the fleet slow today"]);
  assert.deepEqual(asked, []);
});

test("a scope word runs the same search narrowed, names itself on the chip and in the status", async () => {
  const { l, calls } = launcher((term, opts) => ({ ok: true, query: term, phase: opts.phase,
    groups: opts.phase === "fast" ? [] : [hit("agents", "Agents, tools & skills", "tool", "git_status")], errors: [], notes: [], total: 1 }));
  const r = await l.search("tool git");
  assert.equal(r.term, "git");
  assert.equal(r.chip, "Tools only");
  assert.match(r.status, /^Searching tools/);
  assert.deepEqual(calls[0], ["git", "fast", ["agents"], { id: "tool", domains: ["tools"] }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls[1], ["git", "all", ["agents"], { id: "tool", domains: ["tools"] }]);
  const plain = await l.search("git");
  assert.equal(plain.chip, "");
  assert.deepEqual(calls[2].slice(2), [null, null]);
  // A verb that kept the search underneath is never also a scope; a prefix never is.
  assert.equal((await l.search("?tool git")).mode, "ask");
  const nothing = launcher((term) => ({ ok: true, query: term, phase: "fast", groups: [], errors: [], notes: [], total: 0 }));
  await nothing.l.search("file zzqx");
  assert.deepEqual(nothing.calls[0].slice(0, 3), ["zzqx", "fast", ["files"]]);
});

test("a source that did not answer is a row; Enter repeats its reason and runs nothing", async () => {
  const { l, asked } = launcher((term) => ({ ok: true, query: term, phase: "fast", total: 1,
    groups: [hit("cc-knowledge", "Knowledge", "plan", "roadmap")],
    errors: [{ group: "cc-people", label: "People", reason: "People: fetch failed" }],
    notes: [{ group: "cc-knowledge", label: "Knowledge", note: "Memory (awm recall): awm took over 15 s — this PC is busy" }] }));
  const r = await l.search("mem roadmap");
  assert.deepEqual(r.groups.map((g) => g.id), ["cc-knowledge", "ask", "issues"]);
  const rows = r.groups[2].shown;
  assert.deepEqual(rows.map((i) => i.title), ["People did not answer", "Knowledge answered only in part"]);
  const done = await l.runRow(rows[1].key, "");
  assert.equal(done.ok, false);
  assert.match(done.error, /^1 source down — Knowledge answered only in part — Memory \(awm recall\): awm took over 15 s/);
  assert.deepEqual(asked, []);
  assert.equal((await l.runRow("issue:gone", "")).ok, false);
});

// ── memory recall that is down says so ──────────────────────────────────────

function center(awm) {
  const execFile = (file, args, _opts, cb) => {
    if (file === "awm") return awm(cb);
    return cb(Object.assign(new Error("HTTP 404: Not Found"), { code: 1 }), "", "HTTP 404: Not Found");
  };
  const fsImpl = { readFileSync: () => { throw new Error("ENOENT"); }, readdirSync: (p) => (/plans$/.test(p) ? ["2026-11-13-roadmap.md"] : []) };
  return cc.createCommandCenter({ callTool: async () => { throw new Error("fetch failed"); }, harness: async () => ({ ok: false, error: "off" }),
    execFile, fsImpl, repoRoot: "R", home: "H", env: {}, now: () => 0 });
}

test("a memory recall that timed out, is missing or failed is a NOTE with the remedy, never a silent gap", async () => {
  const knowledge = (c) => c.providers().find((p) => p.id === "cc-knowledge").search("roadmap");
  const slow = await knowledge(center((cb) => cb(Object.assign(new Error("Command failed: awm recall --query roadmap --limit 6 --json"), { killed: true }), "", "")));
  assert.equal(slow.ok, true, "plans still answer");
  assert.match(slow.note, /Memory \(awm recall\): awm took over \d+ s — this PC is busy or the memory store is unreachable/);
  assert.doesNotMatch(slow.note, /Command failed/);
  const missing = await knowledge(center((cb) => cb(Object.assign(new Error("spawn awm ENOENT"), { code: "ENOENT" }), "", "")));
  assert.match(missing.note, /awm is not installed or not on this PATH — pip install -e the awm tree/);
  const broken = await knowledge(center((cb) => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "vault unreachable: connection refused")));
  assert.match(broken.note, /vault unreachable: connection refused — check it with `awm recall/);
  const g = core.issuesGroup([], [{ group: "cc-knowledge", label: "Knowledge", note: slow.note }]);
  assert.equal(g.items[0].title, "Knowledge answered only in part");
});
