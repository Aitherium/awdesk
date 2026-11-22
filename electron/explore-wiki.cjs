"use strict";

/**
 * explore-wiki.cjs -- the Wiki tab of aither://explore: list, search and read wiki pages,
 * their backlinks and their link graph, from TWO kinds of source behind one shape.
 *
 *   platform   the gateway's wiki_* tools (LyraWiki): wiki_list_pages, wiki_search,
 *              wiki_read_page, wiki_stats. When LyraWiki is not running the tool answers
 *              {"error": "..."}; that is reported as unreachable WITH its own words,
 *              never as an empty wiki.
 *   folder     a folder of linked markdown read directly, offline: a LyraWiki project
 *              (Library/Data/lyra/<project>/ -- index.md + wiki/<type>/<slug>.md) or an
 *              awbrain brain (brain/wiki/<slug>.md). Frontmatter, [[wikilinks]] and
 *              relative .md links are the link graph.
 *
 * THE FENCE for folders. A page is only ever opened through the index a bounded walk
 * built (slug -> file the walk itself found). A slug from the pane is a KEY into that
 * index, never a path segment, so "../../secret" matches nothing. The walk follows no
 * symlink out: every file's real path must sit under the root's real path. Reads are
 * bounded (files, depth, bytes per page), and say when they stopped early.
 *
 * Electron-free: fs and callTool are injected, so explore-wiki.test.cjs runs it under
 * `node --test`. {ok:false, reason, remedy}, never a throw across the bridge.
 */

const fs = require("node:fs");
const path = require("node:path");
const { renderMarkdown, slugOf, wikiLinksOf } = require("./explore-markdown.cjs");

const LIMITS = Object.freeze({ maxFiles: 4000, maxDepth: 8, maxPageBytes: 512 * 1024, maxIndexBytes: 24 * 1024,
  maxGraphNodes: 400, maxResults: 50 });
const SKIP_DIR = /^(\.|node_modules$|raw$|history$|__pycache__$)/i;
const ROOT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PLATFORM_REMEDY = "LyraWiki is not running: start the aitheros-lyra service, or read a wiki folder on this computer instead";

function clip(text, n) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function parse(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw || "")); } catch { return null; }
}

/** `key: value` lines between the leading --- fences. {meta, body}. Never throws. */
function splitFrontmatter(text) {
  const src = String(text == null ? "" : text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split("\n").slice(0, 60)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]{0,39})\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "").slice(0, 400);
  }
  return { meta, body: src.slice(m[0].length) };
}

