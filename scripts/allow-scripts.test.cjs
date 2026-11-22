"use strict";

/**
 * Every install script in package-lock.json is covered by package.json `allowScripts`, by the
 * rules npm 12 uses under strict-allow-scripts. A miss here is a red `npm ci` on every CI job.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const a = require("./allow-scripts.cjs");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

const SHA = "62e98b31d8bbfbc70bdc971c6e24b0339e6826d3";
const GIT_ELECTRON = {
  version: "39.8.10+wvcus",
  resolved: `git+ssh://git@github.com/castlabs/electron-releases.git#${SHA}`,
  hasInstallScript: true,
};
const REG_ESBUILD = {
  version: "0.28.1",
  resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.1.tgz",
  hasInstallScript: true,
};
const REG_SWC = {
  version: "1.15.46",
  resolved: "https://registry.npmjs.org/@swc/core/-/core-1.15.46.tgz",
  hasInstallScript: true,
};

test("this repo: npm ci under strict-allow-scripts refuses nothing", () => {
  assert.equal(fs.readFileSync(path.join(root, ".npmrc"), "utf8").includes("strict-allow-scripts=true"), true);
  assert.deepEqual(a.uncoveredInstallScripts(pkg, lock), []);
});

test("this repo: no allowScripts key is left over from an older lockfile", () => {
  assert.deepEqual(a.staleKeys(pkg, lock), []);
});

test("this repo: npm 12 may fetch the git dependency (allow-git)", () => {
  const npmrc = fs.readFileSync(path.join(root, ".npmrc"), "utf8");
  assert.deepEqual(a.blockedGitDependencies(npmrc, pkg, lock), []);
});

test("npm 12 refuses a git dependency unless allow-git is root (direct only) or all", () => {
  const p = { devDependencies: { electron: "git+https://github.com/castlabs/electron-releases.git#v39.8.10+wvcus" } };
  const l = { packages: { "node_modules/electron": GIT_ELECTRON, "node_modules/esbuild": REG_ESBUILD } };
  const deep = { packages: { "node_modules/x/node_modules/electron": GIT_ELECTRON } };
  assert.deepEqual(a.blockedGitDependencies("strict-allow-scripts=true\n", p, l).map((b) => b.where), ["node_modules/electron"]);
  assert.equal(a.blockedGitDependencies("allow-git=none\n", p, l).length, 1);
  assert.deepEqual(a.blockedGitDependencies("strict-allow-scripts=true\r\nallow-git=root\r\n", p, l), []);
  assert.deepEqual(a.blockedGitDependencies("allow-git=all\n", p, l), []);
  assert.equal(a.blockedGitDependencies("allow-git=root\n", p, deep).length, 1, "root does not cover a transitive git dependency");
  assert.equal(a.blockedGitDependencies("allow-git=root\n", { devDependencies: { electron: "^39.0.0" } }, l).length, 1);
  assert.deepEqual(a.blockedGitDependencies("allow-git=all\n", p, deep), []);
});

test("a name@version key never covers a git dependency (the PR #74 CI failure)", () => {
  assert.equal(a.keyMatches("electron@39.8.10+wvcus", GIT_ELECTRON), false);
  assert.equal(a.keyMatches("electron", GIT_ELECTRON), false);
  const broken = { allowScripts: { "electron@39.8.10+wvcus": true } };
  const found = a.uncoveredInstallScripts(broken, { packages: { "node_modules/electron": GIT_ELECTRON } });
  assert.deepEqual(found.map((f) => f.where), ["node_modules/electron"]);
});

test("a git dependency is covered by its repository plus a prefix of the locked sha", () => {
  for (const key of [
    `github:castlabs/electron-releases#${SHA}`,
    `github:castlabs/electron-releases#${SHA.slice(0, 7)}`,
    "github:castlabs/electron-releases",
    `git+https://github.com/castlabs/electron-releases.git#${SHA}`,
    `git+ssh://git@github.com/castlabs/electron-releases.git#${SHA}`,
  ]) assert.equal(a.keyMatches(key, GIT_ELECTRON), true, key);
});

test("a tag, another repository, another sha or a longer sha does not cover it", () => {
  for (const key of [
    "github:castlabs/electron-releases#v39.8.10+wvcus",
    `github:electron/electron#${SHA}`,
    "github:castlabs/electron-releases#0000000",
    `github:castlabs/electron-releases#${SHA}ff`,
  ]) assert.equal(a.keyMatches(key, GIT_ELECTRON), false, key);
  assert.equal(a.keyMatches(`github:castlabs/electron-releases#${SHA}`, REG_ESBUILD), false);
});

test("a registry package is matched by the name and version in its tarball URL", () => {
  assert.equal(a.keyMatches("esbuild@0.28.1", REG_ESBUILD), true);
  assert.equal(a.keyMatches("esbuild", REG_ESBUILD), true);
  assert.equal(a.keyMatches("esbuild@0.28.0 || 0.28.1", REG_ESBUILD), true);
  assert.equal(a.keyMatches("esbuild@0.28.0", REG_ESBUILD), false);
  assert.equal(a.keyMatches("esbuild@^0.28.0", REG_ESBUILD), false, "a range is not an approval");
  assert.equal(a.keyMatches("esbuild@latest", REG_ESBUILD), false, "a tag is not an approval");
  assert.equal(a.keyMatches("@swc/core@1.15.46", REG_SWC), true);
  assert.equal(a.keyMatches("core@1.15.46", REG_SWC), false);
  // The lockfile's own version field is not trusted: only the URL is.
  assert.equal(a.keyMatches("esbuild@9.9.9", { ...REG_ESBUILD, version: "9.9.9" }), false);
});

test("a deny wins over an allow, and no matching key is unreviewed", () => {
  assert.equal(a.scriptAllowed(REG_ESBUILD, { esbuild: true, "esbuild@0.28.1": false }), false);
  assert.equal(a.scriptAllowed(REG_ESBUILD, { "esbuild@0.28.1": true }), true);
  assert.equal(a.scriptAllowed(REG_ESBUILD, {}), null);
  const denied = a.uncoveredInstallScripts({ allowScripts: { esbuild: false } }, { packages: { "node_modules/esbuild": REG_ESBUILD } });
  assert.equal(denied.length, 1, "a denied script still stops a strict install");
});

test("packages without an install script need no key; a key naming nothing is stale", () => {
  const l = { packages: { "": { name: "x" }, "node_modules/zod": { version: "4.4.3", resolved: "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz" } } };
  assert.deepEqual(a.uncoveredInstallScripts({ allowScripts: {} }, l), []);
  assert.deepEqual(a.staleKeys({ allowScripts: { "electron@39.8.10+wvcus": true, zod: true } }, l), ["electron@39.8.10+wvcus"]);
});
