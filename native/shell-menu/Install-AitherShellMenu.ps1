#Requires -Version 5.1
<#
.SYNOPSIS
    Installs (or removes) the Aither entry in the Windows 11 File Explorer
    context menu.

.DESCRIPTION
    Aither is a Win32 (Electron) app. Windows 11 only shows the modern context
    menu for commands that come from a package with identity, so this script
    registers a sparse MSIX that points at a directory holding the Aither desk
    (the ExternalLocation) and hosts AitherShellMenu.dll as a COM surrogate.

    The desk may be a packaged Desk.exe (Program Files), or an unpackaged
    Electron run such as
        "D:\desk\node_modules\electron\dist\electron.exe" D:\desk
    The desk records that exact command line on every start under
    HKCU\Software\Aither\Desk\LaunchCommand, and the DLL reads it at click time.
    This script therefore only has to give the sparse package a valid
    ExternalLocation:

      - a directory that already contains Desk.exe is used as-is
        (Program Files\Aither, a per-user NSIS install, ...);
      - otherwise the package uses %LOCALAPPDATA%\Aither, where this script
        copies the COM DLL into shell-menu\ and the CI-built Desk.exe launcher
        stub (next to this script) to the root. The stub launches the recorded
        launch command, so the manifest's Application/@Executable="Desk.exe"
        resolves without pointing at electron.exe.

    Install:
      1. picks the ExternalLocation (-ExternalLocation, else -DeskDir, else the
         directory of the recorded LaunchCommand exe, else Program Files\Aither)
      2. copies AitherShellMenu.dll into <ExternalLocation>\shell-menu\
      3. trusts the package's signing certificate (TrustedPeople)
      4. Add-AppxPackage -Path ... -ExternalLocation <ExternalLocation>
      5. restarts Explorer so the shell reloads the registration

    Uninstall (-Uninstall) removes the package, the certificate it recorded,
    the shell-menu directory, and the stub this script installed.

    ADMIN: nothing needs admin when the ExternalLocation is per-user (the
    default for an unpackaged desk): CurrentUser\TrustedPeople is enough for
    Add-AppxPackage, and %LOCALAPPDATA% is writable. One elevated run is needed
    only when the desk lives under Program Files, because the DLL is copied
    beside it. Use -MachineCertificate only for a machine-wide provisioning
    scenario (it needs admin and LocalMachine\TrustedPeople).

.EXAMPLE
    # Unpackaged desk; no admin needed
    .\Install-AitherShellMenu.ps1

.EXAMPLE
    # Program Files install; run once from an elevated PowerShell
    .\Install-AitherShellMenu.ps1 -DeskDir "$env:ProgramFiles\Aither"

.EXAMPLE
    .\Install-AitherShellMenu.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Package = (Join-Path $PSScriptRoot 'AitherShellMenu.msix'),
    [string]$Dll = (Join-Path $PSScriptRoot 'AitherShellMenu.dll'),
    [string]$Certificate = (Join-Path $PSScriptRoot 'AitherShellMenu.cer'),

    # The per-user Desk.exe launcher stub from the artifact. Copied to the
    # ExternalLocation root only when that directory has no Desk.exe.
    [string]$Stub = (Join-Path $PSScriptRoot 'Desk.exe'),

    # Directory the sparse package's relative paths resolve against. When
    # omitted it is derived from -DeskDir (see below), or %LOCALAPPDATA%\Aither.
    [string]$ExternalLocation = '',

    # Directory that contains the desk launcher. Default: Program Files\Aither
    # when Desk.exe is there, else the directory of the executable recorded in
    # HKCU\Software\Aither\Desk\LaunchCommand, else a detected NSIS install.
    [string]$DeskDir = '',

    # Remove the package, certificate, DLL directory and installed stub.
    [switch]$Uninstall,

    # Trust the certificate for all users (LocalMachine\TrustedPeople) instead
    # of the current user. Requires elevation.
    [switch]$MachineCertificate
)

$ErrorActionPreference = 'Stop'

$PackageName = 'Aither.DesktopShellMenu'
$ShellMenuFolder = 'shell-menu'
$LaunchKey = 'HKCU:\Software\Aither\Desk'
$LaunchValue = 'LaunchCommand'

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The value main.cjs writes on every desk start, or $null.
function Get-LaunchCommand {
    try {
        $item = Get-ItemProperty -Path $LaunchKey -Name $LaunchValue -ErrorAction Stop
        return [string]$item.$LaunchValue
    } catch {
        return $null
    }
}

