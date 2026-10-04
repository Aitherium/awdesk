"use strict";

/**
 * files-access — the Files page's roots, listings and the per-root AGENT grant.
 *
 * Roots come from cast.json's `files.roots` (cast-config.cjs FILES_FIELDS) and
 * default to the owner's home folders when none are authored. The AGENT grant
 * is NOT in cast.json: awsettings syncs cast.json across machines, so a grant
 * there would share that path on every synced box. Grants live in the
 * machine-local ~/.aither/desk-file-grants.json, keyed by root id. Two audiences:
 *
 *   OWNER (the Files page): every configured root, list / open / reveal /
 *     hand-to-agent, and the switch that grants agents read access per root.
 *   AGENTS (the desk MCP files_* tools): ONLY roots granted on THIS machine,
 *     read-only, text only, size-capped, and never a credential-shaped file
 *     even inside a granted root. No write, move or delete exists anywhere here.
 *
 * 🚩 Confinement is checked on the REAL path. A relative path is normalised and
 * refused if it climbs out (`..`), and then the target's realpath must still sit
 * under the root's realpath -- a symlink or junction inside a granted folder
 * that points at C:\Users\me\.ssh is outside the grant, whatever its name says.
 *
 * 🚩 The agent deny list is judged on the NATIVE real path, every segment
 * below the root -- never only on the names the agent typed. On Windows an 8.3
 * short name (ENV~1, SSH~1\config, AITHER~1\SESSIO~1) or an innocently named
 * link to .env is the same file; fs.realpathSync.native expands both to the
 * long name, fs.realpathSync (JS) does not.
 */

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LIST_MAX = 2000;
const AGENT_READ_MAX = 256 * 1024;
const DEFAULT_FOLDERS = Object.freeze(["Desktop", "Documents", "Downloads"]);
const GRANTS_NAME = "desk-file-grants.json";

// Names an agent never sees or reads, even in a granted root: keys, tokens,
// env files, credential stores. The owner still sees them in the page.
const AGENT_DENY = Object.freeze([
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|kdbx|keychain|ppk|jks|keystore)$/i,
  /^session-bearer$/i,
  /^\.(ssh|aither|gnupg|aws|azure|kube|docker)$/i,
  /^\.(git-credentials|netrc|npmrc|pypirc|pgpass)$/i,
  /^(credentials|secrets?)(\.[a-z0-9]+)?$/i,
  /^bridge-token$/i,
  /^\.?credentials\.json$/i, // ~/.claude/.credentials.json (Claude OAuth tokens)
  /^\.claude\.json$/i,
  /^desk-file-grants\.json$/i,
]);

// Whole-path rules for files whose NAME alone is too generic to deny.
const AGENT_DENY_PATHS = Object.freeze([
  /(^|\/)gh\/hosts\.ya?ml$/i, // GitHub CLI token store
  /(^|\/)\.config\/(gcloud|op|hub)(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
]);

function agentDenied(name) {
  const base = String(name || "");
  return AGENT_DENY.some((re) => re.test(base));
}

/** Is any segment of a root-relative path (either separator) withheld from agents? */
function agentDeniedRel(rel) {
  const clean = String(rel || "").replace(/\\/g, "/");
  if (!clean) return false;
  return clean.split("/").some(agentDenied) || AGENT_DENY_PATHS.some((re) => re.test(clean));
}

/** The native real path: expands Windows 8.3 short names and follows links. */
function realNative(p) {
  return (fs.realpathSync.native || fs.realpathSync)(p);
}

function rootId(absPath) {
  const key = process.platform === "win32" ? absPath.toLowerCase() : absPath;
  return nodeCrypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
}

function expandHome(p, home) {
  const s = String(p || "");
  if (s === "~") return home;
  if (/^~[\\/]/.test(s)) return path.join(home, s.slice(2));
  return s;
}

/** Is `child` the same as or below `parent` (both absolute, both real)? */
function within(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  // path.relative is case-insensitive on win32; a different drive comes back absolute.
  return rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel);
}

