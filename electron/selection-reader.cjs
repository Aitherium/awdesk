"use strict";

/**
 * selection-reader.cjs -- read the text the owner has HIGHLIGHTED in another
 * app, without touching the keyboard or the clipboard.
 *
 * Why not Ctrl+C: synthesizing a key press (SendInput) lands in whatever window
 * has focus -- often the desk itself -- and a faked Alt+Space preceded a desk
 * crash on 2026-11-02. It also clobbers the owner's clipboard. Windows UI
 * Automation's TextPattern.GetSelection() reads a control's selection directly:
 * no input is injected and nothing is copied.
 *
 * Focus: when the owner clicks the tray or opens the palette, the DESK may own
 * focus. So the script tries the focused element first and, when that belongs
 * to the desk (excludePids) or has no selection, walks the top-level windows in
 * z-order, skipping the desk's, and asks each text control of the first foreign
 * window for its selection. Controls keep their selection when they lose focus.
 *
 * Windows only; anywhere else, or on any failure/timeout, it resolves "" and
 * the caller falls back to the clipboard. Never rejects.
 */

const TIMEOUT_MS = 4000;
const TEXT_MAX = 8000;

// PowerShell, -STA (UIA wants an STA thread). Prints one JSON line.
// $env:AWDESK_EXCLUDE_PIDS = comma-separated pids whose windows are skipped.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$TP = [System.Windows.Automation.TextPattern]
$skip = @{}
foreach ($p in ("$env:AWDESK_EXCLUDE_PIDS" -split ',')) { if ($p) { $skip[[int]$p] = 1 } }
$script:w32 = $false
function W32 {
  # Classic Win32 EDIT controls (WinForms TextBox, old dialogs) expose no TextPattern.
  # EM_GETSEL + WM_GETTEXT are read-only window messages: no input, no clipboard.
  if (-not $script:w32) {
    Add-Type -Namespace AwDesk -Name Edit -MemberDefinition @'
[DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr h, int m, out int a, out int b);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageW(IntPtr h, int m, IntPtr w, System.Text.StringBuilder l);
[DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr h, int m, IntPtr w, IntPtr l);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
public static string Selection(IntPtr h) {
  var c = new System.Text.StringBuilder(256); GetClassNameW(h, c, 256);
  if (c.ToString().IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) < 0) return "";
  int a, b; SendMessageW(h, 0x00B0, out a, out b);
  if (b <= a) return "";
  int n = (int)SendMessageW(h, 0x000E, IntPtr.Zero, IntPtr.Zero);
  if (n <= 0 || n > 4000000) return "";
  var sb = new System.Text.StringBuilder(n + 1); SendMessageW(h, 0x000D, (IntPtr)(n + 1), sb);
  var s = sb.ToString(); if (b > s.Length) b = s.Length; if (a >= b) return "";
  return s.Substring(a, b - a);
}
public static string FirstIn(IntPtr top) {
  string found = "";
  EnumChildWindows(top, (h, l) => { var s = Selection(h); if (s.Trim().Length > 0) { found = s; return false; } return true; }, IntPtr.Zero);
  return found;
}
'@
    $script:w32 = $true
  }
}
function Sel($el) {
  try {
    $pat = $null
    if ($el.TryGetCurrentPattern($TP::Pattern, [ref]$pat)) {
      $r = $pat.GetSelection()
      if ($r -and $r.Length -gt 0) {
        $t = (($r | ForEach-Object { $_.GetText(${TEXT_MAX}) }) -join [Environment]::NewLine)
        if ($t.Trim()) { return $t }
      }
    }
    $h = [IntPtr][int]$el.Current.NativeWindowHandle
    if ($h -ne [IntPtr]::Zero) { W32; return [AwDesk.Edit]::Selection($h) }
    return ''
  } catch { return '' }
}
$out = @{ text = ''; via = '' }
try {
  $f = $A::FocusedElement
  if ($f -and -not $skip.ContainsKey([int]$f.Current.ProcessId)) {
    $t = Sel $f
    if ($t.Trim()) { $out.text = $t; $out.via = 'focused' }
  }
} catch {}
if (-not $out.text) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($A::IsTextPatternAvailableProperty, $true)
  $kids = $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $kids) {
    try {
      if ($skip.ContainsKey([int]$w.Current.ProcessId)) { continue }
      if ($w.Current.IsOffscreen) { continue }
      $r = $w.Current.BoundingRectangle
      if ($r.Width -lt 50 -or $r.Height -lt 50) { continue }
      foreach ($el in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        $t = Sel $el
        if ($t.Trim()) { $out.text = $t; $out.via = 'window'; break }
      }
      if (-not $out.text) {
        $h = [IntPtr][int]$w.Current.NativeWindowHandle
        if ($h -ne [IntPtr]::Zero) { W32; $t = [AwDesk.Edit]::FirstIn($h); if ($t.Trim()) { $out.text = $t; $out.via = 'win32-edit' } }
      }
      break  # only the top-most foreign window: never reach into a background app
    } catch { continue }
  }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
($out | ConvertTo-Json -Compress)
`;

/** Parse the script's JSON line; "" on anything unexpected. Pure. */
function parseOutput(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  try {
    const o = JSON.parse(line);
    return typeof o.text === "string" ? o.text.slice(0, TEXT_MAX) : "";
  } catch {
    return "";
  }
}

/**
 * The highlighted text in the top-most non-desk window, or "".
 * @param {object} [opts]
 * @param {number[]} [opts.excludePids]  the desk's own process ids
 */
function readSelection({
  execFile = require("node:child_process").execFile, platform = process.platform,
  excludePids = [process.pid], timeoutMs = TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") return Promise.resolve("");
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
        timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 256 * 1024,
        env: { ...process.env, AWDESK_EXCLUDE_PIDS: excludePids.filter(Number.isFinite).join(",") },
      }, (error, stdout) => resolve(error ? "" : parseOutput(stdout)));
    } catch {
      resolve("");
    }
  });
}

module.exports = { readSelection, parseOutput, SCRIPT, TIMEOUT_MS, TEXT_MAX };
