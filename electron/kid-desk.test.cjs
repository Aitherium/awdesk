"use strict";

/**
 * Kid desk (kids' suite S7): a child's PC shows their classroom and nothing adult.
 * Acceptance: awdesk in kid mode lists NO roster character; only the guardian's MACHINE
 * policy turns it on or off; a second launch cannot open anything else; the classroom
 * window stays on the exact classroom host.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const kd = require("./kid-desk.cjs");

const NO_REG = () => false;
const NO_FILE = path.join(os.tmpdir(), "kid-desk-no-such-dir", "kid-desk.json");

function policyDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kid-desk-"));
  const file = path.join(dir, kd.FILE);
  if (body !== undefined) fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

test("kid mode is off unless the guardian's machine policy says on", () => {
  assert.equal(kd.resolveKidDesk({ readRegistry: NO_REG, policyFile: NO_FILE }).enabled, false);
  const reg = kd.resolveKidDesk({ readRegistry: () => true, policyFile: NO_FILE });
  assert.equal(reg.enabled, true);
  assert.equal(reg.source, "machine-registry");
  const file = kd.resolveKidDesk({ readRegistry: NO_REG, policyFile: policyDir({ enabled: true }) });
  assert.equal(file.source, "machine-file");
  assert.equal(kd.resolveKidDesk({ readRegistry: NO_REG, policyFile: policyDir("{not json") }).enabled, false);
  assert.equal(kd.resolveKidDesk({ readRegistry: NO_REG, policyFile: policyDir({ enabled: "yes" }) }).enabled, false);
});

test("nothing in the child's own scope turns kid mode on or OFF", () => {
  // The old child-removable switches are not read at all: a flag, a user env var, a file in
  // the child's AppData. So the child cannot remove one to escape, and none can override.
  const childScope = { argv: ["electron", ".", "--kid-desk"], env: { AWDESK_KID_DESK: "1" } };
  assert.equal(kd.resolveKidDesk({ ...childScope, readRegistry: NO_REG, policyFile: NO_FILE }).enabled, false);
  // Policy on + a child's "off" anywhere in their scope: still on.
  const on = kd.resolveKidDesk({ argv: ["--no-kid-desk"], env: { AWDESK_KID_DESK: "0" },
    readRegistry: () => true, policyFile: policyDir({ enabled: false }) });
  assert.equal(on.enabled, true, "registry policy wins over a file that says false");
  const src = fs.readFileSync(path.join(__dirname, "kid-desk.cjs"), "utf8");
  assert.doesNotMatch(src, /process\.argv|AWDESK_KID_DESK|getPath\(["']userData/);
});

test("the machine policy lives where a standard user cannot write", () => {
  assert.equal(kd.policyFilePath({ platform: "win32", programData: "C:\\ProgramData" }),
    "C:\\ProgramData\\Aitherium\\awdesk\\kid-desk.json");
  assert.equal(kd.policyFilePath({ platform: "win32", programData: "" }), "", "no HKLM ProgramData = no file");
  assert.equal(kd.policyFilePath({ platform: "linux" }), "/etc/aitherium/awdesk/kid-desk.json");
  assert.equal(kd.REG_KEY, "HKLM\\SOFTWARE\\Policies\\Aitherium\\AWDesk");
  const ok = (out) => () => out;
  assert.equal(kd.readRegistryPolicy({ platform: "win32",
    execFileSync: ok("\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Aitherium\\AWDesk\r\n    KidDesk    REG_DWORD    0x1\r\n") }), true);
  assert.equal(kd.readRegistryPolicy({ platform: "win32",
    execFileSync: ok("    KidDesk    REG_DWORD    0x0\r\n") }), false);
  assert.equal(kd.readRegistryPolicy({ platform: "win32",
    execFileSync: () => { throw new Error("ERROR: The system was unable to find the specified registry key"); } }), false);
  assert.equal(kd.readRegistryPolicy({ platform: "linux", execFileSync: ok("KidDesk REG_DWORD 0x1") }), false);
});

test("in kid mode the REAL roster lists no character, and none can be switched to", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kid-roster-"));
  fs.mkdirSync(path.join(dir, "zz-kid-desk-fixture"));
  fs.writeFileSync(path.join(dir, "zz-kid-desk-fixture", "model.vrm"), "glTF");
  const prev = process.env.DESK_ROSTER_DIR;
  process.env.DESK_ROSTER_DIR = dir;
  try {
    delete require.cache[require.resolve("./character-roster.cjs")];
    const roster = require("./character-roster.cjs");
    const all = roster.listAllCharacters();
    assert.ok(all.includes("zz-kid-desk-fixture"), "fixture is installed in the roster");
    const on = kd.resolveKidDesk({ readRegistry: () => true, policyFile: NO_FILE });
    assert.deepEqual(kd.gateRoster(on, roster.listCharacters()), []);
    assert.deepEqual(kd.gateRoster(on, all), []);
    assert.equal(kd.allowCharacterChange(on), false);
    const off = kd.resolveKidDesk({ readRegistry: NO_REG, policyFile: NO_FILE });
    assert.deepEqual(kd.gateRoster(off, all), all);
    assert.equal(kd.allowCharacterChange(off), true);
  } finally {
    if (prev === undefined) delete process.env.DESK_ROSTER_DIR;
    else process.env.DESK_ROSTER_DIR = prev;
    delete require.cache[require.resolve("./character-roster.cjs")];
  }
});

test("the classroom is the EXACT classroom host, never a sibling aitherium.com host", () => {
  const def = kd.resolveKidDesk({ readRegistry: () => true, policyFile: NO_FILE });
  assert.equal(kd.classroomUrl(def), "https://app.aitherium.com/learn?desk=kid");
  assert.equal(kd.allowNavigation("https://app.aitherium.com/learn/sprite", def), true);
  for (const bad of ["https://aitherium.com/", "https://shop.aitherium.com/", "https://beta.aitherium.com/learn",
    "https://app.aitherium.com:8443/learn", "https://u:p@app.aitherium.com/", "http://app.aitherium.com/",
    "https://youtube.com/", "https://app.aitherium.com.evil.io/", "javascript:alert(1)", "file:///C:/", ""]) {
    assert.equal(kd.allowNavigation(bad, def), false, bad);
  }
  // The guardian's policy may name another aitherium.com page host; then ONLY that one.
  const beta = kd.resolveKidDesk({ readRegistry: NO_REG,
    policyFile: policyDir({ enabled: true, classroom_origin: "https://beta.aitherium.com/anything" }) });
  assert.equal(kd.classroomUrl(beta), "https://beta.aitherium.com/learn?desk=kid");
  assert.equal(kd.allowNavigation("https://beta.aitherium.com/learn", beta), true);
  assert.equal(kd.allowNavigation("https://app.aitherium.com/learn", beta), false);
  for (const off of ["https://evil.example/", "http://app.aitherium.com/"]) {
    const s = kd.resolveKidDesk({ readRegistry: NO_REG, policyFile: policyDir({ enabled: true, classroom_origin: off }) });
    assert.equal(kd.classroomUrl(s), "https://app.aitherium.com/learn?desk=kid", off);
  }
  // Under the registry policy, a policy file (maybe child-created) never moves the classroom.
  const regOn = kd.resolveKidDesk({ readRegistry: () => true,
    policyFile: policyDir({ enabled: true, classroom_origin: "https://shop.aitherium.com/" }) });
  assert.equal(kd.classroomUrl(regOn), "https://app.aitherium.com/learn?desk=kid");
  // A child-set env var never moves the classroom.
  const env = kd.resolveKidDesk({ env: { DESK_ONLINE_URL: "https://shop.aitherium.com/" },
    readRegistry: () => true, policyFile: NO_FILE });
  assert.equal(kd.classroomUrl(env), "https://app.aitherium.com/learn?desk=kid");
});

test("the classroom window opens no new windows and refuses any other host", () => {
  const handlers = {};
  let openHandler = null;
  let loaded = "";
  let opts = null;
  class FakeWindow {
    constructor(o) { opts = o; this.webContents = {
      setWindowOpenHandler: (fn) => { openHandler = fn; },
      on: (ev, fn) => { handlers[ev] = fn; },
    }; }
    loadURL(u) { loaded = u; }
    isDestroyed() { return false; }
    show() {}
    focus() {}
  }
  const state = kd.resolveKidDesk({ readRegistry: () => true, policyFile: NO_FILE });
  const win = kd.openClassroomWindow({ BrowserWindow: FakeWindow }, { state });
  assert.equal(loaded, "https://app.aitherium.com/learn?desk=kid");
  assert.equal(opts.webPreferences.nodeIntegration, false);
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.partition, kd.PARTITION, "own session: no grown-up sign-in");
  assert.equal(opts.webPreferences.webviewTag, false);
  assert.deepEqual(openHandler({ url: "https://app.aitherium.com/x" }), { action: "deny" });
  const prevented = (ev, url) => {
    let p = false;
    handlers[ev]({ preventDefault: () => { p = true; } }, url);
    return p;
  };
  assert.equal(prevented("will-navigate", "https://youtube.com/"), true);
  assert.equal(prevented("will-navigate", "https://shop.aitherium.com/"), true);
  assert.equal(prevented("will-navigate", "https://app.aitherium.com/learn"), false);
  assert.equal(prevented("will-redirect", "https://shop.example/"), true);
  assert.equal(prevented("will-redirect", "https://aitherium.com/"), true);
  assert.equal(prevented("will-attach-webview", "https://app.aitherium.com/"), true);
  assert.equal(kd.openClassroomWindow({ BrowserWindow: FakeWindow }, { state, existing: win }), win);
});

test("the kid tray offers the classroom and nothing else", () => {
  const items = kd.kidTrayTemplate({ openClassroom: () => {} });
  assert.deepEqual(items.map((i) => i.label), ["My classroom"]);
});

/** The body of `app.on("<event>", ...)` in main.cjs, up to its first 400 characters. */
function handlerHead(src, event) {
  const at = src.indexOf(`app.on("${event}"`);
  assert.ok(at > 0, `main.cjs registers ${event}`);
  return src.slice(at, at + 400);
}

