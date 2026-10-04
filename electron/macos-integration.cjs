"use strict";

/**
 * macos-integration — start Desk at login on a Mac with no terminal and no prompt: a
 * per-user LaunchAgent (~/Library/LaunchAgents) that runs the installed app with
 * `--background`, so Lend memory and the device's check-in resume after a reboot without
 * a window opening. The same contract as linux-integration's autostart entry. Written for
 * the CURRENT user only, rewritten when the app moves, and never written for a copy that
 * macOS will make disappear (run from the disk image, or App Translocation's random path):
 * that entry would point at nothing after the next login.
 *
 * Not loaded with launchctl now: RunAtLoad starts it at the next login, and loading it
 * here would start a second Desk beside this one.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGENT_LABEL = "com.aitherium.desk";

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Why `exe` is not a place a login item may point at, or "" when it is. Pure. */
function unstablePath(exe) {
  if (!exe || !path.posix.isAbsolute(exe)) return "not an absolute path";
  if (exe.startsWith("/Volumes/")) return "running from the disk image";
  if (exe.includes("/AppTranslocation/")) return "running from a translocated copy (move it to Applications)";
  if (!/\.app\/Contents\/MacOS\/[^/]+$/.test(exe)) return "not inside an .app bundle";
  return "";
}

/** The LaunchAgent plist for the executable at `exe`. Pure, for the tests. */
function launchAgentPlist(exe) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${AGENT_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(exe)}</string>`,
    "    <string>--background</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    // a quit from the tray stays quit until the next login
    "  <key>KeepAlive</key>",
    "  <false/>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>LimitLoadToSessionType</key>",
    "  <string>Aqua</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Where the agent lives for `home`. */
function agentPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

/**
 * Install (or refresh) the login agent. Returns what it did; never throws.
 */
function installMacIntegration({ exe = process.execPath, home = os.homedir() } = {}) {
  const why = unstablePath(exe);
  if (why) return { installed: false, reason: why };
  const file = agentPath(home);
  const text = launchAgentPlist(exe);
  try {
    let old = null;
    try { old = fs.readFileSync(file, "utf8"); } catch { old = null; }
    if (old === text) return { installed: true, changed: false, file };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o644 });
    return { installed: true, changed: true, file };
  } catch (e) {
    return { installed: false, reason: e.message };
  }
}

module.exports = { AGENT_LABEL, agentPath, installMacIntegration, launchAgentPlist, unstablePath };
