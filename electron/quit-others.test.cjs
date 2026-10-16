"use strict";

// `Desk.exe --quit` (the jump list's "Quit Aither", a Start-menu shortcut, a support
// script) ends a running Desk: it asks politely through the single-instance channel, and
// if that Desk has not exited within 3 s -- a main thread stuck in a loop never reads the
// request -- it ends it. Nobody needs Task Manager or Task Scheduler.

const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("./quit-others.cjs");

test("tasklist CSV parses to pids of that image, excluding this process", () => {
  const csv = [
    '"Aither.exe","4120","Console","1","120,332 K"',
    '"Aither.exe","5500","Console","1","6,261,000 K"',
    '"Aither.exe","777","Console","1","1,000 K"',
    "",
  ].join("\r\n");
  assert.deepEqual(q.parseTasklistCsv(csv, { selfPid: 777 }), [4120, 5500]);
  assert.deepEqual(q.parseTasklistCsv("INFO: No tasks are running which match the specified criteria.", { selfPid: 1 }), []);
});

test("a Desk that exits on request is not forced", async () => {
  let listed = 0;
  const killed = [];
  const out = await q.quitRunning({
    list: async () => (listed++ < 2 ? [10, 11] : []),
    kill: async (pids) => killed.push(...pids),
    sleep: async () => {},
    timeoutMs: 3000, stepMs: 250,
  });
  assert.equal(out.forced, 0);
  assert.deepEqual(killed, []);
});

test("a Desk still running after 3 s is ended", async () => {
  const killed = [];
  const out = await q.quitRunning({
    list: async () => [10, 11],
    kill: async (pids) => killed.push(...pids),
    sleep: async () => {},
    timeoutMs: 3000, stepMs: 250,
  });
  assert.equal(out.forced, 2);
  assert.deepEqual(killed, [10, 11]);
});

test("the Windows commands name only this user's processes of this image", () => {
  const listArgs = q.tasklistArgs("Aither.exe", "jmorse");
  assert.deepEqual(listArgs, ["/FI", "IMAGENAME eq Aither.exe", "/FI", "USERNAME eq jmorse", "/FO", "CSV", "/NH"]);
  assert.deepEqual(q.taskkillArgs([10, 11]), ["/F", "/T", "/PID", "10", "/PID", "11"]);
});

test("the installer puts Quit Aither in the Start menu, launching --quit", () => {
  const nsh = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "build", "installer.nsh"), "utf8");
  assert.ok(nsh.includes('"$SMPROGRAMS\\Quit Aither.lnk" "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--quit"'));
  assert.ok(nsh.includes('Delete "$SMPROGRAMS\\Quit Aither.lnk"'), "the uninstaller removes it");
});

test("upgrading a per-user Desk removes only ITS shortcuts, in the user's own context, then returns to all-users", () => {
  const nsh = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "build", "installer.nsh"), "utf8");
  const body = nsh.slice(nsh.indexOf("!macro customInstall"), nsh.indexOf("!macroend", nsh.indexOf("!macro customInstall")));
  const cur = body.indexOf("SetShellVarContext current");
  const all = body.indexOf("SetShellVarContext all");
  assert.ok(cur > 0 && all > cur, "per-user context first, all-users restored after");
  assert.match(body, /IfFileExists "\$LOCALAPPDATA\\Programs\\Desk\\Desk\.exe" 0 aither_no_per_user_copy/);
  const between = body.slice(cur, all);
  assert.match(between, /Delete "\$SMPROGRAMS\\Desk\.lnk"/);
  assert.doesNotMatch(between, /RMDir|Delete "\$LOCALAPPDATA/, "never the per-user files or data");
});

test("main.cjs handles --quit before anything else starts", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  const at = src.indexOf('process.argv.includes("--quit")');
  assert.ok(at > 0, "main.cjs never reads --quit");
  assert.ok(at < src.indexOf("app.requestSingleInstanceLock()"), "--quit must be decided before the lock is taken");
  assert.match(src, /argv\.includes\("--quit"\)/, "the running Desk quits when a second launch says --quit");
});
