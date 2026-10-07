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

// ─── Windows / macOS / .deb ─────────────────────────────────────────────

const WIN = "Desk-0.1.10-windows-x64-setup.exe";
const MAC = "Desk-0.1.10-macos-arm64.zip";
const DEB = "Desk-0.1.10-linux-amd64.deb";

function fullRelease(tag = "v0.1.10") {
  return { tag_name: tag, html_url: `https://github.com/Aitherium/awdesk/releases/tag/${tag}`, assets: [
    ...[NAME, WIN, MAC, DEB, "Desk-0.1.10-macos-arm64.dmg", "Desk-0.1.10-macos-x64.zip"]
      .map((n) => ({ name: n, browser_download_url: `https://dl/${n}` })),
    { name: "SHA256SUMS.txt", browser_download_url: "https://dl/SHA256SUMS.txt" },
  ] };
}

function anyFetcher({ rel = fullRelease(), sums = null, bytes = NEW, seen = [] } = {}) {
  return async (url) => {
    seen.push(url);
    if (url === du.RELEASE_API) return { status: 200, json: async () => rel };
    if (url.endsWith("SHA256SUMS.txt")) {
      return { status: 200, text: async () => sums ?? [WIN, MAC, DEB].map((n) => `${NEW_SHA}  ${n}`).join("\n") };
    }
    if (url.startsWith("https://dl/Desk-")) return { status: 200, arrayBuffer: async () => bytes };
    return { status: 404 };
  };
}

function spawnRecorder() {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; };
  return { calls, spawnImpl };
}

/** A fake Mac install: <tmp>/Desk.app/Contents/MacOS/Desk, POSIX-spelled like a real one. */
function macInstall() {
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), "du-mac-"));
  const posixApps = apps.replace(/\\/g, "/");
  return { apps, posixApps, exe: `${posixApps}/Desk.app/Contents/MacOS/Desk` };
}

test("installKind reads how this copy was installed", () => {
  assert.equal(du.installKind({ platform: "linux", appimage: "/x/Desk.AppImage" }), "appimage");
  assert.equal(du.installKind({ platform: "linux", appimage: "", isPackaged: true, exe: "/opt/Desk/desk" }), "deb");
  assert.equal(du.installKind({ platform: "linux", appimage: "", isPackaged: false, exe: "/opt/Desk/desk" }), "");
  assert.equal(du.installKind({ platform: "win32", appimage: "", isPackaged: true, exe: "C:\\Desk\\Desk.exe" }), "nsis");
  assert.equal(du.installKind({ platform: "win32", appimage: "", isPackaged: false }), "", "a dev run never updates");
  assert.equal(du.installKind({ platform: "darwin", appimage: "", isPackaged: true,
    exe: "/Applications/Desk.app/Contents/MacOS/Desk" }), "mac");
  assert.equal(du.installKind({ platform: "darwin", appimage: "", isPackaged: true, exe: "/usr/local/bin/desk" }), "");
});

test("assetSuffix + pickAsset choose the one installer for this install and arch", () => {
  const rel = fullRelease();
  assert.equal(du.pickAsset(rel, du.assetSuffix("appimage", "x64")).name, NAME);
  assert.equal(du.pickAsset(rel, du.assetSuffix("nsis", "x64")).name, WIN);
  assert.equal(du.pickAsset(rel, du.assetSuffix("mac", "arm64")).name, MAC, "the zip, never the dmg");
  assert.equal(du.pickAsset(rel, du.assetSuffix("mac", "x64")).name, "Desk-0.1.10-macos-x64.zip");
  assert.equal(du.pickAsset(rel, du.assetSuffix("deb", "x64")).name, DEB);
  assert.equal(du.pickAsset(rel, du.assetSuffix("nsis", "arm64")), null, "no arm64 Windows build is shipped");
  assert.equal(du.assetSuffix("nsis", "ia32"), "");
  assert.equal(du.pickAsset(rel, ""), null);
  assert.equal(du.pickAsset({ ...rel, assets: rel.assets.filter((a) => a.name !== "SHA256SUMS.txt") },
    du.assetSuffix("nsis", "x64")), null, "no sums, no update");
});

