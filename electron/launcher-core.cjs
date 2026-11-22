"use strict";

/**
 * launcher-core.cjs -- the pure half of the ONE Alt+Space key (owner 2026-11-02:
 * "SHOULD ALT+SPACE JUST BE THE MAIN HOT KEY FOR EVERYTHING AWDESK? ... PRESS AND
 * HOLD TO BRING UP A RADIAL MENU ... KIND OF LIKE ALFRED ON MAC?").
 *
 * Alt+Space already belongs to the "search.universal" row (command-registry.cjs).
 * What changed is what the press DOES:
 *
 *   tap  (< HOLD_MS)  -> the launcher: one box, grouped results, prefixes.
 *   hold (>= HOLD_MS) -> the radial ring (quick-menu.cjs), released over a slice.
 *
 * A global shortcut reports the key going DOWN, never coming UP, and installing a
 * keyboard hook to see the release is exactly the kind of driver the desk must not
 * add. So main shows a window immediately, the renderer watches keyup, and this
 * module owns every decision that can be asserted without a window: the threshold,
 * the pointer-direction -> slice mapping (with the dead zone), the auto-repeat
 * suppression, the result capping, the prefixes, and the command-line safety rules.
 *
 * Electron-free and side-effect-free, so launcher-core.test.cjs runs under
 * `node --test`.
 */

/** A press released before this is a tap; at or after it, a hold. ~280 ms feels
 *  like Alfred: long enough not to fire on a quick tap, short enough to beat the
 *  ring's own 120 ms entrance. */
const HOLD_MS = 280;
/** After HOLD_MS with no keyup, how long to wait for the OS auto-repeat that proves a
 *  hold (Windows' default repeat delay is ~500 ms) before calling the press a tap. */
const HOLD_GRACE_MS = 650;

/** Two shortcut callbacks closer than this are the OS auto-repeating a held key,
 *  not the owner pressing twice. */
const REPEAT_GAP_MS = 150;

/** The middle of the radial ring: releasing here cancels instead of choosing. */
const DEAD_ZONE_PX = 36;

/** Rows shown per group before "+N more". Same number the search page uses. */
const CAP = 5;

/**
 * Every source the box searches, as the idle line names it. One entry per provider
 * id (universal-search.cjs GROUPS, the launcher's "web", command-center.cjs GROUPS):
 * launcher-core.test.cjs fails when a provider is registered that this line leaves out.
 */
const SOURCES = Object.freeze([
  Object.freeze({ id: "osapps", name: "AitherOS apps" }),
  Object.freeze({ id: "apps", name: "PC apps" }),
  Object.freeze({ id: "files", name: "files" }),
  Object.freeze({ id: "actions", name: "desk actions" }),
  Object.freeze({ id: "agents", name: "agents, tools, skills" }),
  Object.freeze({ id: "cc-agents", name: "runs" }),
  Object.freeze({ id: "cc-work", name: "work" }),
  Object.freeze({ id: "cc-knowledge", name: "knowledge & memory" }),
  Object.freeze({ id: "cc-time", name: "calendar" }),
  Object.freeze({ id: "cc-people", name: "people" }),
  Object.freeze({ id: "clipboard", name: "clipboard" }),
  Object.freeze({ id: "screenshots", name: "screenshots" }),
  Object.freeze({ id: "web", name: "the web" }),
]);

/** The one-line status when there is no query yet: every source, then how to narrow. */
const IDLE_STATUS = `Searches ${SOURCES.map((s) => s.name).join(", ")} · narrow: app, file, agent, tool, skill, mem, web · > run · ? ask · @ spirit`;

const PREFIXES = Object.freeze({ ">": "command", "?": "ask", "@": "spirit" });

/**
 * SCOPE WORDS (owner 2026-11-13: "file search / app search / ... / context search /
 * tools / skills"). A first word that narrows the ONE box to one kind of thing, the
 * same shape as the desk's verbs (desk-verbs.cjs): `tool git`, `skill review`,
 * `file invoice`, `app notepad`, `mem roadmap`, `web aitherium`.
 *
 *   only     the provider ids the run is narrowed to (universal-search.cjs runProviders)
 *   domains  for the discover provider: which of agents/tools/skills it keeps
 *
 * A scope word ALONE is an ordinary search ("agents" still lists the fleet, "memory"
 * the company brain); it only narrows with words after it. `>`, `?`, `@` and `!` are
 * never scopes.
 */
