"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sm = require("./shell-menu.cjs");

// ── an in-memory HKCU, enough of reg.exe to exercise the state machine ──────
function fakeRegistry() {
  const keys = new Map(); // path -> Map(valueName || "" -> data)
  const calls = [];
  const ensure = (key) => {
    if (!keys.has(key)) keys.set(key, new Map());
    return keys.get(key);
  };
  const hasTree = (key) => {
    for (const k of keys.keys()) if (k === key || k.startsWith(`${key}\\`)) return true;
    return false;
  };
  function run(args) {
    calls.push(args);
    const verb = args[0];
    const key = args[1];
    if (verb === "add") {
      const named = args.indexOf("/v");
      const defaulted = args.indexOf("/ve");
      const name = defaulted >= 0 ? "" : args[named + 1];
      const data = args[args.indexOf("/d") + 1];
      // reg add creates every missing parent.
      const parts = key.split("\\");
      for (let i = 2; i <= parts.length; i += 1) ensure(parts.slice(0, i).join("\\"));
      ensure(key).set(name, data);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "delete") {
      if (!hasTree(key)) return { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
      if (args.includes("/v")) {
        const name = args[args.indexOf("/v") + 1];
        const bucket = keys.get(key);
        if (!bucket || !bucket.has(name)) return { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
        bucket.delete(name);
        return { code: 0, stdout: "", stderr: "" };
      }
      for (const k of [...keys.keys()]) if (k === key || k.startsWith(`${key}\\`)) keys.delete(k);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "query") {
      if (!hasTree(key)) return { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
      if (args.includes("/v")) {
        const name = args[args.indexOf("/v") + 1];
        const bucket = keys.get(key);
        if (!bucket || !bucket.has(name)) return { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
        return { code: 0, stdout: `\r\n${key}\r\n    ${name}    REG_SZ    ${bucket.get(name)}\r\n\r\n`, stderr: "" };
      }
      return { code: 0, stdout: `\r\n${key}\r\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unsupported" };
  }
  return {
    keys,
    calls,
    execFile: async (_file, args) => run(args),
    put(key, name, data) { ensure(key).set(name, data); },
    get(key, name) { return keys.get(key) ? keys.get(key).get(name) : undefined; },
    state(root) {
      const bucket = keys.get(root);
      if (!bucket) return "absent";
      return bucket.get(sm.MARKER_VALUE) === sm.MARKER_DATA ? "ours" : "foreign";
    },
  };
}

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-shell-menu-"));
  return path.join(dir, "state.json");
}

const TEST_ROOTS = {
  desktop: "HKCU\\Software\\AitherTest\\DesktopBackground\\Shell\\AitherQuick",
  directory: "HKCU\\Software\\AitherTest\\Directory\\Background\\Shell\\AitherQuick",
};
const EXE = "C:\\Program Files\\Aither\\awdesk.exe";
const APP = "C:\\app\\awdesk";

function manager(reg, extra = {}) {
  const stateFile = tempState();
  const created = sm.createShellMenu({
    execFile: reg.execFile, platform: "win32", exe: EXE, appArgs: [APP],
    roots: TEST_ROOTS, stateFile, ...extra,
  });
  return Object.assign(created, { stateFile });
}

test("S1 the launch command quotes paths and the id is bare", () => {
  assert.equal(sm.launchCommand({ exe: EXE, appArgs: [APP], id: "snip.region" }),
    '"C:\\Program Files\\Aither\\awdesk.exe" "C:\\app\\awdesk" --run=snip.region');
  assert.equal(sm.launchCommand({ exe: EXE, id: "note.new" }),
    '"C:\\Program Files\\Aither\\awdesk.exe" --run=note.new');
  assert.throws(() => sm.launchCommand({ exe: "relative.exe", id: "x" }), /absolute/);
  assert.throws(() => sm.launchCommand({ exe: EXE, id: "a b" }), /command id/);
  assert.throws(() => sm.launchCommand({ exe: EXE, appArgs: ['bad"quote'], id: "x" }), /quote/);
});

test("S2 every root gets the cascade values and one verb+command per entry", () => {
  const cmds = sm.enableCommands({ root: "HKCU\\X\\AitherQuick", exe: EXE, appArgs: [APP] });
  const text = cmds.map((a) => a.join(" ")).join("\n");
  assert.ok(text.includes("/v MUIVerb /t REG_SZ /d Aither /f"));
  assert.ok(text.includes("/v SubCommands /t REG_SZ /d  /f"), "SubCommands must be an EMPTY REG_SZ");
  assert.ok(text.includes("/v AitherDesk /t REG_SZ /d 1 /f"));
  for (const entry of sm.ENTRIES) {
    assert.ok(text.includes(`HKCU\\X\\AitherQuick\\shell\\${entry.key}\\command /ve`), `${entry.id} has no command key`);
    assert.ok(text.includes(`--run=${entry.id}`), `${entry.id} launches no --run`);
  }
  assert.equal(cmds.filter((args) => args.some((part) => part.includes("\\command"))).length, sm.ENTRIES.length);
});

test("S3 enable refuses without consent and never touches the registry", async () => {
  const reg = fakeRegistry();
  const verdict = await manager(reg).enable({});
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /consent/);
  assert.equal(reg.calls.length, 0);
});

test("S4 enable installs both roots, status sees ours, restore removes everything", async () => {
  const reg = fakeRegistry();
  const mgr = manager(reg);
  assert.equal((await mgr.status()).enabled, false);
  const on = await mgr.enable({ consent: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(reg.state(TEST_ROOTS.desktop), "ours");
  assert.equal(reg.state(TEST_ROOTS.directory), "ours");
  assert.equal(reg.get(`${TEST_ROOTS.desktop}\\shell\\snip-region\\command`, ""),
    `"${EXE}" "${APP}" --run=snip.region`);
  assert.equal(reg.get(`${TEST_ROOTS.desktop}\\shell\\ask-aither`, "MUIVerb"), "Ask Aither");
  const now = await mgr.status();
  assert.equal(now.enabled, true);
  assert.equal(now.foreign, false);
  const off = await mgr.restore();
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(reg.state(TEST_ROOTS.desktop), "absent");
  assert.equal(reg.state(TEST_ROOTS.directory), "absent");
  assert.equal((await mgr.status()).enabled, false);
  assert.equal(fs.existsSync(mgr?.stateFile || ""), false, "a successful restore drops the state file");
});

test("S5 a foreign AitherQuick key is refused by enable AND restore, never clobbered", async () => {
  const reg = fakeRegistry();
  reg.put(TEST_ROOTS.desktop, "MUIVerb", "Another tool's menu");
  const mgr = manager(reg);
  const before = JSON.stringify([...reg.keys.entries()].map(([k, v]) => [k, [...v.entries()]]));
  const on = await mgr.enable({ consent: true });
  assert.equal(on.ok, false);
  assert.match(on.reason, /another tool|owned/i);
  assert.equal(JSON.stringify([...reg.keys.entries()].map(([k, v]) => [k, [...v.entries()]])), before);
  // Nothing of ours is installed, so there is nothing of ours to restore.
  const clean = await mgr.restore();
  assert.equal(clean.ok, true);
  assert.equal(reg.get(TEST_ROOTS.desktop, "MUIVerb"), "Another tool's menu");
  // With a (bogus) state file the restore is refused BY ROOT, still untouched.
  fs.writeFileSync(mgr.stateFile, JSON.stringify({ version: 1, roots: { desktop: { createdKey: null }, directory: { createdKey: null } } }));
  const off = await mgr.restore();
  assert.equal(off.ok, false);
  assert.equal(reg.get(TEST_ROOTS.desktop, "MUIVerb"), "Another tool's menu");
});

test("S6 a refused write rolls BOTH roots back and leaves no state file", async () => {
  const reg = fakeRegistry();
  let adds = 0;
  const flaky = async (file, args) => {
    if (args[0] === "add") {
      adds += 1;
      if (adds === 9) return { code: 1, stdout: "", stderr: "Access is denied." }; // mid second root
    }
    return reg.execFile(file, args);
  };
  const mgr = manager(reg, { execFile: flaky });
  const verdict = await mgr.enable({ consent: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rolledBack, true, JSON.stringify(verdict));
  assert.equal(reg.state(TEST_ROOTS.desktop), "absent", "the first root was undone");
  assert.equal(reg.state(TEST_ROOTS.directory), "absent");
  assert.equal(fs.existsSync(mgr.stateFile), false);
});

test("S7 a tampered state file cannot aim a delete outside the two known roots", async () => {
  const reg = fakeRegistry();
  const victim = "HKCU\\Software\\Classes\\Directory\\Background\\Shell\\SomethingElse";
  reg.put(victim, "", "keep me");
  const mgr = manager(reg);
  await mgr.enable({ consent: true });
  // Rewrite the state as a hostile file would.
  fs.writeFileSync(mgr.stateFile, JSON.stringify({
    version: 1,
    roots: {
      desktop: { createdKey: victim },
      directory: { createdKey: victim },
    },
  }));
  const off = await mgr.restore();
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(reg.get(victim, ""), "keep me", "a path from disk was never deleted");
  assert.equal(reg.state(TEST_ROOTS.desktop), "absent");
});

test("S8 non-Windows is refused, and entries can be filtered to what the registry has", async () => {
  const reg = fakeRegistry();
  const mgr = sm.createShellMenu({ execFile: reg.execFile, platform: "linux", roots: TEST_ROOTS, stateFile: tempState() });
  assert.equal((await mgr.status()).supported, false);
  assert.equal((await mgr.enable({ consent: true })).ok, false);
  assert.equal(reg.calls.length, 0);

  const partial = manager(reg, { available: (id) => id !== "orb.ask-screen" });
  await partial.enable({ consent: true });
  const text = reg.calls.map((a) => a.join(" ")).join("\n");
  assert.ok(!text.includes("--run=orb.ask-screen"), "a missing orb.ask-screen must not be installed");
  assert.ok(text.includes("--run=note.new"));
});
