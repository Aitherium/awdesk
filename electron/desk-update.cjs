"use strict";

/**
 * desk-update.cjs — Desk keeps itself current, with nothing for the owner to do.
 *
 * Until v0.1.10 Desk had NO update path: every fix reached a Steam Deck only if the owner
 * downloaded the AppImage again by hand (2026-10-04). Now a running install checks the
 * latest GitHub release of Aitherium/awdesk shortly after start and every few hours, and
 * every byte it acts on is first checked against the release's own SHA256SUMS.txt (the
 * install_awdesk rule in install.sh). What happens next depends on how Desk was installed:
 *
 *   appimage  downloaded next to the running file, made executable, swapped in by rename
 *             and relaunched. The running process keeps the old inode, so the swap is safe.
 *   nsis      (Windows) the new Desk-*-windows-x64-setup.exe is downloaded and run with /S
 *             when Desk quits -- "Restart to update" quits now and the installer relaunches
 *             it (--force-run); a plain quit installs without relaunching.
 *   mac       the new .zip is downloaded and unpacked beside the running Desk.app, and the
 *             owner is offered "Restart to update". These builds are NOT signed by Apple,
 *             so there is no background self-replace: the bundle is swapped only after the
 *             owner clicks, by a script that waits for this process to exit. A bundle in a
 *             folder this user cannot write is never touched; the owner is shown the file.
 *   deb       belongs to the package manager (installing needs root): the owner is told a
 *             newer version exists and where to download it, once per version.
 *
 * Never a downgrade: only a strictly newer x.y.z tag is acted on. The owner turns it off
 * with the "Updates" checkbox in the cast pane (cast.json updates.enabled = false) or
 * AWDESK_NO_UPDATE=1.
 *
 * Electron-free and dependency-injected (desk-update.test.cjs).
 */

const childProcess = require("node:child_process");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RELEASE_API = "https://api.github.com/repos/Aitherium/awdesk/releases/latest";
const ASSET_SUFFIX = "-linux-x86_64.AppImage";
const FIRST_CHECK_MS = 90_000;
const EVERY_MS = 6 * 3600 * 1000;
const KINDS = Object.freeze(["appimage", "nsis", "mac", "deb"]);

/** "v0.1.10" > "0.1.9"? Numeric, dotted; the monorepo's "awdesk-v" tag prefix is allowed;
 *  anything unparseable (a pre-release included) is never newer. Pure. */
function isNewer(tag, current) {
  const parse = (v) => {
    const m = /^(?:awdesk-)?v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
    return m ? m.slice(1).map(Number) : null;
  };
  const a = parse(tag);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The .app bundle around a macOS executable (/Applications/Desk.app/Contents/MacOS/Desk ->
 *  /Applications/Desk.app), or "". Pure. */
function macBundle(exe) {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exe || ""));
  return m ? m[1] : "";
}

/** How THIS copy of Desk was installed, which decides how it updates; "" = it does not
 *  (a dev checkout, an unpacked build, an unknown layout). Pure. */
function installKind({ platform = process.platform, appimage = process.env.APPIMAGE, isPackaged = false,
  exe = "" } = {}) {
  if (platform === "linux") {
    if (appimage) return "appimage";
    // electron-builder's .deb installs to /opt/<productName>/ (release.yaml's smoke: /opt/Desk/desk)
    return isPackaged && String(exe).startsWith("/opt/") ? "deb" : "";
  }
  if (!isPackaged) return "";
  if (platform === "win32") return "nsis";
  if (platform === "darwin") return macBundle(exe) ? "mac" : "";
  return "";
}

/** The release asset suffix for an install kind on an arch, matching package.json's
 *  artifactName patterns (electron-builder spells x64 "x86_64" for AppImage, "amd64" for
 *  deb). "" for an arch Desk does not ship. Pure. */
function assetSuffix(kind, arch = process.arch) {
  if (arch !== "x64" && arch !== "arm64") return "";
  switch (kind) {
    case "appimage": return arch === "x64" ? ASSET_SUFFIX : "-linux-arm64.AppImage";
    case "deb": return arch === "x64" ? "-linux-amd64.deb" : "-linux-arm64.deb";
    case "nsis": return `-windows-${arch}-setup.exe`;
    case "mac": return `-macos-${arch}.zip`;
    default: return "";
  }
}

