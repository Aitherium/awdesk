"use strict";

/**
 * browser-edge-import.cjs -- bring the owner's Microsoft Edge data into the Aither Browser.
 *
 * Bookmarks come from each profile's Bookmarks JSON. History comes from a COPY of
 * the profile's History SQLite file, because Edge holds a lock on it while it runs;
 * the copy lives in a temp dir we create and is removed by that exact path.
 *
 * Passwords are never read from Edge's own database: it is encrypted with DPAPI
 * and app-bound keys, and breaking that would be the wrong kind of clever. The
 * owner exports a CSV at edge://settings/passwords and we read that instead.
 * Password values are never logged and never leave the vault call.
 *
 * Everything here takes its fs, sqlite, library and vault as arguments, so the
 * tests need neither Electron nor a real Edge.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Microseconds between 1601-01-01 and 1970-01-01, the Chromium time epoch offset. */
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;
const MAX_TITLE = 200;

function webUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

function cleanTitle(title, url) {
  const t = String(title || "").trim().slice(0, MAX_TITLE);
  return t || url;
}

/**
 * Convert a Chromium timestamp (microseconds since 1601-01-01 UTC) to ms since the Unix epoch.
 * @param {number|bigint} micros
 * @returns {number} 0 when the input is empty or invalid.
 */
function chromiumTimeToMs(micros) {
  const n = typeof micros === "bigint" ? Number(micros / 1000n) : Math.floor(Number(micros) / 1000);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n - CHROMIUM_EPOCH_OFFSET_MS;
}

/**
 * Every Edge profile that holds bookmarks or history.
 * @param {{localAppData?: string, fsImpl?: typeof fs}} [opts]
 * @returns {{name: string, dir: string}[]}
 */
function edgeProfileDirs({ localAppData = process.env.LOCALAPPDATA, fsImpl = fs } = {}) {
  if (!localAppData) return [];
  const userData = path.join(localAppData, "Microsoft", "Edge", "User Data");
  let names;
  try {
    const state = JSON.parse(fsImpl.readFileSync(path.join(userData, "Local State"), "utf8"));
    names = (state && state.profile && state.profile.info_cache) || {};
  } catch {
    names = {};
  }
  let entries;
  try {
    entries = fsImpl.readdirSync(userData, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name !== "Default" && !/^Profile \d+$/.test(e.name)) continue;
    const dir = path.join(userData, e.name);
    const has = (f) => {
      try {
        return fsImpl.existsSync(path.join(dir, f));
      } catch {
        return false;
      }
    };
    if (!has("Bookmarks") && !has("History")) continue;
    const display = names[e.name] && typeof names[e.name].name === "string" && names[e.name].name.trim();
    out.push({ name: display || e.name, dir });
  }
  const rank = (d) => (path.basename(d) === "Default" ? -1 : Number(path.basename(d).replace(/\D/g, "")) || 0);
  return out.sort((a, b) => rank(a.dir) - rank(b.dir));
}

/**
 * Flatten a Chromium Bookmarks file into a list. Folder names are joined with "/".
 * @param {string|object} json the file text or its parsed object
 * @returns {{url: string, title: string, folder: string}[]}
 */
function parseBookmarks(json) {
  let data = json;
  if (typeof json === "string") {
    try {
      data = JSON.parse(json);
    } catch {
      return [];
    }
  }
  const roots = (data && data.roots) || {};
  const out = [];
  function walk(node, folder) {
    if (!node || typeof node !== "object") return;
    if (node.type === "url") {
      const u = webUrl(node.url);
      if (u) out.push({ url: u.href, title: cleanTitle(node.name, u.href), folder });
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const sub = child && child.type === "folder" ? (folder ? `${folder}/${child.name || ""}` : String(child.name || "")) : folder;
        walk(child, sub);
      }
    }
  }
  for (const key of ["bookmark_bar", "other", "synced"]) {
    const root = roots[key];
    if (root) walk(root, String(root.name || key));
  }
  return out;
}

/**
 * Read Edge history from a copy of the locked History file.
 * @param {string} historyPath
 * @param {{limit?: number, sqlite?: {DatabaseSync: Function}, tmpRoot?: string}} [opts]
 * @returns {{ok: boolean, entries: {url: string, title: string, at: number, count: number}[], error?: string}}
 */
