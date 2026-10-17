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

// Measured 2026-10-17 on the released 0.1.20 (garg tenant, isolated profile): the running
// Desk was gone 4 s after `Desk.exe --quit`, but the --quit launch itself took 39-60+ s to
// exit. Its OWN GPU and network processes are Desk.exe too, so the listing never emptied;
// each `tasklist` takes 1.2-3 s, so twelve "250 ms" steps became ~40 s; and at the end it
// ended its own children -- or a Desk the customer had started again meanwhile.
test("this launch's own processes are never waited for or ended", async () => {
  const killed = [];
  let listed = 0;
  const out = await q.quitRunning({
    // the running Desk (10, 11) leaves after one look; this launch's own 20, 21 stay
    list: async () => (listed++ < 1 ? [10, 11, 20, 21] : [20, 21]),
    own: () => [20, 21],
    kill: async (pids) => killed.push(...pids),
    sleep: async () => {},
    timeoutMs: 3000, stepMs: 250,
  });
  assert.deepEqual(killed, [], "it ended its own GPU/network process");
  assert.equal(out.forced, 0);
  assert.equal(out.asked, 2);
});

test("a Desk started after the first look is never ended", async () => {
  const killed = [];
  let listed = 0;
  const out = await q.quitRunning({
    list: async () => (listed++ < 1 ? [10] : [10, 30]),
    kill: async (pids) => killed.push(...pids),
    sleep: async () => {},
    timeoutMs: 3000, stepMs: 250,
  });
  assert.deepEqual(killed, [10], "only the Desk that was running when Quit was asked");
  assert.equal(out.forced, 1);
});

test("the 3 s wait is wall-clock: a slow listing does not stretch it to 40 s", async () => {
  let clock = 0;
  let calls = 0;
  const killed = [];
  await q.quitRunning({
    list: async () => { calls += 1; clock += 1500; return [10]; }, // tasklist: 1.2-3 s measured
    kill: async (pids) => killed.push(...pids),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    timeoutMs: 3000, stepMs: 250,
  });
  assert.deepEqual(killed, [10]);
  assert.ok(clock <= 6000, `the wait took ${clock} ms of a 3000 ms budget`);
  assert.ok(calls <= 4, `${calls} listings for a 3 s wait`);
});

test("an own() that throws changes nothing", async () => {
  const killed = [];
  const out = await q.quitRunning({
    list: async () => [10],
    own: () => { throw new Error("no metrics yet"); },
    kill: async (pids) => killed.push(...pids),
    sleep: async () => {},
    timeoutMs: 3000, stepMs: 250,
  });
  assert.deepEqual(killed, [10]);
  assert.equal(out.forced, 1);
});

// The same 0.1.21 build, measured on the owner's PC: `Desk.exe --quit` with NO Desk running
// took 3.4-8.9 s, all of it loading the ~4,000 lines of main.cjs above the old --quit branch.
test("main.cjs decides --quit before it loads the rest of Desk", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  const at = src.indexOf('process.argv.includes("--quit")');
  const heavy = src.indexOf('require("./desk-posture.cjs")');
  assert.ok(at > 0 && heavy > 0);
  assert.ok(at < heavy, "--quit must be decided before desk-posture and everything after it load");
  const branch = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(branch, /app\.setName\(INTERNAL_APP_NAME\)/, "the lock must be the real profile's lock");
  assert.match(branch, /userDataDirFor\(/);
  assert.match(branch, /requestSingleInstanceLock\(\)/);
  assert.match(branch, /\breturn;/, "nothing else of Desk may start in a --quit launch");
  assert.equal((src.match(/process\.argv\.includes\("--quit"\)/g) || []).length, 1, "one --quit decision, not two");
});

test("main.cjs tells the --quit launch which processes are its own", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "main.cjs"), "utf8");
  const at = src.indexOf("quitRunningDesk(");
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 300), /own:\s*\(\)\s*=>[^\n]*getAppMetrics\(\)/,
    "--quit must pass this launch's app.getAppMetrics() pids as its own");
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
