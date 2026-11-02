"use strict";

/**
 * universal-search.cjs -- the desk's Start-search replacement (owner, 2026-11-01:
 * Windows' own utilities are bad). ONE box (Alt+Space, or the "This PC" mode of
 * aither://search), ranked groups, five rows each with "+N more":
 *
 *   apps         Start-menu shortcuts (.lnk / .url / .appref-ms) under %AppData% and
 *                %ProgramData% Microsoft\Windows\Start Menu\Programs. Launched by
 *                main with shell.openPath -- the shortcut, never its target string.
 *                Plus Store/packaged apps (Get-StartApps), which have no shortcut;
 *                those launch as explorer.exe shell:AppsFolder\<AppID>.
 *   actions      the desk's own commands (command-registry.cjs paletteRows, read only).
 *   files        the Windows Search index over OLE DB (Search.CollatorDSO, SYSTEMINDEX)
 *                through Windows PowerShell; when the index does not answer, a BOUNDED
 *                walk of the Files page's roots (files-access.cjs).
 *   screenshots  the snipping tool's own folder (snip-capture.cjs screenshotDir).
 *   clipboard    a provider slot: clipboard-sync.cjs mirrors to Strata and keeps no
 *                local history, so a history ring is offered (createClipHistory) for
 *                main to feed; the clipboard as it is right now is read through an
 *                injected reader. Credential-shaped text is never listed.
 *   agents       agents, tools, skills, packs, lanes -- search-client.cjs discover
 *                (`adk discover query`), the same caller the search page uses.
 *
 * THE PROVIDER REGISTRY is the extension point: register({id, label, priority,
 * fast, search}) -> unregister. A provider that throws, times out or answers
 * {ok:false, reason} costs only its own group: the run still answers, and the
 * failure comes back as an `errors` row the page renders "<count> <thing> -- <remedy>".
 *
 * 🚩 SQL. Windows Search's OLE DB provider takes no bound parameters, so the term is
 * escaped HERE (single quotes doubled, LIKE wildcards bracketed, control characters
 * dropped) and the finished statement reaches PowerShell through an ENVIRONMENT
 * variable, never the command line: the script is a constant and the user's text
 * crosses no shell or PowerShell parser. windowsSearchSql() is pure so the test can
 * prove an injection attempt stays one literal.
 *
 * Electron-free: fs, execFile, the platform and the clock are injected, so
 * universal-search.test.cjs runs it under `node --test`. Same contract as every desk
 * module: {ok:false, reason}, never a throw across the bridge.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const MAX_TERM = 200;
const SHOW = 5;
const SHORTCUT_EXT = /\.(lnk|url|appref-ms)$/i;
const SHORTCUT_NOISE = /\b(uninstall|uninst|readme|release notes|license)\b/i;
const APP_CACHE_MS = 2 * 60_000;
const PROVIDER_TIMEOUT_MS = Object.freeze({ fast: 3_000, slow: 16_000 });
// Measured 2026-11-01 on the owner's loaded host: 13-20 s for TOP 50 (a bare
// powershell.exe start alone is ~3 s). The files group runs in the "all" phase, so
// apps / actions paint first; past this bound the bounded walk answers instead.
const WSEARCH_TIMEOUT_MS = 10_000;
const WALK_LIMITS = Object.freeze({ maxDepth: 4, maxEntries: 4_000, maxMs: 2_500 });
const WALK_SKIP = /^(\.|node_modules$|\$recycle\.bin$|appdata$|system volume information$|__pycache__$)/i;
const WSEARCH_ENV = "AWDESK_WSEARCH_SQL";

/** The groups in their tie-break order (lower first when two groups score alike). */
const GROUPS = Object.freeze([
  // `boost` lifts a GROUP's place (never an item's score) the way Start does: an app
  // or desk action matching a word leads a file matching a prefix.
  Object.freeze({ id: "apps", label: "Apps", priority: 0, boost: 25 }),
  Object.freeze({ id: "actions", label: "Desk actions", priority: 1, boost: 15 }),
  Object.freeze({ id: "files", label: "Files", priority: 2 }),
  Object.freeze({ id: "screenshots", label: "Screenshots", priority: 3 }),
  Object.freeze({ id: "clipboard", label: "Clipboard", priority: 4 }),
  Object.freeze({ id: "agents", label: "Agents, tools & skills", priority: 5 }),
]);

