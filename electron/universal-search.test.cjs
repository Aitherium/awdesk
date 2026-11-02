"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const us = require("./universal-search.cjs");
const { createSearchClient } = require("./search-client.cjs");
const searchWindow = require("./search-window.cjs");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
}

// ── ranking + merge ─────────────────────────────────────────────────────────

test("matchScore ranks exact > prefix > word start > substring > initials", () => {
  const q = "code";
  assert.equal(us.matchScore("Code", q), 100);
  assert.equal(us.matchScore("Codex CLI", q), 80);
  assert.equal(us.matchScore("Visual Studio Code", q), 60);
  assert.equal(us.matchScore("Unicodemap", q), 40);
  assert.equal(us.matchScore("Visual Studio Code", "vsc"), 20);
  assert.equal(us.matchScore("Notepad", q), 0);
  assert.equal(us.matchScore("Notepad", "ntpd"), 15);
  assert.equal(us.matchScore("Inference ops widget", "code"), 0, "scattered letters off a word start are not a match");
});

test("rankItems keeps every match in score order and drops non-matches and duplicates", () => {
  const items = us.rankItems([
    { title: "Visual Studio Code", kind: "app", target: "C:/a.lnk" },
    { title: "Code", kind: "app", target: "C:/b.lnk" },
    { title: "Code", kind: "app", target: "C:/b.lnk" },
    { title: "Notepad", kind: "app", target: "C:/c.lnk" },
  ], "code", "apps");
  assert.deepEqual(items.map((i) => i.title), ["Code", "Visual Studio Code"]);
  assert.match(items[0].key, /^[0-9a-f]{16}$/);
});

test("mergeGroups orders groups by their best hit (plus group boost), then priority, and keeps the real total", () => {
  const files = us.rankItems(Array.from({ length: 8 }, (_, i) => ({ title: `notes ${i}.txt`, kind: "file", target: `C:/n${i}` })), "notes", "files");
  const apps = us.rankItems([{ title: "Notes", kind: "app", target: "C:/notes.lnk" }], "notes", "apps");
  const actions = us.rankItems([{ title: "Notes", kind: "action", target: "notes.open" }], "notes", "actions");
  const groups = us.mergeGroups({ files, actions, apps, clipboard: [] });
  assert.deepEqual(groups.map((g) => g.id), ["apps", "actions", "files"], "apps then actions (boosted), then files; the empty clipboard group is absent");
  const f = groups.find((g) => g.id === "files");
  assert.equal(f.total, 8);
  assert.equal(f.items.length, 8, "the merge retains every row; the page caps");
  assert.deepEqual(us.capList(f.items), { shown: f.items.slice(0, 5), more: 3, total: 8 });
});

test("an app matching a word leads a file matching a prefix (the group boost), item scores untouched", () => {
  const files = us.rankItems([{ title: "codex", kind: "file", target: "C:/codex" }], "code", "files");
  const apps = us.rankItems([{ title: "Visual Studio Code", kind: "app", target: "C:/vsc.lnk" }], "code", "apps");
  const groups = us.mergeGroups({ files, apps });
  assert.deepEqual(groups.map((g) => g.id), ["apps", "files"]);
  assert.equal(groups[0].items[0].score, 60);
  const exact = us.rankItems([{ title: "code", kind: "file", target: "C:/code" }], "code", "files");
  assert.deepEqual(us.mergeGroups({ files: exact, apps }).map((g) => g.id), ["files", "apps"], "an exact file name still wins");
});

test("readableStderr turns PowerShell CLIXML into the error line", () => {
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><TN RefId="0"><T>x</T></TN></Obj>'
    + '<S S="Error">Exception calling "Open": provider not registered_x000D__x000A_</S></Objs>';
  assert.equal(us.readableStderr(clixml), 'Exception calling "Open": provider not registered');
  assert.equal(us.readableStderr("plain failure\n"), "plain failure");
});

test("errorLine reads '<count> <thing> — <remedy>'", () => {
  assert.equal(us.errorLine([{ label: "Files", reason: "add a folder on the Files page" }]),
    "1 source down — Files: add a folder on the Files page");
  assert.equal(us.errorLine([]), "");
});

test("clipLabel ends a clipped label at a word boundary with an ellipsis", () => {
  assert.equal(us.clipLabel("alpha beta gamma delta", 14), "alpha beta…");
  assert.equal(us.clipLabel("short", 14), "short");
});

// ── SQL escaping ────────────────────────────────────────────────────────────

