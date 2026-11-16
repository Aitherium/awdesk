"use strict";

/**
 * foreground-probe.cjs -- where the focused window is, cheaply, for the swarm to stay
 * off its content (owner 2026-11-16). One long-lived PowerShell reads a line, answers a
 * line (a spawn per sample is ~200 ms of startup; host-context.cjs's one-shot probe is
 * for questions, this is for a loop). Windows only: elsewhere it answers null forever.
 *
 * The probe runs only while someone is watching (start/stop), so a hidden swarm costs
 * nothing. Coordinates leave here in DIPs (screen.screenToDipPoint), the unit the
 * windows use. A probe that cannot start answers null and stays quiet.
 */

const { spawn } = require("node:child_process");
const fairyControl = require("./fairy-control.cjs");

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AitherFg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
}
"@
[void][AitherFg]::SetProcessDPIAware()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $h = [AitherFg]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero -or [AitherFg]::IsIconic($h)) { Write-Output '{"ok":false}'; continue }
  $r = New-Object AitherFg+RECT
  if ([AitherFg]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [void][AitherFg]::GetWindowRect($h, [ref]$r) }
  $c = New-Object System.Text.StringBuilder 128
  [void][AitherFg]::GetClassName($h, $c, 128)
  $t = New-Object System.Text.StringBuilder 160
  [void][AitherFg]::GetWindowText($h, $t, 160)
  [pscustomobject]@{ ok = $true; x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T); cls = $c.ToString(); title = $t.ToString() } | ConvertTo-Json -Compress
}
`;

/**
 * createForegroundProbe({spawnImpl, toDip, onChange, intervalMs})
 *   onChange(rect|null): the focused window's {x,y,width,height} in DIPs, or null (none,
 *   the desktop, minimised, or no probe). Called only when it moved by more than 3 px.
 */
function createForegroundProbe({
  spawnImpl = spawn,
  platform = process.platform,
  toDip = (p) => p,
  onChange = () => {},
  intervalMs = 1500,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let child = null;
  let timer = null;
  let last = null;
  let pending = false;
  let pendingAt = 0;
  let buf = "";
  let dead = false;

  function emit(rect) {
    if (fairyControl.sameRect(rect, last)) return;
    last = rect;
    try { onChange(rect); } catch { /* a listener bug stays there */ }
  }

  function onLine(line) {
    pending = false;
    const raw = fairyControl.parseForeground(line);
    if (!raw) return emit(null);
    const a = toDip({ x: raw.x, y: raw.y });
    const b = toDip({ x: raw.x + raw.width, y: raw.y + raw.height });
    emit({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, title: raw.title });
  }

  function ensureChild() {
    if (child || dead || platform !== "win32") return child;
    try {
      child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
        stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } catch {
      dead = true;
      return null;
    }
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim().startsWith("{")) onLine(line);
      }
    });
    child.on("error", () => { dead = true; child = null; });
    child.on("exit", () => { child = null; pending = false; });
    return child;
  }

  function sample() {
    const c = ensureChild();
    if (pending && Date.now() - pendingAt > 5000) pending = false; // a probe that never answered
    if (!c || pending || !c.stdin || c.stdin.destroyed) return;
    pending = true;
    pendingAt = Date.now();
    try { c.stdin.write("p\n"); } catch { pending = false; }
  }

  function start() {
    if (timer || platform !== "win32") return;
    sample();
    timer = setTimer(sample, intervalMs);
    if (timer && timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearTimer(timer); timer = null; }
    if (child) {
      try { child.stdin.end(); } catch { /* gone */ }
      try { child.kill(); } catch { /* gone */ }
      child = null;
    }
    pending = false;
    buf = "";
    emit(null);
  }

  return { start, stop, sample, current: () => last, running: () => Boolean(timer) };
}

module.exports = { createForegroundProbe, SCRIPT };