/** The term as a search: control characters to spaces, trimmed, capped. */
function cleanTerm(text) {
  // eslint-disable-next-line no-control-regex
  return String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TERM);
}

function norm(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * How well `text` answers `query`, 0..100. Exact 100, prefix 80, a word starting
 * with the query 60, a substring 40, every typed word present 30, the letters in
 * order (initials: "vsc" -> "Visual Studio Code") 15, else 0.
 *
 * @param {string} text
 * @param {string} query
 * @returns {number}
 */
function matchScore(text, query) {
  const t = norm(text).trim();
  const q = norm(cleanTerm(query));
  if (!t || !q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => t.includes(p))) return 30;
  const initials = words.map((w) => w[0]).join("");
  if (q.length >= 2 && initials.startsWith(q.replace(/\s+/g, ""))) return 20;
  // Letters in order, but anchored on a word that starts with the first typed
  // letter: "ntpd" finds "Notepad", "code" does not find "Inference ops widget".
  const from = words.findIndex((w) => w[0] === q[0]);
  if (q.length < 3 || from < 0) return 0;
  let i = 0;
  for (const ch of words.slice(from).join(" ")) if (ch === q[i]) i += 1;
  return i === q.length ? 15 : 0;
}

/** A stable opaque key for an item: the renderer launches BY KEY, never by path. */
function itemKey(kind, target) {
  return createHash("sha1").update(`${kind}\u0000${target}`).digest("hex").slice(0, 16);
}

/**
 * One provider's rows -> ranked items. A row: {title, subtitle?, kind, target, score?}.
 * The score is the better of the title's match and the provider's own (a semantic
 * hit from adk discover, or a file the index matched by its body). Zero is dropped.
 */
function rankItems(rows, query, group) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.title || r.target == null) continue;
    const kind = String(r.kind || group);
    const target = String(r.target);
    const key = itemKey(kind, target);
    if (seen.has(key)) continue;
    seen.add(key);
    const own = Number.isFinite(Number(r.score)) ? Math.max(0, Math.min(100, Number(r.score))) : 0;
    const score = Math.max(matchScore(r.title, query), own);
    if (score <= 0) continue;
    out.push({ key, group, kind, title: clipLabel(r.title, 200), subtitle: String(r.subtitle || "").slice(0, 300),
      target, score, own });
  }
  // Ties go to the provider's own order (newest screenshot, best discover card), then
  // the shorter title, then alphabetical.
  out.sort((a, b) => b.score - a.score || b.own - a.own || a.title.length - b.title.length || a.title.localeCompare(b.title));
  for (const it of out) delete it.own;
  return out;
}

/**
 * Merge every provider's ranked items into the page's groups. Groups order by their
 * best item, then GROUPS priority; an empty group is absent. Every item is RETAINED
 * (the page caps at five and reveals the rest on "+N more"); `total` is the real count.
 */
function mergeGroups(byGroup, providers = GROUPS) {
  const meta = new Map(providers.map((p) => [p.id, p]));
  const groups = [];
  for (const [id, items] of Object.entries(byGroup || {})) {
    if (!Array.isArray(items) || !items.length) continue;
    const m = meta.get(id) || { id, label: id, priority: 99 };
    const known = GROUPS.find((g) => g.id === id) || {};
    const boost = Number(m.boost != null ? m.boost : known.boost) || 0;
    groups.push({ id, label: m.label, priority: Number(m.priority) || 0, top: items[0].score + boost, total: items.length, items });
  }
  groups.sort((a, b) => b.top - a.top || a.priority - b.priority);
  return groups;
}

/**
 * {shown, more, total}: the five a list shows and how many "+N more" reveals. Never
 * drops data. Same contract as recorder-core.cjs capList (ux-shape law 4).
 */
function capList(items, cap = SHOW) {
  const list = Array.isArray(items) ? items : [];
  return { shown: list.slice(0, cap), more: Math.max(0, list.length - cap), total: list.length };
}

/** A label clipped at a word boundary with an ellipsis (ux-shape: truncation is never silent). */
function clipLabel(text, max = 120) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/** The status line's error sentence: "<count> <thing> -- <remedy>". */
function errorLine(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return "";
  const n = list.length;
  const what = list.map((e) => `${e.label}: ${e.reason}`).join("; ");
  return `${n} source${n === 1 ? "" : "s"} down — ${what}`;
}

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Providers by id. register() replaces a same-id provider (a reload must not stack
 * two clipboard groups) and returns its unregister.
 */
