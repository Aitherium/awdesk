"use strict";

/**
 * copilot-key.cjs -- the Copilot key (LWin + LShift + F23) opens the Aither bar.
 * The decision table is asserted here in JS, and the C# hook is held to the same
 * constants and branches; the lifecycle runs against a fake child process.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const ck = require("./copilot-key.cjs");

const F23 = ck.VK.F23;
const held = { win: true, shift: true, swallowing: false };

test("decide: Win+Shift+F23 fires once and swallows its key-up; everything else passes", () => {
  const down = ck.decide({ vk: F23, down: true }, held);
  assert.deepEqual(down, { action: "fire", swallowing: true });
  // auto-repeat of the held key: swallowed, not fired again
  assert.deepEqual(ck.decide({ vk: F23, down: true }, { ...held, swallowing: true }), { action: "swallow", swallowing: true });
  // its key-up is swallowed even if Win/Shift were released first
  assert.deepEqual(ck.decide({ vk: F23, down: false }, { win: false, shift: false, swallowing: true }), { action: "swallow", swallowing: false });
  // F23 without the chord (a macro pad, a remap) is someone else's key
  assert.equal(ck.decide({ vk: F23, down: true }, { win: true, shift: false, swallowing: false }).action, "pass");
  assert.equal(ck.decide({ vk: F23, down: true }, { win: false, shift: true, swallowing: false }).action, "pass");
  assert.equal(ck.decide({ vk: F23, down: false }, { win: true, shift: true, swallowing: false }).action, "pass");
  // other keys, and injected events (the mask key), always pass
  for (const vk of [ck.VK.LWIN, ck.VK.LSHIFT, 0x41, ck.VK.MASK]) assert.equal(ck.decide({ vk, down: true }, held).action, "pass");
  assert.equal(ck.decide({ vk: F23, down: true, injected: true }, held).action, "pass");
});

test("the C# hook uses the same keys and the same branches", () => {
  const cs = ck.HOOK_CS;
  const hex = (n) => `0x${n.toString(16).toUpperCase()}`;
  for (const [name, code] of [["VK_LWIN", ck.VK.LWIN], ["VK_RWIN", ck.VK.RWIN], ["VK_LSHIFT", ck.VK.LSHIFT], ["VK_RSHIFT", ck.VK.RSHIFT],
    ["VK_SHIFT", ck.VK.SHIFT], ["VK_F23", ck.VK.F23], ["VK_MASK", ck.VK.MASK]]) {
    assert.match(cs, new RegExp(`${name} = ${hex(code)}\\b`), `${name} must be ${hex(code)}`);
  }
  assert.match(cs, /WH_KEYBOARD_LL = 13/);
  assert.match(cs, /\(k\.flags & LLKHF_INJECTED\) == 0 && k\.vk == VK_F23/, "injected events pass, only F23 is judged");
  assert.match(cs, /if \(swallowing\) return \(IntPtr\)1;/, "auto-repeat is swallowed");
  assert.match(cs, /if \(win && shift\) \{\s*swallowing = true;\s*keybd_event\(\(byte\)VK_MASK/, "a fire taps the mask key so Start does not open");
  assert.match(cs, /Console\.Out\.WriteLine\("COPILOT"\)/);
  assert.match(cs, /else if \(swallowing\) \{\s*swallowing = false;\s*return \(IntPtr\)1;/, "the key-up of a swallowed press is swallowed");
  assert.match(cs, /return CallNextHookEx\(hook, code, wParam, lParam\);/, "every other key goes on untouched");
  assert.match(cs, /Console\.In\.ReadLine\(\) != null[\s\S]*Environment\.Exit\(0\)/, "the hook exits when the desk's pipe closes");
  assert.doesNotMatch(cs, /File\.|StreamWriter|GetKeyboardState|ToUnicode/, "it keeps nothing and reads no text");
  // The script is one here-string: a line starting with '@ would end it early.
  assert.doesNotMatch(cs, /^'@/m);
  const script = ck.helperScript();
  assert.match(script, /Add-Type -TypeDefinition @'/);
  assert.equal(Buffer.from(ck.encoded(script), "base64").toString("utf16le"), script);
});

function fakeSpawn() {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { ended: false, end() { this.ended = true; } };
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ exe, args, opts, child });
    return child;
  };
  return { spawn, calls };
}

test("lifecycle: READY = running, each COPILOT line opens the bar, stop() closes the pipe and kills the hook", () => {
  const { spawn, calls } = fakeSpawn();
  let presses = 0;
  const key = ck.createCopilotKey({ onPress: () => { presses += 1; }, spawn, platform: "win32", env: { SystemRoot: "C:\\Windows" } });
  assert.equal(key.start().reason, "starting");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(calls[0].args.includes("-EncodedCommand"));
  assert.equal(calls[0].opts.windowsHide, true);
  key.start();
  assert.equal(calls.length, 1, "one hook, however often start() is called");
  const child = calls[0].child;
  child.stdout.emit("data", "READY\r\nCOPI");
  assert.equal(key.status().running, true);
  child.stdout.emit("data", "LOT\r\nCOPILOT\n");
  assert.equal(presses, 2);
  key.stop();
  assert.equal(child.stdin.ended, true);
  assert.equal(child.killed, true);
  child.emit("exit", 0);
  assert.deepEqual(key.status(), { running: false, reason: "off" });
  assert.equal(calls.length, 1, "a stopped hook is not restarted");
});

test("a crashed hook restarts (bounded); a refused hook names the PowerToys fallback; off Windows it says why", () => {
  const { spawn, calls } = fakeSpawn();
  const timers = [];
  const key = ck.createCopilotKey({ onPress: () => {}, spawn, platform: "win32", setTimeoutImpl: (fn) => timers.push(fn) });
  key.start();
  calls[0].child.stdout.emit("data", "FAILED 5\n");
  assert.match(key.status().reason, /refused/);
  assert.match(key.status().fallback, /PowerToys.*Win \(Left\) \+ Shift \(Left\) \+ F23 → Alt \+ Space/);
  calls[0].child.emit("exit", 3);
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(calls.length, 2);
  for (let i = 0; i < 5; i += 1) { calls[calls.length - 1].child.emit("exit", 1); if (timers.length) timers.shift()(); }
  assert.ok(calls.length <= 4, `restarts are bounded (${calls.length} launches)`);

  const mac = ck.createCopilotKey({ onPress: () => {}, spawn: () => { throw new Error("must not spawn"); }, platform: "darwin" });
  assert.match(mac.start().reason, /Windows-only/);
});
