"use strict";

/**
 * dock-in-model.cjs -- the pure half of "dock terminals and folders INTO the container".
 *
 * Three decisions that must be the same every time, and are asserted under node --test:
 *
 *   1. MOVE TO SPLIT. The bottom terminal dock's "popout" used to open a whole new tab.
 *      Now it moves the session into a second PANE of the same browser window, so the
 *      page you were reading stays beside it. The pane is the terminal page itself with
 *      `?attach=<id>`, plus `split=1` so the internal preload knows it is the pane (and
 *      may accept a folder dropped on it).
 *   2. BRING IN A TERMINAL. The tab strip's "+" menu asks the awsh daemon
 *      (/sessions/unified) what it can open. A daemon session attaches directly. A
 *      Claude Code tab running in Windows Terminal cannot be attached (its pty belongs
 *      to WT), so it is offered as "Resume here" -- an honest choice, not a mirror.
 *   3. A DROP. A folder dropped on the tab strip or a pane opens that folder in Files;
 *      a file opens its FOLDER with the file selected. A text/URL drop carries no path
 *      and is refused without pretending.
 *
 * Electron-free: browser-window.cjs and the tests both require this directly.
 */

const SPLIT_GAP = 4;
const SPLIT_MIN_RATIO = 0.2;
const SPLIT_MAX_RATIO = 0.8;

/** The honest sentence shown beside "Resume here" (owner copy, never paraphrased). */
const RESUME_DETAIL = "opens the same conversation in a new terminal here; the Windows Terminal tab keeps running";

function validId(id) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(id || ""));
}

/**
 * The address a split pane loads for session `id`: the terminal page, attached to that
 * session, marked `split=1` so it is the PANE and not another tab. null for a bad id.
 */
function moveToSplitUrl(id) {
  if (!validId(id)) return null;
  return `aither://terminal/?attach=${encodeURIComponent(String(id))}&split=1`;
}

/** `url`, with `split=1` added, for any aither:// page that becomes a pane. */
function asSplitUrl(url) {
  const raw = String(url || "");
  if (!/^aither:\/\//i.test(raw)) return null;
  const join = raw.includes("?") ? "&" : "?";
  return /(?:[?&])split=1(?:&|$)/.test(raw) ? raw : `${raw}${join}split=1`;
}

function live(s) {
  return Boolean(s) && s.state !== "exited";
}

/**
 * The "+" menu's rows, in the order they are offered.
 *   {kind: "daemon",   action: "attach", id, label}   -- the daemon runs it; attach.
 *   {kind: "external", action: "resume", id, label, cwd, raise: true,
 *    detail: RESUME_DETAIL}                          -- Windows Terminal owns it; resume.
 * A row whose id is already a daemon session is not offered twice. Newest first.
 *
 * @param {{sessions?: object[], external?: object[]}} input
 * @param {number} [limit] most Windows Terminal rows to offer
 */
function pickerRows({ sessions = [], external = [] } = {}, limit = 8) {
  const daemon = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && validId(s.id) && live(s))
    .slice()
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  const mine = new Set(daemon.map((s) => String(s.id)));
  const rows = daemon.map((s) => ({
    kind: "daemon",
    action: "attach",
    id: String(s.id),
    label: String(s.label || s.harness || s.id || "session").slice(0, 120),
  }));
  const tabs = (Array.isArray(external) ? external : [])
    .filter((x) => x && validId(x.id) && !mine.has(String(x.id)))
    .slice()
    .sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0))
    .slice(0, Math.max(0, Number(limit) || 0));
  for (const x of tabs) {
    rows.push({
      kind: "external",
      action: "resume",
      raise: true,
      id: String(x.id),
      label: String(x.label || x.id || "Claude Code").slice(0, 120),
      cwd: String(x.cwd || ""),
      detail: RESUME_DETAIL,
    });
  }
  return rows;
}

/** What the picker does for one row: the action name the browser runs. */
function actionFor(row) {
  if (!row || !validId(row.id)) return null;
  if (row.kind === "daemon" && row.action === "attach") return "attach";
  if (row.kind === "external" && row.action === "resume") return "resume";
  return null;
}