function createProviderRegistry() {
  const providers = new Map();
  function register(provider) {
    const p = provider || {};
    const id = String(p.id || "");
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error(`provider id ${JSON.stringify(id)} is not a lowercase slug`);
    if (typeof p.search !== "function") throw new Error(`provider ${id} has no search()`);
    const known = GROUPS.find((g) => g.id === id);
    const entry = Object.freeze({
      id, label: String(p.label || (known && known.label) || id),
      priority: Number.isFinite(Number(p.priority)) ? Number(p.priority) : (known ? known.priority : 50),
      fast: p.fast !== false, search: p.search,
    });
    providers.set(id, entry);
    return () => { if (providers.get(id) === entry) providers.delete(id); };
  }
  const list = () => [...providers.values()].sort((a, b) => a.priority - b.priority);
  return { register, list, has: (id) => providers.has(String(id)), get: (id) => providers.get(String(id)) || null };
}

/** The reason every provider answers when a newer query aborted its run. */
const SUPERSEDED = "superseded by a newer search";

/** True when `error` is what execFile / AbortController raise for an aborted signal. */
function isAbort(error) {
  return Boolean(error && (error.name === "AbortError" || error.code === "ABORT_ERR"));
}

/**
 * `promise`, or {ok:false, reason} when `ms` passes first, or {ok:false, reason:
 * SUPERSEDED} the moment `signal` aborts -- a superseded run stops WAITING at once
 * even when a provider ignores the signal.
 */
function withTimeout(promise, ms, what, signal = null) {
  let timer;
  let onAbort = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `${what} took over ${Math.round(ms / 1000)} s` }), ms);
    if (timer.unref) timer.unref();
    if (signal) {
      onAbort = () => resolve({ ok: false, reason: SUPERSEDED });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Run the registry against one query.
 *
 * @param {ReturnType<typeof createProviderRegistry>} registry
 * @param {string} text
 * @param {{phase?: "fast"|"all", timeouts?: {fast: number, slow: number}, now?: () => number,
 *   signal?: AbortSignal}} [opts]
 *   `fast` runs only the providers that answer as the owner types (apps, actions,
 *   screenshots, clipboard); the page asks `fast` first, then `all`. `signal` reaches
 *   every provider as search(query, {signal}), so the slow ones (Windows Search's
 *   powershell.exe, `adk discover`) kill their child when a newer query supersedes
 *   this run (search-window.cjs aborts it).
 * @returns {Promise<{ok: true, query: string, phase: string, groups: object[], errors: object[], notes: object[],
 *   total: number, tookMs: number} | {ok: false, reason: string, superseded?: true}>}
 */
async function runProviders(registry, text, { phase = "all", timeouts = PROVIDER_TIMEOUT_MS, now = () => Date.now(),
  signal = null } = {}) {
  const query = cleanTerm(text);
  if (!query) return { ok: false, reason: "type something to search for" };
  if (signal && signal.aborted) return { ok: false, reason: SUPERSEDED, superseded: true };
  const started = now();
  const chosen = registry.list().filter((p) => phase !== "fast" || p.fast);
  const byGroup = {};
  const errors = [];
  const notes = [];
  await Promise.all(chosen.map(async (p) => {
    let answer;
    try {
      answer = await withTimeout(Promise.resolve().then(() => p.search(query, { signal })),
        p.fast ? timeouts.fast : timeouts.slow, p.label, signal);
    } catch (error) {
      answer = { ok: false, reason: String((error && error.message) || error).slice(0, 200) };
    }
    if (Array.isArray(answer)) answer = { ok: true, items: answer };
    if (!answer || answer.ok === false) {
      errors.push({ group: p.id, label: p.label, reason: String((answer && answer.reason) || "no answer") });
      return;
    }
    if (answer.note) notes.push({ group: p.id, label: p.label, note: String(answer.note) });
    byGroup[p.id] = rankItems(answer.items, query, p.id);
  }));
  if (signal && signal.aborted) return { ok: false, reason: SUPERSEDED, superseded: true };
  const groups = mergeGroups(byGroup, chosen);
  errors.sort((a, b) => a.label.localeCompare(b.label));
  return { ok: true, query, phase, groups, errors, notes, total: groups.reduce((n, g) => n + g.total, 0), tookMs: now() - started };
}

// ── apps: the Start menu ─────────────────────────────────────────────────────

/** The two Start-menu Programs folders, the user's first (their copy of a name wins). */
function startMenuDirs(env = process.env) {
  const out = [];
  if (env.APPDATA) out.push(path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"));
  const common = env.ProgramData || env.PROGRAMDATA || env.ALLUSERSPROFILE;
  if (common) out.push(path.join(common, "Microsoft", "Windows", "Start Menu", "Programs"));
  return out;
}

/**
 * Every shortcut under `dirs`, bounded (depth 6, 5,000 entries). One row per display
 * name; uninstallers and readmes are not apps. Never throws: an unreadable folder is
 * skipped.
 *
 * @param {string[]} dirs
 * @param {{fsImpl?: typeof fs, maxDepth?: number, maxEntries?: number}} [opts]
 * @returns {{name: string, path: string, folder: string}[]}
 */
function scanShortcuts(dirs, { fsImpl = fs, maxDepth = 6, maxEntries = 5_000 } = {}) {
  const out = [];
  const names = new Set();
  let visited = 0;
  const walk = (dir, depth, folder) => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++visited > maxEntries) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1, folder ? `${folder}\\${e.name}` : e.name); continue; }
      if (!e.isFile() || !SHORTCUT_EXT.test(e.name)) continue;
      const name = e.name.replace(SHORTCUT_EXT, "");
      if (!name || SHORTCUT_NOISE.test(name) || /^desktop\.ini$/i.test(e.name)) continue;
      const key = name.toLowerCase();
      if (names.has(key)) continue;
      names.add(key);
      out.push({ name, path: full, folder });
    }
  };
  for (const d of Array.isArray(dirs) ? dirs : []) walk(d, 0, "");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── apps: Store / packaged apps (Get-StartApps) ─────────────────────────────
