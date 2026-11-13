# winshot.ps1 -- list or capture the desk's top-level windows without focusing them.
#   winshot.ps1 -ProcId 41164 -List
#   winshot.ps1 -ProcId 41164 -Title "GargBot" -Out C:\x\shot.jpg
param([int]$ProcId, [long]$Hwnd = 0, [string]$Title = "", [string]$Out = "", [switch]$List, [int]$MaxWidth = 1600, [int]$Quality = 70)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class WS {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
"@
[void][WS]::SetProcessDPIAware()
$pids = @($ProcId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcId" | ForEach-Object { $_.ProcessId })
$rows = foreach ($h in [WS]::All()) {
  $p = 0; [void][WS]::GetWindowThreadProcessId($h, [ref]$p)
  if ($pids -notcontains [int]$p) { continue }
  $sb = New-Object System.Text.StringBuilder 512; [void][WS]::GetWindowText($h, $sb, 512)
  $r = New-Object WS+RECT; [void][WS]::GetWindowRect($h, [ref]$r)
  [pscustomobject]@{ hwnd = $h.ToInt64(); title = $sb.ToString(); visible = [WS]::IsWindowVisible($h); x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T }
}
if ($List) { $rows | Where-Object { $_.title -ne "" -and $_.w -gt 1 } | ConvertTo-Json -Compress; exit 0 }
$win = $rows | Where-Object { $_.visible -and $_.w -gt 50 -and $_.title -like "*$Title*" -and ($Hwnd -eq 0 -or $_.hwnd -eq $Hwnd) } | Sort-Object { $_.w * $_.h } -Descending | Select-Object -First 1
if (-not $win) { Write-Output '{"ok":false,"error":"no visible window matches"}'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $win.w, $win.h
$g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
$ok = [WS]::PrintWindow([IntPtr]$win.hwnd, $dc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($dc); $g.Dispose()
if ($bmp.Width -gt $MaxWidth) {
  $nh = [int]($bmp.Height * $MaxWidth / $bmp.Width); $small = New-Object System.Drawing.Bitmap $MaxWidth, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($small); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $MaxWidth, $nh); $g2.Dispose(); $bmp.Dispose(); $bmp = $small
}
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
$bmp.Save($Out, $enc, $ep); $bmp.Dispose()
[pscustomobject]@{ ok = [bool]$ok; title = $win.title; w = $win.w; h = $win.h; out = $Out } | ConvertTo-Json -Compress