function readHistory(historyPath, { limit = 2000, sqlite, tmpRoot = os.tmpdir() } = {}) {
  let lib = sqlite;
  if (!lib) {
    try {
      lib = require("node:sqlite");
    } catch (err) {
      return { ok: false, entries: [], error: `node:sqlite unavailable: ${err.message}` };
    }
  }
  if (!lib || typeof lib.DatabaseSync !== "function") return { ok: false, entries: [], error: "node:sqlite unavailable" };
  if (!historyPath || !fs.existsSync(historyPath)) return { ok: false, entries: [], error: "History file not found" };

  let tmpDir = null;
  let db = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, "aither-edge-history-"));
    const copy = path.join(tmpDir, "History");
    fs.copyFileSync(historyPath, copy);
    for (const side of ["-wal", "-journal"]) {
      if (fs.existsSync(historyPath + side)) fs.copyFileSync(historyPath + side, copy + side);
    }
    // A copied WAL needs a writable open to be replayed; the copy is ours alone.
    const hasWal = fs.existsSync(copy + "-wal");
    db = new lib.DatabaseSync(copy, { readOnly: !hasWal });
    const n = Math.max(1, Math.min(Number(limit) || 2000, 100000));
    // Over-fetch so skipped non-web rows do not shrink the result below the limit.
    const stmt = db.prepare("SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?");
    // Chromium times (~1.3e16) exceed Number.MAX_SAFE_INTEGER; read them as BigInt.
    stmt.setReadBigInts(true);
    const rows = stmt.all(n * 2);
    const entries = [];
    for (const r of rows) {
      const u = webUrl(r.url);
      if (!u) continue;
      entries.push({ url: u.href, title: cleanTitle(r.title, u.href), at: chromiumTimeToMs(r.last_visit_time), count: Number(r.visit_count) || 1 });
      if (entries.length >= n) break;
    }
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, entries: [], error: err.message };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* already closed */
    }
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* temp dir is ours; the OS reclaims it */
      }
    }
  }
}

/** RFC 4180 CSV: quoted fields, embedded commas and newlines, doubled quotes, CRLF, BOM. */
function parseCsv(text) {
  let s = String(text || "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Parse a password CSV exported from Edge (or Chrome). Columns are found by header name.
 * Rows without a valid http(s) URL or without a password are skipped. Values are never logged.
 * @param {string} text
 * @returns {{origin: string, url: string, username: string, password: string, note: string}[]}
 */
function parsePasswordCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0);
  const iUrl = col("url", "origin", "website");
  const iUser = col("username", "login", "user");
  const iPass = col("password");
  const iNote = col("note", "notes");
  if (iUrl === undefined || iPass === undefined) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const u = webUrl((r[iUrl] || "").trim());
    const password = r[iPass] || "";
    if (!u || !password) continue;
    out.push({
      origin: u.origin,
      url: u.href,
      username: iUser === undefined ? "" : r[iUser] || "",
      password,
      note: iNote === undefined ? "" : r[iNote] || "",
    });
  }
  return out;
}

/**
 * Put every row of an exported password CSV into the vault.
 * @param {{text: string, vault: {add: (e: {origin: string, username: string, password: string}) => any}}} opts
 * @returns {Promise<{ok: boolean, added: number, skipped: number, error?: string}>}
 */
async function importPasswordCsv({ text, vault } = {}) {
  if (!vault || typeof vault.add !== "function") return { ok: false, added: 0, skipped: 0, error: "no vault" };
  const total = parseCsv(text).length;
  const rows = parsePasswordCsv(text);
  let added = 0;
  let skipped = Math.max(0, total - 1 - rows.length);
  for (const r of rows) {
    try {
      const res = await vault.add({ origin: r.origin, username: r.username, password: r.password });
      if (res === false || (res && res.ok === false)) skipped++;
      else added++;
    } catch {
      skipped++;
    }
  }
  return { ok: true, added, skipped };
}

/**
 * Import one Edge profile's bookmarks and history into the browser library,
 * and, when a CSV is given, its passwords into the vault.
 * @param {{profileDir: string, library: {importEntries: Function}, passwords?: {text: string, vault: object}, sqlite?: object, historyLimit?: number}} opts
 * @returns {Promise<{ok: boolean, bookmarks: number, history: number, passwords?: number, errors: string[]}>}
 */
async function importFromEdge({ profileDir, library, passwords, sqlite, historyLimit } = {}) {
  const errors = [];
  if (!profileDir) return { ok: false, bookmarks: 0, history: 0, errors: ["no Edge profile"] };
  if (!library || typeof library.importEntries !== "function") return { ok: false, bookmarks: 0, history: 0, errors: ["no library"] };

  let bookmarks = [];
  const bmFile = path.join(profileDir, "Bookmarks");
  if (fs.existsSync(bmFile)) {
    try {
      bookmarks = parseBookmarks(fs.readFileSync(bmFile, "utf8")).map((b) => ({ url: b.url, title: b.title, folder: b.folder }));
    } catch (err) {
      errors.push(`bookmarks: ${err.message}`);
    }
  }

  let history = [];
  const histFile = path.join(profileDir, "History");
  if (fs.existsSync(histFile)) {
    const res = readHistory(histFile, { sqlite, limit: historyLimit });
    if (res.ok) history = res.entries;
    else errors.push(`history: ${res.error}`);
  }

  const out = { ok: false, bookmarks: 0, history: 0, errors };
  try {
    const counts = (await library.importEntries({ bookmarks, history })) || {};
    out.bookmarks = Number(counts.bookmarks) || 0;
    out.history = Number(counts.history) || 0;
  } catch (err) {
    errors.push(`library: ${err.message}`);
  }

  if (passwords && passwords.text) {
    const res = await importPasswordCsv({ text: passwords.text, vault: passwords.vault });
    out.passwords = res.added;
    if (!res.ok) errors.push(`passwords: ${res.error}`);
  }
  out.ok = errors.length === 0;
  return out;
}

module.exports = {
  CHROMIUM_EPOCH_OFFSET_MS,
  chromiumTimeToMs,
  edgeProfileDirs,
  parseBookmarks,
  readHistory,
  parseCsv,
  parsePasswordCsv,
  importPasswordCsv,
  importFromEdge,
};
