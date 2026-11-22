"use strict";

/**
 * needs-you — the asks only the OWNER can unblock, made impossible to miss
 * WITHOUT stealing focus.
 *
 * Owner, 2026-10-14: "theres no fucking card in awdesk or anything". Measured
 * that day: the Proton Bridge credential card was #28 of 41 in an oldest-first
 * flipper, `.popup-off` (his own kill switch since 08-29) correctly kept every
 * window shut, and so the one ask he alone could answer was visible NOWHERE.
 *
 * `.popup-off` means "nothing steals my focus" — it never meant "hide the ask".
 * So everything here is passive and persistent:
 *   - tray menu row 0: "Secret needed: <name> (from <agent/session>)";
 *   - the tray badge draws a red KEY while the list is non-empty;
 *   - a small always-on-top chip, focusable:false and shown inactive;
 *   - the voice lines lead with needsYou[0], re-spoken hourly (mic mute wins).
 * None of it calls openInbox by itself; a CLICK does, with the card id.
 *
 * "Later" is a desk-local snooze (4 h) kept in the desk's own userData, never
 * in the decision store: the card stays open for every other surface, it just
 * leaves this strip until the snooze runs out.
 *
 * Pure functions + a tiny file store; main.cjs owns the windows and the tray.
 */

const fs = require("node:fs");
const path = require("node:path");

const SNOOZE_MS = 4 * 60 * 60 * 1000;
const RESPEAK_MS = 60 * 60 * 1000;
const SNOOZE_FILE = "needs-you-snooze.json";

// P0 escalation (A5, "Aither yells"). A P0 is the one class that may shout: a secret only
// the owner can type, a session stopped on him, or a high/critical ask. It is announced
// ONCE per card id, may cut the line that is playing once (speech-arbiter.cjs
// `preempt`), and when the room is muted it is a caption plus the A1 toast -- never audio.
const P0_FILE = "needs-you-p0.json";
const P0_KINDS = Object.freeze(["credential", "blocked"]);
const P0_URGENCIES = Object.freeze(["critical", "high"]);
/** "Once per card id" holds as long as the card could still be open (the store's stale window). */
const P0_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const P0_MAX_IDS = 500;
const CARD_ID_RE = /^d-[A-Za-z0-9_-]{1,64}$/;

/** id -> until (epoch ms). Expired rows are dropped on read. */
function loadSnoozes(dir, nowMs = Date.now()) {
  const out = new Map();
  if (!dir) return out;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, SNOOZE_FILE), "utf8"));
    for (const [id, until] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
      const t = Number(until);
      if (typeof id === "string" && /^d-[A-Za-z0-9_-]{1,64}$/.test(id) && t > nowMs) out.set(id, t);
    }
  } catch {
    /* no file / unreadable = nothing snoozed: the strip shows MORE, never less */
  }
  return out;
}

function saveSnoozes(dir, snoozes) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SNOOZE_FILE), JSON.stringify(Object.fromEntries(snoozes)));
    return true;
  } catch {
    return false;
  }
}

/** Snooze `id` for SNOOZE_MS; returns the until. */
function snooze(dir, id, nowMs = Date.now(), ms = SNOOZE_MS) {
  const snoozes = loadSnoozes(dir, nowMs);
  const until = nowMs + ms;
  snoozes.set(String(id), until);
  saveSnoozes(dir, snoozes);
  return until;
}

/** The set of ids currently snoozed. */
function snoozedIds(dir, nowMs = Date.now()) {
  return new Set(loadSnoozes(dir, nowMs).keys());
}

/** "claude-code · develop" — who is waiting, never a path. */
function fromLabel(card) {
  if (!card) return "";
  const who = card.agent || card.tab || "";
  const sess = card.sessionId ? `session ${String(card.sessionId).slice(0, 8)}` : "";
  return [who, card.branch || "", sess].filter(Boolean).join(" · ");
}

