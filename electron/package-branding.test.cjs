"use strict";

// Desk ships to customers from github.com/Aitherium/awdesk. The package metadata
// still named the upstream fork (author/homepage/repository/bugs = xikhar/persona),
// which electron-builder stamps into the Windows exe CompanyName, the uninstall
// entry's Publisher, the deb maintainer and the mac copyright.
//
// appId stays "com.xikhar.awdesk" ON PURPOSE. electron-builder derives the NSIS
// APP_GUID from appId, and that GUID keys the install + uninstall registry entries
// (Software\<guid>, ...\Uninstall\<guid>); main.cjs also sets it as the Windows
// AppUserModelId that toasts and taskbar pins bind to. Changing it would make the
// next installer treat every existing install as a different app: a second copy,
// orphaned shortcuts and pins. productName stays "Desk" for the same reason (it is
// the install dir and Electron's userData folder name). Only the shortcut and
// uninstall display names change; electron-builder renames the old "Desk.lnk" on
// update (keepShortcuts) or the old uninstaller removes it on a full reinstall.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

function urlOf(v) {
  return typeof v === "string" ? v : (v && v.url) || "";
}

test("customer-facing metadata names Aitherium, not the upstream fork", () => {
  const author = typeof pkg.author === "string" ? pkg.author : JSON.stringify(pkg.author || {});
  for (const [field, value] of [
    ["author", author],
    ["homepage", pkg.homepage || ""],
    ["repository", urlOf(pkg.repository)],
    ["bugs", urlOf(pkg.bugs)],
    ["description", pkg.description || ""],
    ["build.copyright", pkg.build.copyright || ""],
  ]) {
    assert.ok(!/xikhar|persona/i.test(value), `${field} still names the upstream fork: ${value}`);
  }
  assert.equal(pkg.author.name, "Aitherium");
  // FpmTarget refuses to build the .deb without an author email (or linux.maintainer).
  assert.ok(pkg.author.email || (pkg.build.linux && pkg.build.linux.maintainer), "deb needs a maintainer email");
  assert.match(pkg.homepage, /^https:\/\/github\.com\/Aitherium\/awdesk\b/);
  assert.match(urlOf(pkg.repository), /github\.com\/Aitherium\/awdesk\.git$/);
  assert.match(urlOf(pkg.bugs), /^https:\/\/github\.com\/Aitherium\/awdesk\/issues$/);
  assert.match(pkg.build.copyright, /Aitherium/);
});

test("install identity is unchanged so existing installs upgrade in place", () => {
  assert.equal(pkg.build.appId, "com.xikhar.awdesk");
  assert.equal(pkg.build.productName, "Desk");
  assert.equal(pkg.name, "awdesk");
  const mainSrc = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.ok(mainSrc.includes(`"${pkg.build.appId}"`), "main.cjs AppUserModelId must match build.appId");
});

test("Windows installer shows Aither Desk", () => {
  assert.equal(pkg.build.nsis.shortcutName, "Aither Desk");
  assert.equal(pkg.build.nsis.uninstallDisplayName, "Aither Desk");
});
