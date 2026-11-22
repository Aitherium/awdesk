"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checksSummary, createProjectsClient } = require("./projects-client.cjs");
const { projectsHandlers, fromProjectsPage } = require("./projects-window.cjs");

const A = path.resolve(os.tmpdir(), "repo-a");
const B = path.resolve(os.tmpdir(), "repo-b");
const NOT = path.resolve(os.tmpdir(), "not-a-repo");
const isRepo = (p) => [path.join(A, ".git"), path.join(B, ".git")].includes(p);

function exec(map, calls = []) {
  return (cmd, args, opts, cb) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const out = map[`${cmd} ${args[0]}`];
    setImmediate(() => cb(out ? null : Object.assign(new Error("x"), { code: "ENOENT" }), out || "", ""));
  };
}

test("folders: yours first, then where awsh sessions ran; only git repos; no duplicates", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")), "p.json");
  const c = createProjectsClient({ file, exists: isRepo,
    listSessions: async () => ({ ok: true, sessions: [{ cwd: B }, { cwd: NOT }, { cwd: A }, { cwd: "relative/x" }] }) });
  assert.equal((await c.add(NOT)).ok, false, "a folder without .git is refused");
  assert.equal((await c.add("relative")).ok, false, "a relative path is refused");
  assert.equal((await c.add(A)).ok, true);
  const list = await c.folders();
  assert.deepEqual(list.map((p) => p.dir), [A, B]);
  assert.deepEqual(list.map((p) => p.pinned), [true, false]);
  c.remove(A);
  assert.deepEqual((await c.folders()).map((p) => p.pinned), [false, false]);
});

test("state: awgit state --json in the repo, the branch's PR picked from open_prs", async () => {
  const calls = [];
  const c = createProjectsClient({ exists: isRepo, execFile: exec({ "awgit state": JSON.stringify({
    branch: "feat/x", dirty_count: 3, ahead_behind: { ahead: 1, behind: 2 }, merging: false, conflicts: [],
    open_prs: { "feat/x": 42, other: 7 } }) }, calls) });
  const s = await c.state(A);
  assert.equal(s.ok, true);
  assert.deepEqual([s.branch, s.dirty, s.ahead, s.behind, s.pr, s.openPrs], ["feat/x", 3, 1, 2, 42, 2]);
  assert.deepEqual(calls[0], { cmd: "awgit", args: ["state", "--json"], cwd: A });
  assert.equal((await c.state(NOT)).ok, false);
});

test("pr: gh pr view, https links only, checks summarized", async () => {
  const c = createProjectsClient({ exists: isRepo, execFile: exec({ "gh pr": JSON.stringify({
    number: 42, title: "T", url: "https://github.com/o/r/pull/42", state: "OPEN", isDraft: true,
    statusCheckRollup: [{ name: "a", conclusion: "SUCCESS" }, { name: "b", conclusion: "FAILURE" }, { name: "c", status: "IN_PROGRESS" }] }) }) });
  const pr = await c.pr(A, 42);
  assert.equal(pr.url, "https://github.com/o/r/pull/42");
  assert.equal(pr.checks.verdict, "failing");
  assert.deepEqual(pr.checks.failing, ["b"]);
  assert.equal((await c.pr(A, "1; rm -rf")).ok, false);
});

test("checks: green, running, none", () => {
  assert.equal(checksSummary([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]).verdict, "green");
  assert.equal(checksSummary([{ status: "QUEUED" }]).verdict, "running");
  assert.equal(checksSummary([]).verdict, "none");
});

test("only aither://projects reaches these channels", async () => {
  const s = (url) => ({ getURL: () => url });
  assert.equal(fromProjectsPage(s("aither://projects/")), true);
  assert.equal(fromProjectsPage(s("aither://terminal/")), false);
  let touched = 0;
  const client = new Proxy({}, { get: () => async () => { touched++; return { ok: true }; } });
  const handlers = projectsHandlers(client);
  for (const channel of ["desk:projects-cached", "desk:projects-cached-pr"]) assert.ok(handlers[channel], channel);
  for (const handler of Object.values(handlers)) {
    assert.equal((await handler({ sender: s("https://x.test/") }, A)).ok, false);
  }
  assert.equal(touched, 0);
});

// -- last result first (owner screenshot 2026-11-16: a bare "reading..." on a 1,264-file repo) --

