"use strict";

/**
 * projects-client.cjs -- your repositories in the Aither Browser (owner, 2026-10-04:
 * "project and git integration with AitherFlow / awgit").
 *
 * Read-first, through the tools that already own each fact:
 *   which folders   the folders you added (projects.json in userData) + every working
 *                   folder the awsh daemon has run a session in (where you actually work)
 *   repo state      `awgit state --json`: branch, dirty count, ahead/behind, merge
 *                   state, and the open PR per branch
 *   the branch's PR `gh pr view <n> --json title,url,state,isDraft,statusCheckRollup`
 *
 * Acting on a project goes through pages that already exist: "Terminal here" opens an
 * awsh tab in that folder (aither://terminal/?harness=...&cwd=...), a PR opens as a web
 * tab. Nothing here commits, pushes or merges.
 *
 * Last result first (owner screenshot 2026-11-16: the C:\AitherOS-Fresh card sat on a
 * bare "reading..." while `awgit state` counted 1,264 changed files). Every good read is
 * remembered (and kept next to the folder list, so a restart has it too); the page shows
 * it at once, with its age, and refreshes in the background. A repo never read before
 * still shows its branch at once: `.git/HEAD` is one small file, not a status walk. A
 * read that outlives its timeout says so and keeps the last result on screen. Two
 * reads of one repo never run side by side: the second waits for the first.
 *
 * execFile / fs / listSessions are injected, so it is asserted under node --test.
 */

const fs = require("node:fs");
const path = require("node:path");

const STATE_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 20_000;
const MAX_PROJECTS = 40;
const MAX_CACHED_PRS = 80;

/** execFile's own timeout kills the child and reports `killed` (ETIMEDOUT on some paths). */
function timedOut(error) {
  return Boolean(error && (error.killed === true || error.code === "ETIMEDOUT"));
}

/** The branch HEAD names, read from `.git/HEAD` (a worktree's `.git` file points at its gitdir).
 *  No git process: this is the instant answer for a repo with no remembered state yet. */
function headOf(dir) {
  try {
    let gitDir = path.join(dir, ".git");
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = path.resolve(dir, m[1]);
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return { branch: ref[1], detached: false };
    return /^[0-9a-f]{40,64}$/i.test(head) ? { branch: null, detached: true } : null;
  } catch {
    return null;
  }
}

function normDir(dir) {
  const d = String(dir || "").trim();
  if (!d || d.length > 400 || !path.isAbsolute(d)) return null;
  return path.resolve(d);
}

/** A PR's checks, summarized the way a person reads them. */
function checksSummary(rollup) {
  const rows = Array.isArray(rollup) ? rollup : [];
  const out = { pass: 0, fail: 0, pending: 0, skipped: 0, total: rows.length, failing: [] };
  for (const r of rows) {
    const c = String((r && (r.conclusion || r.state || r.status)) || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL"].includes(c)) out.pass++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c)) {
      out.fail++;
      out.failing.push(String((r && (r.name || r.context)) || "check"));
    } else if (c === "SKIPPED") out.skipped++;
    else out.pending++;
  }
  out.verdict = out.fail ? "failing" : out.pending ? "running" : out.total ? "green" : "none";
  return out;
}

