"use strict";

/**
 * browser-webstore.cjs -- install a Chrome Web Store or Edge Add-ons extension by URL or id.
 *
 * The Aither Browser loads UNPACKED extension folders (extensions-window.cjs). This module
 * turns a store link into such a folder: it downloads the store's .crx, strips the CRX2/CRX3
 * header to the ZIP inside, and extracts it with a small built-in ZIP reader (no new
 * dependency) into <dir>/<id>/<version>. Extraction is zip-slip safe and size-capped.
 * Chromium's `_metadata/` (verified_contents) is dropped; Electron does not read it.
 * Permissions Electron supports poorly come back as warnings so the page can say
 * "may not fully work" instead of pretending.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ID_RE = /^[a-p]{32}$/;
const VERSION_RE = /^\d{1,9}(\.\d{1,9}){0,3}$/;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const INSTALL_RECORD = ".aither-install.json";

/** Permissions Electron implements partly or not at all, with the reason the page shows. */
const WEAK_PERMISSIONS = {
  declarativeNetRequest: "declarativeNetRequest is not implemented by Electron; blocking rules will not apply",
  declarativeNetRequestWithHostAccess: "declarativeNetRequest is not implemented by Electron; blocking rules will not apply",
  declarativeNetRequestFeedback: "declarativeNetRequest is not implemented by Electron; blocking rules will not apply",
  sidePanel: "sidePanel is not implemented by Electron; the side panel will not open",
  offscreen: "offscreen documents are not implemented by Electron",
  identity: "identity (Google sign-in for extensions) is not implemented by Electron",
  webNavigation: "webNavigation is only partly implemented by Electron",
};

/**
 * Extract the 32-char extension id from a raw id or a store URL.
 * @param {string} input raw id, chromewebstore.google.com/detail/<slug>/<id>,
 *   chrome.google.com/webstore/detail/<slug>/<id>, or microsoftedge.microsoft.com/addons/detail/<slug>/<id>
 * @returns {{ok: true, id: string, store: "chrome"|"edge"} | {ok: false, error: string}}
 */
function parseExtensionId(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return { ok: false, error: "empty input" };
  if (ID_RE.test(raw)) return { ok: true, id: raw, store: "chrome" };
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "not an extension id or store URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "not a store URL" };
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let store = null;
  let rest = null;
  if (host === "chromewebstore.google.com" && parts[0] === "detail") {
    store = "chrome"; rest = parts.slice(1);
  } else if (host === "chrome.google.com" && parts[0] === "webstore" && parts[1] === "detail") {
    store = "chrome"; rest = parts.slice(2);
  } else if (host === "microsoftedge.microsoft.com" && parts[0] === "addons" && parts[1] === "detail") {
    store = "edge"; rest = parts.slice(2);
  }
  if (!store) return { ok: false, error: `not a Chrome Web Store or Edge Add-ons URL: ${host}` };
  const id = rest.map((p) => p.toLowerCase()).find((p) => ID_RE.test(p));
  return id ? { ok: true, id, store } : { ok: false, error: "no extension id in the URL" };
}

/**
 * The store's CRX download URL for an id.
 * @param {string} id 32-char extension id
 * @param {"chrome"|"edge"} [store]
 * @param {{prodversion?: string}} [opts]
 * @returns {string}
 */
function crxUrl(id, store = "chrome", { prodversion = "142.0.0.0" } = {}) {
  if (!ID_RE.test(String(id))) throw new Error(`bad extension id: ${id}`);
  if (store === "edge") {
    return `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=id%3D${id}%26installsource%3Dondemand%26uc`;
  }
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(prodversion)}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
}

/**
 * Strip a CRX2 or CRX3 header and return the ZIP payload.
 * @param {Buffer} buffer the .crx bytes
 * @returns {Buffer}
 */
function crxToZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "Cr24") throw new Error("not a CRX file (bad magic)");
  const version = buf.readUInt32LE(4);
  let start;
  if (version === 3) {
    start = 12 + buf.readUInt32LE(8);
  } else if (version === 2) {
    start = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  } else {
    throw new Error(`unsupported CRX version ${version}`);
  }
  if (start + 4 > buf.length) throw new Error("CRX header runs past the end of the file");
  return buf.subarray(start);
}