//
// Measured 2026-11-01 on the owner's box: "notepad" found NOTHING. Windows 11's
// Notepad, Calculator, Settings, Terminal and every Store app have no .lnk under the
// Start-menu folders -- they live only in shell:AppsFolder. Get-StartApps lists every
// Start entry with its AppID (2.4 s cold), so the list is loaded in the BACKGROUND,
// cached ten minutes, and merged under the shortcuts; the first keystroke never waits.

/** The launch target for an AppsFolder entry; search-window opens it via explorer.exe. */
const APPS_FOLDER_PREFIX = "shell:AppsFolder\\";
const START_APPS_CACHE_MS = 10 * 60_000;
// An AppID is a path-ish or PackageFamilyName!App token. Anything with a quote, a
// control character or a shell metacharacter is dropped: it reaches explorer.exe as ONE
// argv entry (no shell), and a strange id is not worth reasoning about.
const SAFE_APP_ID = /^[A-Za-z0-9{}()[\]._\-!\\: ~+,@']{1,300}$/;
const START_APPS_SCRIPT = "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress";

/** Get-StartApps JSON (an array, or ONE object when only one app) -> [{name, appId}]. */
function parseStartApps(text) {
  let data;
  try { data = JSON.parse(String(text || "").trim() || "[]"); } catch { return []; }
  const rows = Array.isArray(data) ? data : (data && typeof data === "object" ? [data] : []);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const name = typeof r?.Name === "string" ? r.Name.trim() : "";
    const appId = typeof r?.AppID === "string" ? r.AppID.trim() : "";
    if (!name || !appId || !SAFE_APP_ID.test(appId) || SHORTCUT_NOISE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, appId });
  }
  return out;
}

/** Load the Start apps once; resolves [] (never rejects) off Windows or on any failure. */
function loadStartApps({ execFile = require("node:child_process").execFile, platform = process.platform,
  timeoutMs = 15_000 } = {}) {
  if (platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedCommand(START_APPS_SCRIPT)],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseStartApps(stdout)));
    } catch {
      resolve([]);
    }
  });
}

/**
 * The apps provider: Start-menu shortcuts (scan cached two minutes; a Start menu
 * changes on install) plus, when `startApps` is given, the AppsFolder entries no
 * shortcut already names. `startApps` is a () => Promise<[{name, appId}]> loader; it
 * is started at creation and refreshed in the background. A search awaits it ONLY
 * while it has never landed, and then for at most `firstWaitMs`: measured live
 * 2026-11-01, the first query after a desk restart missed Notepad because the
 * universal search is created by that query and the 2.4 s load had not landed.
 */