const SCOPES = Object.freeze({
  app: Object.freeze({ id: "app", label: "Apps", only: Object.freeze(["osapps", "apps"]) }),
  file: Object.freeze({ id: "file", label: "Files", only: Object.freeze(["files"]) }),
  agent: Object.freeze({ id: "agent", label: "Agents", only: Object.freeze(["agents", "cc-agents"]), domains: Object.freeze(["agents"]) }),
  tool: Object.freeze({ id: "tool", label: "Tools", only: Object.freeze(["agents"]), domains: Object.freeze(["tools"]) }),
  skill: Object.freeze({ id: "skill", label: "Skills", only: Object.freeze(["agents"]), domains: Object.freeze(["skills"]) }),
  mem: Object.freeze({ id: "mem", label: "Knowledge & memory", only: Object.freeze(["cc-knowledge"]) }),
  web: Object.freeze({ id: "web", label: "Web", only: Object.freeze(["web"]) }),
  action: Object.freeze({ id: "action", label: "Desk actions", only: Object.freeze(["actions"]) }),
});
const SCOPE_WORDS = Object.freeze({
  app: "app", apps: "app",
  file: "file", files: "file",
  agent: "agent", agents: "agent",
  tool: "tool", tools: "tool",
  skill: "skill", skills: "skill",
  mem: "mem", memory: "mem", context: "mem", knowledge: "mem",
  web: "web",
  action: "action", actions: "action",
});

/**
 * The scope in a launcher query, or null when the text is an ordinary search.
 * @param {string} text
 * @returns {null | {id: string, label: string, only: string[], domains?: string[], word: string, term: string}}
 */
function parseScope(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw || /^[>?@!]/.test(raw)) return null;
  const m = /^(\S+)\s+([\s\S]+)$/.exec(raw);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const id = SCOPE_WORDS[word];
  const term = m[2].replace(/\s+/g, " ").trim();
  if (!id || !term) return null;
  return { ...SCOPES[id], word: m[1], term };
}

