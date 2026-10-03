"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DESKTOP_ID, desktopEntries, installLinuxIntegration, steamGameRunning } = require("./linux-integration.cjs");

test("the launcher opens desk:// links and the autostart starts in the background", () => {
  const { launcher, autostart } = desktopEntries("/home/deck/Downloads/Desk-0.1.7-linux-x86_64.AppImage");
  assert.match(launcher, /^Exec="\/home\/deck\/Downloads\/Desk-0\.1\.7-linux-x86_64\.AppImage" %U$/m);
  assert.match(launcher, /^MimeType=x-scheme-handler\/desk;$/m);
  assert.match(autostart, /--background$/m);
  assert.match(desktopEntries('/tmp/a "b"/x.AppImage').launcher, /Exec="\/tmp\/a \\"b\\"\/x\.AppImage"/);
});

test("installs for this user only, once, and registers the desk:// handler", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deck-"));
  const calls = [];
  const run = (cmd, args, cb) => { calls.push([cmd, ...args]); if (cb) cb(null); };
  const r = installLinuxIntegration({ appimage: "/x/Desk.AppImage", home, run });
  assert.deepEqual(r, { installed: true, changed: true });
  assert.ok(fs.existsSync(path.join(home, ".local", "share", "applications", DESKTOP_ID)));
  assert.ok(fs.existsSync(path.join(home, ".config", "autostart", DESKTOP_ID)));
  assert.deepEqual(calls[0], ["xdg-mime", "default", DESKTOP_ID, "x-scheme-handler/desk"]);
  assert.deepEqual(installLinuxIntegration({ appimage: "/x/Desk.AppImage", home, run }), { installed: true, changed: false });
  assert.equal(installLinuxIntegration({ appimage: "", home, run }).installed, false);
});

test("a Steam game is seen the way the Deck guard sees it", () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "proc-"));
  fs.mkdirSync(path.join(proc, "101"));
  fs.writeFileSync(path.join(proc, "101", "cmdline"), "bash\0-l\0");
  assert.equal(steamGameRunning(proc), false);
  fs.mkdirSync(path.join(proc, "202"));
  fs.writeFileSync(path.join(proc, "202", "cmdline"), "/home/deck/.steam/ubuntu12_32/reaper\0SteamLaunch AppId=1145360\0--\0game\0");
  assert.equal(steamGameRunning(proc), true);
  assert.equal(steamGameRunning(path.join(proc, "nope")), false);
});
