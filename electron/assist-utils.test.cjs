"use strict";

/** assist-utils: integrate the owner's PowerToys / Sysinternals, never reimplement; no destructive verb; logged. */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const u = require("./assist-utils.cjs");

const PT = "C:\\Program Files\\PowerToys";
const SI = "C:\\Sysinternals";
const FILES = new Set([
  `${PT}\\PowerToys.exe`, `${PT}\\PowerToys.PowerOCR.exe`, `${PT}\\PowerToys.Awake.exe`, `${PT}\\FileLocksmithCLI.exe`,
  `${PT}\\WinUI3Apps\\PowerToys.ColorPickerUI.exe`, `${PT}\\WinUI3Apps\\PowerToys.ImageResizerCLI.exe`, `${PT}\\PowerToys.AlwaysOnTop.exe`,
  `${SI}\\pslist64.exe`, `${SI}\\handle64.exe`, `${SI}\\procexp64.exe`,
  "C:\\Users\\me\\a.png", "C:\\Users\\me\\doc.txt",
]);
const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "" };
const existsSync = (p) => FILES.has(String(p));

function rig(extra = {}) {
  const calls = [];
  const spawned = [];
  const records = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const handler = extra.exec || (() => ({ code: 0, stdout: "" }));
    const r = handler(file, args, opts) || { code: 0, stdout: "" };
    cb(r.code ? Object.assign(new Error("fail"), { code: r.code, killed: Boolean(r.killed) }) : null, r.stdout || "", r.stderr || "");
  };
  const spawn = (file, args, opts) => { const child = { file, args, opts, killed: false, kill() { this.killed = true; }, unref() {}, on() {} }; spawned.push(child); return child; };
  const utils = u.createAssistUtils({
    env, platform: "win32", existsSync, execFile, spawn,
    clipboard: extra.clipboard, caret: extra.caret, log: extra.log === false ? null : { append: (r) => { records.push(r); return { ok: true }; } },
    sleep: async () => {}, now: extra.now || (() => 1000),
  });
  return { utils, calls, spawned, records };
}

test("list marks what is installed and says what is missing, never faking a tool", () => {
  const all = rig().utils.list();
  assert.ok(all.every((x) => x.available));
  const none = u.createAssistUtils({ env: { ProgramFiles: "C:\\nope", PATH: "" }, platform: "win32", existsSync: () => false }).list();
  assert.ok(none.every((x) => !x.available && /Needs/.test(x.missing)));
  const linux = u.createAssistUtils({ platform: "linux" }).list();
  assert.ok(linux.every((x) => !x.available && x.missing === "Windows only"));
});

test("PowerToys is found in WinUI3Apps too; Sysinternals via its dir", () => {
  assert.equal(u.findTool(["PowerToys.ColorPickerUI.exe"], u.powerToysDirs(env), existsSync), `${PT}\\WinUI3Apps\\PowerToys.ColorPickerUI.exe`);
  assert.equal(u.findTool(["pslist64.exe"], u.sysinternalsDirs(env), existsSync), `${SI}\\pslist64.exe`);
  assert.equal(u.findTool(["nope.exe"], u.sysinternalsDirs(env), existsSync), null);
});

test("the PowerToys event names are a fixed allow-list and the signal script opens only the env-named event", () => {
  for (const name of Object.values(u.PT_EVENTS)) assert.match(name, /^Local\\[A-Za-z]+Event-[0-9a-f-]{36}$/);
  assert.match(u.SIGNAL_SCRIPT, /OpenExisting\(\$env:AWDESK_PT_EVENT\)/);
  assert.match(u.SIGNAL_SCRIPT, /exit 3/);
});