/** The key a link or a slug is looked up by: lowercase, runs of non-alphanumerics as one dash. */
function slugKey(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleOf(meta, body, slug) {
  if (meta.title) return clip(meta.title, 160);
  const h = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(body.slice(0, 4000));
  if (h) return clip(h[1], 160);
  if (meta.heading && meta.heading !== "(none)") return clip(meta.heading, 160);
  return slug;
}

/** Where LyraWiki projects and awbrain brains may be on this computer. Existing folders only. */
function defaultRoots({ env = process.env, cwd = process.cwd(), fsImpl = fs } = {}) {
  const out = [];
  const seen = new Set();
  const add = (dir, label) => {
    if (!dir) return;
    const full = path.resolve(String(dir));
    const key = full.toLowerCase();
    if (seen.has(key)) return;
    try { if (!fsImpl.statSync(full).isDirectory()) return; } catch { return; }
    seen.add(key);
    out.push({ dir: full, label });
  };
  const lyraBases = [];
  if (env.LYRA_WIKI_DATA_DIR) lyraBases.push(env.LYRA_WIKI_DATA_DIR);
  if (env.AITHEROS_ROOT) {
    lyraBases.push(path.join(env.AITHEROS_ROOT, "AitherOS", "Library", "Data", "lyra"));
    lyraBases.push(path.join(env.AITHEROS_ROOT, "Library", "Data", "lyra"));
  }
  if (env.AITHEROS_DATA) lyraBases.push(path.join(env.AITHEROS_DATA, "lyra"));
  for (const base of lyraBases) {
    let names;
    try { names = fsImpl.readdirSync(base).slice(0, 40); } catch { continue; }
    for (const name of names) add(path.join(base, name), `LyraWiki · ${name}`);
  }
  for (const extra of String(env.AITHER_WIKI_ROOTS || "").split(path.delimiter).filter(Boolean)) add(extra, path.basename(extra));
  add(path.join(cwd, "brain"), "awbrain · brain");
  return out;
}

/** [{dir, label}] -> [{id, dir, label}] with stable slug ids ("wiki-1", ...). */
function withIds(roots) {
  const out = [];
  const used = new Set();
  for (const r of Array.isArray(roots) ? roots : []) {
    if (!r || !r.dir) continue;
    let id = slugKey(r.label || path.basename(String(r.dir))).slice(0, 32) || "wiki";
    if (!ROOT_ID.test(id)) id = "wiki";
    let n = 1;
    let unique = id;
    while (used.has(unique)) { n += 1; unique = `${id}-${n}`.slice(0, 40); }
    used.add(unique);
    out.push({ id: unique, dir: path.resolve(String(r.dir)), label: clip(r.label || path.basename(String(r.dir)), 80) });
  }
  return out;
}

/**
 * The offline reader over a set of roots.
 * @param {{roots: () => Array<{id: string, dir: string, label: string}>, fsImpl?: typeof fs, limits?: object, now?: () => number}} opts
 */
function createWikiFolders({ roots, fsImpl = fs, limits = LIMITS, now = () => Date.now(), cacheMs = 15_000 } = {}) {
  const lim = { ...LIMITS, ...(limits || {}) };
  const cache = new Map(); // rootId -> {at, index}

  function rootById(rootId) {
    const id = String(rootId || "");
    if (!ROOT_ID.test(id)) return null;
    return (roots() || []).find((r) => r && r.id === id) || null;
  }

  function real(p) {
    try { return fsImpl.realpathSync(p); } catch { return null; }
  }

  /** Walk one root: {pages: Map(key -> page), list, truncated, reason?}. Bounded; no symlink out. */
  function build(root) {
    const base = real(root.dir);
    if (!base) return { ok: false, reason: `1 wiki folder is not readable: ${root.dir}`, remedy: "choose the folder again, or remove it from the list" };
    const pages = new Map();
    const list = [];
    let files = 0;
    let truncated = false;
    const stack = [{ dir: base, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      let entries;
      try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIR.test(e.name)) continue;
          if (depth + 1 > lim.maxDepth) { truncated = true; continue; }
          stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!/\.(md|markdown)$/i.test(e.name)) continue;
        if (files >= lim.maxFiles) { truncated = true; break; }
        // A symlink (or a junction above it) that resolves outside the root is not a page.
        const resolved = real(full);
        if (!resolved || !(resolved === base || resolved.startsWith(base + path.sep))) continue;
        let stat;
        try { stat = fsImpl.statSync(resolved); } catch { continue; }
        if (!stat.isFile()) continue;
        files += 1;
        const rel = path.relative(base, resolved).split(path.sep).join("/");
        const slug = e.name.replace(/\.(md|markdown)$/i, "");
        let key = slugKey(slug) || slugKey(rel);
        // Two files with one name (entities/x.md, concepts/x.md): the second keeps its folder in the key.
        if (pages.has(key)) key = slugKey(rel.replace(/\.(md|markdown)$/i, ""));
        if (!key || pages.has(key)) continue;
        const page = { key, slug, rel, file: resolved, bytes: stat.size, mtime: Math.round(stat.mtimeMs),
          category: rel.includes("/") ? rel.split("/").slice(-2, -1)[0] : "" };
        pages.set(key, page);
        list.push(page);
      }
      if (truncated && files >= lim.maxFiles) break;
    }
    return { ok: true, base, pages, list, truncated, files };
  }

  function indexOf(rootId) {
    const root = rootById(rootId);
    if (!root) return { ok: false, reason: "1 wiki folder is not in the list", remedy: "add it with Add folder" };
    const held = cache.get(root.id);
    if (held && held.dir === root.dir && now() - held.at < cacheMs) return held.index;
    const index = build(root);
    cache.set(root.id, { at: now(), dir: root.dir, index });
    return index;
  }

  function readText(file, maxBytes) {
    let fd = null;
    try {
      fd = fsImpl.openSync(file, "r");
      const size = fsImpl.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      const n = fsImpl.readSync(fd, buf, 0, len, 0);
      return { text: buf.subarray(0, n).toString("utf8"), truncated: size > len };
    } finally {
      if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
    }
  }

  /** Title + links per page, read once per index (bounded head read), cached on the page row. */
  function hydrate(index) {
    if (index.hydrated) return;
    for (const page of index.list) {
      try {
        const { text } = readText(page.file, lim.maxIndexBytes);
        const { meta, body } = splitFrontmatter(text);
        page.title = titleOf(meta, body, page.slug);
        page.type = meta.type || page.category || "";
        page.links = wikiLinksOf(body).map(slugKey).filter(Boolean);
        page.lower = `${page.title}\n${body}`.toLowerCase();
        page.snippetSrc = body;
      } catch {
        page.title = page.slug; page.type = page.category || ""; page.links = []; page.lower = page.slug.toLowerCase(); page.snippetSrc = "";
      }
    }
    index.hydrated = true;
  }

  const row = (p) => ({ slug: p.key, title: p.title || p.slug, type: p.type || "", path: p.rel, bytes: p.bytes, updated: p.mtime });

  function resolveKey(index, slug) {
    const raw = String(slug == null ? "" : slug);
    // eslint-disable-next-line no-control-regex
    if (!raw || raw.length > 200 || /[\u0000-\u001f]/.test(raw)) return null;
    // A slug is a key. Anything shaped like a path is cut to its page name first, so
    // "../../x" can only ever name a page called "x" that the walk already found.
    const key = slugKey(slugOf(raw));
    return key && index.pages.has(key) ? key : null;
  }

  function list(rootId) {
    const index = indexOf(rootId);
    if (!index.ok) return index;
    hydrate(index);
    const pages = index.list.map(row).sort((a, b) => a.title.localeCompare(b.title));
    return { ok: true, source: "folder", pages, total: pages.length, truncated: index.truncated,
      note: index.truncated ? `stopped at ${lim.maxFiles} pages or ${lim.maxDepth} folders deep` : "" };
  }

  function read(rootId, slug) {
    const index = indexOf(rootId);
    if (!index.ok) return index;
    hydrate(index);
    const key = resolveKey(index, slug);
    if (!key) return { ok: false, reason: `0 pages are called ${clip(slug, 80)} in this wiki`, missing: true };
    const page = index.pages.get(key);
    let got;
    try { got = readText(page.file, lim.maxPageBytes); }
    catch (error) { return { ok: false, reason: `1 page could not be read: ${clip((error && error.message) || error, 120)}` }; }
    const { meta, body } = splitFrontmatter(got.text);
    const rendered = renderMarkdown(body);
    const links = rendered.links.wiki.map((s) => {
      const k = slugKey(s);
      const target = index.pages.get(k);
      return { slug: k, title: target ? target.title || target.slug : s, exists: Boolean(target) };
    });
    const backlinks = index.list.filter((p) => p.key !== key && (p.links || []).includes(key)).map(row);
    return { ok: true, source: "folder", page: { ...row(page), meta, html: rendered.html, headings: rendered.headings,
      links, external: rendered.links.ext, backlinks, truncated: got.truncated || rendered.truncated } };
  }

  function search(rootId, query, { limit = 20 } = {}) {
    const index = indexOf(rootId);
    if (!index.ok) return index;
    hydrate(index);
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return { ok: false, reason: "type what to look for" };
    const hits = [];
    for (const p of index.list) {
      const title = (p.title || p.slug).toLowerCase();
      let score = 0;
      let all = true;
      for (const w of words) {
        const inTitle = title.includes(w) || p.key.includes(w);
        const at = p.lower.indexOf(w);
        if (!inTitle && at < 0) { all = false; break; }
        score += inTitle ? 10 : 0;
        if (at >= 0) score += 1 + Math.min(5, p.lower.split(w).length - 2);
      }
      if (!all) continue;
      const at = Math.max(0, p.snippetSrc.toLowerCase().indexOf(words[0]));
      hits.push({ ...row(p), score, snippet: clip(p.snippetSrc.slice(Math.max(0, at - 60), at + 180), 220) });
    }
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const cap = Math.max(1, Math.min(lim.maxResults, Number(limit) || 20));
    return { ok: true, source: "folder", query: words.join(" "), results: hits.slice(0, cap), total: hits.length };
  }

  /** The link graph: every page a node, every resolved [[link]] an edge. `around` = one page's neighbourhood. */
  function graph(rootId, { around = null } = {}) {
    const index = indexOf(rootId);
    if (!index.ok) return index;
    hydrate(index);
    let keep = null;
    if (around != null) {
      const key = resolveKey(index, around);
      if (!key) return { ok: false, reason: `0 pages are called ${clip(around, 80)} in this wiki`, missing: true };
      keep = new Set([key]);
      for (const l of index.pages.get(key).links || []) if (index.pages.has(l)) keep.add(l);
      for (const p of index.list) if ((p.links || []).includes(key)) keep.add(p.key);
    }
    const chosen = index.list.filter((p) => !keep || keep.has(p.key));
    // The most linked pages first when the wiki is larger than the canvas can read.
    const degree = new Map();
    for (const p of index.list) for (const l of p.links || []) {
      if (!index.pages.has(l)) continue;
      degree.set(l, (degree.get(l) || 0) + 1); degree.set(p.key, (degree.get(p.key) || 0) + 1);
    }
    chosen.sort((a, b) => (degree.get(b.key) || 0) - (degree.get(a.key) || 0) || a.key.localeCompare(b.key));
    const shown = chosen.slice(0, lim.maxGraphNodes);
    const ids = new Set(shown.map((p) => p.key));
    const nodes = shown.map((p) => ({ id: p.key, title: p.title || p.slug, type: p.type || "page", degree: degree.get(p.key) || 0 }));
    const edges = [];
    for (const p of shown) for (const l of p.links || []) if (ids.has(l) && l !== p.key) edges.push({ source: p.key, target: l });
    return { ok: true, source: "folder", nodes, edges, total: chosen.length, shown: nodes.length,
      note: chosen.length > nodes.length ? `showing the ${nodes.length} most linked of ${chosen.length} pages` : "" };
  }

  return { list, read, search, graph, rootById, forget: () => cache.clear() };
}

