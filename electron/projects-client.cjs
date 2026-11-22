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
 * execFile / fs / listSessions are injected, so it is asserted under node --test.
 */

const fs = require("node:fs");
const path = require("node:path");

const STATE_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 20_000;
const MAX_PROJECTS = 40;

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
  exists = (p) => fs.existsSync(p),
} = {}) {
  const run = (cmd, args, cwd, timeout) => new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
  const store = () => file || path.join(require("node:os").homedir(), ".aither", "desk-projects.json");

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

  /** One repo's state from awgit, plus its current branch's PR (number only; details lazily). */
  async function state(dir) {
    const d = normDir(dir);
    if (!d || !exists(path.join(d, ".git"))) return { ok: false, error: "not a git repository" };
    const out = await run("awgit", ["state", "--json"], d, STATE_TIMEOUT_MS);
    let s;
    try {
      s = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
    } catch {
      return { ok: false, error: out.error && out.error.code === "ENOENT" ? "awgit is not installed"
        : (out.stderr.trim().split("\n").pop() || "awgit gave no state") };
    }
    const prs = (s && s.open_prs) || {};
    const pr = s && s.branch && Number.isInteger(prs[s.branch]) ? prs[s.branch] : null;
    return { ok: true, dir: d, branch: s.branch || null, detached: Boolean(s.detached), dirty: Number(s.dirty_count) || 0,
      ahead: Number(s.ahead_behind && s.ahead_behind.ahead) || 0, behind: Number(s.ahead_behind && s.ahead_behind.behind) || 0,
      merging: Boolean(s.merging), conflicts: Array.isArray(s.conflicts) ? s.conflicts.length : 0, pr,
      openPrs: Object.keys(prs).length };
  }

  /** A PR's title, link and checks (gh). */
  async function pr(dir, number) {
    const d = normDir(dir);
    const n = Number(number);
    if (!d || !Number.isInteger(n) || n <= 0) return { ok: false, error: "bad PR" };
    const out = await run("gh", ["pr", "view", String(n), "--json", "number,title,url,state,isDraft,statusCheckRollup"], d, GH_TIMEOUT_MS);
    let data;
    try { data = JSON.parse(out.stdout); } catch {
      return { ok: false, error: out.error && out.error.code === "ENOENT" ? "gh is not installed" : (out.stderr.trim() || "gh gave nothing") };
    }
    const url = String(data.url || "");
    return { ok: true, number: n, title: String(data.title || ""), url: /^https:\/\//.test(url) ? url : "",
      state: String(data.state || ""), draft: Boolean(data.isDraft), checks: checksSummary(data.statusCheckRollup) };
  }

  return { folders, add, remove, state, pr };
}

module.exports = { checksSummary, createProjectsClient, normDir };
