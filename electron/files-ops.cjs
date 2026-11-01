"use strict";

/**
 * files-ops -- the OWNER's write verbs for the Files page: new folder, rename,
 * copy, move, delete-to-Recycle-Bin, import a dropped file, properties, preview,
 * "Send to Aitherium" and "Ask Aither about this".
 *
 * Two audiences, and this module serves only ONE of them. The agent half of
 * files-access.cjs (the desk MCP files_* tools) stays read-only: nothing here is
 * reachable from mcp-server.cjs, and nothing here touches the grants file. The
 * page calls these through files-window.cjs IPC, i.e. only the owner's own hand.
 *
 * 🚩 Confinement is checked on the REAL path, both ends. A source is located
 * through files-access (cleanRel refuses `..`, realpath must stay under the
 * root's realpath -- a junction pointing out of the root is refused). A
 * destination's PARENT is located the same way and the new NAME is one segment
 * that cannot climb, alias (trailing dot/space) or hit a DOS device name. The
 * verb then acts on <real parent>/<name>, so it renames the link, never what a
 * link inside the path pretends to be.
 *
 * 🚩 Delete is the Recycle Bin, ALWAYS. The only removal primitive here is the
 * injected `trash` (Electron shell.trashItem). There is no fs.rm/unlink/rmdir in
 * this file; a cross-volume move copies and then TRASHES the source, so a
 * failed copy can never cost the original.
 *
 * Electron-free: trash, thumbnails, fetch, the token and the file-ask factory are
 * injected so files-ops.test.cjs runs it under node --test against real temp
 * folders. Fail-soft: every verb resolves {ok:true, ...} or {ok:false, reason};
 * batch verbs resolve {ok, done:[...], failed:[{name, reason}]}. Never throws.
 * The token is read per call and is never logged, returned or put in a reason.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { within, agentDeniedRel } = require("./files-access.cjs");

const PREVIEW_TEXT_MAX = 256 * 1024;
const PREVIEW_IMAGE_MAX = 15 * 1024 * 1024;
const UPLOAD_MAX = 100 * 1024 * 1024; // Veil /api/strata/upload MAX_FILE_SIZE
const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_FOLDER = "files";
const PROPS_WALK_MAX = 50_000;
const PROPS_WALK_MS = 3_000;
const NAME_MAX = 255;

const IMAGE_MIME = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
});
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "xml", "html", "htm", "css", "js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "ps1", "psm1", "psd1", "sh",
  "bat", "cmd", "c", "h", "cpp", "hpp", "cs", "go", "rs", "java", "kt", "rb", "php", "sql", "lua", "r",
  "swift", "env.example", "gitignore", "dockerfile", "makefile", "srt", "vtt",
]);
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function extOf(name) {
  const base = String(name || "");
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function message(error) {
  return String((error && error.message) || error || "failed").slice(0, 300);
}

/** Realpath with 8.3 names expanded (files-access does the same). */
function realNative(p) {
  return (fs.realpathSync.native || fs.realpathSync)(p);
}

/**
 * One new file/folder name, or a thrown sentence. A name is ONE segment: no
 * separators, no `.`/`..`, no characters Windows refuses, no trailing dot or
 * space (Windows silently strips them, so `a.` would alias `a`), no DOS device.
 * @param {string} raw
 * @returns {string}
 */