// ── the platform (LyraWiki through the gateway) ──────────────────────────────

function toolFailure(error) {
  const msg = String((error && error.message) || error || "no answer");
  if (/no session bearer/i.test(msg)) {
    return { ok: false, unreachable: true, reason: "0 gateway sessions — this desk has no session bearer", remedy: "sign in, or mint ~/.aither/session-bearer" };
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|timeout|took over/i.test(msg)) {
    return { ok: false, unreachable: true, reason: `1 gateway did not answer — ${clip(msg, 120)}`, remedy: "start the local gateway (127.0.0.1:8182)" };
  }
  return { ok: false, reason: clip(msg, 200), remedy: PLATFORM_REMEDY };
}

/** A promise that settles {ok:false} after `ms` instead of hanging the pane. */
function bounded(promise, ms, what) {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${Math.round(ms / 1000)} s`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function createWikiPlatform({ callTool = (...a) => require("./gateway-mcp.cjs").callTool(...a), timeoutMs = 20_000, project = "default" } = {}) {
  async function tool(name, args) {
    let raw;
    try { raw = await bounded(Promise.resolve().then(() => callTool(name, args)), timeoutMs, name); }
    catch (error) { return toolFailure(error); }
    const data = parse(raw);
    if (data == null) return { ok: false, reason: `${name} answered text, not JSON: ${clip(raw, 120)}`, remedy: PLATFORM_REMEDY };
    if (data && !Array.isArray(data) && data.error) {
      return { ok: false, unreachable: true, reason: `${name}: ${clip(typeof data.error === "string" ? data.error : JSON.stringify(data.error), 160)}`, remedy: PLATFORM_REMEDY };
    }
    return { ok: true, data };
  }
  const rowOf = (p) => {
    if (!p || typeof p !== "object") return null;
    const slug = String(p.slug || p.id || p.page || "");
    if (!slug) return null;
    return { slug, title: clip(p.title || p.name || slug, 160), type: String(p.category || p.type || ""),
      path: String(p.path || ""), bytes: Number(p.bytes || p.size) || 0, updated: p.updated_at || p.updated || null,
      score: Number.isFinite(Number(p.score)) ? Number(p.score) : undefined, snippet: clip(p.snippet || p.summary || p.excerpt || "", 220) };
  };
  const rows = (data) => (Array.isArray(data) ? data : (data.pages || data.results || data.matches || [])).map(rowOf).filter(Boolean);

  async function list() {
    const r = await tool("wiki_list_pages", { project });
    if (!r.ok) return r;
    const pages = rows(r.data);
    return { ok: true, source: "platform", pages, total: pages.length, truncated: false, note: "" };
  }
  async function search(query, { limit = 20 } = {}) {
    const q = clip(query, 200);
    if (!q) return { ok: false, reason: "type what to look for" };
    const r = await tool("wiki_search", { query: q, project, limit: Math.max(1, Math.min(50, Number(limit) || 20)) });
    if (!r.ok) return r;
    const results = rows(r.data);
    return { ok: true, source: "platform", query: q, results, total: results.length };
  }
  async function read(slug) {
    const s = slugOf(slug);
    if (!s) return { ok: false, reason: "not a page name" };
    const r = await tool("wiki_read_page", { slug: s, project });
    if (!r.ok) return r;
    const content = String(r.data.content || r.data.markdown || r.data.body || "");
    if (!content && r.data.found === false) return { ok: false, reason: `0 pages are called ${clip(s, 80)}`, missing: true };
    const { meta, body } = splitFrontmatter(content);
    const rendered = renderMarkdown(body);
    return { ok: true, source: "platform", page: { slug: String(r.data.slug || s), title: titleOf(meta, body, s), type: meta.type || "",
      path: "", bytes: content.length, updated: null, meta, html: rendered.html, headings: rendered.headings,
      links: rendered.links.wiki.map((l) => ({ slug: l, title: l, exists: true })), external: rendered.links.ext,
      // The platform has no backlinks tool; the pane says so instead of showing "0 backlinks".
      backlinks: null, truncated: rendered.truncated } };
  }
  async function stats() {
    const r = await tool("wiki_stats", { project });
    return r.ok ? { ok: true, source: "platform", stats: r.data } : r;
  }
  return { list, search, read, stats };
}

module.exports = { LIMITS, PLATFORM_REMEDY, ROOT_ID, bounded, createWikiFolders, createWikiPlatform, defaultRoots, slugKey,
  splitFrontmatter, titleOf, toolFailure, withIds };
