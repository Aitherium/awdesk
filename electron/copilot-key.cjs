"use strict";

/**
 * copilot-key.cjs -- the keyboard's Copilot key opens the desk's Alt+Space bar, not
 * Microsoft Copilot (owner 2026-11-16).
 *
 * The key is not a key of its own: Windows 11 keyboards send LWin + LShift + F23.
 * Windows' "Customize Copilot key" setting only lists MSIX-packaged, signed apps, and
 * the desk runs unpackaged from source, so the setting cannot point at it. Electron's
 * globalShortcut cannot register F23 with the Win modifier either (the shell owns Win
 * chords). So the desk runs ONE low-level keyboard hook (WH_KEYBOARD_LL) in a hidden
 * PowerShell child that compiles the small C# below with Add-Type -- no native module,
 * no new dependency, nothing installed. The hook:
 *
 *   - swallows F23 down/up while a Win key and a Shift key are held, so Copilot never
 *     sees the chord, and prints COPILOT on stdout for each press;
 *   - taps the unassigned virtual key 0xE8 once per press, so releasing Win does not
 *     open the Start menu (the AutoHotkey "menu mask key" trick);
 *   - ignores injected events (its own mask key included) and passes every other key
 *     through untouched -- it reads no text, keeps nothing, logs nothing;
 *   - exits when its stdin closes, so a desk that quits or crashes never leaves a hook
 *     behind; stop() also kills it on before-quit.
 *
 * The setting is `copilot-key.toggle` (default on), kept in intent-bar.json. When the
 * hook cannot start (not Windows, PowerShell blocked), status() says why and
 * FALLBACK names the PowerToys Keyboard Manager remap that does the same.
 *
 * decide() is the hook's decision table in JS; HOOK_CS implements the same table and
 * copilot-key.test.cjs holds the two together (same constants, same branches).
 */

const VK = Object.freeze({ LWIN: 0x5b, RWIN: 0x5c, SHIFT: 0x10, LSHIFT: 0xa0, RSHIFT: 0xa1, F23: 0x86, MASK: 0xe8 });

const FALLBACK = "PowerToys → Keyboard Manager → Remap a shortcut: Win (Left) + Shift (Left) + F23 → Alt + Space. "
  + "Then the Copilot key opens the Aither bar even without the desk's hook.";

/**
 * The hook's decision for one key event.
 * @param {{vk:number, down:boolean, injected?:boolean}} ev
 * @param {{win:boolean, shift:boolean, swallowing:boolean}} state  modifiers held + whether
 *        this F23 press's key-down was swallowed (its key-up must be swallowed too).
 * @returns {{action:"pass"|"swallow"|"fire", swallowing:boolean}}
 *          "fire" = swallow AND open the bar (and tap the mask key).
 */
function decide(ev, state) {
  const s = state || { win: false, shift: false, swallowing: false };
  if (!ev || ev.injected) return { action: "pass", swallowing: s.swallowing };
  if (ev.vk !== VK.F23) return { action: "pass", swallowing: s.swallowing };
  if (ev.down) {
    if (s.swallowing) return { action: "swallow", swallowing: true }; // auto-repeat of a held key
    if (s.win && s.shift) return { action: "fire", swallowing: true };
    return { action: "pass", swallowing: false };
  }
  if (s.swallowing) return { action: "swallow", swallowing: false };
  return { action: "pass", swallowing: false };
}