test("isNewer accepts the monorepo's awdesk-v tag and never downgrades", () => {
  assert.equal(du.isNewer("awdesk-v0.1.13", "0.1.12"), true);
  assert.equal(du.isNewer("awdesk-v0.1.12", "0.1.12"), false);
  assert.equal(du.isNewer("v0.2.0", "0.10.0"), false);
  assert.equal(du.isNewer("v1.0.0", "0.99.99"), true);
});

test("check: an older latest release is never installed", async () => {
  const { calls, spawnImpl } = spawnRecorder();
  const seen = [];
  const u = new du.DeskUpdater({ kind: "nsis", arch: "x64", version: "0.1.11", env: {}, spawnImpl,
    fetchImpl: anyFetcher({ seen }), notify: () => assert.fail("no notice for a downgrade") });
  assert.equal((await u.check()).reason, "current");
  assert.deepEqual(seen, [du.RELEASE_API], "nothing downloaded");
  assert.equal(u.installOnQuit(), false);
  assert.equal(calls.length, 0);
});

test("Windows: a newer verified installer is staged, runs silently on quit, never relaunches unasked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "du-win-"));
  const { calls, spawnImpl } = spawnRecorder();
  const notes = [];
  const u = new du.DeskUpdater({ kind: "nsis", arch: "x64", version: "0.1.9", env: {}, fetchImpl: anyFetcher(),
    downloadDir: dir, spawnImpl, notify: (n) => notes.push(n) });
  assert.equal(u.enabled(), true);
  const r = await u.check();
  assert.equal(r.updated, true, r.reason);
  assert.equal(calls.length, 0, "nothing runs while Desk is up");
  assert.equal(fs.readFileSync(path.join(dir, WIN), "utf8"), NEW.toString());
  assert.deepEqual(notes.map((n) => [n.kind, n.action, n.tag]), [["nsis", "restart", "v0.1.10"]]);
  assert.equal((await u.check()).reason, "staged", "a staged version is not downloaded again");
  assert.equal(u.installOnQuit(), true);
  assert.equal(calls[0].cmd, path.join(dir, WIN));
  assert.deepEqual(calls[0].args, ["/S", "--updated"]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(u.installOnQuit(), false, "once");
});

test("Windows: Restart to update runs the installer with --force-run and quits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "du-win-"));
  const { calls, spawnImpl } = spawnRecorder();
  let quit = 0;
  const u = new du.DeskUpdater({ kind: "nsis", arch: "x64", version: "0.1.9", env: {}, fetchImpl: anyFetcher(),
    downloadDir: dir, spawnImpl, quit: () => { quit += 1; } });
  await u.check();
  assert.equal(u.restartNow().restarted, true);
  assert.deepEqual(calls[0].args, ["/S", "--updated", "--force-run"]);
  assert.equal(quit, 1);
  assert.equal(u.installOnQuit(), false, "the quit that follows does not run it twice");
});

test("Windows: a bad checksum stages nothing and runs nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "du-win-"));
  const { calls, spawnImpl } = spawnRecorder();
  const u = new du.DeskUpdater({ kind: "nsis", arch: "x64", version: "0.1.9", env: {}, downloadDir: dir, spawnImpl,
    fetchImpl: anyFetcher({ sums: `${"0".repeat(64)}  ${WIN}\n` }) });
  assert.equal((await u.check()).reason, "checksum mismatch");
  assert.equal(fs.existsSync(path.join(dir, WIN)), false);
  assert.equal(u.installOnQuit(), false);
  assert.equal(u.restartNow().restarted, false);
  assert.equal(calls.length, 0);
});

test("opt-out: the setting (re-read every tick) and the env both stop every platform", async () => {
  let on = true;
  const seen = [];
  const u = new du.DeskUpdater({ kind: "nsis", arch: "x64", version: "0.1.9", env: {},
    fetchImpl: anyFetcher({ seen }), allowed: () => on });
  assert.equal(u.enabled(), true);
  on = false;
  assert.equal((await u.check()).reason, "disabled");
  assert.equal(seen.length, 0, "not even the release API is asked");
  assert.equal(new du.DeskUpdater({ kind: "mac", exe: "/Applications/Desk.app/Contents/MacOS/Desk",
    env: { AWDESK_NO_UPDATE: "1" } }).enabled(), false);
  assert.equal(new du.DeskUpdater({ kind: "deb", env: {}, allowed: () => false }).start(), false);
});

