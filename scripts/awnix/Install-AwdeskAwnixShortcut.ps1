<#
.SYNOPSIS
    Start-menu (and pinnable taskbar) launcher for awdesk running ON the awnix fleet host.

.DESCRIPTION
    Creates "AitherOS Desk (awnix).lnk" in the user's Start menu. It targets wslg.exe,
    not wsl.exe: wslg.exe launches a Linux GUI command with NO console window, which is
    what makes the entry behave like a native app when pinned to the taskbar.

    The shortcut runs awdesk-awnix-open.sh inside awnix, which starts
    aither-awdesk.service if needed and hands the requested surface (default --fleet)
    to the running desk through Electron's single-instance lock.

    WSLg ALSO mirrors /usr/share/applications/aither-awdesk.desktop into the Start menu
    under an "awnix" folder on its own; this .lnk is the explicit, icon-carrying,
    pinnable twin that does not depend on WSLg's mirroring having run.

    Exit 0 created (or -WhatIf), 1 failed, 2 could not judge (no wslg.exe / no distro).

.PARAMETER Surface
    --fleet (default), --console, --overlay, --desktop or --command.

.PARAMETER SelfTest
    Build the shortcut arguments and assert their shape; writes nothing.

.EXAMPLE
    pwsh -File Install-AwdeskAwnixShortcut.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('--fleet', '--console', '--overlay', '--desktop', '--command')]
    [string]$Surface = '--fleet',
    [string]$Distro = 'awnix',
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

$OpenScript = '/opt/aitheros/awdesk/scripts/awnix/awdesk-awnix-open.sh'

function Get-ShortcutArgument {
    param([string]$DistroName, [string]$SurfaceName)
    # One argv, no shell re-parse on the Windows side; the Linux side receives
    # /bin/sh <script> <surface> exactly.
    return "-d $DistroName -u root --cd / -- /bin/sh $OpenScript $SurfaceName"
}

if ($SelfTest) {
    $a = Get-ShortcutArgument -DistroName 'awnix' -SurfaceName '--fleet'
    if ($a -notmatch '^-d awnix -u root --cd / -- /bin/sh /opt/aitheros/awdesk/scripts/awnix/awdesk-awnix-open\.sh --fleet$') {
        Write-Error "self-test: unexpected shortcut arguments: $a"
        exit 1
    }
    Write-Output 'self-test OK'
    exit 0
}

$wslg = Join-Path $env:ProgramFiles 'WSL\wslg.exe'
if (-not (Test-Path $wslg)) {
    Write-Error "CANNOT JUDGE: $wslg not found (WSL from the Store is required for WSLg)"
    exit 2
}
$distros = (& wsl.exe -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($distros -notcontains $Distro) {
    Write-Error "CANNOT JUDGE: WSL distro '$Distro' is not registered (have: $($distros -join ', '))"
    exit 2
}

$iconDir = Join-Path $env:LOCALAPPDATA 'AitherOS'
$iconPath = Join-Path $iconDir 'awdesk-awnix.ico'
$png = Join-Path $PSScriptRoot '..\..\build\icon.png'
if ((Test-Path $png) -and -not (Test-Path $iconPath) -and $PSCmdlet.ShouldProcess($iconPath, 'write icon')) {
    New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile((Resolve-Path $png))), 256, 256
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $fs = [System.IO.File]::Create($iconPath)
    try { $icon.Save($fs) } finally { $fs.Close() }
}

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Join-Path $startMenu 'AitherOS Desk (awnix).lnk'
if ($PSCmdlet.ShouldProcess($lnk, 'create shortcut')) {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $wslg
    $sc.Arguments = Get-ShortcutArgument -DistroName $Distro -SurfaceName $Surface
    $sc.Description = 'awdesk running on the awnix fleet host (WSLg)'
    $sc.WorkingDirectory = $env:USERPROFILE
    if (Test-Path $iconPath) { $sc.IconLocation = "$iconPath,0" }
    $sc.Save()
    if (-not (Test-Path $lnk)) { Write-Error "shortcut was not written: $lnk"; exit 1 }
    Write-Output "created $lnk -> $wslg $($sc.Arguments)"
    Write-Output 'Pin it: Start > right-click "AitherOS Desk (awnix)" > Pin to taskbar.'
}
exit 0
