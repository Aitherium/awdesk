"use strict";

/**
 * explore-window.cjs -- main's half of aither://explore: the knowledge graph(s), the
 * wiki and agent / LLM context in ONE pane (owner, 2026-11-13).
 *
 * One channel, `desk:explore-call`, with a fixed table of operations; it answers ONLY
 * the aither://explore page. That page exists only as an internal tab, which only the
 * owner can open (browser-tabs.cjs: "an agent may only open web tabs"; a web or agent
 * tab's session has no aither:// handler at all), so nothing here is reachable by an
 * agent tab or a web page.
 *
 * Everything is read-only except the list of wiki folders, which the OWNER edits with
 * the system folder picker (explore.json under userData). A page never names a path:
 * a wiki is addressed by its source id, a page by its slug, a session by its id.
 *
 * The adapters do the work (explore-graph.cjs, explore-wiki.cjs, explore-context.cjs);
 * exploreHandlers() takes them injected so explore-window.test.cjs runs without Electron.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createGraphAdapter } = require("./explore-graph.cjs");
const { createWikiFolders, createWikiPlatform, defaultRoots, withIds } = require("./explore-wiki.cjs");
const { NOT_AVAILABLE, createContextClient } = require("./explore-context.cjs");

const PLATFORM_SOURCE = Object.freeze({ id: "platform", label: "LyraWiki (platform)", kind: "platform" });
const MAX_FOLDERS = 12;

function fromExplorePage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "explore";
  } catch {
    return false;
  }
}

/** The owner's own wiki folders, kept in <userData>/explore.json. Unreadable = none. */
function createFolderStore({ file, fsImpl = fs } = {}) {
  const where = () => (typeof file === "function" ? file() : file);
  function load() {
    try {
      const raw = JSON.parse(fsImpl.readFileSync(where(), "utf8"));
      const list = Array.isArray(raw && raw.wikiFolders) ? raw.wikiFolders : [];
      return list.filter((r) => r && typeof r.dir === "string" && path.isAbsolute(r.dir)).slice(0, MAX_FOLDERS)
        .map((r) => ({ dir: path.resolve(r.dir), label: String(r.label || path.basename(r.dir)).slice(0, 80) }));
    } catch {
      return [];
    }
  }
  function save(list) {
    const target = where();
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify({ wikiFolders: list.slice(0, MAX_FOLDERS) }, null, 2));
    fsImpl.renameSync(tmp, target);
  }
  function add(dir) {
    const full = path.resolve(String(dir || ""));
    try { if (!fsImpl.statSync(full).isDirectory()) return { ok: false, reason: "1 path is not a folder" }; }
    catch { return { ok: false, reason: "1 folder is not readable" }; }
    const list = load();
    if (list.some((r) => r.dir.toLowerCase() === full.toLowerCase())) return { ok: true, added: false };
    if (list.length >= MAX_FOLDERS) return { ok: false, reason: `${MAX_FOLDERS} wiki folders is the limit — remove one first` };
    list.push({ dir: full, label: path.basename(full) || full });
    save(list);
    return { ok: true, added: true };
  }
  function remove(dir) {
    const full = path.resolve(String(dir || "")).toLowerCase();
    const list = load();
    const next = list.filter((r) => r.dir.toLowerCase() !== full);
    if (next.length === list.length) return { ok: false, reason: "1 folder is not one you added" };
    save(next);
    return { ok: true };
  }
  return { load, add, remove };
}

/**
 * The operations, by name. Every one returns {ok, ...} and never throws.
 * @param {object} deps graph / platform / folders / context adapters, the folder store,
 *   pickFolder() (the system picker; null in tests) and openUrl(url) (an owner web tab).
 */