/** Every SQL string literal, unescaped, in order -- parsed the way SQL would. */
function literals(sql) {
  return [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/** The statement with every string literal replaced by `?`: what the caller CANNOT change. */
function skeleton(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "?");
}

const SKELETON = "SELECT TOP 50 System.ItemPathDisplay, System.ItemNameDisplay, System.DateModified, System.Size "
  + "FROM SYSTEMINDEX WHERE SCOPE=? AND (System.FileName LIKE ? OR CONTAINS(System.FileName, ?)) "
  + "ORDER BY System.DateModified DESC";

test("an injection attempt stays inside the two literals (prefix LIKE and CONTAINS phrase)", () => {
  const attack = "x' OR 1=1; DROP TABLE SYSTEMINDEX --";
  const sql = us.windowsSearchSql(attack);
  assert.equal(skeleton(sql), SKELETON, "nothing the user typed escaped a literal");
  assert.deepEqual(literals(sql), ["file:", `${attack}%`, `"${attack}*"`]);
});

test("a double quote cannot end the CONTAINS phrase early", () => {
  const sql = us.windowsSearchSql('a" OR "b');
  assert.equal(skeleton(sql), SKELETON);
  assert.equal(literals(sql)[2], '"a OR b*"', "the inner quotes are dropped, the phrase is one");
});

test("a punctuation-only term searches the prefix alone (CONTAINS would be a syntax error)", () => {
  const sql = us.windowsSearchSql("%%");
  assert.ok(!sql.includes("CONTAINS"));
  assert.deepEqual(literals(sql), ["file:", "[%][%]%"]);
});

test("the name search is a PREFIX match, never the full-scan %term% (measured 8-16 s)", () => {
  const sql = us.windowsSearchSql("notepad");
  assert.ok(!literals(sql).some((l) => l.startsWith("%")), "no leading wildcard");
  assert.deepEqual(literals(sql), ["file:", "notepad%", '"notepad*"']);
});

test("LIKE wildcards and control characters typed by the owner are literals", () => {
  assert.equal(us.likeEscape("50%_off[1]"), "50[%][_]off[[]1]");
  assert.equal(literals(us.windowsSearchSql("a%b\u0000c"))[1], "a[%]b c%");
  assert.equal(us.windowsSearchSql("   "), null);
  assert.ok(us.windowsSearchSql("x", { limit: "1; DROP" }).startsWith("SELECT TOP 50 "), "a non-numeric limit falls back");
  assert.ok(us.windowsSearchSql("x", { limit: 9999 }).startsWith("SELECT TOP 200 "));
});

test("queryWindowsSearch hands the statement to PowerShell in the environment, hidden, never on the command line", async () => {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    setImmediate(() => cb(null, JSON.stringify([{ path: "C:\\Users\\me\\notes.txt", name: "notes.txt", modified: null, size: 3 }]), ""));
  };
  const r = await us.queryWindowsSearch("it's notes", { execFile, env: { PATH: "x" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.name), ["notes.txt"]);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, "powershell.exe");
  assert.equal(opts.windowsHide, true);
  assert.ok(!args.join(" ").includes("notes"), "the term is not on the command line");
  assert.equal(opts.env[us.WSEARCH_ENV], us.windowsSearchSql("it's notes"));
  const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
  assert.equal(script, us.WSEARCH_SCRIPT);
  assert.ok(script.includes("Provider=Search.CollatorDSO"));
});

test("a Windows Search failure falls back to a bounded walk of the Files roots and says so", async () => {
  const root = tmp("usearch-walk-");
  touch(path.join(root, "deep", "er", "Budget 2026.xlsx"));
  touch(path.join(root, "node_modules", "budget.js"));
  touch(path.join(root, "other.txt"));
  const p = us.filesProvider({ platform: "win32", wsearch: async () => ({ ok: false, reason: "Windows Search is off" }),
    roots: () => [root] });
  const r = await p.search("budget");
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.title), ["Budget 2026.xlsx"], "node_modules is skipped");
  assert.match(r.note, /^Windows Search is off — walked 1 Files folder/);
  const none = await us.filesProvider({ platform: "win32", wsearch: async () => ({ ok: false, reason: "off" }), roots: () => [] }).search("x");
  assert.deepEqual(none, { ok: false, reason: "off — add a folder on the Files page to search it" });
});

test("walkFiles stops at its entry bound and reports the list as partial", async () => {
  const root = tmp("usearch-bound-");
  for (let i = 0; i < 30; i += 1) touch(path.join(root, `f${i}.txt`));
  const w = await us.walkFiles([root, root], "f", { maxEntries: 10, limit: 100 });
  assert.equal(w.truncated, true);
  assert.ok(w.items.length >= 10 && w.items.length <= 30);
});

// ── apps: the .lnk scan ─────────────────────────────────────────────────────

test("scanShortcuts finds Start-menu shortcuts in nested folders, user copy first, noise dropped", () => {
  const user = tmp("usearch-user-");
  const common = tmp("usearch-common-");
  touch(path.join(user, "Code.lnk"));
  touch(path.join(user, "Tools", "Sub", "Terminal.lnk"));
  touch(path.join(user, "Steam.url"));
  touch(path.join(user, "Uninstall Foo.lnk"));
  touch(path.join(user, "desktop.ini"));
  touch(path.join(user, "notes.txt"));
  touch(path.join(common, "code.lnk"));
  touch(path.join(common, "Paint.lnk"));
  const found = us.scanShortcuts([user, common]);
  assert.deepEqual(found.map((a) => a.name), ["Code", "Paint", "Steam", "Terminal"]);
  assert.equal(found.find((a) => a.name === "Code").path, path.join(user, "Code.lnk"), "the user's copy of a name wins");
  assert.equal(found.find((a) => a.name === "Terminal").folder, "Tools\\Sub");
});

