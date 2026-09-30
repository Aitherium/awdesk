<#
.SYNOPSIS
    Windows-side half of the "dual desktop" sync: publish the Windows window list,
    the focused window and the taskbar set so AitherOS on awnix can read them.

.DESCRIPTION
    Enumerates top-level windows through user32/dwmapi and writes ONE JSON snapshot:

        { "schema": "aither.desktop-state/1", "at": "<utc iso>", "host": "<computer>",
          "foreground": { hwnd, title, process, pid, wslg },
          "taskbar":    [ { hwnd, title, process, pid, wslg, minimized, rect } ... ] }

    "taskbar" is the set Explorer shows buttons for: visible, un-owned, not a tool
    window, not DWM-cloaked (hidden UWP / other virtual desktop), with a title.
    `wslg: true` marks a window drawn by WSLg (process msrdc) -- i.e. a Linux window
    from awnix riding the Windows taskbar -- which is the join key between the two
    desktops: awnix's own X window list (xwininfo) plus this list is the whole desk.

    Transport, in order of preference:
      1. -OutFile (default %USERPROFILE%\.aither\desktop-state.json), written
         atomically (temp + move). awnix reads it at /mnt/c/Users/<you>/.aither/...
         No port, no auth surface, nothing listening.
      2. -PostUrl: also POST the snapshot there (e.g. a fleet endpoint once one
         exists). Failures are reported, never retried in a tight loop.

    Loop mode (-IntervalSeconds N) re-publishes only when the snapshot CHANGES, so
    an idle desktop costs one EnumWindows per interval and no disk writes.

    Exit 0 published · 1 failed · 2 could not judge (not Windows).

.EXAMPLE
    pwsh -File Publish-DesktopState.ps1 -Once
.EXAMPLE
    pwsh -File Publish-DesktopState.ps1 -IntervalSeconds 5
#>
[CmdletBinding()]
param(
    [string]$OutFile = (Join-Path $env:USERPROFILE '.aither\desktop-state.json'),
    [string]$PostUrl,
    [ValidateRange(1, 3600)]
    [int]$IntervalSeconds = 5,
    [switch]$Once,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    Write-Error 'CANNOT JUDGE: this agent reads the Windows desktop; run it on Windows.'
    exit 2
}

if (-not ('AitherDesk.Win32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace AitherDesk {
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static class Win32 {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    public static List<IntPtr> TopLevel() {
      var all = new List<IntPtr>();
      EnumWindows((h, l) => { all.Add(h); return true; }, IntPtr.Zero);
      return all;
    }
  }
}
'@
}

$W = [AitherDesk.Win32]
$GW_OWNER = 4
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = 0x80
$WS_EX_APPWINDOW = 0x40000
$DWMWA_CLOAKED = 14

function Get-WindowRow {
    param([IntPtr]$Hwnd, [hashtable]$ProcCache)
    $sb = New-Object System.Text.StringBuilder 512
    [void]$W::GetWindowTextW($Hwnd, $sb, 512)
    [uint32]$procId = 0
    [void]$W::GetWindowThreadProcessId($Hwnd, [ref]$procId)
    if (-not $ProcCache.ContainsKey($procId)) {
        $ProcCache[$procId] = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }
    }
    $r = New-Object AitherDesk.RECT
    [void]$W::GetWindowRect($Hwnd, [ref]$r)
    $proc = $ProcCache[$procId]
    [ordered]@{
        hwnd      = ('0x{0:X}' -f $Hwnd.ToInt64())
        title     = $sb.ToString()
        process   = $proc
        pid       = [int]$procId
        wslg      = ($proc -eq 'msrdc')
        minimized = [bool]$W::IsIconic($Hwnd)
        rect      = @($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
    }
}

function Test-TaskbarWindow {
    <# The Explorer rule, approximately: visible, titled, not cloaked, and either
       un-owned and not a tool window, or explicitly WS_EX_APPWINDOW. #>
    param([IntPtr]$Hwnd)
    if (-not $W::IsWindowVisible($Hwnd)) { return $false }
    $sb = New-Object System.Text.StringBuilder 2
    if ($W::GetWindowTextW($Hwnd, $sb, 2) -le 0) { return $false }
    $cloaked = 0
    if ($W::DwmGetWindowAttribute($Hwnd, $DWMWA_CLOAKED, [ref]$cloaked, 4) -eq 0 -and $cloaked -ne 0) { return $false }
    $ex = $W::GetWindowLongW($Hwnd, $GWL_EXSTYLE)
    if ($ex -band $WS_EX_APPWINDOW) { return $true }
    if ($ex -band $WS_EX_TOOLWINDOW) { return $false }
    return ($W::GetWindow($Hwnd, $GW_OWNER) -eq [IntPtr]::Zero)
}

function Get-DesktopState {
    $cache = @{}
    $taskbar = foreach ($h in $W::TopLevel()) {
        if (Test-TaskbarWindow -Hwnd $h) { Get-WindowRow -Hwnd $h -ProcCache $cache }
    }
    $fg = $W::GetForegroundWindow()
    [ordered]@{
        schema     = 'aither.desktop-state/1'
        at         = [DateTime]::UtcNow.ToString('o')
        host       = $env:COMPUTERNAME
        foreground = if ($fg -ne [IntPtr]::Zero) { Get-WindowRow -Hwnd $fg -ProcCache $cache } else { $null }
        taskbar    = @($taskbar)
    }
}

function Write-StateFile {
    param([string]$Path, [string]$Json)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, $Json, (New-Object System.Text.UTF8Encoding $false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

if ($SelfTest) {
    $s = Get-DesktopState
    $fail = @()
    if ($s.schema -ne 'aither.desktop-state/1') { $fail += 'schema' }
    if ($s.taskbar -isnot [array]) { $fail += 'taskbar is not an array' }
    foreach ($row in $s.taskbar) {
        foreach ($k in 'hwnd', 'title', 'process', 'pid', 'wslg', 'minimized', 'rect') {
            if (-not $row.Contains($k)) { $fail += "row missing $k" }
        }
        if (-not $row.title) { $fail += 'untitled window counted as a taskbar button' }
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "desktop-state-selftest-$PID.json"
    Write-StateFile -Path $tmp -Json ($s | ConvertTo-Json -Depth 5)
    $back = Get-Content -Raw $tmp | ConvertFrom-Json
    Remove-Item $tmp -Force
    if ($back.schema -ne $s.schema) { $fail += 'round-trip lost the schema' }
    if ($fail) { Write-Error ("self-test FAILED: " + ($fail -join '; ')); exit 1 }
    Write-Output "self-test OK ($($s.taskbar.Count) taskbar windows, $(@($s.taskbar | Where-Object wslg).Count) from WSLg)"
    exit 0
}

$last = $null
do {
    $state = Get-DesktopState
    # Compare without the timestamp so an unchanged desktop is not rewritten.
    $key = ($state.foreground, $state.taskbar | ConvertTo-Json -Depth 5 -Compress)
    if ($key -ne $last) {
        $json = $state | ConvertTo-Json -Depth 5
        try {
            Write-StateFile -Path $OutFile -Json $json
        } catch {
            Write-Error "could not write $OutFile : $($_.Exception.Message)"
            if ($Once) { exit 1 }
        }
        if ($PostUrl) {
            try {
                Invoke-RestMethod -Method Post -Uri $PostUrl -Body $json -ContentType 'application/json' -TimeoutSec 5 | Out-Null
            } catch {
                Write-Warning "POST $PostUrl failed: $($_.Exception.Message)"
            }
        }
        $last = $key
    }
    if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
} while (-not $Once)
exit 0