/** The C# hook. Same constants and branches as decide(). */
const HOOK_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class AitherCopilotHook {
  const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
  const int VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_SHIFT = 0x10, VK_F23 = 0x86, VK_MASK = 0xE8;
  const uint LLKHF_INJECTED = 0x10, KEYEVENTF_KEYUP = 0x2;
  [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
  delegate IntPtr Proc(int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, Proc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
  static Proc keep; static IntPtr hook; static bool swallowing;
  static bool Held(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      KBD k = (KBD)Marshal.PtrToStructure(lParam, typeof(KBD));
      int msg = wParam.ToInt32();
      bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
      bool up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
      if ((k.flags & LLKHF_INJECTED) == 0 && k.vk == VK_F23 && (down || up)) {
        bool win = Held(VK_LWIN) || Held(VK_RWIN);
        bool shift = Held(VK_LSHIFT) || Held(VK_RSHIFT) || Held(VK_SHIFT);
        if (down) {
          if (swallowing) return (IntPtr)1;
          if (win && shift) {
            swallowing = true;
            keybd_event((byte)VK_MASK, 0, 0, UIntPtr.Zero);
            keybd_event((byte)VK_MASK, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            Console.Out.WriteLine("COPILOT");
            Console.Out.Flush();
            return (IntPtr)1;
          }
        } else if (swallowing) {
          swallowing = false;
          return (IntPtr)1;
        }
      }
    }
    return CallNextHookEx(hook, code, wParam, lParam);
  }
  public static void Run() {
    new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();
    keep = OnKey;
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, keep, GetModuleHandle("user32.dll"), 0);
    if (hook == IntPtr.Zero) { Console.Out.WriteLine("FAILED " + Marshal.GetLastWin32Error()); Console.Out.Flush(); Environment.Exit(3); }
    Console.Out.WriteLine("READY"); Console.Out.Flush();
    MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    UnhookWindowsHookEx(hook);
  }
}
`;

/** The PowerShell that compiles and runs the hook. */
function helperScript() {
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${HOOK_CS}\n'@\n[AitherCopilotHook]::Run()\n`;
}

/** -EncodedCommand wants UTF-16LE base64. */
function encoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powershellPath(env = process.env) {
  const root = env.SystemRoot || "C:\\Windows";
  return require("node:path").win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The hook's lifecycle. `onPress` opens the bar. Restarts a crashed helper up to
 * MAX_RESTARTS times; stop() kills it and stops restarting.
 */
function createCopilotKey({
  onPress, spawn = require("node:child_process").spawn, platform = process.platform, env = process.env,
  log = () => {}, setTimeoutImpl = setTimeout,
} = {}) {
  if (typeof onPress !== "function") throw new Error("the Copilot key needs onPress");
  const MAX_RESTARTS = 3;
  let child = null;
  let wanted = false;
  let restarts = 0;
  let state = { running: false, reason: "off" };

  function launch() {
    if (platform !== "win32") { state = { running: false, reason: `the Copilot key hook is Windows-only (this is ${platform})` }; return state; }
    let proc;
    try {
      proc = spawn(powershellPath(env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
        "-EncodedCommand", encoded(helperScript())], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      state = { running: false, reason: `PowerShell did not start: ${String((error && error.message) || error)}`, fallback: FALLBACK };
      return state;
    }
    child = proc;
    state = { running: false, reason: "starting" };
    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "READY") { state = { running: true, reason: "" }; restarts = 0; log("copilot key hook ready"); }
        else if (line === "COPILOT") { try { onPress(); } catch (error) { log(`copilot key: ${String((error && error.message) || error)}`); } }
        else if (line.startsWith("FAILED")) state = { running: false, reason: `the hook was refused (${line})`, fallback: FALLBACK };
      }
    });
    let err = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { err = (err + chunk).slice(-600); });
    proc.on("error", (error) => { state = { running: false, reason: String((error && error.message) || error), fallback: FALLBACK }; });
    proc.on("exit", (code) => {
      if (child === proc) child = null;
      if (!wanted) { state = { running: false, reason: "off" }; return; }
      state = { running: false, reason: `the hook exited (${code})${err ? `: ${err.trim().split("\n").pop()}` : ""}`, fallback: FALLBACK };
      if (restarts < MAX_RESTARTS) {
        restarts += 1;
        setTimeoutImpl(() => { if (wanted && !child) launch(); }, 2000 * restarts);
      }
    });
    return state;
  }

  function start() {
    wanted = true;
    if (child) return state;
    return launch();
  }
  function stop() {
    wanted = false;
    const proc = child;
    child = null;
    if (proc) {
      try { proc.stdin.end(); } catch { /* already closed */ }
      try { proc.kill(); } catch { /* already gone */ }
    }
    state = { running: false, reason: "off" };
    return state;
  }
  function set(on) { return on ? start() : stop(); }
  return { start, stop, set, status: () => ({ ...state }), isRunning: () => Boolean(child) };
}

module.exports = { FALLBACK, HOOK_CS, VK, createCopilotKey, decide, encoded, helperScript, powershellPath };