test("startMenuDirs names both Programs folders from the environment", () => {
  const dirs = us.startMenuDirs({ APPDATA: "C:\\U\\AppData\\Roaming", ProgramData: "C:\\ProgramData" });
  assert.deepEqual(dirs, [
    path.join("C:\\U\\AppData\\Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
  ]);
});

test("the apps provider caches its scan for two minutes", () => {
  let reads = 0;
  const fsImpl = { readdirSync: () => { reads += 1; return []; } };
  let t = 0;
  const p = us.appsProvider({ dirs: () => ["X"], fsImpl, now: () => t });
  p.search("a"); p.search("b");
  assert.equal(reads, 1);
  t = 3 * 60_000;
  p.search("c");
  assert.equal(reads, 2);
});

// ── the provider registry ───────────────────────────────────────────────────

test("a registered provider joins the run; a same-id register replaces it; unregister removes it", async () => {
  const reg = us.createProviderRegistry();
  const off = reg.register({ id: "clipboard", search: () => [{ title: "first hello", target: "a", kind: "clip" }] });
  reg.register({ id: "clipboard", search: () => [{ title: "hello world", target: "b", kind: "clip" }] });
  let r = await us.runProviders(reg, "hello");
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].items.map((i) => i.title), ["hello world"]);
  assert.equal(r.groups[0].label, "Clipboard", "a known id takes the group's label");
  off(); // the FIRST registration's unregister must not remove its replacement
  assert.equal(reg.has("clipboard"), true);
  assert.throws(() => reg.register({ id: "Bad Id", search: () => [] }), /lowercase slug/);
  assert.throws(() => reg.register({ id: "nosearch" }), /no search/);
  reg.register({ id: "mine", label: "Mine", search: () => [{ title: "hello mine", target: "m" }] });
  r = await us.runProviders(reg, "hello");
  assert.deepEqual(r.groups.map((g) => g.id).sort(), ["clipboard", "mine"]);
});

