"use strict";

/**
 * linux-integration — make the downloaded AppImage behave like an installed app, with no
 * terminal: a launcher entry (so desk:// links from aitherium.com open Desk), and an
 * autostart entry (so Lend memory resumes after a reboot). Written for the CURRENT user
 * only, and rewritten when the AppImage moves. Also: is a Steam game running (the Steam
 * Deck's guard: Steam starts every game as `reaper SteamLaunch AppId=<id>`, in Game Mode
 * and Desktop Mode alike).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DESKTOP_ID = "aither-desk.desktop";

function quoteExec(p) {
  // the Desktop Entry spec: inside a quoted argument, escape " ` $ and \ with a backslash
  const BS = String.fromCharCode(92);
  const escaped = Array.from(String(p), (c) => ('"`$' + BS).includes(c) ? BS + c : c).join("");
  return '"' + escaped + '"';
}

/** The two .desktop files for an AppImage at `appimage`. Pure, for the tests. */
function desktopEntries(appimage) {
  const exec = quoteExec(appimage);
  const launcher = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Aither Desktop",
    "Comment=Your AI, on this computer",
    `Exec=${exec} %U`,
    "Terminal=false",
    "Categories=Utility;",
    "MimeType=x-scheme-handler/desk;",
    "StartupWMClass=Desk",
    "",
  ].join("\n");
  const autostart = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Aither Desktop",
    `Exec=${exec} --background`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "X-KDE-autostart-after=panel",
    "",
  ].join("\n");
  return { launcher, autostart };
}

/**
 * Install (or refresh) the launcher + autostart entries. Returns what it did; never throws.
 * `run` is execFile, injectable for tests.
 */
function installLinuxIntegration({ appimage = process.env.APPIMAGE, home = os.homedir(), run = execFile } = {}) {
  if (!appimage) return { installed: false, reason: "not an AppImage" };
  const { launcher, autostart } = desktopEntries(appimage);
  const appsDir = path.join(home, ".local", "share", "applications");
  const autoDir = path.join(home, ".config", "autostart");
  const files = [[path.join(appsDir, DESKTOP_ID), launcher], [path.join(autoDir, DESKTOP_ID), autostart]];
  let changed = false;
  try {
    for (const [file, text] of files) {
      let old = null;
      try { old = fs.readFileSync(file, "utf8"); } catch { old = null; }
      if (old === text) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o644 });
      changed = true;
    }
  } catch (e) {
    return { installed: false, reason: e.message };
  }
  if (changed) {
    // best effort: the desktop picks the handler up from the MimeType line either way
    run("xdg-mime", ["default", DESKTOP_ID, "x-scheme-handler/desk"], () => {});
    run("update-desktop-database", [appsDir], () => {});
  }
  return { installed: true, changed };
}

/** True when a Steam game runs (same rule as the Deck installer's guard). */
function steamGameRunning(procDir = "/proc") {
  let names;
  try {
    names = fs.readdirSync(procDir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(path.join(procDir, n, "cmdline"), "latin1");
    } catch {
      continue;
    }
    if (cmd.replace(/\0/g, " ").includes("SteamLaunch AppId=")) return true;
  }
  return false;
}

module.exports = { DESKTOP_ID, desktopEntries, installLinuxIntegration, steamGameRunning };
