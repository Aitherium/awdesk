"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const du = require("./desk-update.cjs");

const NEW = Buffer.from("new appimage bytes");
const NEW_SHA = nodeCrypto.createHash("sha256").update(NEW).digest("hex");
const NAME = "Desk-0.1.10-linux-x86_64.AppImage";

function release(tag = "v0.1.10") {
  return { tag_name: tag, assets: [
    { name: NAME, browser_download_url: `https://dl/${NAME}` },
    { name: "Desk-0.1.10-linux-amd64.deb", browser_download_url: "https://dl/deb" },
    { name: "SHA256SUMS.txt", browser_download_url: "https://dl/SHA256SUMS.txt" },
  ] };
}

function fetcher({ rel = release(), sums = `${NEW_SHA}  ${NAME}\n`, bytes = NEW } = {}) {
  return async (url) => {
    if (url === du.RELEASE_API) return { status: 200, json: async () => rel };
    if (url.endsWith("SHA256SUMS.txt")) return { status: 200, text: async () => sums };
    if (url.endsWith(NAME)) return { status: 200, arrayBuffer: async () => bytes };
    return { status: 404 };
  };
}

function oldAppImage(name = "Desk-0.1.9-linux-x86_64.AppImage") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "du-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, "old");
  return p;
}

test("isNewer compares dotted versions numerically", () => {
  assert.equal(du.isNewer("v0.1.10", "0.1.9"), true);
  assert.equal(du.isNewer("v0.1.9", "0.1.9"), false);
  assert.equal(du.isNewer("v0.1.8", "0.1.9"), false);
  assert.equal(du.isNewer("v1.0.0-beta.1", "0.1.9"), false, "unparseable is never newer");
});

test("expectedHash reads both SHA256SUMS spellings, and only the named file", () => {
  assert.equal(du.expectedHash(`${NEW_SHA}  ${NAME}\n`, NAME), NEW_SHA);
  assert.equal(du.expectedHash(`${NEW_SHA.toUpperCase()} *${NAME}\r\n`, NAME), NEW_SHA);
  assert.equal(du.expectedHash(`${NEW_SHA}  other.AppImage\n`, NAME), "");
});

test("a versioned AppImage moves to the new name; a stable name is replaced in place", () => {
  assert.equal(du.targetPath("/home/deck/Downloads/Desk-0.1.9-linux-x86_64.AppImage", NAME),
    path.join("/home/deck/Downloads", NAME));
  assert.equal(du.targetPath("/home/deck/Applications/Desk.AppImage", NAME), "/home/deck/Applications/Desk.AppImage");
});

test("check: newer release -> verified, swapped in, executable, relaunched", async () => {
  const cur = oldAppImage();
  let relaunched = "";
  const u = new du.DeskUpdater({ appimage: cur, version: "0.1.9", fetchImpl: fetcher(), env: {},
    relaunch: (p) => { relaunched = p; } });
  const r = await u.check();
  assert.equal(r.updated, true);
  assert.equal(r.restarted, true);
  const target = path.join(path.dirname(cur), NAME);
  assert.equal(relaunched, target);
  assert.equal(fs.readFileSync(target, "utf8"), NEW.toString());
  assert.equal(fs.existsSync(cur), false, "the old versioned AppImage was left behind");
  if (process.platform !== "win32") assert.ok(fs.statSync(target).mode & 0o100, "not executable");
});

test("check: a checksum mismatch installs nothing", async () => {
  const cur = oldAppImage();
  let relaunched = false;
  const u = new du.DeskUpdater({ appimage: cur, version: "0.1.9", env: {},
    fetchImpl: fetcher({ sums: `${"0".repeat(64)}  ${NAME}\n` }), relaunch: () => { relaunched = true; } });
  const r = await u.check();
  assert.equal(r.updated, false);
  assert.equal(r.reason, "checksum mismatch");
  assert.equal(fs.readFileSync(cur, "utf8"), "old");
  assert.equal(relaunched, false);
  assert.equal(fs.existsSync(path.join(path.dirname(cur), NAME)), false);
});

test("check: current version, no AppImage, or opted out -> nothing happens", async () => {
  const cur = oldAppImage();
  const relaunch = () => assert.fail("must not relaunch");
  assert.equal((await new du.DeskUpdater({ appimage: cur, version: "0.1.10", env: {}, fetchImpl: fetcher(), relaunch })
    .check()).reason, "current");
  assert.equal(await new du.DeskUpdater({ appimage: "", version: "0.1.9", env: {}, relaunch }).start(), false);
  assert.equal(new du.DeskUpdater({ appimage: cur, version: "0.1.9", env: { AWDESK_NO_UPDATE: "1" }, relaunch })
    .enabled(), false);
});

test("check: an install in progress defers the restart, the next check performs it", async () => {
  const cur = oldAppImage("Desk.AppImage");
  let busy = true;
  let relaunched = "";
  const u = new du.DeskUpdater({ appimage: cur, version: "0.1.9", env: {}, fetchImpl: fetcher(),
    canRestart: () => !busy, relaunch: (p) => { relaunched = p; } });
  const first = await u.check();
  assert.equal(first.restarted, false);
  assert.equal(relaunched, "");
  busy = false;
  const second = await u.check();
  assert.equal(second.restarted, true);
  assert.equal(relaunched, cur, "a stable name is replaced in place");
});
