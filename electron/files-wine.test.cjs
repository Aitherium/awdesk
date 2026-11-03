"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FILES_FLAG, createWinE, baseCommand, launchCommand, enableCommands, restoreCommands, queryCommand,
  parseDefault, BASE_KEY, COMMAND_KEY, KEY_CHAIN,
} = require("./files-wine.cjs");

const EXE = "C:\\Program Files\\Aither Desk\\Aither Desk.exe";
const CMD_KEY = "HKCU\\Software\\Classes\\CLSID\\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\\shell\\opennewwindow\\command";

test("the command key is exactly the Win+E CLSID verb under HKCU", () => {
  assert.equal(COMMAND_KEY, CMD_KEY);
  assert.deepEqual(KEY_CHAIN.map((k) => k.slice(BASE_KEY.length)), ["", "\\shell", "\\shell\\opennewwindow",
    "\\shell\\opennewwindow\\command"]);
});

test("baseCommand is launchCommand without the Win+E flag", () => {
  assert.equal(baseCommand({ exe: EXE }), `"${EXE}"`);
  assert.equal(baseCommand({ exe: "C:\\e\\electron.exe", appArgs: ["C:\\app dir"] }),
    "\"C:\\e\\electron.exe\" \"C:\\app dir\"");
});

test("launchCommand quotes every path and appends --files", () => {
  assert.equal(launchCommand({ exe: EXE }), `"${EXE}" --files`);
  assert.equal(launchCommand({ exe: "C:\\e\\electron.exe", appArgs: ["C:\\app dir"] }),
    "\"C:\\e\\electron.exe\" \"C:\\app dir\" --files");
  assert.throws(() => launchCommand({ exe: "awdesk.exe" }), /must be absolute/);
  assert.throws(() => launchCommand({ exe: "C:\\a\"b.exe" }), /quote/);
});

test("enableCommands writes the default value and an EMPTY DelegateExecute", () => {
  assert.deepEqual(enableCommands({ exe: EXE }), [
    ["add", CMD_KEY, "/ve", "/t", "REG_SZ", "/d", `"${EXE}" --files`, "/f"],
    ["add", CMD_KEY, "/v", "DelegateExecute", "/t", "REG_SZ", "/d", "", "/f"],
  ]);
});

test("restoreCommands deletes a KNOWN key only; anything else falls back to the command key", () => {
  assert.deepEqual(restoreCommands(BASE_KEY), [["delete", BASE_KEY, "/f"]]);
  assert.deepEqual(restoreCommands("HKCU\\Software\\Microsoft"), [["delete", CMD_KEY, "/f"]]);
  assert.deepEqual(queryCommand(), ["query", CMD_KEY, "/ve"]);
});

test("parseDefault reads the (Default) REG_SZ out of reg query output", () => {
  const out = `\r\n${CMD_KEY}\r\n    (Default)    REG_SZ    "${EXE}" --files\r\n\r\n`;
  assert.equal(parseDefault(out), `"${EXE}" --files`);
  assert.equal(parseDefault("ERROR: nothing"), null);
});

/** A fake registry behind a fake execFile. */
function fakeReg(initial = {}) {
  const keys = new Map(Object.entries(initial));
  const calls = [];
  const execFile = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const [verb, key] = args;
    if (verb === "query") {
      if (args[2] === "/ve") {
        const v = keys.get(key);
        return v === undefined || v === null ? { code: 1, stdout: "", stderr: "ERROR: unable to find" }
          : { code: 0, stdout: `${key}\r\n    (Default)    REG_SZ    ${v}\r\n`, stderr: "" };
      }
      return keys.has(key) ? { code: 0, stdout: key, stderr: "" } : { code: 1, stdout: "", stderr: "ERROR" };
    }
    if (verb === "add") {
      let k = BASE_KEY;
      for (const part of key.slice(BASE_KEY.length).split("\\").filter(Boolean)) {
        if (!keys.has(k)) keys.set(k, null);
        k = `${k}\\${part}`;
      }
      if (!keys.has(BASE_KEY)) keys.set(BASE_KEY, null);
      if (args[2] === "/ve") keys.set(key, args[6]);
      else if (!keys.has(key)) keys.set(key, null);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "delete") {
      for (const k of [...keys.keys()]) if (k === key || k.startsWith(`${key}\\`)) keys.delete(k);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "?" };
  };
  return { keys, calls, execFile };
}

function stateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-wine-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "desk-wine.json");
}

test("enable needs consent and runs nothing without it", async (t) => {
  const reg = fakeReg();
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, routed: () => true, stateFile: stateFile(t) });
  const res = await wine.enable({});
  assert.equal(res.ok, false);
  assert.match(res.reason, /needs the owner's consent/);
  assert.equal(reg.calls.length, 0);
});

test("enable -> status ours -> restore deletes exactly what enable created", async (t) => {
  const reg = fakeReg({ "HKCU\\Software\\Classes\\CLSID": null });
  const file = stateFile(t);
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, routed: () => true, stateFile: file,
    env: { SystemRoot: "C:\\Windows" } });
  const on = await wine.enable({ consent: true });
  assert.equal(on.ok, true);
  assert.equal(on.createdKey, BASE_KEY);
  assert.equal(reg.keys.get(CMD_KEY), `"${EXE}" --files`);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).createdKey, BASE_KEY);
  for (const c of reg.calls) {
    assert.equal(c.file, path.join("C:\\Windows", "System32", "reg.exe"));
    assert.equal(c.opts.windowsHide, true);
  }
  const st = await wine.status();
  assert.deepEqual({ enabled: st.enabled, ours: st.ours }, { enabled: true, ours: true });
  const off = await wine.restore();
  assert.equal(off.ok, true);
  assert.equal(off.deleted, BASE_KEY);
  assert.equal(reg.keys.has(BASE_KEY), false);
  assert.equal(reg.keys.has("HKCU\\Software\\Classes\\CLSID"), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await wine.status()).enabled, false);
});

test("a foreign Win+E override is refused, never clobbered", async (t) => {
  const reg = fakeReg({ [BASE_KEY]: null, [CMD_KEY]: "\"C:\\Other\\other.exe\"" });
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, routed: () => true, stateFile: stateFile(t) });
  const res = await wine.enable({ consent: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /1 other Win\+E override is set/);
  assert.equal(reg.keys.get(CMD_KEY), "\"C:\\Other\\other.exe\"");
  const restore = await wine.restore();
  assert.equal(restore.ok, false);
  assert.equal(reg.keys.get(CMD_KEY), "\"C:\\Other\\other.exe\"");
});

test("a tampered state file cannot aim reg delete at another key", async (t) => {
  const reg = fakeReg();
  const file = stateFile(t);
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, routed: () => true, stateFile: file });
  await wine.enable({ consent: true });
  fs.writeFileSync(file, JSON.stringify({ createdKey: "HKCU\\Software" }));
  await wine.restore();
  const deletes = reg.calls.filter((c) => c.args[0] === "delete").map((c) => c.args[1]);
  assert.deepEqual(deletes, [CMD_KEY]);
});

test("off Windows the switch says so and runs nothing", async () => {
  const reg = fakeReg();
  const wine = createWinE({ execFile: reg.execFile, platform: "linux", exe: "/usr/bin/awdesk" });
  assert.match((await wine.enable({ consent: true })).reason, /Windows-only/);
  assert.equal((await wine.status()).supported, false);
  assert.equal(reg.calls.length, 0);
});

test("enable refuses until the desk routes --files, and status says routed:false", async (t) => {
  const reg = fakeReg();
  const file = stateFile(t);
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, stateFile: file });
  const res = await wine.enable({ consent: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /^1 launch route missing -- .*nothing changed$/);
  assert.equal(reg.calls.filter((c) => c.args[0] === "add").length, 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await wine.status()).routed, false);
  const routed = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, stateFile: file, routed: () => true });
  assert.equal((await routed.status()).routed, true);
});