function cleanName(raw) {
  const name = String(raw == null ? "" : raw).trim();
  if (!name) throw new Error("the name is empty");
  if (name === "." || name === "..") throw new Error("that name climbs out of the folder");
  if (/[\\/]/.test(name)) throw new Error("a name cannot contain / or \\");
  if (/[<>:"|?*]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 0x20)) throw new Error("a name cannot contain < > : \" | ? * or control characters");
  if (/[. ]$/.test(name)) throw new Error("a name cannot end with a dot or a space");
  if (RESERVED.test(name)) throw new Error(`${name} is a reserved Windows device name`);
  if (name.length > NAME_MAX) throw new Error(`the name is longer than ${NAME_MAX} characters`);
  return name;
}

/** "a.txt" -> "a - Copy.txt", "a - Copy (2).txt", ... -- the first free one in dir. */
function freeCopyName(dir, name, exists = (p) => fs.existsSync(p)) {
  const ext = extOf(name);
  const stem = ext && !name.startsWith(".") ? name.slice(0, -(ext.length + 1)) : name;
  const suffix = ext && !name.startsWith(".") ? `.${ext}` : "";
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} - Copy${i === 1 ? "" : ` (${i})`}${suffix}`;
    if (!exists(path.join(dir, candidate))) return candidate;
  }
  throw new Error("could not find a free name for the copy");
}

function lexists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/**
 * @param {object} opts
 * @param {object} opts.files            files-access instance (owner half: locate, roots)
 * @param {Function} [opts.trash]        (absPath) => Promise<void>; Electron shell.trashItem
 * @param {Function} [opts.thumbnail]    (absPath, size) => Promise<string|null> data URL
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.token]        () => bearer|null (desk-session readAuthStoreToken)
 * @param {Function} [opts.origin]       () => Veil origin (strata-sync syncOrigin)
 * @param {Function} [opts.fileAsk]      ({files}) => {ask}; default file-ask.cjs createFileAsk
 * @param {Function} [opts.now]
 * @param {Function} [opts.lstat]        (p) => {dev, ino} (bigint); fs.lstatSync -- injected so a
 *                                       case-SENSITIVE folder's clash is testable on NTFS
 */
function createFilesOps({
  files,
  trash = null,
  thumbnail = null,
  fetchImpl = globalThis.fetch,
  token = () => require("./strata-sync.cjs").defaultToken(),
  origin = () => require("./strata-sync.cjs").syncOrigin().origin,
  fileAsk = (deps) => require("./file-ask.cjs").createFileAsk(deps),
  now = Date.now,
  lstat = (p) => fs.lstatSync(p, { bigint: true }),
} = {}) {
  /** True when both paths name the SAME directory entry (dev + inode), never a lookalike. */
  function sameEntry(a, b) {
    try {
      const x = lstat(a);
      const y = lstat(b);
      return x.dev === y.dev && x.ino === y.ino;
    } catch {
      return false;
    }
  }

  /**
   * An EXISTING entry the owner acts on. `op` is <real parent>/<basename>: the
   * entry itself (a link stays a link), confined by its real parent; `real` is
   * what it resolves to, also confined (files-access.locate already refused a
   * target outside the root).
   */
  function source(rootId, rel, { allowRoot = false } = {}) {
    const loc = files.locate(String(rootId || ""), String(rel || ""));
    if (!loc.rel && !allowRoot) throw new Error("that is the place itself -- pick something inside it");
    const realRoot = realNative(loc.root.path);
    const real = realNative(loc.path);
    if (!within(realRoot, real)) throw new Error("path resolves outside the root");
    let op = real;
    if (loc.rel) {
      const realParent = realNative(path.dirname(loc.path));
      if (!within(realRoot, realParent)) throw new Error("path resolves outside the root");
      op = path.join(realParent, path.basename(loc.path));
    }
    return { root: loc.root, rel: loc.rel, abs: loc.path, real, op, realRoot, name: path.basename(loc.path) };
  }

  /** A folder to put something into: must exist, be a folder, sit in the root. */
  function folder(rootId, rel) {
    const dir = source(rootId, rel, { allowRoot: true });
    if (!fs.statSync(dir.real).isDirectory()) throw new Error(`${dir.rel || dir.root.label} is not a folder`);
    return dir;
  }

  /** <real folder>/<clean name>, re-confined (belt and braces after cleanName). */
  function target(dir, name) {
    const clean = cleanName(name);
    const abs = path.join(dir.real, clean);
    if (!within(dir.realRoot, abs) || path.dirname(abs) !== dir.real) throw new Error("path resolves outside the root");
    return { abs, name: clean, rel: dir.rel ? `${dir.rel}/${clean}` : clean };
  }

  async function verdict(fn) {
    try {
      return { ok: true, ...(await fn()) };
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  async function batch(rels, fn) {
    const list = (Array.isArray(rels) ? rels : [rels]).map((r) => String(r == null ? "" : r)).filter(Boolean);
    if (!list.length) return { ok: false, reason: "nothing picked", done: [], failed: [] };
    const done = [];
    const failed = [];
    for (const rel of list) {
      try {
        done.push(await fn(rel));
      } catch (error) {
        failed.push({ name: rel.split("/").pop(), rel, reason: message(error) });
      }
    }
    return { ok: failed.length === 0, done, failed };
  }

  function mkdir(rootId, dirRel, name = "New folder") {
    return verdict(() => {
      const dir = folder(rootId, dirRel);
      let wanted = cleanName(name);
      if (lexists(path.join(dir.real, wanted))) {
        let i = 2;
        while (lexists(path.join(dir.real, `${wanted} (${i})`))) i += 1;
        wanted = `${wanted} (${i})`;
      }
      const t = target(dir, wanted);
      fs.mkdirSync(t.abs);
      return { created: t.rel, name: t.name };
    });
  }

  function rename(rootId, rel, newName) {
    return verdict(() => {
      const src = source(rootId, rel);
      const dir = folder(rootId, src.rel.split("/").slice(0, -1).join("/"));
      const t = target(dir, newName);
      if (t.name === src.name) return { renamed: src.rel, rel: src.rel, unchanged: true };
      // Case-only rename: the "existing" entry may be the source itself (a case-
      // insensitive folder) -- or a DIFFERENT file in a case-sensitive one, which
      // rename would silently replace. Only the same dev+inode is the source.
      const caseOnly = t.name.toLowerCase() === src.name.toLowerCase();
      if (lexists(t.abs) && !(caseOnly && sameEntry(src.op, t.abs))) {
        throw new Error(`${t.name} already exists here -- pick another name`);
      }
      fs.renameSync(src.op, t.abs);
      return { renamed: src.rel, rel: t.rel, name: t.name };
    });
  }

  async function copyInto(srcOp, destAbs) {
    await fs.promises.cp(srcOp, destAbs, {
      recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true,
    });
  }

  /**
   * Copy or move entries of one place into a folder of (possibly) another.
   * @param {"copy"|"move"} mode
   */
  function transfer(mode, srcRootId, rels, dstRootId, dstRel) {
    let dir;
    try {
      dir = folder(dstRootId, dstRel);
    } catch (error) {
      return Promise.resolve({ ok: false, reason: message(error), done: [], failed: [] });
    }
    return batch(rels, async (rel) => {
      const src = source(srcRootId, rel);
      // A folder into itself or below itself never ends.
      if (within(src.real, dir.real)) throw new Error("a folder cannot go inside itself");
      const sameDir = path.dirname(src.op).toLowerCase() === dir.real.toLowerCase();
      if (mode === "move") {
        if (sameDir) throw new Error("it is already in that folder");
        const t = target(dir, src.name);
        if (lexists(t.abs)) throw new Error(`${t.name} already exists there -- rename one of them first`);
        try {
          fs.renameSync(src.op, t.abs);
        } catch (error) {
          if (!error || error.code !== "EXDEV") throw error;
          // Another volume: copy, then the SOURCE goes to the Recycle Bin.
          if (!trash) throw new Error("moving across drives needs the Recycle Bin, which this build lacks", { cause: error });
          await copyInto(src.op, t.abs);
          await trash(src.op);
        }
        return { from: src.rel, rel: t.rel, name: t.name };
      }
      const name = lexists(path.join(dir.real, src.name)) ? freeCopyName(dir.real, src.name, lexists) : src.name;
      const t = target(dir, name);
      await copyInto(src.op, t.abs);
      return { from: src.rel, rel: t.rel, name: t.name };
    });
  }

  /** Delete = Recycle Bin. There is no other path. */
  function remove(rootId, rels) {
    if (typeof trash !== "function") {
      return Promise.resolve({ ok: false, reason: "the Recycle Bin is not wired in this build -- nothing was deleted",
        done: [], failed: [] });
    }
    return batch(rels, async (rel) => {
      const src = source(rootId, rel);
      await trash(src.op);
      return { trashed: src.rel, name: src.name };
    });
  }

  /**
   * Files dropped from outside the desk (Explorer, the browser) into a folder.
   * The SOURCE is the owner's own drag; only the destination is confined.
   */
  function importPaths(absPaths, dstRootId, dstRel, { move = false } = {}) {
    let dir;
    try {
      dir = folder(dstRootId, dstRel);
    } catch (error) {
      return Promise.resolve({ ok: false, reason: message(error), done: [], failed: [] });
    }
    return batch(absPaths, async (raw) => {
      if (!path.isAbsolute(raw)) throw new Error("not an absolute path");
      const real = realNative(raw);
      if (within(real, dir.real)) throw new Error("a folder cannot go inside itself");
      const base = path.basename(raw);
      if (move) {
        const t = target(dir, base);
        if (lexists(t.abs)) throw new Error(`${t.name} already exists there -- rename one of them first`);
        try {
          fs.renameSync(raw, t.abs);
        } catch (error) {
          if (!error || error.code !== "EXDEV") throw error;
          if (!trash) throw new Error("moving across drives needs the Recycle Bin, which this build lacks", { cause: error });
          await copyInto(raw, t.abs);
          await trash(raw);
        }
        return { from: raw, rel: t.rel, name: t.name };
      }
      const name = lexists(path.join(dir.real, base)) ? freeCopyName(dir.real, base, lexists) : base;
      const t = target(dir, name);
      await copyInto(raw, t.abs);
      return { from: raw, rel: t.rel, name: t.name };
    });
  }

  /** Walk a folder for its size and counts, bounded in entries and time. */
  function walk(dirAbs) {
    const started = now();
    let files_ = 0;
    let folders = 0;
    let bytes = 0;
    let partial = false;
    const stack = [dirAbs];
    while (stack.length) {
      if (files_ + folders >= PROPS_WALK_MAX || now() - started > PROPS_WALK_MS) { partial = true; break; }
      const here = stack.pop();
      let names;
      try { names = fs.readdirSync(here); } catch { partial = true; continue; }
      for (const n of names) {
        let st;
        try { st = fs.lstatSync(path.join(here, n)); } catch { continue; }
        if (st.isDirectory()) { folders += 1; stack.push(path.join(here, n)); } else { files_ += 1; bytes += st.size; }
      }
    }
    return { files: files_, folders, bytes, partial };
  }

  function properties(rootId, rel) {
    return verdict(() => {
      const src = source(rootId, rel, { allowRoot: true });
      const lst = fs.lstatSync(src.op);
      const st = fs.statSync(src.real);
      const kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      const out = {
        name: src.name || src.root.label, rel: src.rel, path: src.abs, root: src.root.label, kind,
        ext: kind === "file" ? extOf(src.name) : "",
        size: kind === "file" ? st.size : null,
        createdMs: Math.round(st.birthtimeMs), modifiedMs: Math.round(st.mtimeMs), accessedMs: Math.round(st.atimeMs),
        readOnly: (st.mode & 0o200) === 0, hidden: src.name.startsWith("."),
        link: lst.isSymbolicLink() ? src.real : null,
        agentRead: src.root.agentRead === true,
      };
      if (kind === "dir") out.contents = walk(src.real);
      return out;
    });
  }

  /** What the preview pane shows: an image, text, a pdf, or why not. */
  function preview(rootId, rel) {
    return verdict(() => {
      const src = source(rootId, rel);
      const st = fs.statSync(src.real);
      if (st.isDirectory()) return { kind: "dir", name: src.name };
      const ext = extOf(src.name);
      if (IMAGE_MIME[ext]) {
        if (st.size > PREVIEW_IMAGE_MAX) return { kind: "none", name: src.name, why: "image is over 15 MB -- open it" };
        const b64 = fs.readFileSync(src.real).toString("base64");
        return { kind: "image", name: src.name, size: st.size, dataUrl: `data:${IMAGE_MIME[ext]};base64,${b64}` };
      }
      if (ext === "pdf") return { kind: "pdf", name: src.name, size: st.size, url: pathToFileURL(src.real).href };
      const length = Math.min(st.size, PREVIEW_TEXT_MAX);
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(src.real, "r");
      try { fs.readSync(fd, buf, 0, length, 0); } finally { fs.closeSync(fd); }
      const looksText = TEXT_EXT.has(ext) || TEXT_EXT.has(src.name.toLowerCase()) || !buf.includes(0);
      if (!looksText || buf.includes(0)) return { kind: "none", name: src.name, size: st.size, why: "binary file -- open it" };
      return { kind: "text", name: src.name, size: st.size, text: buf.toString("utf8"), truncated: st.size > length };
    });
  }

  function thumb(rootId, rel, size = 96) {
    return verdict(async () => {
      if (typeof thumbnail !== "function") return { dataUrl: null };
      const src = source(rootId, rel);
      const px = Math.max(16, Math.min(256, Number(size) || 96));
      return { dataUrl: (await thumbnail(src.real, px)) || null };
    });
  }

  /**
   * The owner-side reader file-ask uses. Same shape as files-access agent.read,
   * but over EVERY owner place -- and still never a credential-shaped file: an
   * owner question must not ship a .env or a key to a model.
   */
  function ownerRead(rootId, rel, { maxBytes = PREVIEW_TEXT_MAX } = {}) {
    const src = source(rootId, rel);
    if (agentDeniedRel(path.relative(src.realRoot, src.real))) {
      throw new Error("that file looks like a credential -- it is never sent to a model");
    }
    const st = fs.statSync(src.real);
    if (!st.isFile()) throw new Error(`${src.rel} is not a file`);
    const length = Math.min(st.size, Math.max(1, Number(maxBytes) || PREVIEW_TEXT_MAX));
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(src.real, "r");
    try { fs.readSync(fd, buf, 0, length, 0); } finally { fs.closeSync(fd); }
    const base = { root: src.root.id, rel: src.rel, path: src.abs, size: st.size, offset: 0 };
    if (buf.includes(0)) return { ...base, binary: true, text: null, truncated: false };
    return { ...base, binary: false, text: buf.toString("utf8"), truncated: length < st.size };
  }

  async function ask(rootId, rel, question) {
    try {
      const asker = fileAsk({ files: { read: ownerRead } });
      const out = await asker.ask({ root: rootId, path: rel, question });
      return out && typeof out === "object" ? (out.ok ? out : { ...out, reason: out.reason ? `${out.reason}: ${out.error}` : out.error })
        : { ok: false, reason: "no answer" };
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  /** ONE POST {origin}/api/strata/upload, folder `files`; the tenant is the session's. */
  async function uploadOne(src, bearer, base) {
    const st = fs.statSync(src.real);
    if (st.isDirectory()) throw new Error("folders are not sent -- open it and send its files");
    if (st.size > UPLOAD_MAX) throw new Error("over Aitherium's 100 MB limit");
    const form = new FormData();
    form.append("folder", UPLOAD_FOLDER);
    form.append("file", new Blob([fs.readFileSync(src.real)]), src.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}/api/strata/upload`, {
        method: "POST", headers: { Authorization: `Bearer ${bearer}` }, body: form, signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status === 401 || res.status === 403) throw new Error("Aitherium refused the sign-in -- sign in to Aither again");
      if (!res.ok || (data && data.success === false)) {
        throw new Error(data && typeof data.error === "string" ? data.error.slice(0, 200) : `Aitherium answered HTTP ${res.status}`);
      }
      return { sent: src.rel, name: src.name, size: st.size };
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("the upload timed out -- retry on a better connection", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendToAitherium(rootId, rels) {
    if (typeof fetchImpl !== "function") return { ok: false, reason: "no network in this build", done: [], failed: [] };
    let bearer;
    let base;
    try { bearer = token(); } catch { bearer = null; }
    if (!bearer) return { ok: false, reason: "not signed in -- sign in to Aither, then send again", done: [], failed: [] };
    try { base = String(origin()).replace(/\/+$/, ""); } catch (error) {
      return { ok: false, reason: message(error), done: [], failed: [] };
    }
    const out = await batch(rels, (rel) => uploadOne(source(rootId, rel), bearer, base));
    return { ...out, origin: base, folder: UPLOAD_FOLDER };
  }

  /** GET {origin}/api/strata/files?folder=files -- what is already in Aitherium. */
  async function cloudList() {
    let bearer;
    try { bearer = token(); } catch { bearer = null; }
    if (!bearer) return { ok: false, reason: "not signed in -- sign in to Aither to see Aitherium files" };
    try {
      const base = String(origin()).replace(/\/+$/, "");
      const res = await fetchImpl(`${base}/api/strata/files?folder=${UPLOAD_FOLDER}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, reason: (data && typeof data.error === "string" && data.error) || `HTTP ${res.status}` };
      const list = (data && (data.files || data.items)) || [];
      return { ok: true, origin: base, folder: UPLOAD_FOLDER, files: Array.isArray(list) ? list : [] };
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  /**
   * An address-bar path -> the place that holds it. A path outside every place
   * is refused with the remedy (add its folder), never silently opened.
   */
  function resolveAddress(raw) {
    return verdict(() => {
      const text = String(raw || "").trim().replace(/^"|"$/g, "");
      if (!text) throw new Error("type a folder path");
      if (!path.isAbsolute(text)) throw new Error("type a full path, e.g. C:\\Users\\you\\Documents");
      let real;
      try { real = realNative(text); } catch (error) { throw new Error(`${text} does not exist`, { cause: error }); }
      const places = files.roots().roots.filter((r) => r.exists);
      let best = null;
      for (const r of places) {
        let rr;
        try { rr = realNative(r.path); } catch { continue; }
        if (within(rr, real) && (!best || rr.length > best.rr.length)) best = { root: r, rr };
      }
      if (!best) throw new Error(`${text} is outside your places -- add its folder with "Add folder"`);
      const rel = path.relative(best.rr, real).split(path.sep).filter(Boolean).join("/");
      const isDir = fs.statSync(real).isDirectory();
      return { rootId: best.root.id, rel: isDir ? rel : rel.split("/").slice(0, -1).join("/"),
        select: isDir ? null : rel };
    });
  }

  return {
    mkdir, rename, remove, importPaths, properties, preview, thumb, ask, ownerRead,
    sendToAitherium, cloudList, resolveAddress,
    copy: (s, rels, d, dRel) => transfer("copy", s, rels, d, dRel),
    move: (s, rels, d, dRel) => transfer("move", s, rels, d, dRel),
    locateOp: (rootId, rel) => source(rootId, rel).op,
  };
}

module.exports = {
  createFilesOps, cleanName, freeCopyName, extOf, IMAGE_MIME, UPLOAD_FOLDER, UPLOAD_MAX, PREVIEW_TEXT_MAX,
};