/** What to do about a source's failure, from its reason. "" when the reason already says. */
function remedyFor(reason) {
  const r = String(reason || "");
  if (/—|run `|rebuild|install|add a folder/i.test(r)) return "";
  if (/\b(401|403)\b|authentication required|not signed in|unauthori[sz]ed/i.test(r)) return "sign in (AitherOS Online: sign in…)";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|socket hang up|gateway|\b50[234]\b/i.test(r)) {
    return "the AitherOS gateway (127.0.0.1:8182) is not answering; start the fleet, then search again";
  }
  if (/took over|took too long|timed out|timeout/i.test(r)) return "this PC is busy; search again";
  if (/ENOENT|not installed|not on (this )?PATH/i.test(r)) return "install it, then search again";
  return "";
}

/**
 * The sources that did NOT answer, as rows (never a silent empty group). `errors` are
 * providers that returned nothing at all; `notes` are providers that answered PARTLY
 * (memory timed out but plans listed; Windows Search fell back to the bounded walk).
 * A row's subtitle is the reason plus its remedy; Enter repeats it in the status line.
 *
 * @param {{group: string, label: string, reason: string}[]} errors
 * @param {{group: string, label: string, note: string}[]} notes
 * @returns {null | {id: string, label: string, total: number, items: object[]}}
 */
function issuesGroup(errors, notes) {
  const items = [];
  const add = (group, label, why, partial) => {
    const reason = String(why || "no answer").replace(/\s+/g, " ").trim();
    if (!reason || /superseded by a newer search/.test(reason)) return;
    const fix = remedyFor(reason);
    items.push({
      key: `issue:${String(group || label || items.length)}`, kind: "down",
      title: partial ? `${label || group} answered only in part` : `${label || group} did not answer`,
      subtitle: `${reason}${fix ? ` — ${fix}` : ""}`.slice(0, 300),
    });
  };
  for (const e of Array.isArray(errors) ? errors : []) add(e && e.group, e && e.label, e && e.reason, false);
  for (const n of Array.isArray(notes) ? notes : []) {
    // "still loading" is a source warming up, not one that is down.
    const live = String((n && n.note) || "").split(/;\s*/).filter((part) => part && !/still loading/.test(part)).join("; ");
    if (live) add(n && n.group, n && n.label, live, true);
  }
  if (!items.length) return null;
  return { id: "issues", label: "Not answering", total: items.length, items };
}

/**
 * The fall-through row: whatever was typed can always go to Aither (the last group, so
 * Enter reaches it by itself only when nothing else matched).
 */
function askGroup(term) {
  const t = String(term == null ? "" : term).replace(/\s+/g, " ").trim();
  if (!t) return null;
  const shown = t.length > 80 ? `${t.slice(0, 79)}…` : t;
  return { id: "ask", label: "Ask Aither", total: 1,
    items: [{ key: "ask:query", kind: "ask", title: `Ask Aither: ${shown}`, subtitle: "Sends this to Aither chat · the same as starting with ?" }] };
}

/**
 * awsh verbs that cannot change anything, so they run on the FIRST Enter.
 * Everything else (restart, deploy, remove, ...) needs a second Enter.
 */
const READONLY_AWSH = Object.freeze([
  "status", "list", "ls", "show", "info", "version", "help", "doctor", "health",
  "discover", "recall", "query", "find", "search", "get", "cat", "read", "plan",
  "models", "sessions", "wakes", "whoami", "config", "env",
]);

/** "tap" | "hold" from the press/release clock. */
function classifyRelease(pressedAt, releasedAt, threshold = HOLD_MS) {
  const start = Number(pressedAt);
  const end = Number(releasedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "tap";
  return end - start >= threshold ? "hold" : "tap";
}

/** The slice centre angle in degrees: index 0 at the top, clockwise. */
function sliceAngle(index, count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (!n) return -90;
  const i = ((Math.trunc(Number(index) || 0) % n) + n) % n;
  return -90 + (360 * i) / n;
}

/** Normalise any degree value into [0, 360). */
function normalizeAngle(deg) {
  const d = Number(deg);
  if (!Number.isFinite(d)) return 0;
  return ((d % 360) + 360) % 360;
}

/**
 * Which slice the pointer is over, or null for the dead zone.
 *
 * The ring is split into `count` equal wedges centred on sliceAngle(i, count);
 * the release angle alone decides (the distance only feeds the dead zone, so a
 * short nudge past the middle is not a choice). Pointer coordinates and the
 * centre are in the same space (screen DIPs).
 */
function sliceIndexAt(point, center, count, { deadZonePx = DEAD_ZONE_PX } = {}) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (!n) return null;
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  const cx = Number(center && center.x);
  const cy = Number(center && center.y);
  if (![x, y, cx, cy].every(Number.isFinite)) return null;
  const dx = x - cx;
  const dy = y - cy;
  const dead = Math.max(0, Number(deadZonePx) || 0);
  if (Math.hypot(dx, dy) < dead) return null;
  // Screen y grows DOWN, so atan2 already gives the on-screen direction.
  const fromTop = normalizeAngle((Math.atan2(dy, dx) * 180) / Math.PI + 90);
  return Math.round((fromTop * n) / 360) % n;
}

/**
 * "ignore" | "close" | "open" for a global-shortcut callback.
 *
 * - pending / radial-hold: the key is still down; this is auto-repeat.
 * - launcher up: a press inside `repeatGapMs` of the release is still a repeat;
 *   otherwise it is the owner pressing again, which closes the box.
 * - ignoreUntil covers the Windows foreground-lock fallback (the window was
 *   opened without ever seeing a release).
 */
function pressDecision({ phase = "idle", now = Date.now(), lastPressAt = 0, releasedAt = 0, ignoreUntil = 0,
  repeatGapMs = REPEAT_GAP_MS } = {}) {
  if (phase === "pending" || phase === "radial-hold") return "ignore";
  if (ignoreUntil && now < ignoreUntil) return "ignore";
  if (phase === "launcher") {
    if (releasedAt && now - releasedAt < repeatGapMs) return "ignore";
    // No release was ever seen (a focus-locked press): treat a quick repeat as
    // auto-repeat rather than as a second, deliberate press.
    if (!releasedAt && lastPressAt && now - lastPressAt < 700) return "ignore";
    return "close";
  }
  return "open";
}

/** ">" command, "?" ask Aither, "@" spirit, else "all". The prefix must be first. */
function parseQuery(text) {
  const raw = String(text == null ? "" : text).trim();
  const first = raw.slice(0, 1);
  const mode = PREFIXES[first] || "all";
  return { mode, term: mode === "all" ? raw : raw.slice(1).trim(), raw };
}

/** The chip for a scoped search ("Files only"). */
function scopeChip(scope) {
  return scope && scope.label ? `${scope.label} only` : "";
}

/** The prefix's chip text. */
function prefixLabel(mode) {
  return mode === "command" ? "> awsh / adk desk" : mode === "ask" ? "? Ask Aither"
    : mode === "spirit" ? "@ Spirit" : "Everything";
}

/** Split a command line on whitespace, honouring simple single/double quotes. */
function splitArgs(line) {
  const text = String(line || "");
  if ((text.match(/"/g) || []).length % 2 || (text.match(/'/g) || []).length % 2) return null;
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}

/**
 * Is this command line allowed to run? The spawn never uses a shell, and this
 * refuses shell syntax anyway so a paste cannot smuggle one in.
 *
 * First Enter: `adk desk ...` and read-only awsh verbs.
 * Second Enter: any other `adk ...` / `awsh ...` verb.
 * Never: another executable, shell metacharacters, an empty line.
 *
 * Returns {ok, argv?, exe?, needsConfirm, reason}.
 */
function commandPlan(text) {
  const line = String(text == null ? "" : text).trim();
  if (!line) return { ok: false, needsConfirm: false, reason: "type a command" };
  if (/[;&|<>`$()\r\n]/.test(line)) {
    return { ok: false, needsConfirm: false, reason: "shell syntax is refused — run a plain adk desk or awsh command" };
  }
  const argv = splitArgs(line);
  if (!argv || !argv.length) return { ok: false, needsConfirm: false, reason: "type a command" };
  const exe = argv[0].toLowerCase();
  if (exe === "adk") {
    const desk = String(argv[1] || "").toLowerCase() === "desk";
    return {
      ok: true, argv, exe: "adk", needsConfirm: !desk,
      reason: desk ? "" : "adk commands other than `adk desk ...` need a second Enter",
    };
  }
  if (exe === "awsh") {
    const verb = String(argv[1] || "").toLowerCase();
    const asked = argv.slice(1).some((a) => a === "--help" || a === "--version" || a === "-h");
    const readOnly = READONLY_AWSH.includes(verb) || asked;
    return {
      ok: true, argv, exe: "awsh", needsConfirm: !readOnly,
      reason: readOnly ? "" : "this awsh verb can change something — press Enter again to run it",
    };
  }
  return { ok: false, needsConfirm: false, reason: `only adk desk and awsh run here — “${argv[0]}” is refused` };
}