test("a provider that throws, refuses or hangs costs only its own group", async () => {
  const reg = us.createProviderRegistry();
  reg.register({ id: "apps", search: () => [{ title: "Hello App", target: "h", kind: "app" }] });
  reg.register({ id: "files", fast: false, search: () => { throw new Error("disk gone"); } });
  reg.register({ id: "agents", fast: false, search: async () => ({ ok: false, reason: "adk is not installed (pip install -e awdk)" }) });
  reg.register({ id: "screenshots", search: () => new Promise(() => {}) });
  const r = await us.runProviders(reg, "hello", { timeouts: { fast: 50, slow: 50 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.groups.map((g) => g.id), ["apps"]);
  assert.deepEqual(r.errors.map((e) => [e.group, e.reason]), [
    ["agents", "adk is not installed (pip install -e awdk)"],
    ["files", "disk gone"],
    ["screenshots", "Screenshots took over 0 s"],
  ]);
  assert.equal(r.total, 1);
});

test("the fast phase runs only the as-you-type providers", async () => {
  const reg = us.createProviderRegistry();
  const ran = [];
  reg.register({ id: "apps", search: () => { ran.push("apps"); return []; } });
  reg.register({ id: "files", fast: false, search: () => { ran.push("files"); return []; } });
  await us.runProviders(reg, "x", { phase: "fast" });
  assert.deepEqual(ran, ["apps"]);
  assert.deepEqual(await us.runProviders(reg, "  "), { ok: false, reason: "type something to search for" });
});

test("the clipboard history refuses credential-shaped text and lists the rest", async () => {
  const h = us.createClipHistory();
  assert.equal(h.remember("ghp_" + "A".repeat(36)), false);
  assert.equal(h.remember("meeting notes for friday"), true);
  const p = us.clipboardProvider({ history: h, current: () => "sk-ant-" + "b".repeat(30) });
  const items = us.rankItems(p.search("notes"), "notes", "clipboard");
  assert.deepEqual(items.map((i) => i.title), ["meeting notes for friday"], "the secret on the clipboard is not a row");
});

test("screenshots: asking for the kind lists the newest; a date matches by name", () => {
  const dir = tmp("usearch-shots-");
  touch(path.join(dir, "Screenshot 2026-10-30 101010.png"));
  touch(path.join(dir, "Screenshot 2026-11-01 090000.png"));
  const p = us.screenshotsProvider({ dir: () => dir });
  const all = us.rankItems(p.search("screenshot"), "screenshot", "screenshots");
  assert.equal(all[0].title, "Screenshot 2026-11-01 090000");
  const day = us.rankItems(p.search("2026-10-30"), "2026-10-30", "screenshots");
  assert.deepEqual(day.map((i) => i.title), ["Screenshot 2026-10-30 101010"]);
});

test("actions come from the command registry, prompt commands excluded", () => {
  const p = us.actionsProvider({ rows: () => [{ id: "disk.open", label: "Disk Explorer…" }, { id: "blog.new", label: "New post", prompt: { placeholder: "t" } }] });
  assert.deepEqual(p.search("disk"), [{ title: "Disk Explorer…", subtitle: "Desk action", kind: "action", target: "disk.open" }]);
  const real = us.actionsProvider().search("x");
  assert.ok(real.some((r) => r.target === "disk.open"), "the real registry's disk.open is a desk action");
});

// ── agents via search-client discover ───────────────────────────────────────

test("discover runs adk discover --json with the task after --, and maps cards", async () => {
  const calls = [];
  const execFile = (cmd, args, _o, cb) => {
    calls.push([cmd, ...args]);
    setImmediate(() => cb(null, JSON.stringify({ cards: [
      { domain: "skills", name: "awscreen", one_line: "find a UI element", score: 0.9, how_to_invoke: "Skill tool: awscreen" },
      { domain: "bogus", name: "x" },
    ] }), ""));
  };
  const c = createSearchClient({ execFile });
  const r = await c.discover("--help screenshot");
  assert.deepEqual(calls[0], ["adk", "discover", "query", "--json", "--no-live", "--k", "10", "--", "--help screenshot"]);
  assert.deepEqual(r.cards.map((x) => [x.domain, x.name, x.howToInvoke]), [["skills", "awscreen", "Skill tool: awscreen"]]);
  const items = await us.agentsProvider({ discover: (q) => c.discover(q) }).search("screenshot");
  assert.equal(items[0].subtitle, "Skill · find a UI element");
  assert.equal(items[0].score, 66);
});

test("a missing adk says how to install it", async () => {
  const execFile = (_c, _a, _o, cb) => setImmediate(() => cb(Object.assign(new Error("spawn adk ENOENT"), { code: "ENOENT" }), "", ""));
  const r = await createSearchClient({ execFile }).discover("x");
  assert.deepEqual(r, { ok: false, error: "adk is not installed (pip install -e awdk)" });
});

// ── search-window: launch by key ────────────────────────────────────────────

test("the page sees no paths; launch opens only what the search found", async () => {
  searchWindow.__forget();
  const opened = [];
  const shell = { openPath: async (p) => { opened.push(p); return ""; } };
  const copied = [];
  const clipboard = { writeText: (t) => copied.push(t) };
  const ran = [];
  const asked = [];
  const view = searchWindow.publicRun({ ok: true, query: "code", phase: "all", total: 3, errors: [], notes: [], tookMs: 1, groups: [
    { id: "apps", label: "Apps", total: 1, items: [{ key: "k1", kind: "app", title: "Code", subtitle: "Start menu", target: "C:\\sm\\Code.lnk", score: 100 }] },
    { id: "actions", label: "Desk actions", total: 1, items: [{ key: "k2", kind: "action", title: "Disk Explorer…", subtitle: "", target: "disk.open", score: 40 }] },
    { id: "agents", label: "Agents", total: 1, items: [{ key: "k3", kind: "agent", title: "awscreen", subtitle: "", target: "skills:awscreen", score: 50 }] },
  ] });
  assert.equal(JSON.stringify(view).includes("Code.lnk"), false, "no target crosses to the page");
  const io = { shell, clipboard, action: async (id) => ran.push(id), chat: async (t) => asked.push(t) };
  assert.deepEqual(await searchWindow.launchItem("k1", "code", io), { ok: true, did: "opened Code" });
  assert.deepEqual(opened, ["C:\\sm\\Code.lnk"]);
  await searchWindow.launchItem("k2", "code", io);
  assert.deepEqual(ran, ["disk.open"]);
  await searchWindow.launchItem("k3", "find the button", io);
  assert.deepEqual(asked, ['find the button\n\n(Use the skill "awscreen".)']);
  assert.deepEqual(await searchWindow.launchItem("C:\\Windows\\evil.exe", "", io), { ok: false, error: "1 result is gone — search again" });
  assert.equal(opened.length, 1);
});

test("the universal channels answer the search page and refuse any other", async () => {
  let ran = 0;
  const everything = () => ({ run: async (q, o) => { ran++; return { ok: true, query: q, phase: o.phase, groups: [], total: 0, errors: [], notes: [], tookMs: 0 }; } });
  const h = searchWindow.searchHandlers({}, { everything, hide: () => {}, chat: () => async () => {} });
  const page = { getURL: () => "aither://search/?mode=pc" };
  const evil = { getURL: () => "https://evil.test/" };
  assert.equal((await h["desk:usearch-run"]({ sender: evil }, "x")).ok, false);
  assert.equal(ran, 0);
  const r = await h["desk:usearch-run"]({ sender: page }, "x", "fast");
  assert.equal(r.ok, true);
  assert.equal(r.phase, "fast");
  assert.deepEqual(await h["desk:usearch-ask"]({ sender: page }, "what is on my calendar"), { ok: true, did: "sent to Aither chat" });
});

// ── review fixes (2026-11-01): each test failed before its fix ──────────────

const vm = require("node:vm");

function actionRun(items) {
  searchWindow.__forget();
  searchWindow.publicRun({ ok: true, query: "q", phase: "all", total: items.length, errors: [], notes: [], tookMs: 1,
    groups: [{ id: "actions", label: "Desk actions", total: items.length, items }] });
}

test("an unwired runner names main.cjs, not a restart that cannot wire it", async () => {
  actionRun([{ key: "a1", kind: "action", title: "Sleep GPU", subtitle: "", target: "fleet.gpu-sleep", score: 40 },
    { key: "a2", kind: "agent", title: "awscreen", subtitle: "", target: "skills:awscreen", score: 40 }]);
  const a = await searchWindow.launchItem("a1", "", { action: null, chat: null });
  assert.equal(a.ok, false);
  assert.match(a.error, /^1 desk action not wired in main\.cjs — /);
  const c = await searchWindow.launchItem("a2", "", { action: null, chat: null });
  assert.match(c.error, /^Aither chat not wired in main\.cjs — /);
  const h = searchWindow.searchHandlers({}, { chat: () => null, hide: () => {} });
  const ask = await h["desk:usearch-ask"]({ sender: { getURL: () => "aither://search/" } }, "hello");
  assert.equal(ask.error, searchWindow.UNWIRED.chat);
  for (const e of [a.error, c.error, ask.error]) assert.equal(/restart/i.test(e), false, e);
});

test("the launcher key falls back when Alt+Space is held, and says so when every key is", () => {
  const bound = [];
  const gs = { register: (accel, fn) => { if (accel === "Alt+Space") return false; bound.push([accel, fn]); return true; } };
  let pressed = 0;
  const r = searchWindow.registerLauncherShortcut(gs, { onPress: () => pressed++ });
  assert.deepEqual(r, { ok: true, accel: "Ctrl+Alt+Space", refused: ["Alt+Space"] });
  bound[0][1]();
  assert.equal(pressed, 1);
  const first = searchWindow.registerLauncherShortcut({ register: () => true }, { onPress: () => {} });
  assert.equal(first.accel, "Alt+Space");
  const none = searchWindow.registerLauncherShortcut({ register: () => false }, { onPress: () => {} });
  assert.equal(none.ok, false);
  assert.deepEqual(none.refused, ["Alt+Space", "Ctrl+Alt+Space"]);
  assert.match(none.error, /^2 launcher keys held by another app \(Alt\+Space, Ctrl\+Alt\+Space\) — free one/);
});

test("launch reports the runner's verdict: a failed or cancelled action is not 'ran X' and keeps the launcher up", async () => {
  const items = [{ key: "f1", kind: "action", title: "Sleep GPU", subtitle: "", target: "fleet.gpu-sleep", score: 40 }];
  actionRun(items);
  assert.deepEqual(await searchWindow.launchItem("f1", "", { action: async () => ({ ok: false, error: "fleet control unreachable" }) }),
    { ok: false, error: "1 desk action failed — fleet control unreachable" });
  assert.deepEqual(await searchWindow.launchItem("f1", "", { action: async () => ({ ok: false, cancelled: true }) }),
    { ok: false, error: "1 desk action cancelled — nothing ran" });
  assert.deepEqual(await searchWindow.launchItem("f1", "", { action: async () => { throw new Error("boom"); } }),
    { ok: false, error: "1 desk action failed — boom" });
  assert.deepEqual(await searchWindow.launchItem("f1", "", { action: async () => undefined }), { ok: true, did: "ran Sleep GPU" });
  assert.deepEqual(await searchWindow.launchItem("f1", "", { action: async () => ({ ok: true }) }), { ok: true, did: "ran Sleep GPU" });

  let hides = 0;
  const page = { sender: { getURL: () => "aither://search/" } };
  const h = searchWindow.searchHandlers({}, { hide: () => { hides++; }, io: () => ({}),
    action: () => async () => ({ ok: false, cancelled: true }), chat: () => null });
  actionRun(items);
  const r = await h["desk:usearch-launch"](page, "f1", "");
  assert.equal(r.error, "1 desk action cancelled — nothing ran");
  assert.equal(hides, 0, "a cancelled action keeps the launcher up");
  const ok = searchWindow.searchHandlers({}, { hide: () => { hides++; }, io: () => ({}), action: () => async () => ({ ok: true }) });
  actionRun(items);
  assert.equal((await ok["desk:usearch-launch"](page, "f1", "")).ok, true);
  assert.equal(hides, 1);
});

test("a chat send that refuses is a failure; one still working is accepted", async () => {
  assert.deepEqual(await searchWindow.sendChat(async () => ({ ok: false, reply: "no agent on this desk" }), "hi"),
    { ok: false, error: "1 chat message failed — no agent on this desk" });
  assert.deepEqual(await searchWindow.sendChat(async () => { throw new Error("relay down"); }, "hi"),
    { ok: false, error: "1 chat message failed — relay down" });
  assert.deepEqual(await searchWindow.sendChat(() => new Promise(() => {}), "hi", { acceptMs: 20 }), { ok: true, did: "sent to Aither chat" });
  let hides = 0;
  const h = searchWindow.searchHandlers({}, { hide: () => { hides++; }, chat: () => async () => ({ ok: false, error: "Chat pane closed" }) });
  const r = await h["desk:usearch-ask"]({ sender: { getURL: () => "aither://search/" } }, "what is on my calendar");
  assert.deepEqual(r, { ok: false, error: "1 chat message failed — Chat pane closed" });
  assert.equal(hides, 0);
});

test("runProviders hands the signal to providers and answers 'superseded' the moment it aborts", async () => {
  const reg = us.createProviderRegistry();
  let seen = null;
  reg.register({ id: "slow", fast: false, search: (_q, o) => { seen = o.signal; return new Promise(() => {}); } });
  const ctl = new AbortController();
  const p = us.runProviders(reg, "notepad", { signal: ctl.signal, timeouts: { fast: 5_000, slow: 5_000 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen, ctl.signal);
  ctl.abort();
  assert.deepEqual(await p, { ok: false, reason: us.SUPERSEDED, superseded: true });
  assert.deepEqual(await us.runProviders(reg, "notepad", { signal: ctl.signal }), { ok: false, reason: us.SUPERSEDED, superseded: true });
});

test("Windows Search and adk discover pass the signal to execFile and read an abort as superseded", async () => {
  const opts = [];
  const execFile = (_c, _a, o, cb) => {
    opts.push(o);
    o.signal.addEventListener("abort", () => cb(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }), "", ""));
  };
  const ctl = new AbortController();
  const w = us.queryWindowsSearch("notepad", { execFile, env: {}, signal: ctl.signal });
  const d = createSearchClient({ execFile }).discover("notepad", { signal: ctl.signal });
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  assert.deepEqual(await w, { ok: false, reason: us.SUPERSEDED });
  assert.deepEqual(await d, { ok: false, error: "superseded by a newer search" });
  assert.equal(opts.length, 2);
  for (const o of opts) { assert.equal(o.signal, ctl.signal); assert.equal(o.windowsHide, true); }
  let spawned = 0;
  assert.deepEqual(await us.queryWindowsSearch("x", { execFile: () => { spawned++; }, signal: ctl.signal }), { ok: false, reason: us.SUPERSEDED });
  assert.equal(spawned, 0, "an already-aborted run spawns nothing");
});

test("the universal search wires the signal through files and agents to their children", async () => {
  const signals = [];
  const execFile = (cmd, _a, o, cb) => { signals.push([cmd, o.signal || null]); setImmediate(() => cb(null, "[]", "")); };
  const empty = tmp("us-sig-");
  const s = us.createUniversalSearch({ execFile, platform: "win32", env: { APPDATA: empty, ProgramData: empty },
    roots: () => [], actionRows: () => [], screenshotDir: () => empty });
  // Creation starts ONE background Get-StartApps load (no signal: it belongs to no query).
  await new Promise((r) => setImmediate(r));
  const atCreation = signals.splice(0);
  assert.deepEqual(atCreation.map(([c, sig]) => [c, sig]), [["powershell.exe", null]]);
  const ctl = new AbortController();
  await s.run("notepad", { phase: "all", signal: ctl.signal });
  assert.deepEqual(signals.map(([c]) => c).sort(), ["adk", "powershell.exe"]);
  for (const [, sig] of signals) assert.equal(sig, ctl.signal);
});

test("one in-flight 'all' run per page: a new query aborts the previous, another page's run is left alone", async () => {
  const runs = [];
  const everything = () => ({ run: (q, o) => new Promise((resolve) => {
    runs.push({ q, phase: o.phase, signal: o.signal || null });
    if (o.phase === "fast") return resolve({ ok: true, query: q, phase: "fast", groups: [], total: 0, errors: [], notes: [], tookMs: 0 });
    o.signal.addEventListener("abort", () => resolve({ ok: false, reason: us.SUPERSEDED, superseded: true }));
  }) });
  const h = searchWindow.searchHandlers({}, { everything, isSearch: () => true });
  const pageA = { id: "A" };
  const pageB = { id: "B" };
  const first = h["desk:usearch-run"]({ sender: pageA }, "note", "all");
  void h["desk:usearch-run"]({ sender: pageB }, "note", "all");
  await h["desk:usearch-run"]({ sender: pageA }, "note", "fast"); // same query: its all run keeps going
  assert.equal(runs[0].signal.aborted, false);
  await h["desk:usearch-run"]({ sender: pageA }, "notepad", "fast"); // new query: the old all run dies
  assert.equal(runs[0].signal.aborted, true);
  assert.equal((await first).superseded, true);
  void h["desk:usearch-run"]({ sender: pageA }, "notepad", "all");
  await new Promise((r) => setImmediate(r));
  void h["desk:usearch-run"]({ sender: pageA }, "notepad", "all"); // a second all for the same page replaces the first
  await new Promise((r) => setImmediate(r));
  const alls = runs.filter((r) => r.phase === "all" && r.q === "notepad");
  assert.equal(alls.length, 2);
  assert.equal(alls[0].signal.aborted, true);
  assert.equal(alls[1].signal.aborted, false);
  assert.equal(runs[1].signal.aborted, false, "page B's run is not page A's to cancel");
});

// ── search-page.js under vm: Enter and the slow-phase debounce ─────────────

class PNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.className = "";
    this.value = "";
    this._text = "";
    this.classList = { add() {}, remove() {} };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...kids) { for (const k of kids) this.children.push(k); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ preventDefault() {}, ...ev }); }
  focus() {}
  select() {}
  scrollIntoView() {}
  walk() { return [this, ...this.children.flatMap((c) => c.walk())]; }
  querySelector(sel) { return this.walk().find((n) => sel.startsWith(".") && n.className.split(" ").includes(sel.slice(1))) || null; }
}

