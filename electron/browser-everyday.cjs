"use strict";

/**
 * browser-everyday.cjs -- the everyday browser the owner expects from Edge.
 *
 * Owner, 2026-11-13: "close the gaps" (what he would miss switching from Edge). This
 * module holds the pure parts, so each is tested without Electron:
 *   - keyAction: the standard keys (Ctrl+T/W/L/F/P/D, zoom, Ctrl+Tab, Ctrl+Shift+N/T, F5).
 *   - zoom steps, the same ladder Chromium uses.
 *   - the InPrivate partition: in memory only, never written to disk, no history kept.
 *   - session restore: the owner's open tabs, saved on every change, reopened next time.
 *   - recently closed tabs, for Ctrl+Shift+T.
 *   - DRM sites: Electron has no Widevine, so these pages are offered to Edge instead of
 *     failing with a black player.
 *   - page translation: text nodes read in the isolated world, translated in batches by
 *     the desk's own agent, written back. Nothing goes to Microsoft or Google.
 * browser-window.cjs does the wiring.
 */

const fs = require("node:fs");
const path = require("node:path");

/** In-memory only (no "persist:" prefix): Chromium keeps nothing on disk for it. */
const INPRIVATE_PARTITION = "aither-inprivate";

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** The next zoom factor in direction `dir` (+1 / -1); 0 resets. */
function nextZoom(current, dir) {
  if (!dir) return 1;
  const now = Number(current) || 1;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > now + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < now - 0.001) || ZOOM_STEPS[0];
}

/**
 * Which browser action a key press means, or null. `input` is Electron's
 * before-input-event Input ({type, key, code, control, meta, shift, alt}).
 * @returns {null | {action: string, arg?: number}}
 */
function keyAction(input) {
  if (!input || input.type !== "keyDown") return null;
  const key = String(input.key || "");
  const lower = key.toLowerCase();
  const mod = Boolean(input.control || input.meta);
  if (!mod && !input.alt) {
    if (key === "F5") return { action: "reload" };
    if (key === "F11") return { action: "fullscreen" };
    if (key === "F3") return { action: input.shift ? "find-prev" : "find-next" };
    return null;
  }
  if (input.alt && !mod) {
    if (key === "ArrowLeft") return { action: "back" };
    if (key === "ArrowRight") return { action: "forward" };
    if (key === "Home") return { action: "home" };
    return null;
  }
  if (!mod || input.alt) return null;
  if (input.shift) {
    if (lower === "n") return { action: "inprivate" };
    if (lower === "t") return { action: "reopen-closed" };
    if (key === "Tab") return { action: "prev-tab" };
    if (key === "+" || key === "=") return { action: "zoom-in" };
    return null;
  }
  if (key === "Tab") return { action: "next-tab" };
  if (key === "PageDown") return { action: "next-tab" };
  if (key === "PageUp") return { action: "prev-tab" };
  if (/^[1-9]$/.test(key)) return { action: "tab-index", arg: Number(key) };
  if (key === "+" || key === "=") return { action: "zoom-in" };
  if (key === "-" || key === "_") return { action: "zoom-out" };
  if (key === "0") return { action: "zoom-reset" };
  const letters = { t: "new-tab", w: "close-tab", l: "focus-address", f: "find", p: "print", r: "reload", d: "bookmark", h: "history", j: "downloads" };
  return letters[lower] ? { action: letters[lower] } : null;
}

// ---------------------------------------------------------------- session restore

/**
 * The owner's open tabs, kept in one JSON file so the browser reopens where it was
 * (Edge's "continue where you left off"), including after the desk restarts. Only
 * owner web tabs: agent tabs, InPrivate tabs and console panes are never written.
 */
