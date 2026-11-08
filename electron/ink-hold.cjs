"use strict";

/**
 * ink-hold.cjs -- hold-to-draw: while the chord (default Ctrl+Alt) is HELD, the
 * screen ink takes the pointer; release it and you are back on the desktop.
 *
 * WHY A POLLER. Electron's globalShortcut reports a chord going DOWN, never coming
 * UP, and the desk does not install keyboard hooks (launcher-core.cjs: "exactly the
 * kind of driver the desk must not add"). So this reads the KEY STATE, not the key
 * stream: one long-lived Windows PowerShell child calls user32 GetAsyncKeyState for
 * the two modifiers every 15 ms and prints a line only when "both down" changes. No
 * hook, no new npm dependency, no keystrokes ever leave the child -- only 0/1. The
 * child exits on its own when the desk's process does (it watches the parent pid),
 * and main kills it on quit.
 *
 * WHY 250 ms. Every desk hotkey is Ctrl+Alt+<key>: holding Ctrl+Alt is also how a
 * chord starts. A hold only counts once both keys stayed down HOLD_MS with no desk
 * hotkey firing (main calls cancel() from every shortcut callback). Ctrl+Alt+D
 * while held latches draw instead (ink-mode.cjs).
 *
 * Choose the chord with AWDESK_INK_HOLD: "ctrl+alt" (default), "ctrl+shift", or
 * "off". AltGr on European layouts IS Ctrl+Alt; a typist who holds AltGr past
 * 250 ms should pick ctrl+shift or off.
 *
 * Pure core (createHoldWatch with an injected `source` and clock) so
 * ink-hold.test.cjs drives it under `node --test`; the PowerShell source is only
 * built on win32.
 */

const HOLD_MS = 250;
const CHORDS = Object.freeze({
  "ctrl+alt": Object.freeze([0x11, 0x12]),
  "ctrl+shift": Object.freeze([0x11, 0x10]),
});

/** The configured chord name, or null when hold-to-draw is off. */
function chordFromEnv(env = process.env) {
  const raw = String(env.AWDESK_INK_HOLD || "ctrl+alt").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "none") return null;
  return CHORDS[raw] ? raw : "ctrl+alt";
}

/** The PowerShell poller's script for a chord: prints 1 / 0 when "all down" changes. */
function pollerScript(chord, parentPid) {
  const keys = CHORDS[chord] || CHORDS["ctrl+alt"];
  const test = keys.map((k) => `(([AwDeskInk.Keys]::GetAsyncKeyState(${k}) -band 0x8000) -ne 0)`).join(" -and ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace AwDeskInk -Name Keys -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int v);'",
    `$parent = [Diagnostics.Process]::GetProcessById(${Math.trunc(Number(parentPid)) || 0})`,
    "$last = -1; $n = 0",
    "while ($true) {",
    `  $s = [int](${test})`,
    "  if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last = $s }",
    "  $n++; if ($n % 64 -eq 0) { $parent.Refresh(); if ($parent.HasExited) { exit 0 } }",
    "  Start-Sleep -Milliseconds 15",
    "}",
  ].join("\n");
}

/**
 * The poller as a source: {on(fn), stop()}. fn(down:boolean) on every change.
 * Returns null off Windows or when the child cannot start.
 */
function powershellSource({ chord = "ctrl+alt", spawn = require("node:child_process").spawn,
  platform = process.platform, pid = process.pid } = {}) {
  if (platform !== "win32") return null;
  const listeners = [];
  let child;
  try {
    const encoded = Buffer.from(pollerScript(chord, pid), "utf16le").toString("base64");
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += String(chunk);
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (line === "1" || line === "0") for (const fn of listeners) fn(line === "1");
    }
  });
  child.on("error", () => { /* no powershell: hold-to-draw is simply absent */ });
  return {
    on: (fn) => listeners.push(fn),
    stop: () => { try { child.kill(); } catch { /* gone */ } },
    pid: child.pid,
  };
}

/**
 * The hold logic over any source.
 * @param {{onHold: () => void, onRelease: () => void, source?: object|null, holdMs?: number,
 *   setTimer?: Function, clearTimer?: Function, env?: object}} opts
 * @returns {{cancel: () => void, stop: () => void, state: () => object}}
 */
function createHoldWatch({ onHold, onRelease, source, holdMs = HOLD_MS, setTimer = setTimeout,
  clearTimer = clearTimeout, env = process.env } = {}) {
  const chord = chordFromEnv(env);
  let src = source;
  if (src === undefined) src = chord ? powershellSource({ chord }) : null;
  let down = false;
  let held = false;
  let consumed = false;
  let timer = null;
  const fire = (fn) => { try { if (fn) fn(); } catch { /* the overlay owns its own failures */ } };

  function onState(isDown) {
    if (isDown === down) return;
    down = isDown;
    if (down) {
      consumed = false;
      timer = setTimer(() => {
        timer = null;
        if (down && !consumed) { held = true; fire(onHold); }
      }, holdMs);
      if (timer && timer.unref) timer.unref();
      return;
    }
    if (timer) { clearTimer(timer); timer = null; }
    if (held) { held = false; fire(onRelease); }
  }
  if (src && typeof src.on === "function") src.on(onState);

  return {
    /** A desk hotkey fired: this press was a chord, not a hold. */
    cancel() {
      consumed = true;
      if (timer) { clearTimer(timer); timer = null; }
      if (held) { held = false; fire(onRelease); }
    },
    stop() { if (src && src.stop) src.stop(); },
    state: () => ({ chord, active: Boolean(src), down, held }),
    /** Test seam: feed a key state as the poller would. */
    __feed: onState,
  };
}

module.exports = { HOLD_MS, CHORDS, chordFromEnv, pollerScript, powershellSource, createHoldWatch };
