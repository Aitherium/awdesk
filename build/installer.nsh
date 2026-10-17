; electron-builder NSIS include (package.json build.nsis.include).
;
; "Set up Aither" in the Start menu: first-time setup of this machine as one window
; (sign in through the browser, account, agent, inference, safe restart, verify).
; It launches the desk with --setup; a running desk takes it through the
; single-instance hand-off and opens setup-window.cjs.

;
; "Quit Aither" in the Start menu (2026-10-16): Desk.exe --quit asks a running Desk to
; quit and ends it after 3 s if it is not answering (electron/quit-others.cjs). A
; customer had to use Task Manager because Quit lived only in the tray overflow.

;
; Upgrading a PER-USER install (Desk <= 0.1.18 lived in %LOCALAPPDATA%\Programs\Desk;
; #13135 made the installer per machine): electron-builder runs that copy's own uninstaller
; first (installSection.nsh uninstallOldVersion HKEY_CURRENT_USER, data kept; build-awdesk.yml
; asserts it is gone). If it survives anyway, its own Start-menu and desktop shortcuts would
; keep launching the OLD version, so they are deleted here (only when the per-user Desk.exe
; is really there); its files and the user's data stay. The all-users shortcuts this
; installer creates are untouched.

;
; The installer STARTS without administrator rights and asks for them itself (2026-10-16).
; perMachine makes electron-builder mark the setup exe requireAdministrator, and every Desk
; up to 0.1.18 starts its downloaded update with a plain CreateProcess (desk-update.cjs
; runInstaller), which Windows refuses for such an exe: ERROR_ELEVATION_REQUIRED, measured
; as `spawn ... EACCES` against the 0.1.19 installer. So no customer Desk could ever update
; itself to 0.1.19. Marked asInvoker, the exe always starts; .onInit then raises the UAC
; prompt (the UAC plug-in electron-builder already ships), the elevated copy installs for
; all users with the same switches (/S --updated --force-run), and its exit code is passed
; back. A relaunch from the elevated copy runs as the signed-in user (ExecShellAsUser).

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    RequestExecutionLevel user
  !endif
!macroend

!macro customInit
  ${IfNot} ${UAC_IsAdmin}
    ${If} ${UAC_IsInnerInstance}
      ; The account chosen at the UAC prompt is not an administrator.
      SetErrorLevel 740
      Quit
    ${EndIf}
    !insertmacro UAC_RunElevated
    ${If} $0 == 0
      ${If} $1 == 1
        ; The elevated copy did the install; hand its exit code to whoever started us.
        SetErrorLevel $2
        Quit
      ${ElseIf} $1 == 3
        SetErrorLevel 740
        Quit
      ${EndIf}
      ; $1 == 2: already elevated (UAC off, or an admin token): install right here.
    ${Else}
      ; 1223 = the user answered No at the UAC prompt; nothing was changed.
      SetErrorLevel $0
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Set up Aither.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--setup" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "Set up this machine for AitherOS"
  CreateShortCut "$SMPROGRAMS\Quit Aither.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--quit" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWMINIMIZED "" "Quit Aither, even if it is not responding"
  SetShellVarContext current
  IfFileExists "$LOCALAPPDATA\Programs\Desk\Desk.exe" 0 aither_no_per_user_copy
    Delete "$SMPROGRAMS\Desk.lnk"
    Delete "$SMPROGRAMS\Aither.lnk"
    Delete "$SMPROGRAMS\Set up Aither.lnk"
    Delete "$DESKTOP\Desk.lnk"
    Delete "$DESKTOP\Aither.lnk"
  aither_no_per_user_copy:
  SetShellVarContext all
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Set up Aither.lnk"
  Delete "$SMPROGRAMS\Quit Aither.lnk"
!macroend
