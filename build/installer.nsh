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
; #13135 made the installer per machine): that copy is not removed, and its own Start-menu
; and desktop shortcuts would keep launching the OLD version. Those per-user shortcuts are
; deleted here (only when the per-user Desk.exe is really there); its files and the user's
; data stay. The all-users shortcuts this installer creates are untouched.

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
