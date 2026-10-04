"use strict";

/**
 * desk-update.cjs — Desk keeps itself current, with nothing for the owner to do.
 *
 * Until v0.1.10 Desk had NO update path: every fix reached a Steam Deck only if the owner
 * downloaded the AppImage again by hand (2026-10-04). Now a running AppImage checks the
 * latest GitHub release of Aitherium/awdesk shortly after start and every few hours; a
 * newer one is downloaded next to the running file, checked against the release's own
 * SHA256SUMS.txt (the install_awdesk rule in install.sh), made executable, swapped in by
 * rename and relaunched. The running process keeps the old inode, so the swap is safe.
 *
 * Only the AppImage updates itself: a .deb belongs to the package manager, Windows and
 * macOS installs to their installers. AWDESK_NO_UPDATE=1 turns it off.
 *
 * Electron-free and dependency-injected (desk-update.test.cjs).
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RELEASE_API = "https://api.github.com/repos/Aitherium/awdesk/releases/latest";
const ASSET_SUFFIX = "-linux-x86_64.AppImage";
const FIRST_CHECK_MS = 90_000;
const EVERY_MS = 6 * 3600 * 1000;

/** "v0.1.10" > "0.1.9"? Numeric, dotted; anything unparseable is never newer. Pure. */
function isNewer(tag, current) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
    return m ? m.slice(1).map(Number) : null;
  };
  const a = parse(tag);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The AppImage asset + sums URL of a release body, or null. Pure. */
function pickAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const app = assets.find((a) => String(a.name || "").endsWith(ASSET_SUFFIX));
  const sums = assets.find((a) => a.name === "SHA256SUMS.txt");
  if (!app || !sums) return null;
  return { tag: String(release.tag_name || ""), name: app.name, url: app.browser_download_url,
    sumsUrl: sums.browser_download_url };
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

class DeskUpdater {
  constructor({ appimage = process.env.APPIMAGE, version, fetchImpl = fetch, relaunch, canRestart = () => true,
    env = process.env, log = () => {}, setTimer = setTimeout, setRepeat = setInterval } = {}) {
    Object.assign(this, { appimage, version, fetchImpl, relaunch, canRestart, env, log, setTimer, setRepeat });
    this.busy = false;
    this.pending = "";
  }

  enabled() {
    return Boolean(this.appimage) && this.env.AWDESK_NO_UPDATE !== "1";
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
      const asset = pickAsset(await res.json());
      if (!asset) return { updated: false, reason: "no AppImage in the latest release" };
      if (!isNewer(asset.tag, this.version)) return { updated: false, reason: "current", tag: asset.tag };
      const sums = await this.fetchImpl(asset.sumsUrl, { headers: { "User-Agent": "aither-desk" } });
      const want = sums.status === 200 ? expectedHash(await sums.text(), asset.name) : "";
      if (!want) return { updated: false, reason: "no checksum for the AppImage" };
      const bin = await this.fetchImpl(asset.url, { headers: { "User-Agent": "aither-desk" } });
      if (bin.status !== 200) return { updated: false, reason: `download ${bin.status}` };
      const bytes = Buffer.from(await bin.arrayBuffer());
      const got = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (got !== want) return { updated: false, reason: "checksum mismatch" };
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
}

module.exports = { ASSET_SUFFIX, DeskUpdater, RELEASE_API, expectedHash, isNewer, pickAsset, targetPath };