/** The installable asset + sums URL of a release body, or null. Pure. */
function pickAsset(release, suffix = ASSET_SUFFIX) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const app = suffix
    ? assets.find((a) => /^Desk-/.test(String(a.name || "")) && String(a.name).endsWith(suffix))
    : null;
  const sums = assets.find((a) => a.name === "SHA256SUMS.txt");
  if (!app || !sums) return null;
  return { tag: String(release.tag_name || ""), name: app.name, url: app.browser_download_url,
    sumsUrl: sums.browser_download_url, page: String(release.html_url || "") };
}

/** The expected hash of `name` in a SHA256SUMS.txt body (`<hex>  name` or `<hex> *name`). Pure. */
function expectedHash(sumsText, name) {
  for (const line of String(sumsText || "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return "";
}

/** Where the new AppImage goes: a versioned name moves to the new version's name, a stable
 *  name (install.sh's ~/Applications/Desk.AppImage) is replaced in place. Pure. */
function targetPath(current, assetName) {
  const base = path.basename(current);
  return /^Desk-\d+\.\d+\.\d+-linux/.test(base) ? path.join(path.dirname(current), assetName) : current;
}

/** The NSIS arguments: silent always; relaunch only when the owner asked to restart.
 *  --updated is electron-builder's "this is an update" flag (no first-run pages). Pure. */
function installerArgs({ relaunch }) {
  return relaunch ? ["/S", "--updated", "--force-run"] : ["/S", "--updated"];
}

/** The detached swap for an unsigned Mac bundle: wait for Desk (pid $1) to exit, move the
 *  old bundle aside, move the staged one in (putting the old one back if that fails), open
 *  it. Paths travel as positional arguments, never spliced into the script text. */
const MAC_SWAP_SCRIPT = [
  'pid="$1"; app="$2"; staged="$3"',
  'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
  'rm -rf "$app.old"',
  'if mv "$app" "$app.old" && mv "$staged" "$app"; then rm -rf "$app.old"; else [ -d "$app" ] || mv "$app.old" "$app"; fi',
  'rmdir "$(dirname "$staged")" 2>/dev/null',
  'open "$app"',
].join("\n");

/** ditto keeps the bundle's symlinks, modes and signature layout; unzip(1) does not. */
function defaultUnzip(zip, dir) {
  return new Promise((resolve, reject) => {
    childProcess.execFile("/usr/bin/ditto", ["-x", "-k", zip, dir], (err) => (err ? reject(err) : resolve()));
  });
}

class DeskUpdater {
  constructor({ kind, appimage = process.env.APPIMAGE, exe = "", arch = process.arch, version, fetchImpl = fetch,
    relaunch, quit = () => {}, notify = () => {}, canRestart = () => true, allowed = () => true,
    env = process.env, log = () => {}, setTimer = setTimeout, setRepeat = setInterval,
    downloadDir = path.join(os.tmpdir(), "desk-update"), spawnImpl = childProcess.spawn,
    unzip = defaultUnzip, pid = process.pid } = {}) {
    if (kind === undefined) kind = appimage ? "appimage" : "";
    Object.assign(this, { kind, appimage, exe, arch, version, fetchImpl, relaunch, quit, notify, canRestart,
      allowed, env, log, setTimer, setRepeat, downloadDir, spawnImpl, unzip, pid });
    this.busy = false;
    this.pending = "";
    this.staged = null; // nsis / mac: { tag, file, ... } waiting for a quit or a click
    this.noticed = ""; // deb: the tag already announced, so the owner hears it once
  }

  /** Re-asked on every tick, so turning the setting off stops the next check, no restart. */
  enabled() {
    if (!KINDS.includes(this.kind)) return false;
    if (this.kind === "appimage" && !this.appimage) return false;
    if (this.kind === "mac" && !macBundle(this.exe)) return false;
    if (this.env.AWDESK_NO_UPDATE === "1") return false;
    try { return this.allowed() !== false; } catch { return true; }
  }

  start() {
    if (!this.enabled()) return false;
    const tick = () => { void this.check(); };
    const t = this.setTimer(tick, FIRST_CHECK_MS);
    if (t && t.unref) t.unref();
    const r = this.setRepeat(tick, EVERY_MS);
    if (r && r.unref) r.unref();
    return true;
  }

  /** One check. Resolves { updated, tag, reason }. Never throws. */
  async check() {
    if (!this.enabled()) return { updated: false, reason: "disabled" };
    if (this.pending) return this.maybeRestart();
    if (this.busy) return { updated: false, reason: "busy" };
    this.busy = true;
    try {
      const res = await this.fetchImpl(RELEASE_API, { headers: { "User-Agent": "aither-desk",
        Accept: "application/vnd.github+json" } });
      if (res.status !== 200) return { updated: false, reason: `release API ${res.status}` };
      const suffix = assetSuffix(this.kind, this.arch);
      const asset = pickAsset(await res.json(), suffix);
      if (!asset) return { updated: false, reason: `no ${suffix || this.kind} in the latest release` };
      if (!isNewer(asset.tag, this.version)) return { updated: false, reason: "current", tag: asset.tag };
      if (this.staged && this.staged.tag === asset.tag) return { updated: false, tag: asset.tag, reason: "staged" };
      if (this.kind === "deb") return this.announce(asset);
      const sums = await this.fetchImpl(asset.sumsUrl, { headers: { "User-Agent": "aither-desk" } });
      const want = sums.status === 200 ? expectedHash(await sums.text(), asset.name) : "";
      if (!want) return { updated: false, reason: `no checksum for ${asset.name}` };
      const bin = await this.fetchImpl(asset.url, { headers: { "User-Agent": "aither-desk" } });
      if (bin.status !== 200) return { updated: false, reason: `download ${bin.status}` };
      const bytes = Buffer.from(await bin.arrayBuffer());
      const got = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (got !== want) return { updated: false, reason: "checksum mismatch" };
      if (this.kind === "nsis") return this.stageInstaller(asset, bytes);
      if (this.kind === "mac") return await this.stageBundle(asset, bytes);
      const target = targetPath(this.appimage, asset.name);
      const tmp = `${target}.part`;
      fs.writeFileSync(tmp, bytes, { mode: 0o755 });
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, target);
      if (target !== this.appimage) {
        try { fs.unlinkSync(this.appimage); } catch { /* the old file is harmless */ }
      }
      this.pending = target;
      this.log(`desk-update: ${asset.tag} installed at ${target}`);
      return this.maybeRestart(asset.tag);
    } catch (e) {
      return { updated: false, reason: e && e.message ? e.message : String(e) };
    } finally {
      this.busy = false;
    }
  }

  /** Relaunch into the new AppImage now, unless something must not be interrupted. */
  maybeRestart(tag = "") {
    if (!this.pending) return { updated: false, reason: "nothing pending" };
    if (!this.canRestart()) return { updated: true, tag, restarted: false, reason: "waiting for a quiet moment" };
    const target = this.pending;
    this.pending = "";
    this.relaunch(target);
    return { updated: true, tag, restarted: true };
  }

  /** A verified download, written whole before it gets its real name. */
  writeVerified(name, bytes) {
    fs.mkdirSync(this.downloadDir, { recursive: true });
    // One installer at a time: an older one already ran, or this one supersedes it.
    for (const old of fs.readdirSync(this.downloadDir)) {
      if (old.startsWith("Desk-") && old !== name) {
        try { fs.rmSync(path.join(this.downloadDir, old), { force: true }); } catch { /* in use; next time */ }
      }
    }
    const file = path.join(this.downloadDir, name);
    fs.writeFileSync(`${file}.part`, bytes);
    fs.renameSync(`${file}.part`, file);
    return file;
  }

  /** Windows: keep the verified installer for the quit (installOnQuit) or the click (restartNow). */
  stageInstaller(asset, bytes) {
    const file = this.writeVerified(asset.name, bytes);
    this.staged = { tag: asset.tag, file };
    this.log(`desk-update: ${asset.tag} installer verified at ${file}; it runs when Desk quits`);
    this.notify({ kind: "nsis", tag: asset.tag, file, action: "restart" });
    return { updated: true, tag: asset.tag, restarted: false, reason: "installs on quit" };
  }

  /** macOS: unpack the verified zip next to the running bundle, so the swap is a rename on
   *  one volume. A folder this user cannot write (an admin-owned /Applications) gets no
   *  swap: the owner is shown the verified zip instead. */
  async stageBundle(asset, bytes) {
    const bundle = macBundle(this.exe);
    const file = this.writeVerified(asset.name, bytes);
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    } catch {
      this.staged = { tag: asset.tag, file, bundle: "" };
      this.notify({ kind: "mac", tag: asset.tag, file, action: "reveal" });
      return { updated: false, tag: asset.tag, reason: `${path.dirname(bundle)} is not writable; showed the download` };
    }
    // A staged version the owner never restarted into is a whole second Desk.app (and a
    // second registration of its bundle id): only the newest one stays.
    for (const old of fs.readdirSync(path.dirname(bundle))) {
      if (old.startsWith(".desk-update-")) fs.rmSync(path.join(path.dirname(bundle), old), { recursive: true, force: true });
    }
    const dir = path.join(path.dirname(bundle), `.desk-update-${asset.tag}`);
    fs.mkdirSync(dir, { recursive: true });
    await this.unzip(file, dir);
    const staged = path.join(dir, path.basename(bundle));
    if (!fs.existsSync(path.join(staged, "Contents", "MacOS"))) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { updated: false, tag: asset.tag, reason: `the zip holds no ${path.basename(bundle)}` };
    }
    this.staged = { tag: asset.tag, file, bundle: staged, dir };
    this.log(`desk-update: ${asset.tag} verified and unpacked at ${staged}; waiting for "Restart to update"`);
    this.notify({ kind: "mac", tag: asset.tag, file, action: "restart" });
    return { updated: true, tag: asset.tag, restarted: false, reason: "waiting for the owner" };
  }

  /** .deb: say so once per version, with where to get it. Nothing is downloaded or run. */
  announce(asset) {
    if (this.noticed === asset.tag) return { updated: false, tag: asset.tag, reason: "announced" };
    this.noticed = asset.tag;
    this.notify({ kind: "deb", tag: asset.tag, url: asset.url, page: asset.page, action: "open" });
    return { updated: false, tag: asset.tag, reason: "announced" };
  }

  /** "Restart to update" (the notification click). Resolves what it did; never throws. */
  restartNow() {
    try {
      if (this.kind === "appimage") return this.maybeRestart();
      if (!this.staged) return { restarted: false, reason: "nothing staged" };
      if (this.kind === "nsis") {
        const { tag } = this.staged;
        this.runInstaller({ relaunch: true });
        this.quit();
        return { restarted: true, tag };
      }
      if (this.kind === "mac" && this.staged.bundle) {
        const { tag } = this.staged;
        const child = this.spawnImpl("/bin/sh", ["-c", MAC_SWAP_SCRIPT, "desk-update", String(this.pid),
          macBundle(this.exe), this.staged.bundle], { detached: true, stdio: "ignore" });
        if (child && child.unref) child.unref();
        this.staged = null;
        this.quit();
        return { restarted: true, tag };
      }
      return { restarted: false, reason: "no swap for this install" };
    } catch (e) {
      return { restarted: false, reason: e && e.message ? e.message : String(e) };
    }
  }

  /** Windows: a quit with a verified installer waiting runs it silently, no relaunch. Not
   *  while Windows is logging off or shutting down: the OS can kill the installer between
   *  removing the old Desk and laying down the new one, so it stays staged for a later quit. */
  installOnQuit({ sessionEnding = false } = {}) {
    if (this.kind !== "nsis" || !this.staged) return false;
    if (sessionEnding) {
      this.log(`desk-update: the session is ending; the ${this.staged.tag} installer waits for the next quit`);
      return false;
    }
    try { return this.runInstaller({ relaunch: false }); } catch { return false; }
  }

  runInstaller({ relaunch }) {
    const { file, tag } = this.staged;
    this.staged = null;
    const child = this.spawnImpl(file, installerArgs({ relaunch }), { detached: true, stdio: "ignore",
      windowsHide: true });
    if (child && child.unref) child.unref();
    this.log(`desk-update: running the ${tag} installer silently${relaunch ? " and relaunching" : ""}`);
    return true;
  }
}

