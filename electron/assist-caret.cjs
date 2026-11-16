"use strict";

/**
 * assist-caret.cjs -- find the caret in ANY Windows app, read the field and selection
 * around it, and put text back (insert / replace) with an undo.
 *
 * Read side: Windows UI Automation, the same technique as selection-reader.cjs -- no key
 * is injected and the clipboard is untouched. It returns where the caret is (so the pop-up
 * opens beside it), the selection, the field's text so far, and whether the focused
 * element is a PASSWORD field. A password field makes `snapshot()` return
 * {sensitive:true} and NOTHING else: assist-core refuses to build a prompt from it.
 *
 * Write side: the only portable way into an arbitrary app's text box is paste. So:
 *   1. the caller saves the clipboard (injected, Electron's clipboard: text, html, image),
 *   2. the result goes on the clipboard,
 *   3. the target window is re-focused and Ctrl+V is sent to it (System.Windows.Forms
 *      SendKeys, the one place this module injects a key -- on the owner's explicit
 *      "Accept", never on open),
 *   4. the clipboard is restored.
 * Undo re-focuses the same window and sends Ctrl+Z. The chord is chosen inside the
 * worker from the words "paste" / "undo"; no caller can hand it arbitrary key text.
 * A window that is gone or cannot be focused gets NO keys: a stale pop-up must never
 * type into another app.
 *
 * ONE long-lived PowerShell worker (measured: a cold per-call run was 5.4 s because the
 * C# helper and UI Automation compile each time; the warm worker answers in well under a
 * second). Windows only; elsewhere every method resolves {ok:false, reason:"unsupported"}
 * and the pop-up falls back to Copy. Never rejects.
 */

const TIMEOUT_MS = 8000;
const FIELD_MAX = 6000;
const SELECTION_MAX = 12000;