function appsProvider({ dirs = () => startMenuDirs(), fsImpl = fs, now = () => Date.now(), startApps = null,
  firstWaitMs = 2_000 } = {}) {
  let cache = null;
  let at = 0;
  let packaged = [];
  let packagedAt = -Infinity;
  let loading = null;
  const refreshPackaged = () => {
    if (!startApps || loading || now() - packagedAt < START_APPS_CACHE_MS) return loading;
    loading = Promise.resolve()
      .then(() => startApps())
      .then((list) => { if (Array.isArray(list) && list.length) packaged = list; packagedAt = now(); })
      .catch(() => { packagedAt = now(); })
      .finally(() => { loading = null; });
    return loading;
  };
  refreshPackaged();
  return {
    id: "apps", fast: true,
    ready: () => loading || Promise.resolve(),
    search: async () => {
      if (!cache || now() - at > APP_CACHE_MS) { cache = scanShortcuts(dirs(), { fsImpl }); at = now(); }
      const pending = refreshPackaged();
      if (pending && packagedAt === -Infinity && firstWaitMs > 0) {
        let timer;
        await Promise.race([pending, new Promise((r) => { timer = setTimeout(r, firstWaitMs); if (timer.unref) timer.unref(); })]);
        clearTimeout(timer);
      }
      const rows = cache.map((a) => ({ title: a.name, subtitle: a.folder || "Start menu", kind: "app", target: a.path }));
      const named = new Set(cache.map((a) => a.name.toLowerCase()));
      for (const p of packaged) {
        if (named.has(p.name.toLowerCase())) continue;
        rows.push({ title: p.name, subtitle: "App", kind: "app", target: `${APPS_FOLDER_PREFIX}${p.appId}` });
      }
      return rows;
    },
  };
}

// ── files: Windows Search, else a bounded walk ───────────────────────────────

/** A T-SQL style string literal: wrapped in single quotes, every single quote doubled. */
function sqlString(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** LIKE wildcards as literals (Windows Search honours [x] sets): %, _ and [ bracketed. */
function likeEscape(text) {
  return String(text).replace(/[[%_]/g, (c) => `[${c}]`);
}

/**
 * The SYSTEMINDEX statement for a file-name search. The term is the ONLY variable
 * part and it goes through cleanTerm -> likeEscape -> sqlString; the limit is an
 * integer clamped to 1..200.
 *
 * @param {string} term
 * @param {{limit?: number}} [opts]
 * @returns {string|null} null for an empty term
 */
function windowsSearchSql(term, { limit = 50 } = {}) {
  const q = cleanTerm(term);
  if (!q) return null;
  const n = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
  return `SELECT TOP ${n} System.ItemPathDisplay, System.ItemNameDisplay, System.DateModified, System.Size `
    + `FROM SYSTEMINDEX WHERE SCOPE='file:' AND System.FileName LIKE ${sqlString(`%${likeEscape(q)}%`)} `
    + "ORDER BY System.DateModified DESC";
}

/**
 * The PowerShell half: a CONSTANT script that reads its statement from the
 * environment. Windows PowerShell 5.1 (powershell.exe) ships System.Data.OleDb;
 * PowerShell 7 does not, which is why this never picks pwsh.
 */
const WSEARCH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  `$sql = $env:${WSEARCH_ENV}`,
  "$c = New-Object System.Data.OleDb.OleDbConnection \"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\"",
  "$c.Open()",
  "try {",
  "  $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; $r = $cmd.ExecuteReader()",
  "  $rows = New-Object System.Collections.ArrayList",
  "  while ($r.Read()) {",
  "    $m = $null; if (-not $r.IsDBNull(2)) { $m = ([datetime]$r.GetValue(2)).ToString('o') }",
  "    $z = $null; if (-not $r.IsDBNull(3)) { $z = [int64]$r.GetValue(3) }",
  "    [void]$rows.Add([pscustomobject]@{ path = [string]$r.GetValue(0); name = [string]$r.GetValue(1); modified = $m; size = $z })",
  "  }",
  "  ConvertTo-Json -InputObject @($rows) -Compress -Depth 3",
  "} finally { $c.Close() }",
].join("\n");

/**
 * PowerShell's stderr as one line. A -EncodedCommand child writes CLIXML
 * ("#< CLIXML <Objs ...>") when stderr is a pipe; keep only the error strings.
 */
function readableStderr(stderr) {
  const text = String(stderr || "");
  const errors = [...text.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((m) => m[1]).join("");
  const plain = (errors || text.replace(/#< CLIXML/g, "").replace(/<[^>]+>/g, " "))
    .replace(/_x000D__x000A_/g, " ").replace(/\s+/g, " ").trim();
  return plain.slice(0, 200);
}

function encodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Query the Windows Search index. {ok, items:[{path, name, modified, size}]} | {ok:false, reason}.
 *
 * @param {string} term
 * @param {{execFile?: Function, env?: object, limit?: number, timeoutMs?: number, signal?: AbortSignal}} [opts]
 *   `signal` goes to execFile, which kills powershell.exe when a newer query aborts it.
 */
function queryWindowsSearch(term, { execFile = require("node:child_process").execFile, env = process.env, limit = 50,
  timeoutMs = WSEARCH_TIMEOUT_MS, signal = null } = {}) {
  const sql = windowsSearchSql(term, { limit });
  if (!sql) return Promise.resolve({ ok: false, reason: "type something to search for" });
  if (signal && signal.aborted) return Promise.resolve({ ok: false, reason: SUPERSEDED });
  const opts = { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...env, [WSEARCH_ENV]: sql } };
  if (signal) opts.signal = signal;
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(WSEARCH_SCRIPT)],
      opts,
      (error, stdout, stderr) => {
        if (error) {
          if (isAbort(error)) return resolve({ ok: false, reason: SUPERSEDED });
          const why = error.killed ? "Windows Search took too long"
            : readableStderr(stderr) || String(error.message || "").split("\n")[0] || "Windows Search failed";
          return resolve({ ok: false, reason: why.slice(0, 200) });
        }
        try {
          const text = String(stdout || "").trim();
          const parsed = text ? JSON.parse(text) : [];
          const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter((r) => r && r.path);
          resolve({ ok: true, items: rows.map((r) => ({ path: String(r.path), name: String(r.name || path.basename(String(r.path))),
            modified: r.modified ? String(r.modified) : null, size: Number.isFinite(Number(r.size)) ? Number(r.size) : null })) });
        } catch (e) {
          resolve({ ok: false, reason: `Windows Search answered something unreadable: ${e.message}` });
        }
      });
  });
}

