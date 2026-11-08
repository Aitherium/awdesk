"use strict";

// session-context.cjs under node --test: finding a session's journal, reading
// what it was doing from bounded windows (a fixture journal padded with the
// api-request blobs that bury real turns in practice), liveness from the
// running processes' state files, the teammate-message cleanup, the tab-name
// match and the resume argv (decoded, so the quoting is asserted, not trusted).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sc = require("./session-context.cjs");

const SID = "ce9c9f1b-5eed-4d06-a5ac-da2db3c6e866";
const CWD = "C:\\AitherOS-Fresh";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-context-"));
}

function line(obj) { return `${JSON.stringify(obj)}\n`; }

function writeJournal(home, { blobs = 0 } = {}) {
  const dir = path.join(home, "projects", sc.projectSlug(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SID}.jsonl`);
  let body = "";
  body += line({ type: "user", timestamp: "2026-11-08T01:00:00Z", message: { role: "user", content: "<system-reminder>noise</system-reminder>make the desk canvas customizable" } });
  body += line({ type: "assistant", timestamp: "2026-11-08T01:01:00Z", message: { content: [{ type: "text", text: "Starting." }, { type: "tool_use", name: "Edit", input: { file_path: "D:\\desk\\electron\\orb-window.cjs" } }] } });
  body += line({ type: "user", timestamp: "2026-11-08T01:01:05Z", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
  const blob = line({ type: "api-request-blob", data: "x".repeat(50_000) });
  for (let i = 0; i < blobs; i += 1) body += blob;
  body += line({ type: "custom-title", customTitle: "Desktop canvas layout", sessionId: SID });
  body += line({ type: "user", timestamp: "2026-11-08T07:14:00Z", message: { role: "user", content: 'Another Claude session sent a message: <teammate-message teammate_id="desk-pins-ink" color="green"> {"type":"idle_notification","result":"The flake is fixed in #20."} </teammate-message>' } });
  body += line({ type: "assistant", timestamp: "2026-11-08T07:15:00Z", message: { content: [{ type: "text", text: "Merged #20." }] } });
  body += line({ type: "assistant", timestamp: "2026-11-08T07:15:01Z", message: { content: [{ type: "text", text: "Decide: approve #15355 via card `d-dph2`." }, { type: "tool_use", name: "Write", input: { file_path: "C:\\notes.md" } }] } });
  fs.writeFileSync(file, body);
  return file;
}

test("projectSlug matches Claude Code's directory naming", () => {
  assert.equal(sc.projectSlug("C:\\AitherOS-Fresh"), "C--AitherOS-Fresh");
  assert.equal(sc.projectSlug("D:\\desk"), "D--desk");
});

test("readContext finds title, goal, the last ask and the FULL last answer past a wall of blobs", () => {
  const home = tmpHome();
  writeJournal(home, { blobs: 80 }); // ~4 MB of blobs between the head and the tail
  const c = sc.readContext(SID, CWD, { home, live: null, repo: "Aitherium/AitherOS" });
  assert.equal(c.ok, true);
  assert.equal(c.name, "Desktop canvas layout");
  assert.equal(c.firstAsk, "make the desk canvas customizable", "system reminders are stripped");
  assert.equal(c.lastAsk, "Message from desk-pins-ink: The flake is fixed in #20.");
  assert.equal(c.lastSaid, "Merged #20.\n\nDecide: approve #15355 via card `d-dph2`.", "a streamed answer is one answer");
  assert.ok(c.turns.length >= 2);
  assert.ok(c.turns.every((t) => !/tool_result/.test(t.text)), "tool results are not turns");
  // 3 turns in the first 2 MB < 4 wanted, so the window widened and reached the head's Edit.
  assert.deepEqual(c.files, ["C:\\notes.md", "D:\\desk\\electron\\orb-window.cjs"], "edited files, most recent first");
  assert.equal(c.live, null);
  assert.equal(c.repo, "Aitherium/AitherOS");
});

test("a missing journal is an honest error, not a crash", () => {
  const home = tmpHome();
  const c = sc.readContext(SID, CWD, { home, repo: "" });
  assert.equal(c.ok, false);
  assert.match(c.error, /not on this machine/);
  assert.equal(sc.readContext("../../etc/passwd", CWD, { home, repo: "" }).ok, false, "only a real session id is looked up");
});

test("liveness: a state file counts only while its pid is alive", () => {
  const home = tmpHome();
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "111.json"), JSON.stringify({ pid: 111, sessionId: SID, name: "Desktop canvas layout", status: "idle", statusUpdatedAt: 5 }));
  fs.writeFileSync(path.join(dir, "222.json"), JSON.stringify({ pid: 222, sessionId: "aaaaaaaa-0000-0000-0000-000000000000", status: "busy" }));
  fs.writeFileSync(path.join(dir, "333.json.key"), "not a state file");
  const live = sc.liveSessions({ home, alive: (pid) => pid === 111 });
  assert.deepEqual([...live.keys()], [SID]);
  assert.equal(live.get(SID).status, "idle");
  assert.equal(sc.pidAlive(process.pid), true);
  assert.equal(sc.pidAlive(-1), false);
});

test("teammate messages read as who said what, even when clipped", () => {
  assert.equal(
    sc.cleanUserText('<teammate-message teammate_id="x" color="g"> {"type":"idle_notification","result":"done"} </teammate-message>'),
    "Message from x: done",
  );
  assert.equal(
    sc.cleanUserText('<teammate-message teammate_id="desk-pins-ink"> {"type":"idle_notification","from":"desk-pins-ink","idleReaso…'),
    "Message from desk-pins-ink: (idle notification)",
  );
  assert.equal(sc.cleanUserText("<command-name>/clear</command-name><command-args></command-args>"), "/clear");
});

test("a terminal tab matches the session name past Claude's status glyph", () => {
  assert.equal(sc.tabMatches("◐ Desktop canvas layout", "Desktop canvas layout"), true);
  assert.equal(sc.tabMatches("✳ 0.tar.gz C:\\Users\\wzns\\Downloads\\README.md lets review…", "0.tar.gz C:\\Users\\wzns\\Downloads\\README.md lets review…"), true);
  assert.equal(sc.tabMatches("pwsh", "Desktop canvas layout"), false);
  assert.equal(sc.tabMatches("ab", "ab"), false, "a two-letter name matches nothing");
});

test("the resume argv opens a WT tab whose payload quotes the prompt safely", () => {
  const argv = sc.resumeArgv({ sessionId: SID, cwd: CWD, title: "Desktop canvas layout", prompt: "it's fine; run `rm` -- no" });
  assert.deepEqual(argv.slice(0, 3), ["-w", "0", "new-tab"]);
  assert.ok(argv.includes("--title") && argv.includes("-d"));
  const encoded = argv[argv.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /^Remove-Item Env:NO_COLOR/);
  assert.match(script, /Set-Location -LiteralPath 'C:\\AitherOS-Fresh'/);
  assert.ok(script.includes(`& 'claude' --resume ${SID} 'it''s fine; run \`rm\` -- no'`), script);
  assert.throws(() => sc.resumeArgv({ sessionId: "x; calc", cwd: CWD }), /not a session id/);
});

test("repoFromRemote reads owner/repo from https and ssh remotes", () => {
  assert.equal(sc.repoFromRemote("https://github.com/Aitherium/AitherOS"), "Aitherium/AitherOS");
  assert.equal(sc.repoFromRemote("git@github.com:Aitherium/awdesk.git\n"), "Aitherium/awdesk");
  assert.equal(sc.repoFromRemote("https://gitlab.com/x/y"), "");
});