// Line protocol on stdin, one JSON line back per command:
//   snap <comma-separated pids to skip>   -> the snapshot
//   keys <hwnd> <paste|undo|focus>        -> focus that window, send ONE chord (focus: none)
const WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -Namespace AwAssist -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct GTI { public int cb, flags; public IntPtr act, focus, capture, menu, move, caret; public RECT rc; }
[DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GTI i);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref System.Drawing.Point p);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
'@
$A = [System.Windows.Automation.AutomationElement]
function Snap([string]$skiplist) {
  $out = @{ ok = $true; sensitive = $false; canInsert = $false; editable = $false; selection = ''; field = ''; fieldLabel = ''; app = ''; title = ''; hwnd = 0; pid = 0; caret = $null }
  $skip = @{}
  foreach ($p in ($skiplist -split ',')) { if ($p) { $skip[[int]$p] = 1 } }
  try {
    $fg = [AwAssist.Win]::GetForegroundWindow()
    $out.hwnd = [int64]$fg
    [uint32]$fpid = 0
    $tid = [AwAssist.Win]::GetWindowThreadProcessId($fg, [ref]$fpid)
    $out.pid = [int]$fpid
    $sb = New-Object System.Text.StringBuilder 256
    [void][AwAssist.Win]::GetWindowTextW($fg, $sb, 256)
    $out.title = $sb.ToString()
    try { $out.app = (Get-Process -Id $fpid -ErrorAction Stop).ProcessName } catch {}
    $gti = New-Object AwAssist.Win+GTI
    $gti.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($gti)
    if ([AwAssist.Win]::GetGUIThreadInfo($tid, [ref]$gti) -and $gti.caret -ne [IntPtr]::Zero) {
      $pt = New-Object System.Drawing.Point $gti.rc.L, $gti.rc.T
      if ([AwAssist.Win]::ClientToScreen($gti.caret, [ref]$pt)) { $out.caret = @{ x = $pt.X; y = $pt.Y; h = ($gti.rc.B - $gti.rc.T); via = 'caret' } }
    }
    $f = $A::FocusedElement
    if ($f -and -not $skip.ContainsKey([int]$f.Current.ProcessId)) {
      if ($f.Current.IsPassword) { $out.sensitive = $true }
      $ct = $f.Current.ControlType.ProgrammaticName
      $nm = ($f.Current.Name + '')
      $out.fieldLabel = $nm.Substring(0, [Math]::Min(120, $nm.Length))
      $out.editable = ($ct -eq 'ControlType.Edit' -or $ct -eq 'ControlType.Document')
      $out.canInsert = ($out.editable -or $f.Current.IsKeyboardFocusable)
      if (-not $out.sensitive) {
        $pat = $null
        if ($f.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) {
          $r = $pat.GetSelection()
          if ($r -and $r.Length -gt 0) { $out.selection = (($r | ForEach-Object { $_.GetText(${SELECTION_MAX}) }) -join [Environment]::NewLine) }
          $out.field = $pat.DocumentRange.GetText(${FIELD_MAX})
          if (-not $out.caret -and $r -and $r.Length -gt 0) {
            $b = $r[0].GetBoundingRectangles()
            if ($b -and $b.Length -gt 0) { $out.caret = @{ x = [int]$b[0].Left; y = [int]$b[0].Top; h = [int]$b[0].Height; via = 'selection' } }
          }
        } else {
          $vp = $null
          if ($f.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $out.field = ($vp.Current.Value + '') }
        }
      }
      if (-not $out.caret) {
        $rc = $f.Current.BoundingRectangle
        if (-not $rc.IsEmpty) { $out.caret = @{ x = [int]$rc.Left; y = [int]$rc.Top; h = [int]$rc.Height; via = 'element' } }
      }
    }
  } catch { $out.ok = $false; $out.error = $_.Exception.Message }
  return ($out | ConvertTo-Json -Compress -Depth 4)
}
function Keys([string]$hwnd, [string]$word) {
  $chord = switch ($word) { 'paste' { '^v' } 'undo' { '^z' } 'focus' { '' } default { $null } }
  if ($null -eq $chord) { return '{"ok":false,"reason":"refused-chord"}' }
  $h = [IntPtr][int64]$hwnd
  if (-not [AwAssist.Win]::IsWindow($h)) { return '{"ok":false,"reason":"window-gone"}' }
  if ([AwAssist.Win]::IsIconic($h)) { [void][AwAssist.Win]::ShowWindow($h, 9) }
  [void][AwAssist.Win]::SetForegroundWindow($h)
  $ok = $false
  for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 40; if ([AwAssist.Win]::GetForegroundWindow() -eq $h) { $ok = $true; break } }
  if (-not $ok) { return '{"ok":false,"reason":"could-not-focus"}' }
  Start-Sleep -Milliseconds 80
  if ($chord) { [System.Windows.Forms.SendKeys]::SendWait($chord) }
  return '{"ok":true}'
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ')
  $res = '{"ok":false,"reason":"bad-command"}'
  try {
    if ($parts[0] -eq 'snap') { $res = Snap ($parts[1] + '') }
    elseif ($parts[0] -eq 'keys' -and $parts.Length -ge 3) { $res = Keys $parts[1] $parts[2] }
  } catch { $res = '{"ok":false,"reason":"worker-error"}' }
  [Console]::Out.WriteLine($res); [Console]::Out.Flush()
}
`;

/** Parse the snapshot JSON line. Pure. A password field yields ONLY {sensitive:true}. */
function parseSnapshot(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  let o;
  try { o = JSON.parse(line); } catch { return { ok: false, reason: "unreadable" }; }
  if (!o || typeof o !== "object") return { ok: false, reason: "unreadable" };
  const base = { ok: o.ok !== false, hwnd: Number(o.hwnd) || 0, pid: Number(o.pid) || 0, app: String(o.app || ""), title: String(o.title || "") };
  if (o.sensitive === true) return { ...base, sensitive: true };
  const caret = o.caret && Number.isFinite(Number(o.caret.x)) && Number.isFinite(Number(o.caret.y))
    ? { x: Math.round(Number(o.caret.x)), y: Math.round(Number(o.caret.y)), h: Math.max(0, Math.round(Number(o.caret.h) || 0)), via: String(o.caret.via || "") }
    : null;
  return {
    ...base, sensitive: false, caret,
    selection: String(o.selection || "").slice(0, SELECTION_MAX),
    field: String(o.field || "").slice(0, FIELD_MAX),
    fieldLabel: String(o.fieldLabel || ""),
    canInsert: o.canInsert === true,
    editable: o.editable === true,
    error: o.ok === false ? String(o.error || "") : undefined,
  };
}

/** Only these chords may ever be sent (paste, undo). Pure. */
function keysFor(action) {
  if (action === "paste") return "^v";
  if (action === "undo") return "^z";
  if (action === "focus") return "";
  return null;
}

/**
 * The worker's wire: line in, line out, one request at a time. `spawn` is injected.
 * A worker that dies or answers late is killed and respawned on the next request.
 */
function createWorker({ spawn, timeoutMs = TIMEOUT_MS, startMs = 20000 }) {
  let child = null;
  let buffer = "";
  let waiter = null;
  let ready = null;
  let queue = Promise.resolve();
  function drop(reason) {
    const w = waiter;
    waiter = null;
    if (child) { try { child.kill(); } catch { /* gone */ } }
    child = null;
    ready = null;
    buffer = "";
    if (w) w.resolve({ ok: false, reason });
  }
  function start() {
    if (ready) return ready;
    ready = new Promise((resolve) => {
      let proc;
      try {
        proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", "-"],
          { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      } catch { resolve(false); return; }
      child = proc;
      let started = false;
      const timer = setTimeout(() => { if (!started) { drop("worker-start-timeout"); resolve(false); } }, startMs);
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!line) continue;
          if (!started) { started = true; clearTimeout(timer); resolve(true); continue; }
          const w = waiter;
          waiter = null;
          if (w) w.resolve({ line });
        }
      });
      proc.on("exit", () => { if (child === proc) drop("worker-exited"); });
      proc.on("error", () => { if (child === proc) drop("worker-error"); resolve(false); });
      try { proc.stdin.write(`${WORKER_SCRIPT}\n`); } catch { drop("worker-write"); resolve(false); }
    });
    return ready;
  }
  function request(command) {
    const run = queue.then(async () => {
      if (!(await start())) return { ok: false, reason: "worker-unavailable" };
      return new Promise((resolve) => {
        const timer = setTimeout(() => drop("worker-timeout"), timeoutMs);
        waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); } };
        try { child.stdin.write(`${command}\n`); } catch { drop("worker-write"); }
      });
    });
    queue = run.catch(() => {});
    return run;
  }
  return { request, start, stop: () => drop("stopped") };
}

function createCaret({
  spawn = require("node:child_process").spawn, platform = process.platform, excludePids = [process.pid],
  timeoutMs = TIMEOUT_MS, clipboard: initialClipboard = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), worker = null,
} = {}) {
  let clipboard = initialClipboard;
  const unsupported = { ok: false, reason: "unsupported" };
  const w = worker || (platform === "win32" ? createWorker({ spawn, timeoutMs }) : null);
  const prewarm = () => (w ? w.start().then(() => undefined) : Promise.resolve());
  async function snapshot() {
    if (!w) return unsupported;
    const r = await w.request(`snap ${excludePids.filter(Number.isFinite).join(",")}`);
    return r.line ? parseSnapshot(r.line) : { ok: false, reason: r.reason || "unreadable" };
  }
  async function sendKeys(hwnd, action) {
    if (keysFor(action) === null) return { ok: false, reason: "refused-chord" };
    if (!w) return unsupported;
    if (!Number.isFinite(Number(hwnd)) || Number(hwnd) <= 0) return { ok: false, reason: "no-target-window" };
    const r = await w.request(`keys ${Math.trunc(Number(hwnd))} ${action}`);
    if (!r.line) return { ok: false, reason: r.reason || "unreadable" };
    try { return JSON.parse(r.line); } catch { return { ok: false, reason: "unreadable" }; }
  }
  /** Paste `text` into the captured window, restoring the clipboard around it. */
  async function insert({ hwnd, text }) {
    if (!clipboard) return { ok: false, reason: "no-clipboard" };
    const body = String(text == null ? "" : text);
    if (!body) return { ok: false, reason: "empty" };
    const saved = clipboard.snapshot();
    try {
      clipboard.write(body);
      const verdict = await sendKeys(hwnd, "paste");
      await sleep(250); // the target reads the clipboard asynchronously
      return verdict;
    } finally {
      try { clipboard.restore(saved); } catch { /* the owner's clipboard stays as the result */ }
    }
  }
  const undo = ({ hwnd }) => sendKeys(hwnd, "undo");
  const focus = ({ hwnd }) => sendKeys(hwnd, "focus");
  return { snapshot, insert, undo, focus, sendKeys, prewarm, setClipboard: (port) => { clipboard = port; }, stop: () => (w ? w.stop() : undefined) };
}

/**
 * Where the pop-up opens: just under the caret, flipped above when there is no room, then
 * clamped inside the display. Pure. `caret` null falls back to `fallback` (the mouse).
 */
function placePopup({ caret, fallback, size, work }) {
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  const anchor = caret || (fallback ? { x: fallback.x, y: fallback.y, h: 0 } : { x: work.x + 80, y: work.y + 80, h: 0 });
  let x = anchor.x;
  let y = anchor.y + (anchor.h || 0) + 8;
  if (y + h > work.y + work.height) y = anchor.y - h - 8;
  x = Math.max(work.x + 8, Math.min(x, work.x + work.width - w - 8));
  y = Math.max(work.y + 8, Math.min(y, work.y + work.height - h - 8));
  return { x: Math.round(x), y: Math.round(y) };
}

module.exports = { createCaret, createWorker, parseSnapshot, keysFor, placePopup, WORKER_SCRIPT, FIELD_MAX, SELECTION_MAX };
