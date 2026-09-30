; electron-builder NSIS include (package.json build.nsis.include).
;
; "Set up Aither" in the Start menu: first-time setup of this machine as one window
; (sign in through the browser, account, agent, inference, safe restart, verify).
; It launches the desk with --setup; a running desk takes it through the
; single-instance hand-off and opens setup-window.cjs.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Set up Aither.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--setup" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "Set up this machine for AitherOS"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Set up Aither.lnk"
!macroend