function createProjectsClient({
  execFile = require("node:child_process").execFile,
  listSessions = () => require("./sessions-client.cjs").listSessions(),
  file = null,
  // Where the last results are kept. Default: beside `file` (projects.json ->
  // projects-state.json). With no `file` they live in memory only, so a test never
  // writes into a real home folder.
  cacheFile = null,
  exists = (p) => fs.existsSync(p),
  now = () => Date.now(),
  stateTimeoutMs = STATE_TIMEOUT_MS,
} = {}) {
  const run = (cmd, args, cwd, timeout) => new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
  const store = () => file || path.join(require("node:os").homedir(), ".aither", "desk-projects.json");

  // The last good results: { states: { dir: state }, prs: { "dir#n": pr } }, each with `at`.
  const cachePath = cacheFile || (file ? String(file).replace(/\.json$/i, "") + "-state.json" : null);
  let memo = null;
  function cache() {
    if (memo) return memo;
    memo = { states: {}, prs: {} };
    if (!cachePath) return memo;
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (data && data.states && typeof data.states === "object") memo.states = data.states;
      if (data && data.prs && typeof data.prs === "object") memo.prs = data.prs;
    } catch { /* none yet, or unreadable: start empty */ }
    return memo;
  }
  function persist() {
    const c = cache();
    // Bounded: the newest PR rows win; states are bounded by the folder list itself.
    c.prs = Object.fromEntries(Object.entries(c.prs)
      .sort((a, b) => (Number(b[1] && b[1].at) || 0) - (Number(a[1] && a[1].at) || 0)).slice(0, MAX_CACHED_PRS));
    if (!cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(c));
    } catch { /* an unwritable cache only costs the next open its head start */ }
  }
  /** A remembered row, with how old it is. */
  const aged = (row) => ({ ...row, cached: true, ageMs: Math.max(0, now() - (Number(row.at) || 0)) });
  const inflight = new Map(); // dir -> the state read already running for it

  function saved() {
    try {
      const data = JSON.parse(fs.readFileSync(store(), "utf8"));
      return Array.isArray(data.folders) ? data.folders.map(normDir).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function save(folders) {
    fs.mkdirSync(path.dirname(store()), { recursive: true });
    fs.writeFileSync(store(), JSON.stringify({ folders: [...new Set(folders)].slice(0, MAX_PROJECTS) }, null, 2));
  }

  /** The folders: yours first, then where awsh sessions ran. Only ones that are git repos. */
  async function folders() {
    const mine = saved();
    let fromSessions = [];
    try {
      const r = await listSessions();
      const rows = (r && (r.sessions || r.rows)) || (Array.isArray(r) ? r : []);
      fromSessions = rows.map((s) => normDir(s && s.cwd)).filter(Boolean);
    } catch { /* the daemon is optional */ }
    const all = [...new Set([...mine, ...fromSessions])].filter((d) => exists(path.join(d, ".git")));
    return all.slice(0, MAX_PROJECTS).map((dir) => ({ dir, name: path.basename(dir), pinned: mine.includes(dir) }));
  }

  async function add(dir) {
    const d = normDir(dir);
    if (!d) return { ok: false, error: "give a full folder path" };
    if (!exists(path.join(d, ".git"))) return { ok: false, error: "that folder is not a git repository" };
    save([d, ...saved()]);
    return { ok: true, dir: d };
  }

  function remove(dir) {
    const d = normDir(dir);
    save(saved().filter((x) => x !== d));
    return { ok: true };
  }

  /**
   * What to show for a repo RIGHT NOW, without running anything: the last good read (with
   * its age), else the branch from `.git/HEAD` (`partial`: the counts are not known yet).
   */
  function cached(dir) {
    const d = normDir(dir);
    if (!d || !exists(path.join(d, ".git"))) return { ok: false, error: "not a git repository" };
    const last = cache().states[d];
    if (last && last.ok) return aged(last);
    const head = headOf(d);
    if (head) return { ok: true, partial: true, dir: d, branch: head.branch, detached: head.detached };
    return { ok: false, error: "not read yet" };
  }

  /** A failed read carries the last good one, so the page keeps showing it. */
  function failed(d, row) {
    const last = cache().states[d];
    return last && last.ok ? { ...row, last: aged(last) } : row;
  }

  async function readState(d) {
    const out = await run("awgit", ["state", "--json"], d, stateTimeoutMs);
    if (timedOut(out.error)) {
      return failed(d, { ok: false, timedOut: true,
        error: `git status took longer than ${Math.round(stateTimeoutMs / 1000)} s` });
    }
    let s;
    try {
      s = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
    } catch {
      return failed(d, { ok: false, error: out.error && out.error.code === "ENOENT" ? "awgit is not installed"
        : (out.stderr.trim().split("\n").pop() || "awgit gave no state") });
    }
    const prs = (s && s.open_prs) || {};
    const pr = s && s.branch && Number.isInteger(prs[s.branch]) ? prs[s.branch] : null;
    const row = { ok: true, dir: d, branch: s.branch || null, detached: Boolean(s.detached), dirty: Number(s.dirty_count) || 0,
      ahead: Number(s.ahead_behind && s.ahead_behind.ahead) || 0, behind: Number(s.ahead_behind && s.ahead_behind.behind) || 0,
      merging: Boolean(s.merging), conflicts: Array.isArray(s.conflicts) ? s.conflicts.length : 0, pr,
      openPrs: Object.keys(prs).length, at: now() };
    cache().states[d] = row;
    persist();
    return row;
  }

  /** One repo's state from awgit, plus its current branch's PR (number only; details lazily).
   *  A read already running for this repo is joined, never doubled. */
  async function state(dir) {
    const d = normDir(dir);
    if (!d || !exists(path.join(d, ".git"))) return { ok: false, error: "not a git repository" };
    if (inflight.has(d)) return inflight.get(d);
    const job = readState(d).finally(() => inflight.delete(d));
    inflight.set(d, job);
    return job;
  }

  /** The last good read of a PR, with its age; nothing is run. */
  function cachedPr(dir, number) {
    const d = normDir(dir);
    const n = Number(number);
    if (!d || !Number.isInteger(n) || n <= 0) return { ok: false, error: "bad PR" };
    const last = cache().prs[`${d}#${n}`];
    return last && last.ok ? aged(last) : { ok: false, error: "not read yet" };
  }

  /** A PR's title, link and checks (gh). */
  async function pr(dir, number) {
    const d = normDir(dir);
    const n = Number(number);
    if (!d || !Number.isInteger(n) || n <= 0) return { ok: false, error: "bad PR" };
    const out = await run("gh", ["pr", "view", String(n), "--json", "number,title,url,state,isDraft,statusCheckRollup"], d, GH_TIMEOUT_MS);
    let data;
    try { data = JSON.parse(out.stdout); } catch {
      return { ok: false, timedOut: timedOut(out.error), error: timedOut(out.error)
        ? `gh took longer than ${Math.round(GH_TIMEOUT_MS / 1000)} s`
        : out.error && out.error.code === "ENOENT" ? "gh is not installed" : (out.stderr.trim() || "gh gave nothing") };
    }
    const url = String(data.url || "");
    const row = { ok: true, number: n, title: String(data.title || ""), url: /^https:\/\//.test(url) ? url : "",
      state: String(data.state || ""), draft: Boolean(data.isDraft), checks: checksSummary(data.statusCheckRollup), at: now() };
    cache().prs[`${d}#${n}`] = row;
    persist();
    return row;
  }

  return { folders, add, remove, cached, state, cachedPr, pr };
}

module.exports = { checksSummary, createProjectsClient, headOf, normDir, timedOut };
