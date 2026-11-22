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
  for (const handler of Object.values(projectsHandlers(client))) {
    assert.equal((await handler({ sender: s("https://x.test/") }, A)).ok, false);
  }
  assert.equal(touched, 0);
});