/** Normalise a root-relative path; refuse absolute paths and any climb out. */
function cleanRel(rel) {
  const raw = String(rel == null ? "" : rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw || raw === ".") return "";
  if (/^[A-Za-z]:/.test(raw)) throw new Error("expected a path relative to the root");
  const parts = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") throw new Error("path climbs out of the root");
    if (seg.includes("\0")) throw new Error("bad path");
    parts.push(seg);
  }
  return parts.join("/");
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function kindOf(stat) {
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "link";
  return "other";
}

/**
 * @param {object} [opts]
 * @param {string} [opts.castFile]  cast.json override (tests); default CAST_FILE().
 * @param {string} [opts.home]      home directory (tests); default os.homedir().
 * @param {object} [opts.cast]      cast-config module (tests may inject).
 */
function createFilesAccess({
  castFile, grantsFile, home = os.homedir(), cast = require("./cast-config.cjs"),
} = {}) {
  const fileOpt = castFile ? { file: castFile } : {};
  const grantsPath = grantsFile || path.join(home, ".aither", GRANTS_NAME);

  /** Machine-local grants: {version:1, grants:{<rootId>: true}}. Missing/bad = none. */
  function readGrants() {
    try {
      const raw = JSON.parse(fs.readFileSync(grantsPath, "utf8"));
      const g = raw && raw.grants && typeof raw.grants === "object" ? raw.grants : {};
      const out = {};
      for (const [k, v] of Object.entries(g)) if (v === true) out[k] = true;
      return out;
    } catch {
      return {};
    }
  }

  function writeGrants(grants) {
    fs.mkdirSync(path.dirname(grantsPath), { recursive: true });
    const tmp = `${grantsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, grantsPath);
  }

  function authored() {
    const loaded = cast.load(fileOpt);
    const desk = cast.resolveDesk(loaded.snapshot || { version: 1 }, { env: {} });
    const roots = desk.files && Array.isArray(desk.files.roots) ? desk.files.roots : null;
    return { roots, problems: (desk.problems || []).filter((p) => String(p.path).startsWith("files")),
      error: loaded.error || null };
  }

  function defaults() {
    const out = [{ path: home, label: "Home", agentRead: false }];
    for (const name of DEFAULT_FOLDERS) out.push({ path: path.join(home, name), label: name, agentRead: false });
    return out;
  }

  /** Every root the owner sees, resolved, with an id that survives a restart. */
  function roots() {
    const { roots: list, problems, error } = authored();
    const source = list ? "file" : "builtin";
    const grants = readGrants();
    const seen = new Set();
    const out = [];
    for (const r of list || defaults()) {
      const abs = path.resolve(expandHome(r.path, home));
      const id = rootId(abs);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: r.label || path.basename(abs) || abs, path: abs, exists: isDirectory(abs),
        agentRead: grants[id] === true, source });
    }
    return { roots: out, source, problems, error };
  }

  function findRoot(id, { forAgent = false } = {}) {
    const key = String(id || "");
    const all = roots().roots;
    const root = all.find((r) => r.id === key)
      || all.find((r) => r.label.toLowerCase() === key.toLowerCase());
    if (!root) throw new Error(`no root ${key || "(none)"}`);
    if (forAgent && !root.agentRead) {
      throw new Error(`root ${root.label} is not shared with agents -- the owner grants it in the Files page`);
    }
    if (!root.exists) throw new Error(`root ${root.label} (${root.path}) does not exist on this machine`);
    return root;
  }

  /** Absolute, confined, real target for (root, rel). Throws on any escape. */
  function resolveIn(root, rel, { forAgent = false } = {}) {
    const clean = cleanRel(rel);
    if (forAgent && clean.split("/").some(agentDenied)) throw new Error("that file is withheld from agents");
    const target = path.join(root.path, ...clean.split("/").filter(Boolean));
    let realRoot;
    let realTarget;
    try {
      realRoot = realNative(root.path);
      realTarget = realNative(target);
    } catch {
      throw new Error(`not found: ${clean || "(root)"}`);
    }
    if (!within(realRoot, realTarget)) throw new Error("path resolves outside the root");
    // The names on DISK decide, not the names typed: a short name or a link alias
    // of .env / .ssh / .aither\session-bearer expands to the denied long name here.
    if (forAgent && agentDeniedRel(path.relative(realRoot, realTarget))) {
      throw new Error("that file is withheld from agents");
    }
    return { abs: target, real: realTarget, realRoot, rel: clean };
  }

  function list(id, rel = "", { forAgent = false } = {}) {
    const root = findRoot(id, { forAgent });
    const where = resolveIn(root, rel, { forAgent });
    const stat = fs.statSync(where.real);
    if (!stat.isDirectory()) throw new Error(`${where.rel || root.label} is not a folder`);
    const names = fs.readdirSync(where.real);
    const entries = [];
    let withheld = 0;
    for (const name of names) {
      if (forAgent && agentDenied(name)) { withheld += 1; continue; }
      let st;
      try { st = fs.lstatSync(path.join(where.real, name)); } catch { continue; }
      if (forAgent && st.isSymbolicLink()) {
        // A link is judged by what it points at: outside the root or at a
        // denied name, an agent never learns it exists.
        let real = null;
        try { real = realNative(path.join(where.real, name)); } catch { real = null; }
        if (!real || !within(where.realRoot, real)
          || agentDeniedRel(path.relative(where.realRoot, real))) {
          withheld += 1;
          continue;
        }
      }
      let kind = kindOf(st);
      if (kind === "link") {
        // Follow for the kind only; an agent read of it is re-confined anyway.
        try {
          kind = fs.statSync(path.join(where.real, name)).isDirectory() ? "dir" : "file";
        } catch {
          kind = "link";
        }
      }
      entries.push({ name, rel: where.rel ? `${where.rel}/${name}` : name, kind,
        size: kind === "file" ? st.size : null, mtimeMs: Math.round(st.mtimeMs),
        hidden: name.startsWith(".") });
    }
    entries.sort((a, b) => (a.kind === "dir") === (b.kind === "dir")
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : (a.kind === "dir" ? -1 : 1));
    const parent = where.rel ? where.rel.split("/").slice(0, -1).join("/") : null;
    return {
      root: { id: root.id, label: root.label, path: root.path, agentRead: root.agentRead },
      rel: where.rel, path: where.abs, parent,
      entries: entries.slice(0, LIST_MAX), truncated: entries.length > LIST_MAX,
      total: entries.length, withheld,
    };
  }

  /** Absolute path of an entry the OWNER may open / reveal / hand over. */
  function locate(id, rel) {
    const root = findRoot(id);
    const where = resolveIn(root, rel);
    return { root, path: where.abs, rel: where.rel };
  }

  /**
   * Owner switch: let agents read this root, or stop them. Writes the
   * machine-local grants file, never cast.json (which syncs across machines).
   */
  function setAgentRead(id, allowed) {
    const current = roots();
    const root = current.roots.find((r) => r.id === String(id || ""));
    if (!root) throw new Error(`no root ${id || "(none)"}`);
    const want = allowed === true;
    const grants = readGrants();
    if (want) grants[root.id] = true;
    else delete grants[root.id];
    writeGrants(grants);
    return { id: root.id, agentRead: want };
  }

  function addRoot(absPath, label = null) {
    const abs = path.resolve(String(absPath || ""));
    if (!absPath || !path.isAbsolute(String(absPath))) throw new Error("expected an absolute folder path");
    if (!isDirectory(abs)) throw new Error(`${abs} is not a folder`);
    const current = roots();
    if (current.roots.some((r) => r.id === rootId(abs))) return { id: rootId(abs), added: false };
    const result = cast.write((draft) => {
      const files = draft.files && typeof draft.files === "object" ? draft.files : {};
      const list = Array.isArray(files.roots) ? files.roots : current.roots.map((r) => ({
        path: r.path, label: r.label }));
      list.push({ path: abs, label: label || path.basename(abs) || abs });
      files.roots = list;
      draft.files = files;
      return draft;
    }, fileOpt);
    if (!result.ok) throw new Error(result.error || "could not write cast.json");
    return { id: rootId(abs), added: true };
  }

  function removeRoot(id) {
    const current = roots();
    const root = current.roots.find((r) => r.id === String(id || ""));
    if (!root) throw new Error(`no root ${id || "(none)"}`);
    const result = cast.write((draft) => {
      const files = draft.files && typeof draft.files === "object" ? draft.files : {};
      const list = Array.isArray(files.roots) ? files.roots : current.roots.map((r) => ({
        path: r.path, label: r.label }));
      files.roots = list.filter((r) => rootId(path.resolve(expandHome(typeof r === "string" ? r : r.path, home)))
        !== root.id);
      draft.files = files;
      return draft;
    }, fileOpt);
    if (!result.ok) throw new Error(result.error || "could not write cast.json");
    return { id: root.id, removed: true };
  }

  // ── the agent half: granted roots only, read-only ──────────────────────────
  const agent = {
    roots: () => roots().roots.filter((r) => r.agentRead && r.exists)
      .map((r) => ({ id: r.id, label: r.label, path: r.path })),

    list: (id, rel = "") => {
      const out = list(id, rel, { forAgent: true });
      // `hidden` is a page affordance; an agent gets the plain entry.
      return { ...out, entries: out.entries.map((e) => ({ name: e.name, rel: e.rel, kind: e.kind, size: e.size,
        mtimeMs: e.mtimeMs })) };
    },

    /** Read one text file under a granted root. Binary files answer metadata only. */
    read: (id, rel, { maxBytes = AGENT_READ_MAX, offset = 0 } = {}) => {
      const root = findRoot(id, { forAgent: true });
      const where = resolveIn(root, rel, { forAgent: true });
      const stat = fs.statSync(where.real);
      if (!stat.isFile()) throw new Error(`${where.rel} is not a file`);
      const cap = Math.max(1, Math.min(AGENT_READ_MAX, Number(maxBytes) || AGENT_READ_MAX));
      const start = Math.max(0, Math.min(stat.size, Number(offset) || 0));
      const length = Math.min(cap, stat.size - start);
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(where.real, "r");
      try { fs.readSync(fd, buf, 0, length, start); } finally { fs.closeSync(fd); }
      const base = { root: root.id, rel: where.rel, path: where.abs, size: stat.size, offset: start };
      if (buf.includes(0)) return { ...base, binary: true, text: null, truncated: false };
      return { ...base, binary: false, text: buf.toString("utf8"), truncated: start + length < stat.size };
    },
  };

  return { roots, list, locate, setAgentRead, addRoot, removeRoot, agent, grantsPath };
}

const AGENT_TOOLS = Object.freeze(["files_roots", "files_list", "files_read"]);

/**
 * One desk MCP files_* call, as the MCP result the tool returns. Pure over the
 * agent half, so the refusals are testable without the MCP SDK. Never throws:
 * a refusal is {isError:true} with the sentence that says how to get access.
 */
function agentToolCall(agent, name, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const done = (value, isError = false) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError,
  });
  try {
    if (name === "files_roots") {
      const roots = agent.roots();
      return done({ ok: true, roots, note: roots.length ? undefined
        : "The owner has not shared any folder with agents. Ask them to switch one on in the Files page." });
    }
    if (name === "files_list") return done({ ok: true, ...agent.list(String(a.root || ""), String(a.path || "")) });
    if (name === "files_read") {
      return done({ ok: true, ...agent.read(String(a.root || ""), String(a.path || ""),
        { maxBytes: a.max_bytes, offset: a.offset }) });
    }
    return done({ ok: false, error: `unknown files tool ${name}` }, true);
  } catch (error) {
    return done({ ok: false, error: String((error && error.message) || error) }, true);
  }
}

module.exports = {
  createFilesAccess, agentDenied, agentDeniedRel, agentToolCall, cleanRel, rootId, within,
  AGENT_READ_MAX, AGENT_TOOLS, LIST_MAX,
};