/** Boot search-page.js in launcher mode over a paper DOM, a fake api and a fake clock. */
function bootPage(api) {
  const byId = new Map();
  const $ = (id) => { if (!byId.has(id)) { const n = new PNode("div"); n.id = id; byId.set(id, n); } return byId.get(id); };
  let clock = 0;
  const timers = [];
  const setTimeoutF = (fn, ms) => { const t = { at: clock + (ms || 0), fn }; timers.push(t); return t; };
  const clearTimeoutF = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  const document = {
    body: new PNode("body"),
    createElement: (t) => new PNode(t),
    createTextNode: (t) => { const n = new PNode("#text"); n._text = String(t); return n; },
    getElementById: $,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === "#out .hit" ? $("out").walk().filter((n) => n.className === "hit") : []),
  };
  const ctx = vm.createContext({
    window: { aitherSearch: api }, document, URLSearchParams, location: { search: "?mode=pc&launcher=1" },
    history: { replaceState() {} }, setTimeout: setTimeoutF, clearTimeout: clearTimeoutF,
    setInterval: () => 0, clearInterval: () => {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "search-page.js"), "utf8"), ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = clock + ms;
    for (;;) {
      await flush();
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift();
      clock = t.at;
      t.fn();
    }
    clock = end;
    await flush();
  }
  return { $, advance, flush };
}

