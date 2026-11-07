# Aither Shell Menu — Windows 11 top-level context menu

Adds an **Aither** flyout to the Windows 11 modern right-click menu on the
desktop background, folder backgrounds, selected folders, and files — the menu
that also holds entries like **AMD Software: Adrenalin Edition** and
**Open in Terminal**, not the legacy **Show more options** menu.

The menu is a native `IExplorerCommand` DLL plus a **sparse MSIX** identity
package that points at the already-installed Aither app. Nothing is rebuilt into
Desk.exe, and the package contains no app binaries.

The desk does **not** have to be the NSIS `Desk.exe`. It can run unpackaged,
e.g. `"D:\desk\node_modules\electron\dist\electron.exe" D:\desk`. On every
start the desk records that exact command line under
`HKCU\Software\Aither\Desk\LaunchCommand`, and the DLL reads it when a verb is
clicked — not when the package is registered.

```
┌─ Aither
│  Snip a region              --run=snip.region
│  Record a region            --run=record.region
│  Record a region with sound --run=record.region.audio
│  Draw on screen             --run=ink.toggle
│  New note                   --run=note.new
│  New whiteboard             --run=board.new
│  Ask Aither                 --run=orb.ask-screen
│  Send to Aither             --run=spirit.go       (JSON attachment per selected item)
╰  Find a file                --run=search.universal
```

## Why this shape

Windows 11 only draws an app's commands in the modern context menu when the
command comes from a **package with identity**. Classic registry verbs
(`HKCU\Software\Classes\*\shell\…` + `IContextMenu`) are shown under **Show more
options**. Microsoft's supported route for an unpackaged Win32 app is:

1. a native COM DLL implementing `IExplorerCommand` (`EnumSubCommands` gives the
   flyout),
2. a package manifest that registers the DLL as a `windows.comServer` and the
   command as `windows.fileExplorerContextMenus`,
3. package identity installed as a **sparse package** with
   `Add-AppxPackage -ExternalLocation <Aither install dir>`.

`AppxManifest.xml` registers the same CLSID for all three item types:
`*` (files), `Directory` (selected folders) and `Directory\Background` (folder
backgrounds **and the desktop background**).

## Files

| Path | What it is |
|---|---|
| `src/ShellMenu.cpp` | `IExplorerCommand` + `IEnumExplorerCommand`; resolves the desk launch command at click time (HKCU `LaunchCommand`, else the ExternalLocation `Desk.exe`), appends `--run=<id>` and one `--arg=<path>` per selected item. |
| `src/DeskStub.cpp` | Tiny `Desk.exe` stub for a per-user ExternalLocation: launches the recorded `LaunchCommand`, forwarding its own arguments. The manifest's `Application/@Executable="Desk.exe"` needs a real file there. |
| `src/aither.rc`, `src/aither-menu.ico` | Icon resource (`GetIcon` returns `<dll>,-101`). |
| `src/exports.def` | Exports `DllGetClassObject` / `DllCanUnloadNow`; `combaseapi.h` already declares them, so `__declspec(dllexport)` on the definitions is a C2375 linkage clash. |
| `AppxManifest.xml` | Sparse-package identity, COM surrogate registration, and the three `ItemType` registrations. |
| `Install-AitherShellMenu.ps1` | One-time install / `-Uninstall`. |
| `.github/workflows/build-awdesk-shell-menu.yml` | Builds on a **hosted** `windows-latest` runner (this PC has no MSVC/SDK), packs, signs, uploads. |

## Build

The owner's PC has no Visual C++ or Windows SDK, so the DLL is built on GitHub
Actions:

```text
Actions ▸ Build Aither Shell Menu (Win11) ▸ Run workflow
```

Triggers: manual dispatch, a push touching this folder or the workflow, and a
pull request touching either. The artifact is named **`aither-shell-menu-win11`**
and contains:

```
AitherShellMenu.msix     signed sparse package
AitherShellMenu.dll      x64 COM handler
Desk.exe                 per-user launcher stub (never used beside a real Desk.exe)
AitherShellMenu.cer      public signing certificate
Install-AitherShellMenu.ps1
README.md
SHA256SUMS.txt
```

The workflow verifies the DLL and the stub are x64 and statically linked (`/MT`,
so the target PC does not need the Visual C++ redistributable), and that the
signing certificate's Subject exactly matches `Identity/@Publisher`.

## Install (owner, once)

