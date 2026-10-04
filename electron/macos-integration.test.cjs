"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AGENT_LABEL, agentPath, installMacIntegration, launchAgentPlist, unstablePath } = require("./macos-integration.cjs");

const EXE = "/Applications/Aither Desktop.app/Contents/MacOS/Aither Desktop";

test("the agent starts the installed app in the background at login, once", () => {
  const plist = launchAgentPlist(EXE);
  assert.match(plist, new RegExp(`<string>${AGENT_LABEL}</string>`));
  assert.match(plist, /<string>\/Applications\/Aither Desktop\.app\/Contents\/MacOS\/Aither Desktop<\/string>\n\s*<string>--background<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\s*<false\/>/);
});

test("a path with XML characters cannot break out of its string", () => {
  const plist = launchAgentPlist("/Users/a/Apps/<x>&y.app/Contents/MacOS/Desk");
  assert.ok(plist.includes("&lt;x&gt;&amp;y.app"));
  assert.ok(!plist.includes("<x>"));
});

test("a copy macOS will make disappear never gets a login item", () => {
  assert.equal(unstablePath(EXE), "");
  assert.match(unstablePath("/Volumes/Aither Desktop/Aither Desktop.app/Contents/MacOS/Aither Desktop"), /disk image/);
  assert.match(unstablePath("/private/var/folders/x/T/AppTranslocation/ABC/d/Aither Desktop.app/Contents/MacOS/Aither Desktop"), /translocated/);
  assert.match(unstablePath("/usr/local/bin/electron"), /\.app bundle/);
  assert.match(unstablePath(""), /absolute/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-mac-"));
  const r = installMacIntegration({ exe: "/Volumes/D/Aither Desktop.app/Contents/MacOS/Aither Desktop", home });
  assert.equal(r.installed, false);
  assert.ok(!fs.existsSync(agentPath(home)));
});

test("install writes the agent for this user only, and is idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desk-mac-"));
  const first = installMacIntegration({ exe: EXE, home });
  assert.deepEqual([first.installed, first.changed], [true, true]);
  assert.equal(first.file, path.join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`));
  assert.equal(fs.readFileSync(first.file, "utf8"), launchAgentPlist(EXE));
  assert.equal(installMacIntegration({ exe: EXE, home }).changed, false);
  // the app moved: the agent follows it
  const moved = "/Users/me/Applications/Aither Desktop.app/Contents/MacOS/Aither Desktop";
  assert.equal(installMacIntegration({ exe: moved, home }).changed, true);
  assert.match(fs.readFileSync(first.file, "utf8"), /\/Users\/me\/Applications\//);
});