function pageApi({ allNeverAnswers = true } = {}) {
  const calls = [];
  const launched = [];
  const api = {
    everything: (q, phase) => {
      calls.push([q, phase]);
      if (phase === "all" && allNeverAnswers) return new Promise(() => {});
      return Promise.resolve({ ok: true, query: q, phase, total: 1, errors: [], notes: [], tookMs: 1,
        groups: [{ id: "apps", label: "Apps", total: 1, items: [{ key: `app:${q}`, kind: "app", title: "Notepad", subtitle: "Start menu" }] }] });
    },
    launch: (key, q) => { launched.push([key, q]); return Promise.resolve({ ok: true, did: "opened Notepad" }); },
    askAither: () => Promise.resolve({ ok: true, did: "sent" }),
    hide: () => Promise.resolve({ ok: true }),
    onFocus: () => {},
  };
  return { api, calls, launched };
}

test("Enter before the debounce opens the fast phase's top row without waiting on files and agents", async () => {
  const { api, calls, launched } = pageApi({ allNeverAnswers: true });
  const page = bootPage(api);
  page.$("q").value = "notepad";
  page.$("q").fire("input");
  // Before the 140 ms debounce fired. Not awaited: the old page awaited the slow phase
  // here (which never answers in this test), so it would hang instead of failing.
  void page.$("form").onsubmit({ preventDefault() {} });
  await page.flush();
  assert.deepEqual(launched, [["app:notepad", "notepad"]]);
  assert.deepEqual(calls, [["notepad", "fast"]], "Enter skips the slow phase once a row is there");
  assert.match(page.$("status").textContent, /^Done — opened Notepad/);
});