1. Start the desk at least once so it records its launch command (the menu can
   be installed before that, but the first click will say
   `Aither desk not found - start awdesk once` until it has).
2. Download and unzip the **`aither-shell-menu-win11`** artifact.
3. Run PowerShell **as the signed-in user** (no elevation for an unpackaged
   desk) and run:

   ```powershell
   .\Install-AitherShellMenu.ps1
   ```

   The script:
   - picks the ExternalLocation: `-ExternalLocation`, else a directory that
     already holds `Desk.exe` (`C:\Program Files\Aither` wins when present),
     else `%LOCALAPPDATA%\Aither`;
   - copies `AitherShellMenu.dll` to `<ExternalLocation>\shell-menu\`;
   - copies the artifact's `Desk.exe` stub to `<ExternalLocation>\Desk.exe`
     only when that directory has no `Desk.exe` (never overwrites a real app);
   - trusts the `.cer` in `CurrentUser\TrustedPeople`;
   - runs

     ```powershell
     Add-AppxPackage -Path .\AitherShellMenu.msix -ExternalLocation '<ExternalLocation>'
     ```

   - restarts Explorer.

   For an unpackaged desk that is all that runs; `%LOCALAPPDATA%\Aither` needs
   no admin. For a Program Files install, use an elevated PowerShell (the DLL
   is copied beside `Desk.exe`) or pass
   `-DeskDir "$env:ProgramFiles\Aither"`.

Uninstall:

```powershell
.\Install-AitherShellMenu.ps1 -Uninstall
```

### Sparse-package ExternalLocation: the two facts that matter

- **A per-user ExternalLocation is allowed.** Microsoft documents a per-user
  registration with no elevation:
  `Add-AppxPackage -Path <PackagePath> -ExternalLocation <ExternalLocation>`,
  where `<ExternalLocation>` is "the absolute path of your application's
  installation directory". Nothing requires Program Files or administrator
  rights; `%LOCALAPPDATA%\Aither` works. (Machine-wide provisioning is the
  separate `Add-AppxProvisionedPackage` path and does need elevation.)
- **Every relative manifest path is resolved against that ExternalLocation.**
  `Application/@Executable="Desk.exe"` and
  `com:Class/@Path="shell-menu\AitherShellMenu.dll"` are not paths inside the
  `.msix`; `makeappx /nv` deliberately skips checking them at pack time, and
  the installer must place the files there. That is why the per-user layout is:

  ```text
  %LOCALAPPDATA%\Aither\
    Desk.exe                      <- stub (or the real app if one is installed here)
    shell-menu\AitherShellMenu.dll
  ```

  A per-user ExternalLocation whose only executable is `electron.exe` would
  leave `Application/@Executable` unresolved, so the stub exists to satisfy it
  and to forward clicks to the recorded launch command.

### Admin: what actually needs elevation

- **Does not need admin (normal unpackaged desk):** copying the DLL and stub
  into `%LOCALAPPDATA%\Aither`, importing the `.cer` into
  `CurrentUser\TrustedPeople`, and `Add-AppxPackage` for the per-user package.
- **Needs admin:** copying the DLL into `C:\Program Files\Aither` (or any
  ExternalLocation under Program Files), because that directory is protected.
  For a machine-wide provisioning (`Add-AppxProvisionedPackage` / all users)
  the certificate must go into `LocalMachine\TrustedPeople`; the script exposes
  that as `-MachineCertificate`.

### Which certificate store does `Add-AppxPackage` require?

For a **self-signed** package certificate, the public `.cer` must be in
**Trusted People**. A per-user registration accepts
`Cert:\CurrentUser\TrustedPeople`; a machine-wide/all-users installation needs
`Cert:\LocalMachine\TrustedPeople`. Without either, registration fails with
`CERT_E_UNTRUSTEDROOT (0x800B0109)`. A package signed by a CA that the machine
already trusts does not need this step.

### Certificate reality in CI

No long-lived signing secret exists in `Aitherium/AitherOS` today, so the
workflow **generates a self-signed certificate per run** (`CN=Aither Shell
Menu`) and publishes the matching `.cer`. Consequence: each new build has a new
thumbprint, so re-import the new `.cer` before upgrading. To pin it:

- add repository secret `AITHER_SHELL_MENU_PFX_BASE64` (base64 of a `.pfx`) and
  `AITHER_SHELL_MENU_PFX_PASSWORD`;
- the `.pfx` Subject must equal `Identity/@Publisher` in `AppxManifest.xml`
  (change one to match the other if your certificate uses a different subject).

Never commit a `.pfx` or its password. The workflow fails with a clear
publisher-mismatch error before uploading if they disagree.

## Desk-side contract

On every start `electron/main.cjs` writes
`HKCU\Software\Aither\Desk\LaunchCommand` (`REG_SZ`), only when the value
differs, with a hidden `reg.exe`:

```
"C:\Program Files\Aither\Desk.exe"
"C:\Users\me\AppData\...\electron.exe" "D:\desk"     (unpackaged)
```

It is `files-wine.baseCommand` — the same quoted `"<exe>" ["<app dir>"]` string
`launchCommand` builds for Win+E, without the `--files` flag. The DLL appends
the verb and arguments to it at click time:

```
<LaunchCommand> --run=<command id> [--arg=<path>]...
```

and starts it with `CreateProcessW`. If the value is missing, the DLL falls
back to `Desk.exe` in the ExternalLocation (the real app or the stub); if that
is missing too it shows `Aither desk not found - start awdesk once`.
For `spirit.go` the argument is JSON, one object per selected item:
`{"kind":"file","target":"<path>","requester":"shell"}` (JSON-escaped, then
argv-quoted). `--arg` is repeatable. One selected path (or one JSON object) is
passed to `runCommand(id, arg)` as a string; a multi-selection is passed as an
array. `Invoke()` in the DLL quotes
each path with the `CommandLineToArgvW` quoting rules, so spaces and quotes in
filenames survive. Cold start is routed exactly once (`routeColdRunRequest`),
and the second-instance handler uses the same `parseRunRequest`.

## Command-id status (coordinated 2026-11-02)

The menu contract uses the ids below. The orb lane owns `orb.ask-screen` and
`orb.toggle`; the spirit lane owns `spirit.go` (which takes the JSON argument
`{"kind":"file","target":"<path>","requester":"shell"}`) and
`spirit.attach-toggle`; lane/quick owns `note.new` / `board.new`; lane/ink owns
`ink.toggle`.

| Menu item | `--run=` id | Owner lane / develop |
|---|---|---|
| Snip a region | `snip.region` | develop |
| Record a region | `record.region` | develop |
| Record a region with sound | `record.region.audio` | develop |
| Draw on screen | `ink.toggle` | lane/ink (not on develop yet) |
| New note | `note.new` | lane/quick (not on develop yet) |
| New whiteboard | `board.new` | lane/quick (not on develop yet) |
| Ask Aither (and a parent click) | `orb.ask-screen` | orb lane (not on develop yet) |
| Send to Aither | `spirit.go` | spirit lane, JSON arg (not on develop yet) |
| Find a file | `search.universal` | develop |

Until those lanes merge, those flyout items launch Desk with an id this branch's
registry does not know and therefore do nothing (they are not silently
remapped). This is called out rather than hidden because the menu is installed
independently of the desk build.

## Verification status

- **Built and signed in CI:** the workflow compiles, packs, signs, verifies the
  publisher, and uploads the artifact. See the run linked on the PR.
- **Not verified here:** installation on a real Windows 11 desktop, including
  the per-user (`%LOCALAPPDATA%\Aither`) ExternalLocation and whether the
  deployment stack accepts the stub as `Application/@Executable` without
  complaining. This lane was explicitly forbidden from installing anything or
  touching this PC's certificate stores or registry. The remaining risk is
  runtime shell activation (`dllhost` loading the DLL, the flyout appearing
  immediately after registration); restarting Explorer is the documented
  remedy.
- **Not verified here:** click-time `CreateProcessW` against an unpackaged
  Electron command line, and the `HKCU` read from inside the packaged COM
  surrogate (the package is `win32App`/`mediumIL`, not a virtualized
  `packagedClassicApp`, so the read should be the real per-user hive).
- **Not verified here:** that the five missing command ids behave as their menu
  labels promise.

## Microsoft references

- Add a File Explorer context menu command to a packaged desktop app —
  https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer
- Grant package identity by packaging with external location manually —
  https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps
- `IExplorerCommand` —
  https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-iexplorercommand
- `desktop4:FileExplorerContextMenus` schema —
  https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-desktop4-fileexplorercontextmenus
- `com:SurrogateServer` / `com:Class` —
  https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-com-surrogateserver-class
- `MakeAppx.exe` —
  https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool
- `SignTool` —
  https://learn.microsoft.com/en-us/windows/msix/package/sign-app-package-using-signtool