/** The tray's "Restart to update" line while a Windows or Mac update is staged; none
 *  otherwise. The notification is easy to miss (or denied) on a dock-less Mac Desk, and
 *  restartNow is the only way a Mac update is ever applied. Pure. */
function updateTrayItems(staged, kind, restartNow) {
  if (!staged || !(kind === "nsis" || (kind === "mac" && staged.bundle))) return [];
  const version = String(staged.tag || "").replace(/^(?:awdesk-)?v/, "");
  return [{ label: `Restart to update (${version})`, click: () => restartNow() }];
}

const RELEASES_PAGE = "https://github.com/Aitherium/awdesk/releases";

/** A release URL from the API, opened only when it is on Desk's own releases; anything
 *  else (another host, file:, a custom scheme) becomes the fixed releases page. Pure. */
function safeReleaseUrl(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return RELEASES_PAGE; }
  if (u.protocol !== "https:" || u.host !== "github.com" || !u.pathname.startsWith("/Aitherium/awdesk/")) {
    return RELEASES_PAGE;
  }
  return u.href;
}

module.exports = { ASSET_SUFFIX, DeskUpdater, KINDS, MAC_SWAP_SCRIPT, RELEASE_API, assetSuffix, expectedHash,
  RELEASES_PAGE, installKind, installerArgs, isNewer, macBundle, pickAsset, safeReleaseUrl, targetPath,
  updateTrayItems };