function exploreOps({ graph, platform, folders, context, store, roots, pickFolder = null, openUrl = null }) {
  const sources = () => {
    const own = new Set(store.load().map((r) => r.dir.toLowerCase()));
    return [PLATFORM_SOURCE, ...roots().map((r) => ({ id: r.id, label: r.label, kind: "folder", dir: r.dir,
      removable: own.has(r.dir.toLowerCase()) }))];
  };
  const isFolder = (id) => id !== PLATFORM_SOURCE.id && Boolean(folders.rootById(id));
  const wiki = (id, onPlatform, onFolder) => {
    const source = String(id || "");
    if (source === PLATFORM_SOURCE.id) return onPlatform();
    if (isFolder(source)) return onFolder(source);
    return { ok: false, reason: "1 wiki source is not in the list", remedy: "choose one from the list, or add a folder" };
  };
  return {
    "graph.search": (q, opts) => graph.search(q, { domain: opts && opts.domain, limit: opts && opts.limit }),
    "graph.neighbors": (id) => graph.neighbors(id),
    "graph.stats": () => graph.stats(),
    "wiki.sources": () => ({ ok: true, sources: sources() }),
    "wiki.list": (id) => wiki(id, () => platform.list(), (s) => folders.list(s)),
    "wiki.search": (id, q, opts) => wiki(id, () => platform.search(q, opts || {}), (s) => folders.search(s, q, opts || {})),
    "wiki.read": (id, slug) => wiki(id, () => platform.read(slug), (s) => folders.read(s, slug)),
    "wiki.graph": (id, opts) => wiki(id,
      () => ({ ok: false, reason: "0 link graphs from the platform — the gateway has no wiki graph tool",
        remedy: "choose a wiki folder on this computer to draw its links" }),
      (s) => folders.graph(s, { around: opts && opts.around != null ? opts.around : null })),
    "wiki.addFolder": async () => {
      if (typeof pickFolder !== "function") return { ok: false, reason: "1 folder picker is not available here" };
      const dir = await pickFolder();
      if (!dir) return { ok: true, cancelled: true, sources: sources() };
      const added = store.add(dir);
      if (!added.ok) return added;
      folders.forget();
      const now = sources();
      const mine = now.find((s) => s.dir && s.dir.toLowerCase() === path.resolve(dir).toLowerCase());
      return { ok: true, sources: now, selected: mine ? mine.id : null };
    },
    "wiki.removeFolder": (id) => {
      const root = folders.rootById(id);
      if (!root) return { ok: false, reason: "1 wiki source is not in the list" };
      const gone = store.remove(root.dir);
      if (!gone.ok) return gone;
      folders.forget();
      return { ok: true, sources: sources() };
    },
    "context.sessions": (opts) => context.sessions({ query: opts && opts.query }),
    "context.facts": (id) => context.facts(id),
    "context.request": (id, requestId) => context.request(id, requestId),
    "context.traces": () => context.traces({ limit: 30 }),
    "context.trace": (id) => context.trace(id),
    "context.recall": (q) => context.recall(q),
    "context.limits": () => ({ ok: true, notAvailable: [...NOT_AVAILABLE] }),
    "open.external": (url) => {
      let parsed;
      try { parsed = new URL(String(url || "")); } catch { return { ok: false, reason: "not an address" }; }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "only web addresses open from a wiki page" };
      if (typeof openUrl !== "function") return { ok: false, reason: "1 browser door is not wired" };
      openUrl(parsed.href);
      return { ok: true, url: parsed.href };
    },
  };
}

function exploreHandlers(ops, { isExplore = fromExplorePage } = {}) {
  return {
    "desk:explore-call": async (event, op, ...args) => {
      if (!event || !event.sender || !isExplore(event.sender)) return { ok: false, reason: "not the explore page" };
      const name = String(op || "");
      if (!Object.prototype.hasOwnProperty.call(ops, name)) return { ok: false, reason: `1 operation is not offered: ${name.slice(0, 40)}` };
      try {
        return await ops[name](...args.slice(0, 3));
      } catch (error) {
        return { ok: false, reason: String((error && error.message) || error).slice(0, 300) };
      }
    },
  };
}

/**
 * What an Alt+Space explore verb shows inline (explore-verbs.cjs verbRows ctx): the
 * graph search, the wiki search (platform first, else the first wiki folder, and it
 * says which), or the sessions matching the words.
 */
async function verbLookup(v, deps = sharedExplore()) {
  if (!v || v.bare) return {};
  if (v.verb === "graph") return { graph: await deps.graph.search(v.arg, { limit: 8 }) };
  if (v.verb === "context") return { sessions: await deps.context.sessions({ query: v.arg }) };
  const remote = await deps.platform.search(v.arg, { limit: 8 });
  if (remote.ok) return { wiki: { ...remote, sourceId: PLATFORM_SOURCE.id, label: PLATFORM_SOURCE.label } };
  const folder = deps.roots()[0];
  if (!folder) return { wiki: remote };
  const local = deps.folders.search(folder.id, v.arg, { limit: 8 });
  return { wiki: { ...local, sourceId: folder.id, label: folder.label } };
}

let wired = false;
let shared = null;

/** The adapters main and the launcher share (one wiki index, one session index). */
function sharedExplore({ userData = null } = {}) {
  if (shared) return shared;
  const dataDir = () => userData || require("electron").app.getPath("userData");
  const store = createFolderStore({ file: () => path.join(dataDir(), "explore.json") });
  const roots = () => withIds([...defaultRoots(), ...store.load()]);
  shared = {
    store, roots,
    graph: createGraphAdapter(),
    platform: createWikiPlatform(),
    folders: createWikiFolders({ roots }),
    context: createContextClient(),
  };
  return shared;
}

/** `openUrl(url)` opens an owner web tab; `parentWindow()` is where the folder picker attaches. */
function ensureExploreIpc({ openUrl = null, parentWindow = null } = {}) {
  if (wired) return;
  wired = true;
  const { ipcMain, dialog } = require("electron");
  const pickFolder = async () => {
    const parent = typeof parentWindow === "function" ? parentWindow() : null;
    const options = { title: "Choose a wiki folder", properties: ["openDirectory"] };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return picked.canceled || !picked.filePaths.length ? null : picked.filePaths[0];
  };
  const ops = exploreOps({ ...sharedExplore(), pickFolder, openUrl });
  for (const [channel, handler] of Object.entries(exploreHandlers(ops))) ipcMain.handle(channel, handler);
}

module.exports = { MAX_FOLDERS, PLATFORM_SOURCE, createFolderStore, ensureExploreIpc, exploreHandlers, exploreOps,
  fromExplorePage, sharedExplore, verbLookup };