test("macOS: verified zip unpacked beside the bundle, swapped only on Restart to update", async () => {
  const { apps, posixApps, exe } = macInstall();
  const unzipped = [];
  const unzip = async (zip, dir) => {
    unzipped.push(zip);
    fs.mkdirSync(path.join(dir, "Desk.app", "Contents", "MacOS"), { recursive: true });
  };
  const { calls, spawnImpl } = spawnRecorder();
  const notes = [];
  let quit = 0;
  const u = new du.DeskUpdater({ kind: "mac", exe, arch: "arm64", version: "0.1.9", env: {}, pid: 4242,
    fetchImpl: anyFetcher(), downloadDir: path.join(apps, "dl"), unzip, spawnImpl,
    notify: (n) => notes.push(n), quit: () => { quit += 1; } });
  const r = await u.check();
  assert.equal(r.updated, true, r.reason);
  assert.equal(path.basename(unzipped[0]), MAC);
  assert.deepEqual(notes.map((n) => n.action), ["restart"]);
  assert.equal(calls.length, 0, "an unsigned bundle is never swapped in the background");
  const staged = u.staged.bundle;
  assert.equal(staged, path.join(posixApps, ".desk-update-v0.1.10", "Desk.app"));
  assert.equal(u.restartNow().restarted, true);
  assert.equal(calls[0].cmd, "/bin/sh");
  assert.equal(calls[0].args[1], du.MAC_SWAP_SCRIPT);
  assert.deepEqual(calls[0].args.slice(3), ["4242", `${posixApps}/Desk.app`, staged]);
  assert.equal(quit, 1);
});

test("macOS: a zip without the bundle is refused", async () => {
  const { apps, exe } = macInstall();
  const u = new du.DeskUpdater({ kind: "mac", exe, arch: "arm64", version: "0.1.9", env: {},
    fetchImpl: anyFetcher(), downloadDir: path.join(apps, "dl"), unzip: async () => {} });
  const r = await u.check();
  assert.equal(r.updated, false);
  assert.match(r.reason, /holds no Desk\.app/);
  assert.equal(u.restartNow().restarted, false);
});

test(".deb: announced once per version with the download, nothing fetched or run", async () => {
  const seen = [];
  const notes = [];
  const { calls, spawnImpl } = spawnRecorder();
  const u = new du.DeskUpdater({ kind: "deb", arch: "x64", version: "0.1.9", env: {}, spawnImpl,
    fetchImpl: anyFetcher({ seen }), notify: (n) => notes.push(n) });
  await u.check();
  await u.check();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].url, `https://dl/${DEB}`);
  assert.match(notes[0].page, /releases\/tag\/v0\.1\.10$/);
  assert.ok(seen.every((url) => url === du.RELEASE_API), "the .deb itself is never downloaded");
  assert.equal(calls.length, 0);
});

// ─── cleanup, shutdown, the tray line, opened URLs ──────────────────────

/** A release of `v` whose Windows and arm64 Mac assets all verify against NEW. */
function releaseOf(v) {
  const names = [`Desk-${v}-windows-x64-setup.exe`, `Desk-${v}-macos-arm64.zip`];
  const rel = { tag_name: `v${v}`, assets: [...names.map((n) => ({ name: n, browser_download_url: `https://dl/${n}` })),
    { name: "SHA256SUMS.txt", browser_download_url: "https://dl/SHA256SUMS.txt" }] };
  return anyFetcher({ rel, sums: names.map((n) => `${NEW_SHA}  ${n}`).join("\n") });
}

test("Windows: a newer download replaces the older installer instead of piling up", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "du-win-"));
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "kept");
  const u = new du.DeskUpdater({ kind: "nsis", arch: "x64", version: "0.1.9", env: {}, downloadDir: dir,
    spawnImpl: spawnRecorder().spawnImpl, fetchImpl: releaseOf("0.1.10") });
  assert.equal((await u.check()).updated, true);
  u.fetchImpl = releaseOf("0.1.11");
  assert.equal((await u.check()).updated, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["Desk-0.1.11-windows-x64-setup.exe", "unrelated.txt"]);
  assert.equal(u.staged.tag, "v0.1.11");
});