/**
 * A bounded breadth-first walk of `roots` for names containing `term`: depth 4,
 * 4,000 entries and 2.5 s in total, dot-folders / node_modules / AppData skipped.
 * `truncated` says the bound stopped it, so the page can say the list is partial.
 */
async function walkFiles(roots, term, { fsImpl = fs, limit = 50, maxDepth = WALK_LIMITS.maxDepth,
  maxEntries = WALK_LIMITS.maxEntries, maxMs = WALK_LIMITS.maxMs, now = () => Date.now() } = {}) {
  const q = norm(cleanTerm(term));
  if (!q) return { items: [], truncated: false };
  const deadline = now() + maxMs;
  const queue = (Array.isArray(roots) ? roots : []).map((r) => ({ dir: r, depth: 0 }));
  const items = [];
  const seen = new Set();
  let visited = 0;
  let truncated = false;
  while (queue.length) {
    if (visited >= maxEntries || now() > deadline || items.length >= limit) { truncated = true; break; }
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = await fsImpl.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited += 1;
      const full = path.join(dir, e.name);
      if (norm(e.name).includes(q) && !seen.has(full.toLowerCase())) {
        seen.add(full.toLowerCase());
        items.push({ path: full, name: e.name, dir: e.isDirectory() });
        if (items.length >= limit) break;
      }
      if (e.isDirectory() && depth < maxDepth && !WALK_SKIP.test(e.name)) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return { items, truncated };
}

/** The files provider: the index first, the walk when the index does not answer. */
function filesProvider({ platform = process.platform, wsearch = (q) => queryWindowsSearch(q), roots = () => [],
  walk = (r, q) => walkFiles(r, q) } = {}) {
  const row = (f) => ({ title: f.name, subtitle: path.dirname(f.path), kind: "file", target: f.path, score: 40 });
  return {
    id: "files", fast: false,
    search: async (q, { signal = null } = {}) => {
      let why = platform === "win32" ? null : "Windows Search exists only on Windows";
      if (!why) {
        const r = await wsearch(q, { signal });
        // Superseded: no fallback walk for a query nobody is waiting on.
        if (signal && signal.aborted) return { ok: false, reason: SUPERSEDED };
        if (r && r.ok) return { ok: true, items: r.items.map(row) };
        why = (r && r.reason) || "Windows Search did not answer";
      }
      let dirs;
      try { dirs = (await roots()) || []; } catch { dirs = []; }
      if (!dirs.length) return { ok: false, reason: `${why} — add a folder on the Files page to search it` };
      const w = await walk(dirs, q);
      const n = dirs.length;
      return { ok: true, items: w.items.map(row),
        note: `${why} — walked ${n} Files folder${n === 1 ? "" : "s"}${w.truncated ? " (stopped at the bound; partial)" : ""}` };
    },
  };
}

/** The Files page's roots that exist (files-access.cjs), as absolute paths. */
function filesRoots(access = null) {
  try {
    const a = access || require("./files-access.cjs").createFilesAccess();
    return a.roots().roots.filter((r) => r.exists).map((r) => r.path);
  } catch {
    return [];
  }
}

// ── screenshots + clipboard ──────────────────────────────────────────────────

/**
 * The snipping tool's folder, newest first. A query naming the kind ("screenshot",
 * "snip") lists the latest; anything else matches the file name (its date).
 */
function screenshotsProvider({ dir = () => require("./snip-capture.cjs").screenshotDir(), fsImpl = fs, limit = 50 } = {}) {
  return {
    id: "screenshots", fast: true,
    search: (q) => {
      let names;
      try { names = fsImpl.readdirSync(dir()).filter((n) => /\.(png|jpe?g)$/i.test(n)); } catch { return []; }
      names.sort().reverse(); // "Screenshot YYYY-MM-DD HHMMSS" sorts by time
      const wantsAll = matchScore("screenshot", q) >= 60 || matchScore("snip", q) >= 60;
      // Asking for the kind lists the newest `limit`; any other term is matched on
      // the name, which rankItems scores (0 drops it).
      return names.slice(0, wantsAll ? limit : 2_000)
        // Newest first survives ranking: each older shot scores a hair lower.
        .map((n, i) => ({ title: n.replace(/\.(png|jpe?g)$/i, ""), subtitle: "Aither Screenshots", kind: "screenshot",
          target: path.join(dir(), n), score: wantsAll ? 50 - i / 1000 : 0 }));
    },
  };
}

/**
 * The clipboard's local history ring. clipboard-sync.cjs keeps none, so main feeds
 * this from the same reader (remember(text)); credential-shaped text is refused at
 * the door (clipboard-sync looksSecret), so a key never becomes a search row.
 */
function createClipHistory({ max = 50, looksSecret = (t) => require("./clipboard-sync.cjs").looksSecret(t),
  now = () => Date.now() } = {}) {
  const ring = [];
  function remember(text) {
    const t = String(text == null ? "" : text);
    if (!t.trim() || t.length > 64 * 1024) return false;
    let secret;
    try { secret = looksSecret(t); } catch { secret = true; }
    if (secret) return false;
    const at = ring.findIndex((r) => r.text === t);
    if (at >= 0) ring.splice(at, 1);
    ring.unshift({ text: t, at: now() });
    if (ring.length > max) ring.length = max;
    return true;
  }
  return { remember, entries: () => ring.map((r) => ({ ...r })), size: () => ring.length };
}

/** The clipboard provider: the history ring plus what is on the clipboard now. */
function clipboardProvider({ history = null, current = () => "", looksSecret = (t) => require("./clipboard-sync.cjs").looksSecret(t) } = {}) {
  const preview = (t) => clipLabel(t, 120);
  return {
    id: "clipboard", fast: true,
    search: (q) => {
      const rows = [];
      let now;
      try { now = String(current() || ""); } catch { now = ""; }
      let nowSecret;
      try { nowSecret = !now.trim() || looksSecret(now); } catch { nowSecret = true; }
      const qn = norm(q);
      if (!nowSecret) {
        rows.push({ title: preview(now), subtitle: "On the clipboard now", kind: "clip", target: now,
          score: norm(now).includes(qn) ? 45 : (matchScore("clipboard", q) >= 60 ? 45 : 0) });
      }
      for (const e of history ? history.entries() : []) {
        if (e.text === now) continue;
        rows.push({ title: preview(e.text), subtitle: "Copied earlier", kind: "clip", target: e.text,
          score: norm(e.text).includes(qn) ? 40 : (matchScore("clipboard", q) >= 60 ? 35 : 0) });
      }
      return rows;
    },
  };
}

// ── actions + agents ─────────────────────────────────────────────────────────

/** Desk commands (command-registry.cjs paletteRows). A command that prompts for text is the palette's. */
function actionsProvider({ rows = () => require("./command-registry.cjs").paletteRows({}) } = {}) {
  return {
    id: "actions", fast: true,
    search: () => (rows() || []).filter((r) => r && r.id && !r.prompt)
      .map((r) => ({ title: String(r.label), subtitle: "Desk action", kind: "action", target: String(r.id) })),
  };
}

/** Agents, tools, skills, packs, lanes from search-client.cjs discover (adk discover). */
function agentsProvider({ discover }) {
  const singular = { agents: "Agent", tools: "Tool", skills: "Skill", packs: "Pack", lanes: "Lane" };
  return {
    id: "agents", fast: false,
    search: async (q, { signal = null } = {}) => {
      const r = await discover(q, { signal });
      if (!r || !r.ok) return { ok: false, reason: (r && r.error) || "adk discover did not answer" };
      return r.cards.map((c) => ({
        title: c.name, subtitle: `${singular[c.domain] || c.domain}${c.oneLine ? ` · ${c.oneLine}` : ""}`,
        kind: "agent", target: `${c.domain}:${c.name}`, score: Math.round(25 + c.score * 45),
      }));
    },
  };
}

/** The chat prompt for a query, optionally about one discovered card. */
function chatPrompt(query, item = null) {
  const q = cleanTerm(query);
  if (item && item.kind === "agent") {
    const [domain, ...rest] = String(item.target).split(":");
    const name = rest.join(":");
    return q ? `${q}\n\n(Use the ${domain.replace(/s$/, "")} "${name}".)` : `Use the ${domain.replace(/s$/, "")} "${name}".`;
  }
  return q;
}

/**
 * The desk's universal search: the registry pre-loaded with the six providers.
 * Every dependency is injectable; main passes the Electron clipboard reader and the
 * live palette context.
 */
function createUniversalSearch({
  searchClient = null,
  execFile = require("node:child_process").execFile,
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
  readClipboard = () => "",
  actionRows,
  roots = () => filesRoots(),
  screenshotDir,
  history = createClipHistory(),
} = {}) {
  const registry = createProviderRegistry();
  const client = searchClient || require("./search-client.cjs").createSearchClient({ execFile });
  registry.register(appsProvider({ dirs: () => startMenuDirs(env), fsImpl,
    startApps: () => loadStartApps({ execFile, platform }) }));
  registry.register(actionsProvider(actionRows ? { rows: actionRows } : {}));
  registry.register(filesProvider({ platform, roots, wsearch: (q, o) => queryWindowsSearch(q, { execFile, env, signal: (o && o.signal) || null }),
    walk: (r, q) => walkFiles(r, q, { fsImpl }) }));
  registry.register(screenshotsProvider({ fsImpl, ...(screenshotDir ? { dir: screenshotDir } : {}) }));
  registry.register(clipboardProvider({ history, current: readClipboard }));
  registry.register(agentsProvider({ discover: (q, o) => client.discover(q, { signal: (o && o.signal) || null }) }));
  return {
    registry,
    history,
    register: (p) => registry.register(p),
    run: (text, opts) => runProviders(registry, text, opts),
  };
}

module.exports = {
  GROUPS, SHOW, SUPERSEDED, WSEARCH_ENV, WSEARCH_SCRIPT, PROVIDER_TIMEOUT_MS, APPS_FOLDER_PREFIX,
  appsProvider, loadStartApps, parseStartApps, actionsProvider, agentsProvider, capList, chatPrompt, clipLabel, cleanTerm, clipboardProvider, createClipHistory,
  createProviderRegistry, createUniversalSearch, encodedCommand, errorLine, isAbort, filesProvider, filesRoots, itemKey,
  likeEscape, matchScore, mergeGroups, readableStderr, queryWindowsSearch, rankItems, runProviders, scanShortcuts, screenshotsProvider,
  sqlString, startMenuDirs, walkFiles, windowsSearchSql,
};