test("main.cjs routes --files on first launch AND second-instance before it opens the Win+E gate", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const opensGate = /setFilesLaunchRouted\(\s*true\s*\)/.test(main);
  assert.equal(FILES_FLAG, "--files");
  const firstLaunch = /process\.argv\.includes\(\s*["']--files["']\s*\)\s*\)\s*\{?\s*createFilesWindow\(/.test(main);
  const at = main.indexOf('app.on("second-instance"');
  assert.ok(at > 0, "main.cjs has a second-instance handler");
  const secondInstance = /[^.]argv\.includes\(\s*["']--files["']\s*\)\s*\)\s*\{?\s*createFilesWindow\(/
    .test(main.slice(at, at + 4000));
  // The gate may only open where both routes exist; with neither, the gate stays shut.
  assert.equal(opensGate, firstLaunch && secondInstance,
    `setFilesLaunchRouted(true)=${opensGate} but first-launch=${firstLaunch} second-instance=${secondInstance}`);
});

const OTHER = `"C:\\Other\\other.exe" /new`;

test("restore with a state file still refuses another tool's override and keeps its keys", async (t) => {
  const reg = fakeReg({ [BASE_KEY]: null, [CMD_KEY]: `"${EXE}" --files` });
  const file = stateFile(t);
  fs.writeFileSync(file, JSON.stringify({ version: 1, createdKey: BASE_KEY }));
  // Another tool rewrote the command after Aither enabled it.
  reg.keys.set(CMD_KEY, OTHER);
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, stateFile: file, routed: () => true });
  const res = await wine.restore();
  assert.equal(res.ok, false);
  assert.equal(res.reason, "1 Win+E override is not Aither's -- left as it is");
  assert.equal(reg.calls.filter((c) => c.args[0] === "delete").length, 0);
  assert.equal(reg.keys.has(BASE_KEY), true);
  assert.equal(reg.keys.get(CMD_KEY), OTHER);
  assert.equal(fs.existsSync(file), false);
});

test("a failed second reg add rolls back what enable created and says so", async (t) => {
  const reg = fakeReg({ [BASE_KEY.slice(0, BASE_KEY.lastIndexOf("\\"))]: null });
  const inner = reg.execFile;
  reg.execFile = async (file, args, opts) => (args[0] === "add" && args[2] === "/v"
    ? (reg.calls.push({ file, args, opts }), { code: 1, stdout: "", stderr: "ERROR: Access is denied." })
    : inner(file, args, opts));
  const file = stateFile(t);
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, stateFile: file, routed: () => true });
  const res = await wine.enable({ consent: true });
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.match(res.reason, /Access is denied.*rolled back/);
  assert.doesNotMatch(res.reason, /nothing else changed/);
  const deletes = reg.calls.filter((c) => c.args[0] === "delete").map((c) => c.args[1]);
  assert.deepEqual(deletes, [BASE_KEY]);
  assert.equal(reg.keys.has(BASE_KEY), false);
  assert.equal(reg.keys.has(CMD_KEY), false);
  assert.equal(fs.existsSync(file), false);
});

test("the state file is written BEFORE the first reg add", async (t) => {
  const reg = fakeReg();
  const file = stateFile(t);
  const inner = reg.execFile;
  let stateAtFirstAdd = null;
  reg.execFile = async (f, args, opts) => {
    if (args[0] === "add" && stateAtFirstAdd === null) stateAtFirstAdd = fs.existsSync(file);
    return inner(f, args, opts);
  };
  const wine = createWinE({ execFile: reg.execFile, platform: "win32", exe: EXE, stateFile: file, routed: () => true });
  assert.equal((await wine.enable({ consent: true })).ok, true);
  assert.equal(stateAtFirstAdd, true);
});
