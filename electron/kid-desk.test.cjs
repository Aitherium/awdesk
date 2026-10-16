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
  assert.equal(kd.policyFilePath({ platform: "win32", env: { ProgramData: "C:\\ProgramData" } }),
    "C:\\ProgramData\\Aitherium\\awdesk\\kid-desk.json");
  assert.equal(kd.policyFilePath({ platform: "linux", env: {} }), "/etc/aitherium/awdesk/kid-desk.json");
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