# The executable out of a quoted command line: `"exe" ["app dir"]`.
function Get-LaunchCommandExe {
    param([string]$Command)

    $text = if ($Command) { $Command.Trim() } else { '' }
    if (-not $text) { return $null }
    if ($text.StartsWith('"')) {
        $end = $text.IndexOf('"', 1)
        if ($end -gt 1) { return $text.Substring(1, $end - 1) }
        return $null
    }
    return ($text -split '\s+', 2)[0]
}

function Find-DeskDir {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) {
            throw "-DeskDir '$Explicit' does not exist."
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $programFiles = [Environment]::GetFolderPath('ProgramFiles')
    $programFilesAither = Join-Path $programFiles 'Aither'
    if (Test-Path -LiteralPath (Join-Path $programFilesAither 'Desk.exe')) {
        return $programFilesAither
    }

    # An unpackaged desk: the recorded command points at electron.exe.
    $exe = Get-LaunchCommandExe -Command (Get-LaunchCommand)
    if ($exe -and (Test-Path -LiteralPath $exe)) {
        return (Split-Path -Parent $exe)
    }

    $candidates = @()
    if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'Aither' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Aither' }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'Desk.exe')) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

# A directory can be the ExternalLocation only when every relative manifest
# path resolves there; Application/@Executable is Desk.exe.
function Resolve-ExternalLocation {
    param([string]$Explicit, [string]$Desk)

    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) {
            New-Item -ItemType Directory -Path $Explicit -Force | Out-Null
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    if ($Desk -and (Test-Path -LiteralPath (Join-Path $Desk 'Desk.exe'))) {
        return $Desk
    }
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is not set; pass -ExternalLocation '<the folder that contains Desk.exe>'."
    }
    return (Join-Path $env:LOCALAPPDATA 'Aither')
}

# The ExternalLocation an earlier install used, so -Uninstall finds it without
# the user retyping the flags.
function Find-ExistingExternalLocation {
    $candidates = @()
    if ($ExternalLocation) { $candidates += $ExternalLocation }
    if ($DeskDir) { $candidates += $DeskDir }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Aither' }
    $programFiles = [Environment]::GetFolderPath('ProgramFiles')
    $candidates += Join-Path $programFiles 'Aither'
    if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'Aither' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Aither' }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "$ShellMenuFolder\thumbprint.txt")) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Add-TrustedCertificate {
    param(
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert,
        [string]$Location
    )
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
        'TrustedPeople', $Location)
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        # X509Store.Add is idempotent for the same certificate.
        $store.Add($Cert)
    } finally {
        $store.Close()
    }
}

function Remove-TrustedCertificate {
    param(
        [string]$Thumbprint,
        [string]$Location
    )
    try {
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
            'TrustedPeople', $Location)
        try {
            $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            $found = $store.Certificates.Find(
                [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
                $Thumbprint, $false)
            foreach ($cert in $found) { $store.Remove($cert) }
        } finally {
            $store.Close()
        }
    } catch {
        Write-Warning "Could not clean $Location\TrustedPeople (run elevated if it persists): $($_.Exception.Message)"
    }
}

function Restart-Explorer {
    Write-Host 'Restarting Explorer so the new menu registration is loaded...'
    # Explorer restarts automatically after Stop-Process.
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------- uninstall --
if ($Uninstall) {
    $externalLocation = Find-ExistingExternalLocation

    $removedPackage = $false
    Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-AppxPackage -Package $_.PackageFullName
        $removedPackage = $true
    }
    if ($removedPackage) { Write-Host "Removed package $PackageName." }
    else { Write-Host "Package $PackageName was not registered." }

    if ($externalLocation) {
        $shellMenuDir = Join-Path $externalLocation $ShellMenuFolder
        $thumbprintFile = Join-Path $shellMenuDir 'thumbprint.txt'
        if (Test-Path -LiteralPath $thumbprintFile) {
            $thumbprint = (Get-Content -LiteralPath $thumbprintFile -Raw).Trim()
            if ($thumbprint) {
                Remove-TrustedCertificate -Thumbprint $thumbprint -Location 'CurrentUser'
                Remove-TrustedCertificate -Thumbprint $thumbprint -Location 'LocalMachine'
                Write-Host "Removed certificate $thumbprint from TrustedPeople."
            }
        }

        # Remove the Desk.exe stub ONLY when this script installed it.
        $stubMarker = Join-Path $shellMenuDir 'desk-stub.txt'
        if (Test-Path -LiteralPath $stubMarker) {
            $stubPath = Join-Path $externalLocation 'Desk.exe'
            if (Test-Path -LiteralPath $stubPath) {
                Remove-Item -LiteralPath $stubPath -Force
                Write-Host "Removed the Desk.exe launcher stub at $stubPath."
            }
        }

        if (Test-Path -LiteralPath $shellMenuDir) {
            Remove-Item -LiteralPath $shellMenuDir -Recurse -Force
            Write-Host "Removed $shellMenuDir."
        }
    } else {
        Write-Host 'No shell-menu directory was found; the package half is still removed.'
    }

    Restart-Explorer
    Write-Host 'Done. The Aither context-menu entry is gone.'
    return
}