/** A ZIP entry name made safe, or null when it would escape the destination. */
function safeEntryName(name) {
  if (!name || name.includes("\0")) return null;
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return null;
  const segs = n.split("/");
  if (segs.some((s) => s === "..")) return null;
  return segs.filter((s) => s && s !== ".").join("/");
}

function readEntries(zip, maxBytes, maxEntries) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no end of central directory)");
  const count = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (count > maxEntries) throw new Error(`too many entries (${count} > ${maxEntries})`);
  const entries = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt ZIP central directory");
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const rawName = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error(`encrypted entry: ${rawName}`);
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression method ${method}: ${rawName}`);
    const name = safeEntryName(rawName);
    if (name === null) throw new Error(`unsafe path in ZIP (zip-slip): ${rawName}`);
    total += size;
    if (total > maxBytes) throw new Error(`ZIP expands past ${maxBytes} bytes`);
    entries.push({ name, isDir: rawName.endsWith("/") || rawName.endsWith("\\"), method, crc, compSize, size, localOffset });
  }
  return entries;
}

function entryData(zip, e) {
  const lo = e.localOffset;
  if (lo + 30 > zip.length || zip.readUInt32LE(lo) !== 0x04034b50) throw new Error(`corrupt local header: ${e.name}`);
  const start = lo + 30 + zip.readUInt16LE(lo + 26) + zip.readUInt16LE(lo + 28);
  if (start + e.compSize > zip.length) throw new Error(`entry runs past the end of the ZIP: ${e.name}`);
  const comp = zip.subarray(start, start + e.compSize);
  const data = e.method === 0 ? comp : zlib.inflateRawSync(comp, { maxOutputLength: Math.max(1, e.size) });
  if (data.length !== e.size) throw new Error(`size mismatch: ${e.name}`);
  if (typeof zlib.crc32 === "function" && (zlib.crc32(data) >>> 0) !== e.crc) throw new Error(`CRC mismatch: ${e.name}`);
  return data;
}

/**
 * Extract a ZIP into destDir. Every entry is validated before anything is written: absolute
 * paths, drive letters and `..` segments are rejected, as are archives that expand past
 * `maxBytes` or hold more than `maxEntries` entries.
 * @param {Buffer} zipBuffer
 * @param {string} destDir
 * @param {{fsImpl?: typeof fs, maxBytes?: number, maxEntries?: number}} [opts]
 * @returns {{files: number, bytes: number}}
 */
function unzipTo(zipBuffer, destDir, { fsImpl = fs, maxBytes = MAX_UNZIPPED_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  const zip = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  const root = path.resolve(destDir);
  const entries = readEntries(zip, maxBytes, maxEntries);
  const planned = entries.map((e) => {
    const target = path.resolve(root, e.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in ZIP (zip-slip): ${e.name}`);
    return { e, target };
  });
  fsImpl.mkdirSync(root, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const { e, target } of planned) {
    if (e.isDir || !e.name) { fsImpl.mkdirSync(target, { recursive: true }); continue; }
    const data = entryData(zip, e);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(target, data);
    files++;
    bytes += data.length;
  }
  return { files, bytes };
}

/** Resolve a `__MSG_name__` manifest string from the default locale. */
function localized(value, extDir, manifest, fsImpl) {
  const m = /^__MSG_(.+)__$/.exec(String(value || ""));
  if (!m || !manifest.default_locale) return value;
  try {
    const file = path.join(extDir, "_locales", String(manifest.default_locale), "messages.json");
    const msgs = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    const key = Object.keys(msgs).find((k) => k.toLowerCase() === m[1].toLowerCase());
    return key && msgs[key] && msgs[key].message ? msgs[key].message : value;
  } catch {
    return value;
  }
}

/**
 * Permissions in a manifest that Electron does not fully support.
 * @param {object} manifest
 * @returns {string[]}
 */