test("pathFromSelection accepts only an existing absolute drive path: no UNC-verbatim, no .., no wildcard", () => {
  assert.equal(u.pathFromSelection('"C:\\Users\\me\\a.png"', existsSync), "C:\\Users\\me\\a.png");
  assert.equal(u.pathFromSelection("C:\\Users\\me\\doc.txt\nsecond line", existsSync), "C:\\Users\\me\\doc.txt");
  assert.equal(u.pathFromSelection("\\\\?\\C:\\Users\\me\\a.png", existsSync), null);
  assert.equal(u.pathFromSelection("C:\\Users\\me\\..\\me\\a.png", existsSync), null);
  assert.equal(u.pathFromSelection("C:\\Users\\*\\a.png", existsSync), null);
  assert.equal(u.pathFromSelection("relative\\a.png", existsSync), null);
  assert.equal(u.pathFromSelection("C:\\Users\\me\\missing.png", existsSync), null);
});

test("duration parsing: minutes by default, hours and seconds, capped at 24 h", () => {
  assert.equal(u.parseDuration("30"), 1800);
  assert.equal(u.parseDuration("2h"), 7200);
  assert.equal(u.parseDuration("45s"), 45);
  assert.equal(u.parseDuration("25h"), null);
  assert.equal(u.parseDuration("0"), null);
  assert.equal(u.parseDuration("1; calc"), null);
});

test("procinfo runs pslist -x on the captured pid as an argv array, and refuses a bogus pid", async () => {
  const r = rig({ exec: () => ({ stdout: "Name  Pid\nnotepad 4242\n" }) });
  const ok = await r.utils.run("procinfo", { pid: 4242, app: "notepad" });
  assert.ok(ok.ok);
  assert.match(ok.text, /notepad 4242/);
  assert.equal(r.calls[0].file, `${SI}\\pslist64.exe`);
  assert.deepEqual(r.calls[0].args, ["-accepteula", "-nobanner", "-x", "4242"]);
  assert.equal(r.calls[0].opts.shell, false);
  assert.equal((await r.utils.run("procinfo", { pid: "4242; calc" })).ok, false);
  assert.equal((await r.utils.run("procinfo", { pid: 2 })).ok, false);
});

test("locks: File Locksmith JSON becomes a process list; handle is the fallback; a path is required", async () => {
  const json = JSON.stringify({ processes: [{ pid: 7, name: "winword.exe", user: "me" }] });
  const r = rig({ exec: (file) => (/FileLocksmith/.test(file) ? { stdout: json } : { stdout: "" }) });
  const res = await r.utils.run("locks", { selection: "C:\\Users\\me\\doc.txt" });
  assert.match(res.text, /winword\.exe \(pid 7, me\)/);
  assert.deepEqual(r.calls[0].args, ["--json", "C:\\Users\\me\\doc.txt"]);
  assert.equal((await r.utils.run("locks", { selection: "no path here" })).ok, false);
  const none = rig({ exec: (file) => (/FileLocksmith/.test(file) ? { stdout: '{"processes":[]}' } : { stdout: "" }) });
  assert.match((await none.utils.run("locks", { selection: "C:\\Users\\me\\doc.txt" })).text, /Nothing has doc\.txt open/);
  const slow = rig({ exec: () => ({ code: 143, killed: true }) });
  assert.match((await slow.utils.run("locks", { selection: "C:\\Users\\me\\doc.txt" })).error, /took too long/);
  const fallback = rig({ exec: (file) => (/FileLocksmith/.test(file) ? { stdout: "garbage" } : { stdout: "explorer.exe pid: 9 type: File  C: doc.txt" }) });
  const fb = await fallback.utils.run("locks", { selection: "C:\\Users\\me\\doc.txt" });
  assert.match(fb.note, /Sysinternals handle/);
  assert.deepEqual(fallback.calls[1].args.slice(0, 2), ["-accepteula", "-nobanner"]);
});

test("resize never replaces the original, takes an integer width, and wants an image", async () => {
  const r = rig({ exec: () => ({ stdout: "Done" }) });
  const ok = await r.utils.run("resize", { selection: "C:\\Users\\me\\a.png", arg: "800" });
  assert.ok(ok.ok);
  const args = r.calls[0].args;
  assert.deepEqual(args, ["--width", "800", "--unit", "Pixel", "--fit", "Fit", "--shrink-only", "C:\\Users\\me\\a.png"]);
  assert.equal(args.includes("--replace"), false);
  assert.equal((await r.utils.run("resize", { selection: "C:\\Users\\me\\a.png", arg: "8; del" })).ok, false);
  assert.equal((await r.utils.run("resize", { selection: "C:\\Users\\me\\doc.txt" })).ok, false);
});