# ------------------------------------------------------------------ install --
foreach ($required in @($Package, $Dll, $Certificate)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Missing install file: $required"
    }
}

$deskDir = Find-DeskDir -Explicit $DeskDir
$externalLocation = Resolve-ExternalLocation -Explicit $ExternalLocation -Desk $deskDir
$isAdmin = Test-IsAdministrator
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$needsAdminToCopy = $externalLocation.StartsWith($programFiles, [StringComparison]::OrdinalIgnoreCase)

if ($needsAdminToCopy -and -not $isAdmin) {
    throw ("The ExternalLocation '$externalLocation' is under Program Files. The shell-menu " +
           "DLL must be copied there, which needs one elevated run.`n`n" +
           "Re-run this script from an elevated PowerShell (Run as administrator), or " +
           "omit -ExternalLocation so the package uses the per-user " +
           "%LOCALAPPDATA%\Aither instead.")
}
if ($MachineCertificate -and -not $isAdmin) {
    throw '-MachineCertificate writes LocalMachine\TrustedPeople; run elevated.'
}

if ($deskDir) { Write-Host "Desk directory: $deskDir" }
else {
    Write-Warning ("No Desk.exe install was found and no LaunchCommand is recorded yet. " +
                   "Start awdesk once, then run this script again if the menu does not launch it.")
}
Write-Host "ExternalLocation: $externalLocation"

# 1. Trust the package signing certificate.
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
    (Resolve-Path -LiteralPath $Certificate).Path)
$certLocation = if ($MachineCertificate) { 'LocalMachine' } else { 'CurrentUser' }
Add-TrustedCertificate -Cert $cert -Location $certLocation
Write-Host "Trusted certificate $($cert.Thumbprint) in $certLocation\TrustedPeople."

# 2. Copy the COM DLL into the external location the manifest references.
$shellMenuDir = Join-Path $externalLocation $ShellMenuFolder
New-Item -ItemType Directory -Path $shellMenuDir -Force | Out-Null
Copy-Item -LiteralPath $Dll -Destination (Join-Path $shellMenuDir 'AitherShellMenu.dll') -Force
Set-Content -LiteralPath (Join-Path $shellMenuDir 'thumbprint.txt') -Value $cert.Thumbprint -Encoding ASCII
Write-Host "Copied AitherShellMenu.dll to $shellMenuDir."

# 3. The manifest names Application/@Executable="Desk.exe", which must resolve
#    in the ExternalLocation. An unpackaged desk has no such file, so place the
#    launcher stub at the root. Never overwrite a real Desk.exe.
$deskExe = Join-Path $externalLocation 'Desk.exe'
if (-not (Test-Path -LiteralPath $deskExe)) {
    if (-not (Test-Path -LiteralPath $Stub)) {
        throw ("The ExternalLocation '$externalLocation' has no Desk.exe and the launcher stub " +
               "'$Stub' is missing from the install files. Copy Desk.exe next to this script.")
    }
    Copy-Item -LiteralPath $Stub -Destination $deskExe -Force
    Set-Content -LiteralPath (Join-Path $shellMenuDir 'desk-stub.txt') -Value 'installed' -Encoding ASCII
    Write-Host "Installed the Desk.exe launcher stub at $deskExe."
}

# 4. Register the sparse package. Same-version registrations must be removed
#    first (0x80073CF9), so re-running this script is safe.
$existing = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Replacing existing package $($existing.PackageFullName)..."
    $existing | Remove-AppxPackage
}
try {
    Add-AppxPackage -Path (Resolve-Path -LiteralPath $Package).Path -ExternalLocation $externalLocation
} catch {
    $message = $_.Exception.Message
    if ($message -match '0x800B0109|CERT_E_UNTRUSTEDROOT') {
        throw ("Windows did not trust the package certificate. Re-run this script " +
               "(it imports $Certificate into $certLocation\TrustedPeople), then retry. `n$message")
    }
    throw
}

$registered = Get-AppxPackage -Name $PackageName -ErrorAction SilentlyContinue
if (-not $registered) {
    throw "Add-AppxPackage returned without registering $PackageName."
}
Write-Host "Registered $($registered.PackageFullName)."

# 5. Reload the shell.
Restart-Explorer
Write-Host ''
Write-Host 'Done. Right-click the desktop, a folder background, a folder, or a file.'
Write-Host 'The Aither flyout should appear in the Windows 11 menu.'
Write-Host 'If a verb does nothing, start awdesk once so it records its launch command.'
