"use strict";

// Product rename 2026-10-15 (Desk -> Aither): a customer upgrading must keep their
// userData (tenant config, sessions, settings) and see "Aither" in every title.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { PRODUCT_NAME, INTERNAL_APP_NAME, userDataDirFor } = require("./app-identity.cjs");
const { badgeTooltip } = require("./badge.cjs");
const deskTenant = require("./desk-tenant.cjs");

const mainSrc = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("the userData dir is unchanged by the rename: <appData>/Desk", () => {
  assert.equal(INTERNAL_APP_NAME, "Desk");
  const appData = path.join("C:", "Users", "x", "AppData", "Roaming");
  assert.equal(userDataDirFor(appData), path.join(appData, "Desk"));
});

test("main.cjs names the app by its INTERNAL name and pins userData before anything reads it", () => {
  assert.ok(!/app\.setName\(\s*["'`]/.test(mainSrc), "app.setName() must take INTERNAL_APP_NAME, never a literal");
  const setName = mainSrc.indexOf("app.setName(INTERNAL_APP_NAME)");
  const setPath = mainSrc.indexOf('app.setPath("userData", userDataDirFor(app.getPath("appData")))');
  assert.ok(setName > 0 && setPath > setName, "setName(INTERNAL_APP_NAME) then setPath(userData)");
  // The pin is top-level, before app.whenReady() is ever reached.
  const ready = mainSrc.indexOf("app.whenReady()");
  assert.ok(ready === -1 || setPath < ready, "userData must be pinned before ready");
});

test("cast-config's out-of-Electron fallback agrees with the pinned dir", () => {
  const src = fs.readFileSync(path.join(__dirname, "cast-config.cjs"), "utf8");
  assert.match(src, /require\("\.\/app-identity\.cjs"\)\.INTERNAL_APP_NAME/);
});

test("customers see Aither: product name, tray tooltip, window titles, About, notices", () => {
  assert.equal(PRODUCT_NAME, "Aither");
  assert.equal(badgeTooltip(0, 0), "Aither");
  assert.match(badgeTooltip(1, 1), /^Aither — /);
  // Inside a tenant workspace the tenant brand decorates the title (desk-tenant.cjs).
  assert.equal(deskTenant.decorateTitle(PRODUCT_NAME, { name: "GARG" }), "Aither · GARG");
  assert.ok(!/title: "Desk"/.test(mainSrc), "a window title still says Desk");
  assert.ok(!/About Desk/.test(mainSrc), "About still says Desk");
  assert.ok(!/`Desk \$\{/.test(mainSrc), "an update notice still says Desk");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<title>Aither<\/title>/);
});
