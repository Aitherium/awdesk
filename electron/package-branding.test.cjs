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
// orphaned shortcuts and pins.
//
// Product rename 2026-10-15: Desk -> Aither. productName is "Aither" (installer title,
// Start menu, uninstall entry, Dock/menu bar), but win/mac.executableName pins the
// FILES to "Desk": Desk.exe, the Programs\Desk install dir (electron-builder's
// APP_FILENAME = productFilename), "Uninstall Desk.exe" (3268_Install-Desk.ps1 keys on
// it) and Desk.app (desk-update.cjs swaps that bundle). userData stays "Desk" through
// app.setName(INTERNAL_APP_NAME) -- see app-identity.test.cjs. electron-builder renames
// the old "Aither Desk.lnk" shortcut to "Aither.lnk" on upgrade (oldShortcutName).

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
  assert.equal(pkg.name, "awdesk");
  // Files on disk keep the internal name, so an upgrade lands on the same paths.
  assert.equal(pkg.build.win.executableName, "Desk");
  assert.equal(pkg.build.mac.executableName, "Desk");
  assert.equal(pkg.build.linux.executableName, "desk");
  assert.equal(pkg.desktopName, "desk.desktop");
  const mainSrc = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.ok(mainSrc.includes(`"${pkg.build.appId}"`), "main.cjs AppUserModelId must match build.appId");
});

test("the product is called Aither everywhere a customer looks", () => {
  assert.equal(pkg.build.productName, "Aither");
  assert.equal(pkg.build.nsis.shortcutName, "Aither");
  assert.equal(pkg.build.nsis.uninstallDisplayName, "Aither");
  assert.match(pkg.description, /^Aither:/);
});

test("release asset names are unchanged (3268, desk-update.cjs and adk match Desk-<ver>-...)", () => {
  assert.equal(pkg.build.win.artifactName, "Desk-${version}-windows-${arch}-setup.${ext}");
  assert.equal(pkg.build.mac.artifactName, "Desk-${version}-macos-${arch}.${ext}");
  assert.equal(pkg.build.linux.artifactName, "Desk-${version}-linux-${arch}.${ext}");
});