/** A real folder with a .git/HEAD, so the HEAD read has a file to read. */
function realRepo(head) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proj-head-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), head);
  return dir;
}
const STATE = { branch: "develop", dirty_count: 1264, ahead_behind: { ahead: 0, behind: 0 }, merging: false,
  conflicts: [], open_prs: { develop: 9 } };

test("cached: a repo never read shows its branch from .git/HEAD at once; nothing runs", async () => {
  const calls = [];
  const dir = realRepo("ref: refs/heads/develop\n");
  const c = createProjectsClient({ execFile: exec({}, calls) });
  const s = c.cached(dir);
  assert.deepEqual([s.ok, s.partial, s.branch, s.detached], [true, true, "develop", false]);
  assert.equal(calls.length, 0, "the instant answer runs no process");
  const detached = realRepo("0123456789abcdef0123456789abcdef01234567\n");
  assert.deepEqual([c.cached(detached).branch, c.cached(detached).detached], [null, true]);
  // A worktree: .git is a FILE naming the real gitdir.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "proj-wt-"));
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(dir, ".git")}\n`);
  assert.equal(c.cached(wt).branch, "develop");
  assert.equal(c.cached(NOT).ok, false);
});

test("cached: the last good read is shown with its age, and survives a restart", async () => {
  const dir = realRepo("ref: refs/heads/develop\n");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proj-c-")), "projects.json");
  let t = 1_000_000;
  const c = createProjectsClient({ file, now: () => t, execFile: exec({ "awgit state": JSON.stringify(STATE) }) });
  const fresh = await c.state(dir);
  assert.deepEqual([fresh.ok, fresh.dirty, fresh.pr, fresh.at], [true, 1264, 9, 1_000_000]);
  t += 180_000;
  const shown = c.cached(dir);
  assert.deepEqual([shown.ok, shown.cached, shown.partial, shown.dirty, shown.ageMs], [true, true, undefined, 1264, 180_000]);
  assert.ok(fs.existsSync(path.join(path.dirname(file), "projects-state.json")), "kept beside the folder list");
  // A new client (the desk restarted) reads it back without running awgit.
  const calls = [];
  const again = createProjectsClient({ file, now: () => t, execFile: exec({}, calls) });
  assert.equal(again.cached(dir).dirty, 1264);
  assert.equal(calls.length, 0);
});

test("state: a read that outlives its timeout says so and carries the last good read", async () => {
  const dir = realRepo("ref: refs/heads/develop\n");
  let slow = false;
  const execFile = (cmd, args, opts, cb) => {
    assert.equal(opts.timeout, 5_000, "the timeout reaches execFile");
    if (slow) setImmediate(() => cb(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", ""));
    else setImmediate(() => cb(null, JSON.stringify(STATE), ""));
  };
  const c = createProjectsClient({ execFile, stateTimeoutMs: 5_000 });
  assert.equal((await c.state(dir)).ok, true);
  slow = true;
  const late = await c.state(dir);
  assert.equal(late.ok, false);
  assert.equal(late.timedOut, true);
  assert.match(late.error, /took longer than 5 s/);
  assert.equal(late.last.dirty, 1264, "the page keeps the last result on screen");
});

test("state: two reads of one repo run awgit once (a Refresh never stacks git walks)", async () => {
  const dir = realRepo("ref: refs/heads/develop\n");
  const calls = [];
  const c = createProjectsClient({ execFile: exec({ "awgit state": JSON.stringify(STATE) }, calls) });
  const [a, b] = await Promise.all([c.state(dir), c.state(dir)]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  await c.state(dir);
  assert.equal(calls.length, 2, "a later read runs again");
});

test("cachedPr: the last PR read, with its age; nothing runs", async () => {
  let t = 5_000;
  const calls = [];
  const c = createProjectsClient({ exists: isRepo, now: () => t, execFile: exec({ "gh pr": JSON.stringify({
    number: 9, title: "T", url: "https://github.com/o/r/pull/9", state: "OPEN", isDraft: false,
    statusCheckRollup: [{ name: "a", conclusion: "SUCCESS" }] }) }, calls) });
  assert.equal(c.cachedPr(A, 9).ok, false, "not read yet");
  assert.equal((await c.pr(A, 9)).ok, true);
  t += 60_000;
  const last = c.cachedPr(A, 9);
  assert.deepEqual([last.ok, last.title, last.checks.verdict, last.ageMs], [true, "T", "green", 60_000]);
  assert.equal(calls.length, 1);
  assert.equal(c.cachedPr(A, "9; rm").ok, false);
});