test("macOS: a newer staged version removes the older staged bundle and download", async () => {
  const { apps, exe } = macInstall();
  fs.mkdirSync(path.join(apps, "Desk.app"));
  const unzip = async (zip, dir) => fs.mkdirSync(path.join(dir, "Desk.app", "Contents", "MacOS"), { recursive: true });
  const dl = path.join(apps, "dl");
  const u = new du.DeskUpdater({ kind: "mac", exe, arch: "arm64", version: "0.1.9", env: {}, downloadDir: dl,
    unzip, fetchImpl: releaseOf("0.1.10") });
  assert.equal((await u.check()).updated, true);
  assert.ok(fs.existsSync(path.join(apps, ".desk-update-v0.1.10", "Desk.app")));
  u.fetchImpl = releaseOf("0.1.11");
  assert.equal((await u.check()).updated, true);
  assert.equal(fs.existsSync(path.join(apps, ".desk-update-v0.1.10")), false, "the stale bundle is gone");
  assert.ok(fs.existsSync(path.join(apps, ".desk-update-v0.1.11", "Desk.app")));
  assert.deepEqual(fs.readdirSync(dl), ["Desk-0.1.11-macos-arm64.zip"]);
});

test("the Mac swap script removes its emptied staging dir", () => {
  assert.match(du.MAC_SWAP_SCRIPT, /rmdir "\$\(dirname "\$staged"\)"/);
  assert.ok(du.MAC_SWAP_SCRIPT.indexOf("rmdir") < du.MAC_SWAP_SCRIPT.indexOf("open "), "cleaned before reopening");
});

test("Windows: a logoff or shutdown leaves the installer staged for a later quit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "du-win-"));
  const { calls, spawnImpl } = spawnRecorder();
  const u = new du.DeskUpdater({ kind: "nsis", arch: "x64", version: "0.1.9", env: {}, fetchImpl: anyFetcher(),
    downloadDir: dir, spawnImpl });
  await u.check();
  assert.equal(u.installOnQuit({ sessionEnding: true }), false);
  assert.equal(calls.length, 0, "never started while the OS is tearing the session down");
  assert.equal(u.staged.tag, "v0.1.10");
  assert.equal(u.installOnQuit(), true);
  assert.deepEqual(calls[0].args, ["/S", "--updated"]);
});

test("updateTrayItems: a Restart to update line only while something can be restarted into", () => {
  let clicked = 0;
  const go = () => { clicked += 1; };
  assert.deepEqual(du.updateTrayItems(null, "mac", go), []);
  assert.deepEqual(du.updateTrayItems({ tag: "v0.1.10", bundle: "" }, "mac", go), [], "a reveal-only Mac has no swap");
  assert.deepEqual(du.updateTrayItems({ tag: "v0.1.10" }, "deb", go), []);
  const [mac] = du.updateTrayItems({ tag: "v0.1.10", bundle: "/A/.desk-update-v0.1.10/Desk.app" }, "mac", go);
  assert.equal(mac.label, "Restart to update (0.1.10)");
  mac.click();
  const [win] = du.updateTrayItems({ tag: "awdesk-v0.1.11", file: "x" }, "nsis", go);
  assert.equal(win.label, "Restart to update (0.1.11)");
  win.click();
  assert.equal(clicked, 2);
});

test("safeReleaseUrl opens only Desk's own GitHub release pages", () => {
  const ok = "https://github.com/Aitherium/awdesk/releases/tag/v0.1.10";
  assert.equal(du.safeReleaseUrl(ok), ok);
  assert.equal(du.safeReleaseUrl("https://github.com/Aitherium/awdesk/releases/download/v0.1.10/x.deb"),
    "https://github.com/Aitherium/awdesk/releases/download/v0.1.10/x.deb");
  for (const bad of ["file:///etc/passwd", "http://github.com/Aitherium/awdesk/releases", "smb://host/share",
    "https://github.com.evil.example/Aitherium/awdesk/", "https://github.com/Aitherium/awdeskx/", "", undefined,
    "https://user@github.com:444/Aitherium/awdesk/"]) {
    assert.equal(du.safeReleaseUrl(bad), du.RELEASES_PAGE, String(bad));
  }
});