test("awake starts PowerToys.Awake with a bounded time limit; awake-off ends only OUR child", async () => {
  const r = rig();
  const res = await r.utils.run("awake", { arg: "2h" });
  assert.ok(res.ok);
  assert.deepEqual(r.spawned[0].args, ["--time-limit", "7200", "--display-on"]);
  assert.equal((await r.utils.run("awake-off")).ok, true);
  assert.equal(r.spawned[0].killed, true);
  assert.match((await r.utils.run("awake-off")).note, /no Awake running/);
});

test("ocr signals the Text Extractor event, then returns the NEW clipboard text", async () => {
  let reads = 0;
  const clip = { readText: () => { reads += 1; return reads < 4 ? "old" : "hello from the screen"; } };
  const r = rig({ clipboard: clip });
  const res = await r.utils.run("ocr", {});
  assert.ok(res.ok);
  assert.equal(res.text, "hello from the screen");
  const sig = r.calls.find((c) => c.file === "powershell.exe");
  assert.equal(sig.opts.env.AWDESK_PT_EVENT, u.PT_EVENTS.ocr);
});

test("a missing PowerToys event starts the owner's runner once, retries, and says so if still absent", async () => {
  let attempts = 0;
  const r = rig({ exec: () => { attempts += 1; return attempts < 4 ? { code: 3 } : { code: 0 }; } });
  const res = await r.utils.signal(u.PT_EVENTS.color);
  assert.ok(res.ok && res.startedRunner);
  assert.equal(r.spawned[0].file, `${PT}\\PowerToys.exe`);
  const dead = rig({ exec: () => ({ code: 3 }) });
  const bad = await dead.utils.signal(u.PT_EVENTS.color);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /PowerToys did not answer/);
});

test("ontop focuses the captured window (no keys), then pins; no window means no pin", async () => {
  const focused = [];
  const r = rig({ caret: { focus: async (a) => { focused.push(a.hwnd); return { ok: true }; } } });
  let hidden = false;
  const res = await r.utils.run("ontop", { hwnd: 777, hide: () => { hidden = true; } });
  assert.ok(res.ok && hidden);
  assert.deepEqual(focused, [777]);
  assert.equal((await r.utils.run("ontop", { hwnd: 0 })).ok, false);
});

test("every run is logged before and after; a log that cannot be written refuses the run", async () => {
  const r = rig({ exec: () => ({ stdout: "x" }) });
  await r.utils.run("procinfo", { pid: 4242, app: "notepad" });
  assert.deepEqual(r.records.map((x) => x.outcome), ["started", "ok"]);
  assert.equal(r.records[0].verb, "util:procinfo");
  const refusing = u.createAssistUtils({ env, platform: "win32", existsSync, execFile: () => assert.fail("must not run"), spawn: () => assert.fail("must not run"), log: { append: () => ({ ok: false, error: "disk full" }) } });
  const res = await refusing.run("procinfo", { pid: 4242 });
  assert.equal(res.ok, false);
  assert.match(res.error, /action log is not writable/);
});

test("nothing destructive is on the menu: no kill, no replace, no handle close", () => {
  const src = require("node:fs").readFileSync(path.join(__dirname, "assist-utils.cjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /"--kill"|"--replace"|"-c"|"-y"|pskill|sdelete|taskkill/);
  assert.equal(new Set(["procexp", "locks"]).size, 2);
});

test("an unknown utility, a tool that is gone, and a non-Windows host are stated errors", async () => {
  const r = rig();
  assert.equal((await r.utils.run("format-c")).ok, false);
  const gone = u.createAssistUtils({ env, platform: "win32", existsSync: () => false });
  assert.match((await gone.run("color")).error, /Needs PowerToys/);
  assert.match((await u.createAssistUtils({ platform: "linux" }).run("color")).error, /Windows only/);
});