/**
 * The page's groups, capped for display. Every item is retained (`items`) so a
 * "+N more" reveals the rest; `more` is the real remainder and `total` the real
 * count. Empty groups are absent, never a header with nothing under it.
 */
function capGroups(groups, cap = CAP) {
  const limit = Math.max(1, Math.trunc(Number(cap) || CAP));
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const items = Array.isArray(g && g.items) ? g.items : [];
    if (!items.length) continue;
    const shown = items.slice(0, limit);
    out.push({
      id: String(g.id || ""), label: String(g.label || g.id || ""),
      total: Number.isFinite(Number(g.total)) ? Number(g.total) : items.length,
      items, shown, more: Math.max(0, items.length - shown.length),
    });
  }
  return out;
}

/** Rows in reading order, honouring the groups the owner expanded. */
function flattenGroups(groups, expanded = new Set()) {
  const rows = [];
  for (const g of capGroups(groups)) {
    const items = expanded && typeof expanded.has === "function" && expanded.has(g.id) ? g.items : g.shown;
    for (const item of items) rows.push({ group: g.id, label: g.label, item });
  }
  return rows;
}

/** The row the first Enter would run. */
function topRow(groups, expanded) {
  return flattenGroups(groups, expanded)[0] || null;
}

/**
 * The footer line: what the run found, or "<count> source(s) down — <reason>"
 * (the desk's error shape). No errors and no query yet reads IDLE_STATUS.
 */
function statusText({ groups = [], errors = [], indexing = false, total = null } = {}) {
  const list = Array.isArray(errors) ? errors : [];
  if (list.length) {
    const n = list.length;
    return `${n} source${n === 1 ? "" : "s"} down — `
      + list.map((e) => `${e.label || e.group || "source"}: ${e.reason || "no answer"}`).join("; ");
  }
  const count = total != null && Number.isFinite(Number(total)) ? Number(total)
    : groups.reduce((n, g) => n + (Number(g.total) || 0), 0);
  if (!count && !groups.length) return IDLE_STATUS;
  return `${count} result${count === 1 ? "" : "s"} in ${groups.length} group${groups.length === 1 ? "" : "s"}`
    + (indexing ? " · still searching files, agents, tools, skills, knowledge and the web" : "");
}

module.exports = {
  CAP, DEAD_ZONE_PX, HOLD_MS, HOLD_GRACE_MS, IDLE_STATUS, PREFIXES, READONLY_AWSH, REPEAT_GAP_MS, SCOPES, SCOPE_WORDS, SOURCES,
  askGroup, issuesGroup, parseScope, remedyFor, scopeChip, capGroups, classifyRelease, commandPlan, flattenGroups, normalizeAngle, parseQuery, prefixLabel,
  pressDecision, sliceAngle, sliceIndexAt, splitArgs, statusText, topRow,
};