/** The one-line ask: "Secret needed: X (from Y)" or "Needs you: <title> (from Y)". */
function askLine(card, max = 110) {
  if (!card) return "";
  const from = fromLabel(card);
  const what = card.secretName
    ? `Secret needed: ${card.secretName}`
    : `Needs you: ${String(card.title || card.id).slice(0, 80)}`;
  const line = from ? `${what} (from ${from})` : what;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Tray rows for the needs-you list, spliced in at index 0. `open(id)` is the
 * click. At most three rows plus a "+N more" so a flood cannot bury the menu.
 */
function trayRows(needsYou, open) {
  const list = Array.isArray(needsYou) ? needsYou : [];
  if (!list.length) return [];
  // A native menu eats a single "&" (mnemonic marker), so an agent title such as
  // "Allow Claude to use: Bash(git ... && ...)" must go through the same escape as every
  // other menu row. NOT command-registry.menuText: that one is idempotent for authored
  // labels that already say "&&"; an agent's text is raw, so every "&" doubles ("&&"
  // in a title must draw "&&", i.e. be sent as "&&&&").
  const menuText = (text) => String(text).replace(/&/g, "&&");
  const rows = list.slice(0, 3).map((card) => ({
    label: menuText(askLine(card)),
    click: () => open(card.id),
  }));
  if (list.length > 3) {
    rows.push({ label: menuText(`+${list.length - 3} more waiting on you`), click: () => open(list[3].id) });
  }
  rows.push({ type: "separator" });
  return rows;
}

/**
 * The spoken line. A needs-you card always leads (even in a backlog of 40),
 * then the plain count. `isBacklog` = the first poll after launch.
 */
function voiceLine(needsYou, actionable, isBacklog) {
  const lead = Array.isArray(needsYou) && needsYou[0];
  const n = Array.isArray(actionable) ? actionable.length : 0;
  if (lead) {
    const what = lead.secretName
      ? `a secret only you can give: ${lead.secretName}`
      : String(lead.title || "a blocked session").slice(0, 120);
    const more = n > 1 ? ` ${n - 1} other decision${n - 1 === 1 ? "" : "s"} wait too.` : "";
    return `Aither needs you: ${what}.${more}`;
  }
  const title = String(((actionable || [])[isBacklog ? 0 : n - 1] || {}).title || "a decision").slice(0, 120);
  if (isBacklog) {
    return n === 1 ? `You have one decision waiting: ${title}.` : `You have ${n} decisions waiting. First up: ${title}.`;
  }
  return n === 1 ? `A decision needs you: ${title}.` : `${n} decisions need you. The latest is: ${title}.`;
}

/** Should the hourly reminder speak now? Never while muted or with nothing waiting. */
function respeakDue({ needsYou, lastSpokenAt, nowMs = Date.now(), muted = false, everyMs = RESPEAK_MS }) {
  if (muted) return false;
  if (!Array.isArray(needsYou) || needsYou.length === 0) return false;
  return nowMs - (Number(lastSpokenAt) || 0) >= everyMs;
}

// ── P0: the one ask that may interrupt ──────────────────────────────────────
//
// The plan's priority ladder (attention §3): P0 = credential / blocked /
// signed-destructive / fleet-down. A decision card carries no "signed
// destructive" field, so the reachable P0 shapes are a credential or a blocked
// card (kind or an explicit raiser flag) and a high/critical urgency on a real
// decision. `kind=info` is a report whatever else it says, so it never shouts.

/** Is this card a P0 (may interrupt with a spoken line)? */
function isP0(card) {
  if (!card || typeof card !== "object") return false;
  const kind = String(card.kind || "").trim().toLowerCase();
  if (kind === "info") return false;
  if (P0_KINDS.includes(kind) || card.blocking === true) return true;
  return P0_URGENCIES.includes(String(card.urgency || "").trim().toLowerCase());
}

/** The one line a P0 says: the ask first, never a path or a wall of text. */
function p0Line(card, max = 160) {
  if (!card) return "";
  const what = card.secretName
    ? `a secret only you can give: ${card.secretName}`
    : String(card.title || card.id || "a blocked session").slice(0, 100);
  const line = `Aither needs you now: ${what}`;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What a P0 announcement does, as data, so the rule is testable without Electron:
 *   caption  always -- the words are on screen even when there is no sound;
 *   speak    only when the room is not muted (the owner's mute always stands);
 *   toast    only when the A1 actionable-toast path actually exists (`hasToast`);
 *   preempt  the arbiter may cut the playing line once.
 * A non-P0 yields all-false: escalation is a class, not a volume knob.
 */
function p0AnnouncementPlan({ card = null, muted = false, hasToast = false } = {}) {
  if (!isP0(card)) return { caption: false, speak: false, toast: false, preempt: false };
  return { caption: true, speak: !muted, toast: Boolean(hasToast), preempt: true };
}

/**
 * The once-per-card-id ledger for P0 announcements. A restart must not shout a
 * card the owner already saw, so this is a small JSON file next to the snoozes
 * (no dir = in-memory for the process, still once). fs/clock injected.
 */
function createP0Claims({ dir = "", file = P0_FILE, fs: fsImpl = fs, now = Date.now,
  maxAgeMs = P0_MAX_AGE_MS, max = P0_MAX_IDS } = {}) {
  let seen = null; // Map id -> announced-at
  const load = () => {
    if (seen) return seen;
    seen = new Map();
    if (!dir) return seen;
    try {
      const raw = JSON.parse(fsImpl.readFileSync(path.join(dir, file), "utf8"));
      const t = now();
      for (const [id, at] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
        const when = Number(at);
        if (!CARD_ID_RE.test(id) || !Number.isFinite(when) || t - when > maxAgeMs) continue;
        seen.set(id, when);
      }
    } catch { /* no file / unreadable = nothing announced yet */ }
    return seen;
  };
  const save = () => {
    if (!dir) return false;
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const rows = [...load().entries()].sort((a, b) => a[1] - b[1]);
      while (rows.length > max) rows.shift();
      fsImpl.writeFileSync(path.join(dir, file), JSON.stringify(Object.fromEntries(rows)));
      return true;
    } catch { return false; }
  };
  return {
    /** true only the FIRST time this card id is claimed (then it is recorded). */
    claim(id) {
      const key = String(id == null ? "" : id);
      if (!CARD_ID_RE.test(key)) return false;
      const map = load();
      if (map.has(key)) return false;
      map.set(key, now());
      save();
      return true;
    },
    has: (id) => load().has(String(id == null ? "" : id)),
    size: () => load().size,
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The chip's click target: main intercepts this navigation, it never loads. */
const CHIP_OPEN_SCHEME = "aither-needs-you:";

/** A self-contained page for the chip window (no preload, no script). */
function chipHtml(needsYou) {
  const list = Array.isArray(needsYou) ? needsYou : [];
  const lead = list[0];
  if (!lead) return "<!doctype html><html><body></body></html>";
  const more = list.length > 1 ? ` +${list.length - 1}` : "";
  const label = escapeHtml(askLine(lead, 70));
  const href = `${CHIP_OPEN_SCHEME}//open/${encodeURIComponent(lead.id)}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;background:transparent;overflow:hidden;font:600 12px/1.2 "Segoe UI",system-ui,sans-serif}
a{display:flex;align-items:center;gap:6px;box-sizing:border-box;height:30px;padding:0 10px;border-radius:15px;
background:#e5484d;color:#fff;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
box-shadow:0 2px 8px rgba(0,0,0,.35)}a:hover{background:#f05d61}b{font-weight:800}</style></head>
<body><a href="${href}" title="${escapeHtml(askLine(lead, 300))} — click to answer"><b>&#128273; Needs you${escapeHtml(more)}</b><span>${label}</span></a></body></html>`;
}

/** The card id a chip navigation names, or null when it is not ours. */
function chipTarget(url) {
  const s = String(url || "");
  if (!s.startsWith(CHIP_OPEN_SCHEME)) return null;
  const m = /^aither-needs-you:\/\/open\/([^/?#]+)$/.exec(s);
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return null; }
  return /^d-[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** A stable signature so the chip/tray re-render only when the list moved. */
function needsYouSignature(needsYou) {
  return (Array.isArray(needsYou) ? needsYou : []).map((c) => c && c.id).join(",");
}

/** The chip window's options: never focusable, never in the taskbar, no script. */
function chipWindowOptions(workArea, { width = 380, height = 34 } = {}) {
  return {
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 12,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: "Needs you",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false },
  };
}

/**
 * The "Needs you" chip: a small always-on-top window, focusable:false and shown
 * INACTIVE, so it is on screen under .popup-off without ever taking focus. A
 * click is a navigation intercepted here (chipTarget) -> onOpen(id); the page
 * never navigates. `sync(list, { hidden })` shows/updates/hides it.
 * Electron pieces are injected so the real-Electron smoke drives THIS code.
 */
function createChip({ BrowserWindow, screen, onOpen, log = () => {} }) {
  let win = null;
  let shownSig = "";
  const ensure = () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow(chipWindowOptions(screen.getPrimaryDisplay().workArea));
    win.setAlwaysOnTop(true, "floating");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const target = chipTarget(url);
      if (target) onOpen(target);
    });
    win.on("closed", () => {
      win = null;
      shownSig = "";
    });
    return win;
  };
  const sync = (list, { hidden = false } = {}) => {
    const sig = needsYouSignature(list);
    if (!sig || hidden) {
      shownSig = "";
      if (win && !win.isDestroyed()) win.hide();
      return Promise.resolve(false);
    }
    try {
      const w = ensure();
      if (sig !== shownSig) {
        shownSig = sig;
        return w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chipHtml(list))}`)
          .then(() => {
            if (!w.isDestroyed()) w.showInactive();
            return true;
          })
          .catch((error) => {
            log("needs-you chip load failed", (error && error.message) || error);
            return false;
          });
      }
      if (!w.isVisible()) w.showInactive();
      return Promise.resolve(true);
    } catch (error) {
      log("needs-you chip failed", (error && error.message) || error);
      return Promise.resolve(false);
    }
  };
  return { sync, window: () => (win && !win.isDestroyed() ? win : null) };
}

module.exports = {
  SNOOZE_MS,
  RESPEAK_MS,
  SNOOZE_FILE,
  P0_FILE,
  P0_MAX_AGE_MS,
  CHIP_OPEN_SCHEME,
  loadSnoozes,
  saveSnoozes,
  snooze,
  snoozedIds,
  fromLabel,
  askLine,
  trayRows,
  voiceLine,
  respeakDue,
  isP0,
  p0Line,
  p0AnnouncementPlan,
  createP0Claims,
  chipHtml,
  chipTarget,
  needsYouSignature,
  chipWindowOptions,
  createChip,
};