test("main.cjs routes every roster read through the kid gate and stops before adult boot", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(src, /listCharacters: rosterListCharacters,/);
  assert.match(src, /installCharacter: rosterInstallCharacter,/);
  assert.match(src, /function listCharacters\(\) \{\s*return kidDesk\.gateRoster\(kidDeskMode\(\), rosterListCharacters\(\)\);/);
  assert.doesNotMatch(src, /const \{ listAllCharacters \} = require\("\.\/character-roster\.cjs"\)/);
  const kid = src.indexOf("if (kidDeskMode().enabled) {", src.indexOf("app.whenReady()"));
  const adult = src.indexOf("startAeonMoodFeed();", src.indexOf("app.whenReady()"));
  assert.ok(kid > 0 && adult > kid, "kid desk returns before the avatar/agent boot");
  // kid mode is resolved from machine policy only (no argv/env/userData handed in)
  assert.match(src, /kidDeskState = kidDesk\.resolveKidDesk\(\);/);
});

test("a second launch in kid mode only brings the classroom forward", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  // second-instance: before ANY argv routing (--open-deck, --fleet, --console, --run=,
  // desk:// links), kid mode opens the classroom and returns.
  const second = handlerHead(src, "second-instance");
  const gate = second.indexOf("if (kidDeskMode().enabled) {");
  assert.ok(gate > 0, "second-instance checks kid mode");
  assert.ok(gate < second.indexOf("handleProtocolArgv"), "kid gate runs before protocol routing");
  assert.match(second.slice(gate), /^if \(kidDeskMode\(\)\.enabled\) \{\s*openKidClassroom\(\);\s*return;/);
  // desk:// links (macOS open-url) and dock activation: never a desk window in kid mode.
  assert.match(handlerHead(src, "open-url"), /event\.preventDefault\(\);\s*if \(kidDeskMode\(\)\.enabled\) \{\s*openKidClassroom\(\);\s*return;/);
  assert.match(handlerHead(src, "activate"), /kidDeskMode\(\)\.enabled \? openKidClassroom\(\) : showOverlay/);
  // --smoke skips the single-instance lock; a child cannot use it to start a second desk.
  assert.match(src, /const smokeIsRequested = process\.argv\.includes\("--smoke"\) && !kidDeskMode\(\)\.enabled;/);
});

/** A fake reg.exe: `values` maps "<key>|<value>" to its `reg query` output line. */
function fakeReg(values, calls = []) {
  return (exe, args) => {
    calls.push({ exe, args });
    const out = values[`${args[1]}|${args[3]}`];
    if (out === undefined) throw new Error("ERROR: The system was unable to find the specified registry key or value.");
    return `\r\n${args[1]}\r\n    ${out}\r\n\r\n`;
  };
}
const PD = (v) => ({ [`${kd.PROFILE_LIST_KEY}|ProgramData`]: `ProgramData    REG_EXPAND_SZ    ${v}` });
const ROOT = (v) => ({ [`${kd.NT_CURRENT_KEY}|SystemRoot`]: `SystemRoot    REG_SZ    ${v}` });

test("the machine ProgramData comes from HKLM, never from the process environment", () => {
  // A standard (child) account can set a per-user ProgramData env var, or launch the desk
  // with any env at all, and point the policy lookup at an empty folder = kid mode OFF.
  const saved = { ProgramData: process.env.ProgramData, PROGRAMDATA: process.env.PROGRAMDATA };
  process.env.ProgramData = "C:\\Users\\kid\\Fake";
  process.env.PROGRAMDATA = "C:\\Users\\kid\\Fake";
  try {
    const calls = [];
    const run = fakeReg({ ...PD("%SystemDrive%\\ProgramData"), ...ROOT("D:\\WINDOWS") }, calls);
    assert.equal(kd.machineProgramData({ platform: "win32", execFileSync: run }), "D:\\ProgramData");
    assert.equal(kd.policyFilePath({ platform: "win32", execFileSync: run }),
      "D:\\ProgramData\\Aitherium\\awdesk\\kid-desk.json");
    // reg.exe by absolute path (a bare "reg" is searched in the child-controlled cwd/PATH)
    assert.ok(calls.length && calls.every((c) => c.exe === kd.REG_EXE), JSON.stringify(calls));
    assert.equal(kd.REG_EXE, "C:\\Windows\\System32\\reg.exe");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // %SystemDrive% from Session Manager\Environment when it is there
  const run2 = fakeReg({ ...PD("%SystemDrive%\\ProgramData"),
    [`${kd.SESSION_ENV_KEY}|SystemDrive`]: "SystemDrive    REG_SZ    E:", ...ROOT("C:\\WINDOWS") });
  assert.equal(kd.machineProgramData({ platform: "win32", execFileSync: run2 }), "E:\\ProgramData");
  // an already-literal value needs no expansion
  assert.equal(kd.machineProgramData({ platform: "win32", execFileSync: fakeReg(PD("C:\\ProgramData")) }),
    "C:\\ProgramData");
});

test("an unreadable or unexpandable HKLM ProgramData skips the file: only the HKLM value counts", () => {
  const none = fakeReg({});
  assert.equal(kd.machineProgramData({ platform: "win32", execFileSync: none }), "");
  // a variable HKLM cannot answer (an env-only one) is never filled from process.env
  assert.equal(kd.machineProgramData({ platform: "win32",
    execFileSync: fakeReg(PD("%USERPROFILE%\\ProgramData")) }), "");
  assert.equal(kd.machineProgramData({ platform: "win32",
    execFileSync: fakeReg(PD("%SystemDrive%\\ProgramData")) }), "", "no SystemDrive, no SystemRoot");
  assert.equal(kd.machineProgramData({ platform: "win32", execFileSync: fakeReg(PD("ProgramData")) }), "");
  assert.equal(kd.machineProgramData({ platform: "linux", execFileSync: fakeReg(PD("C:\\ProgramData")) }), "");
  assert.equal(kd.policyFilePath({ platform: "win32", execFileSync: none }), "");
  // resolveKidDesk with no file path still honours the registry policy, and reads no file
  assert.equal(kd.resolveKidDesk({ platform: "linux", readRegistry: () => true, policyFile: "" }).enabled, true);
});

test("kid-desk.cjs reads no environment variable at all", () => {
  const src = fs.readFileSync(path.join(__dirname, "kid-desk.cjs"), "utf8");
  assert.doesNotMatch(src, /process\.env|\benv\s*[.[]|ProgramData\s*\|\||PROGRAMDATA/);
});

test("kid mode closes the CDP doors a child could open from their own scope", () => {
  const on = { enabled: true };
  const off = { enabled: false };
  assert.equal(kd.allowCdpPort(on), false);
  assert.equal(kd.allowCdpPort(off), true);
  const sw = new Set(["remote-debugging-port", "remote-debugging-pipe", "lang"]);
  const cl = { hasSwitch: (n) => sw.has(n), removeSwitch: (n) => sw.delete(n) };
  assert.deepEqual(kd.scrubDebugSwitches(on, cl), ["remote-debugging-port", "remote-debugging-pipe"]);
  assert.deepEqual([...sw], ["lang"]);
  const sw2 = new Set(["remote-debugging-port"]);
  assert.deepEqual(kd.scrubDebugSwitches(off, { hasSwitch: (n) => sw2.has(n), removeSwitch: (n) => sw2.delete(n) }), []);
  assert.equal(sw2.size, 1, "outside kid mode the owner's diagnostics door is untouched");
  // main.cjs: kid mode is resolved BEFORE the DESK_CDP_PORT door, and the door checks it
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const resolved = src.indexOf("function kidDeskMode()");
  const scrub = src.indexOf("kidDesk.scrubDebugSwitches(kidDeskMode(), app.commandLine);");
  const door = src.indexOf("process.env.DESK_CDP_PORT");
  assert.ok(resolved > 0 && scrub > resolved && door > scrub, "kid mode resolves before the CDP door");
  assert.match(src, /if \(kidDesk\.allowCdpPort\(kidDeskMode\(\)\) && \/\^\\d\{2,5\}\$\/\.test\(String\(process\.env\.DESK_CDP_PORT/);
  assert.match(src, /function cardWindowsMayOpen\(\) \{\s*if \(kidDeskMode\(\)\.enabled\) return false;/);
});