function permissionWarnings(manifest) {
  const perms = new Set(
    [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].filter((p) => typeof p === "string"),
  );
  if (manifest.side_panel) perms.add("sidePanel");
  return [...new Set([...perms].filter((p) => WEAK_PERMISSIONS[p]).map((p) => WEAK_PERMISSIONS[p]))];
}

async function download(url, fetchImpl) {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res || !res.ok) throw new Error(`download failed: HTTP ${res ? res.status : "no response"}`);
  const len = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`download too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`download too large (${buf.length} bytes)`);
  if (!buf.length) throw new Error("download was empty (the store may not offer this extension)");
  return buf;
}

/**
 * Download a store extension and unpack it to `<dir>/<id>/<version>`, ready for
 * session.extensions.loadExtension. A previous version this module installed for the same
 * id is removed by exact path. Never throws; failures come back as {ok: false, error}.
 * @param {string} input extension id or store URL
 * @param {{dir: string, fetchImpl?: typeof fetch, fsImpl?: typeof fs, prodversion?: string}} opts
 * @returns {Promise<{ok: true, id: string, store: string, name: string, version: string, path: string,
 *   manifestVersion: number, warnings: string[]} | {ok: false, error: string}>}
 */
async function installFromStore(input, { dir, fetchImpl = globalThis.fetch, fsImpl = fs, prodversion } = {}) {
  const parsed = parseExtensionId(input);
  if (!parsed.ok) return parsed;
  if (!dir || !path.isAbsolute(dir)) return { ok: false, error: "install dir must be an absolute path" };
  if (typeof fetchImpl !== "function") return { ok: false, error: "no fetch available" };
  const { id, store } = parsed;
  const idDir = path.join(path.resolve(dir), id);
  const staging = path.join(idDir, `.incoming-${process.pid}-${Date.now()}`);
  let stagingMade = false;
  try {
    const crx = await download(crxUrl(id, store, prodversion ? { prodversion } : {}), fetchImpl);
    const zip = crxToZip(crx);
    stagingMade = true;
    unzipTo(zip, staging, { fsImpl });
    fsImpl.rmSync(path.join(staging, "_metadata"), { recursive: true, force: true });

    let manifest;
    try {
      manifest = JSON.parse(fsImpl.readFileSync(path.join(staging, "manifest.json"), "utf8").replace(/^\s+/, ""));
    } catch (err) {
      throw new Error(`manifest.json missing or unreadable: ${err.message}`, { cause: err });
    }
    const mv = manifest.manifest_version;
    if (mv !== 2 && mv !== 3) throw new Error(`unsupported manifest_version: ${mv}`);
    const version = String(manifest.version || "");
    if (!VERSION_RE.test(version)) throw new Error(`bad manifest version: ${version}`);

    const recordFile = path.join(idDir, INSTALL_RECORD);
    let prev = null;
    try {
      const rec = JSON.parse(fsImpl.readFileSync(recordFile, "utf8"));
      if (rec && rec.id === id && VERSION_RE.test(String(rec.version))) prev = String(rec.version);
    } catch { /* first install */ }

    const target = path.join(idDir, version);
    if (fsImpl.existsSync(target)) {
      if (prev !== version) throw new Error(`${target} exists and was not installed here; not replacing it`);
      fsImpl.rmSync(target, { recursive: true, force: true });
    }
    fsImpl.renameSync(staging, target);
    stagingMade = false;
    if (prev && prev !== version) fsImpl.rmSync(path.join(idDir, prev), { recursive: true, force: true });
    fsImpl.writeFileSync(recordFile, JSON.stringify({ id, store, version, installedAt: new Date().toISOString() }, null, 2));

    return {
      ok: true,
      id,
      store,
      name: String(localized(manifest.name, target, manifest, fsImpl) || id),
      version,
      path: target,
      manifestVersion: mv,
      warnings: permissionWarnings(manifest),
    };
  } catch (err) {
    if (stagingMade) {
      try { fsImpl.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  parseExtensionId,
  crxUrl,
  crxToZip,
  unzipTo,
  installFromStore,
  permissionWarnings,
  WEAK_PERMISSIONS,
  MAX_UNZIPPED_BYTES,
  MAX_ENTRIES,
};