test("the slow phase waits for a 500 ms pause; a key inside it starts nothing slow", async () => {
  const { api, calls } = pageApi({ allNeverAnswers: false });
  const page = bootPage(api);
  page.$("q").value = "note";
  page.$("q").fire("input");
  await page.advance(200);
  assert.deepEqual(calls, [["note", "fast"]], "fast paints after 140 ms, all has not started");
  page.$("q").value = "notepad";
  page.$("q").fire("input");
  await page.advance(200);
  assert.deepEqual(calls, [["note", "fast"], ["notepad", "fast"]], "the superseded query never ran its slow phase");
  await page.advance(600);
  assert.deepEqual(calls, [["note", "fast"], ["notepad", "fast"], ["notepad", "all"]]);
  assert.match(page.$("status").textContent, /^Enter opens “Notepad” · 1 results in 1 group$/);
});

// ── Store / packaged apps (Get-StartApps), 2026-11-01: "notepad" found nothing ──

test("parseStartApps: an array, a single object, and unsafe ids are handled", () => {
  const many = JSON.stringify([
    { Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
    { Name: "Calculator", AppID: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
    { Name: "Evil", AppID: "x\" & calc.exe & \"" },
    { Name: "Uninstall Foo", AppID: "{6D809377}\\Foo\\uninst.exe" },
    { Name: "notepad", AppID: "Dup!App" },
  ]);
  assert.deepEqual(us.parseStartApps(many), [
    { name: "Notepad", appId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
    { name: "Calculator", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  ]);
  assert.deepEqual(us.parseStartApps(JSON.stringify({ Name: "Settings", AppID: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel" })),
    [{ name: "Settings", appId: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel" }]);
  assert.deepEqual(us.parseStartApps("not json"), []);
  assert.deepEqual(us.parseStartApps(""), []);
});

test("appsProvider merges packaged apps under the shortcuts; a never-landing load costs at most firstWaitMs", async () => {
  const dir = tmp("us-apps-");
  fs.writeFileSync(path.join(dir, "Calculator.lnk"), "");
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = us.appsProvider({
    dirs: () => [dir],
    firstWaitMs: 30,
    startApps: () => gate.then(() => [{ name: "Notepad", appId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
      { name: "Calculator", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }]),
  });
  // A load that has not landed holds the first search only for firstWaitMs, then the
  // shortcuts answer alone.
  const t0 = Date.now();
  assert.deepEqual((await p.search()).map((r) => r.title), ["Calculator"]);
  assert.ok(Date.now() - t0 < 1000, "bounded wait");
  release();
  await p.ready();
  const rows = await p.search();
  assert.deepEqual(rows.map((r) => r.title), ["Calculator", "Notepad"], "the shortcut's name wins; Notepad is added");
  const notepad = rows.find((r) => r.title === "Notepad");
  assert.equal(notepad.kind, "app");
  assert.equal(notepad.target, `${us.APPS_FOLDER_PREFIX}Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`);
  assert.ok(rows.find((r) => r.title === "Calculator").target.endsWith("Calculator.lnk"));
});

test("the FIRST search after creation waits for a load that lands in time (the post-restart miss)", async () => {
  const dir = tmp("us-apps-first-");
  const p = us.appsProvider({ dirs: () => [dir], firstWaitMs: 2_000,
    startApps: () => new Promise((r) => setTimeout(() => r([{ name: "Notepad", appId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" }]), 40)) });
  assert.deepEqual((await p.search()).map((r) => r.title), ["Notepad"]);
});

test("a run finds a packaged app by name (the 'notepad' miss)", async () => {
  const dir = tmp("us-apps2-");
  const p = us.appsProvider({ dirs: () => [dir], startApps: async () => [{ name: "Notepad", appId: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" }] });
  await p.ready();
  const reg = us.createProviderRegistry();
  reg.register(p);
  const r = await us.runProviders(reg, "notepad", { phase: "fast" });
  assert.equal(r.ok, true);
  assert.equal(r.groups[0].id, "apps");
  assert.equal(r.groups[0].items[0].title, "Notepad");
});

test("loadStartApps resolves [] off Windows and on a failed spawn, never rejects", async () => {
  assert.deepEqual(await us.loadStartApps({ platform: "linux" }), []);
  const failing = (_c, _a, _o, cb) => cb(new Error("boom"), "", "");
  assert.deepEqual(await us.loadStartApps({ platform: "win32", execFile: failing }), []);
  let argv = null;
  const ok = (cmd, args, opts, cb) => { argv = { cmd, args, opts }; cb(null, JSON.stringify([{ Name: "Paint", AppID: "Microsoft.Paint_8wekyb3d8bbwe!App" }]), ""); };
  assert.deepEqual(await us.loadStartApps({ platform: "win32", execFile: ok }), [{ name: "Paint", appId: "Microsoft.Paint_8wekyb3d8bbwe!App" }]);
  assert.equal(argv.cmd, "powershell.exe");
  assert.equal(argv.opts.windowsHide, true);
});

test("openAppsFolderEntry refuses a non-AppsFolder target; the id travels by ENV, never the command line", async () => {
  let calls = 0;
  const never = () => { calls++; };
  assert.equal(await searchWindow.openAppsFolderEntry("C:\\Windows\\System32\\calc.exe", { execFile: never }), "not an app id");
  assert.equal(await searchWindow.openAppsFolderEntry(`${us.APPS_FOLDER_PREFIX}a"b`, { execFile: never }), "not an app id");
  assert.equal(calls, 0, "a refused target spawns nothing");
  let seen = null;
  const ok = (cmd, args, opts, cb) => { seen = { cmd, args, opts }; setImmediate(() => cb(null, "", "")); };
  const t = `${us.APPS_FOLDER_PREFIX}Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`;
  assert.equal(await searchWindow.openAppsFolderEntry(t, { execFile: ok, env: {} }), "");
  assert.equal(seen.cmd, "powershell.exe");
  assert.equal(seen.opts.windowsHide, true);
  assert.equal(seen.opts.env.AWDESK_APPS_FOLDER_TARGET, t);
  assert.ok(!seen.args.some((a) => a.includes("WindowsNotepad")), "the id is not on the command line");
  const bad = (_c, _a, _o, cb) => setImmediate(() => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "Start-Process : This command cannot be run\r\nmore"));
  assert.equal(await searchWindow.openAppsFolderEntry(t, { execFile: bad, env: {} }), "Start-Process : This command cannot be run");
});

test("ensureSearchIpc warms the universal search after boot (the first-Alt+Space miss)", () => {
  const src = fs.readFileSync(path.join(__dirname, "search-window.cjs"), "utf8");
  const body = src.slice(src.indexOf("function ensureSearchIpc("), src.indexOf("// ── the launcher"));
  assert.match(body, /setTimeout\(\(\) => \{ try \{ universal\(\); \}/, "ensureSearchIpc schedules universal()");
  assert.match(src, /const UNIVERSAL_WARM_MS = 10_000;/);
  assert.match(body, /t\.unref\(\)/, "the warm timer never holds the process open");
});
