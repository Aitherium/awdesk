"use strict";

/**
 * app-identity -- the two names this app carries, kept apart on purpose.
 *
 *   PRODUCT_NAME       "Aither": what a customer sees. Window titles, the tray tooltip,
 *                      notifications, About, the Start-menu shortcut, the installer and
 *                      the uninstall entry (package.json build.productName / nsis.*).
 *   INTERNAL_APP_NAME  "Desk": the code name, and the name on DISK. It is what
 *                      app.setName() is given, so it decides
 *                        - Electron's userData dir (%APPDATA%\Desk, ~/Library/Application
 *                          Support/Desk, ~/.config/Desk) -- tenant config, sessions,
 *                          settings, cast.json, the character roster;
 *                        - the Linux WM_CLASS / Wayland app_id ("desk") that
 *                          hyprland-window.cjs and the .desktop StartupWMClass match;
 *                      and package.json win/mac.executableName keeps Desk.exe, the
 *                      Programs\Desk install dir, "Uninstall Desk.exe" and Desk.app.
 *
 * Renaming the product (2026-10-15, Desk -> Aither) changed only PRODUCT_NAME. Changing
 * INTERNAL_APP_NAME would start every existing install on an EMPTY userData dir (signed
 * out, tenant forgotten) -- app-identity.test.cjs pins it.
 */

const path = require("node:path");

const PRODUCT_NAME = "Aither";
const INTERNAL_APP_NAME = "Desk";

/** The userData dir under Electron's appData dir. Pure; main.cjs pins it with
 *  app.setPath("userData", ...) so a later setName() cannot move it. */
function userDataDirFor(appDataDir) {
  return path.join(appDataDir, INTERNAL_APP_NAME);
}

module.exports = { PRODUCT_NAME, INTERNAL_APP_NAME, userDataDirFor };