function createSessionStore({ file, fsImpl = fs, max = 60 } = {}) {
  if (!file) throw new Error("createSessionStore needs a file");
  let timer = null;
  let pending = null;
  function writeNow(entries) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, tabs: entries }));
      fsImpl.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }
  return {
    /** Tabs worth restoring: owner, web, http(s), not InPrivate. */
    pick(tabList) {
      return (Array.isArray(tabList) ? tabList : [])
        .filter((t) => t && t.by === "you" && t.kind === "web" && !t.private && /^https?:\/\//i.test(String(t.url || "")))
        .slice(0, max)
        .map((t) => ({ url: String(t.url), title: String(t.title || "").slice(0, 200), active: Boolean(t.active) }));
    },
    /** Save soon (debounced: a page load fires many events). */
    save(tabList, { delayMs = 800 } = {}) {
      pending = this.pick(tabList);
      if (timer) return;
      timer = setTimeout(() => { timer = null; writeNow(pending); }, delayMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    /** Save now (the window is closing). */
    flush(tabList) {
      if (timer) { clearTimeout(timer); timer = null; }
      return writeNow(tabList ? this.pick(tabList) : (pending || []));
    },
    load() {
      try {
        const data = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        return Array.isArray(data.tabs) ? data.tabs.filter((t) => t && /^https?:\/\//i.test(String(t.url || ""))).slice(0, max) : [];
      } catch {
        return [];
      }
    },
  };
}

/** Recently closed owner tabs (newest first), for Ctrl+Shift+T. InPrivate tabs are never kept. */
function createClosedTabs(max = 25) {
  const list = [];
  return {
    push(entry) {
      if (!entry || entry.private || entry.by !== "you" || !/^https?:\/\//i.test(String(entry.url || ""))) return false;
      list.unshift({ url: String(entry.url), title: String(entry.title || "") });
      if (list.length > max) list.length = max;
      return true;
    },
    pop() { return list.shift() || null; },
    list() { return list.slice(); },
  };
}

// ---------------------------------------------------------------- DRM

/**
 * Sites whose players need Widevine. Stock Electron ships without it, so the page
 * would show a black player or "your browser is not supported". These are offered to
 * Edge with one click instead (and the page still opens here for everything else).
 */
const DRM_HOSTS = [
  "netflix.com", "disneyplus.com", "hulu.com", "max.com", "hbomax.com", "primevideo.com",
  "amazon.com/gp/video", "tv.apple.com", "music.apple.com", "open.spotify.com", "peacocktv.com",
  "paramountplus.com", "crunchyroll.com", "tidal.com", "deezer.com", "music.amazon.com",
  "play.max.com", "tv.youtube.com", "sling.com", "fubo.tv", "pandora.com",
];

/** Does `url` need DRM playback (a known Widevine site)? */
function needsDrm(url) {
  let u;
  try { u = new URL(String(url || "")); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const hostPath = `${host}${u.pathname}`;
  return DRM_HOSTS.some((d) => (d.includes("/")
    ? hostPath.startsWith(d)
    : host === d || host.endsWith(`.${d}`)));
}

/** Where Edge lives on this machine (null when it is not installed). */
function edgeExecutable({ env = process.env, exists = fs.existsSync } = {}) {
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const exe = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (exists(exe)) return exe;
  }
  return null;
}

// ---------------------------------------------------------------- translate

const TRANSLATE_MARK = "__aitherTranslate";

/**
 * Isolated-world script: collect the page's visible text nodes (skipping code, inputs
 * and scripts), remember them on the isolated world's window, return their text.
 */
const TRANSLATE_COLLECT_SCRIPT = `(() => {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT", "SELECT", "SVG", "MATH"]);
  const nodes = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = n.nodeValue;
      if (!t || !/[\\p{L}]{2,}/u.test(t) || t.trim().length < 2) return NodeFilter.FILTER_REJECT;
      for (let p = n.parentElement; p; p = p.parentElement) {
        if (skip.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n && nodes.length < 1500; n = walker.nextNode()) nodes.push(n);
  window.${TRANSLATE_MARK} = nodes;
  return { lang: document.documentElement.lang || "", texts: nodes.map((n) => n.nodeValue.trim().slice(0, 600)) };
})()`;

/** Isolated-world script: write translations back, keeping each node's own whitespace. */
function translateApplyScript(start, translated) {
  return `(() => {
    const nodes = window.${TRANSLATE_MARK} || [];
    const out = ${JSON.stringify(translated)};
    let n = 0;
    out.forEach((text, i) => {
      const node = nodes[${Number(start) || 0} + i];
      if (!node || typeof text !== "string" || !text.trim()) return;
      const v = node.nodeValue;
      const lead = v.match(/^\\s*/)[0];
      const tail = v.match(/\\s*$/)[0];
      node.nodeValue = lead + text.trim() + tail;
      n += 1;
    });
    return n;
  })()`;
}

/** Split texts into batches no larger than `maxChars` / `maxItems`, keeping order. */
function translateBatches(texts, { maxChars = 3500, maxItems = 60 } = {}) {
  const batches = [];
  let cur = { start: 0, texts: [] };
  let chars = 0;
  (texts || []).forEach((t, i) => {
    const len = String(t).length;
    if (cur.texts.length && (chars + len > maxChars || cur.texts.length >= maxItems)) {
      batches.push(cur);
      cur = { start: i, texts: [] };
      chars = 0;
    }
    cur.texts.push(String(t));
    chars += len;
  });
  if (cur.texts.length) batches.push(cur);
  return batches;
}

/** The prompt for one batch: a JSON array in, the same-length JSON array out. */
function translatePrompt(texts, target = "English") {
  return [
    `Translate each string in this JSON array into ${target}.`,
    "Return ONLY a JSON array of strings with exactly the same length and order.",
    "Keep names, numbers, URLs and code unchanged. If a string is already in the target language, return it unchanged.",
    "",
    JSON.stringify(texts),
  ].join("\n");
}

/** Parse the agent's reply into an array of `n` strings, or null when it is not one. */
function parseTranslation(reply, n) {
  const text = String(reply || "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr) || arr.length !== n) return null;
    return arr.map((x) => (typeof x === "string" ? x : String(x ?? "")));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- right-click

/**
 * The page's right-click menu as data (Electron draws none of its own): link, image,
 * selection, editable field with spelling suggestions, and the page itself. Each item
 * is {id, label, arg?, enabled?} or {type: "separator"}; main maps ids to actions.
 * `params` is Electron's context-menu params; `page` = {canGoBack, canGoForward, private}.
 */
function contextMenuSpec(params = {}, page = {}) {
  const out = [];
  const sep = () => { if (out.length && out[out.length - 1].type !== "separator") out.push({ type: "separator" }); };
  const flags = params.editFlags || {};
  const link = /^https?:\/\//i.test(String(params.linkURL || "")) ? String(params.linkURL) : "";
  const src = /^(https?|data|blob):/i.test(String(params.srcURL || "")) ? String(params.srcURL) : "";
  const selection = String(params.selectionText || "").trim();

  if (params.isEditable && params.misspelledWord) {
    const sugg = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, 5) : [];
    for (const word of sugg) out.push({ id: "spell-replace", label: word, arg: word });
    if (!sugg.length) out.push({ id: "noop", label: "No spelling suggestions", enabled: false });
    out.push({ id: "spell-add", label: "Add to dictionary", arg: String(params.misspelledWord) });
    sep();
  }
  if (link) {
    out.push({ id: "link-new-tab", label: "Open link in new tab", arg: link });
    if (!page.private) out.push({ id: "link-inprivate", label: "Open link in InPrivate tab", arg: link });
    out.push({ id: "copy-text", label: "Copy link", arg: link });
    sep();
  }
  if (params.mediaType === "image" && src) {
    if (!src.startsWith("data:")) out.push({ id: "link-new-tab", label: "Open image in new tab", arg: src });
    out.push({ id: "image-save", label: "Save image as…", arg: src });
    out.push({ id: "image-copy", label: "Copy image" });
    if (!src.startsWith("data:")) out.push({ id: "copy-text", label: "Copy image link", arg: src });
    sep();
  }
  if (params.isEditable) {
    out.push({ id: "undo", label: "Undo", enabled: flags.canUndo !== false });
    out.push({ id: "redo", label: "Redo", enabled: flags.canRedo !== false });
    sep();
    out.push({ id: "cut", label: "Cut", enabled: flags.canCut !== false });
    out.push({ id: "copy", label: "Copy", enabled: flags.canCopy !== false });
    out.push({ id: "paste", label: "Paste", enabled: flags.canPaste !== false });
    out.push({ id: "paste-plain", label: "Paste as plain text", enabled: flags.canPaste !== false });
    out.push({ id: "select-all", label: "Select all" });
    sep();
  } else if (selection) {
    out.push({ id: "copy", label: "Copy" });
    const short = selection.length > 32 ? `${selection.slice(0, 32)}…` : selection;
    out.push({ id: "search", label: `Search the web for "${short}"`, arg: selection.slice(0, 500) });
    out.push({ id: "read-aloud", label: "Read aloud" });
    sep();
  }
  if (!link && !params.isEditable && !selection && params.mediaType !== "image") {
    out.push({ id: "back", label: "Back", enabled: Boolean(page.canGoBack) });
    out.push({ id: "forward", label: "Forward", enabled: Boolean(page.canGoForward) });
    out.push({ id: "reload", label: "Reload" });
    sep();
    out.push({ id: "save-page", label: "Save page as…" });
    out.push({ id: "print", label: "Print…" });
    out.push({ id: "translate", label: "Translate page" });
    out.push({ id: "read-aloud", label: "Read aloud" });
    sep();
  }
  out.push({ id: "inspect", label: "Inspect" });
  return out;
}

module.exports = {
  contextMenuSpec,
  DRM_HOSTS, INPRIVATE_PARTITION, TRANSLATE_COLLECT_SCRIPT, ZOOM_STEPS,
  createClosedTabs, createSessionStore, edgeExecutable, keyAction, needsDrm, nextZoom,
  parseTranslation, translateApplyScript, translateBatches, translatePrompt,
};