/** A dropped path without its trailing separators -- "C:\\work\\" is the folder "C:\\work". */
function trimPath(p) {
  const raw = String(p == null ? "" : p);
  const cut = raw.replace(/[\\/]+$/, "");
  if (!cut) return raw; // "/" or "\\" IS the root
  if (/^[A-Za-z]:$/.test(cut)) return cut + raw.slice(cut.length, cut.length + 1); // a drive root keeps its slash
  return cut;
}

function dirnameOf(p) {
  const s = trimPath(p).replace(/[\\/]+$/, "");
  const cut = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (cut < 0) return "";
  if (cut === 0) return s.slice(0, 1);
  const head = s.slice(0, cut);
  return /^[A-Za-z]:$/.test(head) ? head + s[cut] : head;
}

function baseOf(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const cut = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return cut < 0 ? s : s.slice(cut + 1);
}

/**
 * Route a drop onto the tab strip or a pane.
 * @param {{path: string, dir: boolean}[]} dropped  paths resolved in the preload, with
 *   `dir` from main's statSync (the renderer must never decide a path's kind).
 * @returns {{kind: "files", root: string, select: string|null}
 *          | {kind: "refuse", reason: string}}
 *   A folder (first, if several) opens as the Files root. A file opens its folder with
 *   the file selected. A drop with no path (text, a URL) is refused.
 */
function dropRouting(dropped) {
  const entries = (Array.isArray(dropped) ? dropped : [])
    .filter((e) => e && typeof e.path === "string" && e.path.trim());
  if (!entries.length) {
    return { kind: "refuse", reason: "that drop carries no file path -- drop a folder or a file" };
  }
  const folder = entries.find((e) => e.dir === true);
  if (folder) return { kind: "files", root: trimPath(folder.path), select: null };
  const file = entries.find((e) => e.dir === false || e.dir == null);
  if (!file) {
    return { kind: "refuse", reason: "nothing in that drop can open in Files" };
  }
  return { kind: "files", root: dirnameOf(file.path), select: baseOf(file.path) };
}

/** Clamp a split ratio to something a pane can still be read at. */
function clampRatio(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(SPLIT_MIN_RATIO, Math.min(SPLIT_MAX_RATIO, n));
}

/**
 * Two panes inside `bounds`. `axis: "vertical"` splits LEFT/RIGHT (a vertical divider);
 * `axis: "horizontal"` splits TOP/BOTTOM. `ratio` is the share the primary pane takes.
 * Integer rects, a SPLIT_GAP divider between them, never negative.
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {{axis?: "vertical"|"horizontal", ratio?: number}} [state]
 * @returns {{primary: object, secondary: object}}
 */
function splitRects(bounds, state = {}) {
  const b = bounds && typeof bounds === "object" ? bounds : { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.round(Number(b.x) || 0);
  const y = Math.round(Number(b.y) || 0);
  const width = Math.max(0, Math.round(Number(b.width) || 0));
  const height = Math.max(0, Math.round(Number(b.height) || 0));
  const ratio = clampRatio(state && state.ratio);
  if (state && state.axis === "horizontal") {
    const usable = Math.max(0, height - SPLIT_GAP);
    const first = Math.round(usable * ratio);
    return {
      primary: { x, y, width, height: first },
      secondary: { x, y: y + first + SPLIT_GAP, width, height: Math.max(0, usable - first) },
    };
  }
  const usable = Math.max(0, width - SPLIT_GAP);
  const first = Math.round(usable * ratio);
  return {
    primary: { x, y, width: first, height },
    secondary: { x: x + first + SPLIT_GAP, y, width: Math.max(0, usable - first), height },
  };
}

module.exports = {
  RESUME_DETAIL, SPLIT_GAP, SPLIT_MAX_RATIO, SPLIT_MIN_RATIO,
  actionFor, asSplitUrl, baseOf, clampRatio, dirnameOf, dropRouting, moveToSplitUrl, pickerRows, splitRects, trimPath, validId,
};
