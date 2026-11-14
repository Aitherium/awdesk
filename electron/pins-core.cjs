"use strict";

/**
 * pins-core.cjs -- the Electron-free half of desktop pins (owner 2026-11-07:
 * "searching for GIFs and pinning them on the desktop, or a YouTube video, or a
 * web page tab, or an app"). pins-window.cjs owns the windows; this module owns
 * the persisted list, what each kind SHOWS, and the rules a pin may not break.
 *
 * The store is ONE JSON document under the desk's userData (never Documents /
 * Pictures: Controlled Folder Access, see boards-core.cjs):
 *
 *   {version: 1, pins: [PinRecord]}
 *   PinRecord = pin-item.cjs card + {onTop: boolean, muted: boolean, hidden: boolean}
 *
 * What a pin shows (`contentFor`):
 *   gif / image  an <img> in pin.html (the pin page's CSP allows https images only)
 *   url          the page itself, in a sandboxed WebContentsView: no preload, no
 *                node, its own partition, every permission denied
 *   youtube      the youtube-nocookie EMBED of the video, same sandbox
 *   app          a tile; a click LAUNCHES it (an aither:// page needs privileges a
 *                pin never gets, so it is never embedded)
 *   widget       widget "launch" with extra.launch = a Start-menu shortcut or a
 *                shell:AppsFolder id: a NATIVE app's launch tile. pin-item.cjs keeps
 *                `app` for aither:// pages (the canvas renders those live), so a
 *                native app rides as this widget (launchPin below).
 *   note         the text, editable in place
 *   widget       a named tile (the canvas lane renders real widgets)
 *
 * Pure: pins-core.test.cjs asserts every rule under `node --test`.
 */

const { normalizePinItem, newPinId, youtubeId } = require("./pin-item.cjs");

const VERSION = 1;
const MAX_PINS = 40;
const MAX_LIST = 5;
/** The grab strip above an embedded page: it carries the controls, the page sits below. */
const STRIP = 26;
const STORE_FILE = "desk-pins.json";

const PIN_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SHORTCUT = /\.(lnk|url|appref-ms)$/i;
const APPS_FOLDER = /^shell:AppsFolder\\[A-Za-z0-9{}()[\]._\-!\\: ~+,@']{1,300}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** An http(s) URL string, or null. */
function httpUrl(text) {
  try {
    const u = new URL(String(text || "").trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A native app's launch target (a Start-menu shortcut path or a shell:AppsFolder
 * id), or null. Never a bare executable, never a relative or ".." path.
 */
function launchTarget(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t || CONTROL.test(t) || t.length > 1024) return null;
  if (APPS_FOLDER.test(t)) return t;
  if (SHORTCUT.test(t) && /^[A-Za-z]:[\\/]/.test(t) && !t.includes("..")) return t;
  return null;
}

/** The card for a native app's launch tile (see the module comment), or null. */
function launchPin(target, title = "") {
  const launch = launchTarget(target);
  if (!launch) return null;
  return normalizeRecord({ kind: "widget", widget: "launch", src: "", title: title || "App", extra: { launch } });
}

/** A record: the card plus the window's own switches. A card with no id gets one. */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && PIN_ID.test(raw.id) ? raw.id : newPinId();
  const item = normalizePinItem({ ...raw, id });
  if (!item) return null;
  return {
    ...item,
    onTop: raw.onTop !== false,
    muted: raw.muted === true,
    hidden: raw.hidden === true,
  };
}

/** A torn or hand-edited file degrades to the pins that still read, never a crash. */
function normalizeStore(raw) {
  const list = raw && typeof raw === "object" && Array.isArray(raw.pins) ? raw.pins : [];
  const seen = new Set();
  const pins = [];
  for (const entry of list) {
    const rec = normalizeRecord(entry);
    if (!rec || seen.has(rec.id)) continue;
    seen.add(rec.id);
    pins.push(rec);
    if (pins.length >= MAX_PINS) break;
  }
  return { version: VERSION, pins };
}

function emptyStore() {
  return { version: VERSION, pins: [] };
}

function topZ(store) {
  return store.pins.reduce((m, p) => Math.max(m, p.z || 0), 0);
}

/**
 * Add (or replace by id) one pin; it lands on top. Over MAX_PINS the OLDEST
 * (lowest z) pin is dropped and named in `dropped`, never silently.
 */
function addPin(store, raw) {
  const s = normalizeStore(store);
  const rec = normalizeRecord(raw);
  if (!rec) return { store: s, pin: null, dropped: [] };
  rec.z = topZ(s) + 1;
  rec.hidden = false;
  let pins = s.pins.filter((p) => p.id !== rec.id);
  pins.push(rec);
  const dropped = [];
  while (pins.length > MAX_PINS) {
    const oldest = [...pins].sort((a, b) => a.z - b.z)[0];
    dropped.push(oldest.id);
    pins = pins.filter((p) => p !== oldest);
  }
  return { store: { version: VERSION, pins }, pin: rec, dropped };
}

/** The fields a window / its controls may change. Identity, kind and src are not among them. */
// `extra` carries a note's colour and the workspace it was written in (toolkit.cjs, 2026-11-13).
/** A sticky note's paper colours (the first is the default). */
const NOTE_COLORS = Object.freeze(["#28261a", "#3a2a1e", "#1e2f24", "#1d2a3a", "#33223a"]);

const PATCHABLE = Object.freeze(["title", "bounds", "locked", "opacity", "onTop", "muted", "hidden", "src", "extra"]);

function patchPin(store, id, patch) {
  const s = normalizeStore(store);
  const at = s.pins.findIndex((p) => p.id === id);
  if (at < 0) return { store: s, pin: null };
  const p = patch && typeof patch === "object" ? patch : {};
  const next = { ...s.pins[at] };
  for (const key of PATCHABLE) {
    if (p[key] === undefined) continue;
    // src may change only for a note (its text); every other src is the pin's identity.
    if (key === "src" && next.kind !== "note") continue;
    next[key] = p[key];
  }
  const rec = normalizeRecord(next);
  if (!rec) return { store: s, pin: null };
  const pins = [...s.pins];
  pins[at] = rec;
  return { store: { version: VERSION, pins }, pin: rec };
}

function removePin(store, id) {
  const s = normalizeStore(store);
  const pins = s.pins.filter((p) => p.id !== id);
  return { store: { version: VERSION, pins }, removed: pins.length !== s.pins.length };
}

function raisePin(store, id) {
  const s = normalizeStore(store);
  const target = s.pins.find((p) => p.id === id);
  if (!target) return { store: s, pin: null };
  return patchPinZ(s, id, topZ(s) + 1);
}

function patchPinZ(s, id, z) {
  const pins = s.pins.map((p) => (p.id === id ? { ...p, z } : p));
  return { store: { version: VERSION, pins }, pin: pins.find((p) => p.id === id) };
}

/** The youtube-nocookie embed for a video id; autoplay respects the mute switch. */
function youtubeEmbedUrl(id, { muted = false, autoplay = true } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ""))) return null;
  const q = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    mute: muted ? "1" : "0",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
  });
  return `https://www.youtube-nocookie.com/embed/${id}?${q.toString()}`;
}

/**
 * What a pin shows:
 *   {mode: "image", url} | {mode: "web", url} | {mode: "app", target}
 *   | {mode: "note", text} | {mode: "widget", widget}
 * Every URL is re-validated here, so a hand-edited store cannot smuggle in a
 * javascript: or file: page.
 */
function contentFor(pin) {
  if (!pin) return null;
  if (pin.kind === "gif" || pin.kind === "image") {
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(String(pin.src))) return { mode: "image", url: pin.src };
    const url = httpUrl(pin.src);
    return url && url.startsWith("https:") ? { mode: "image", url } : null;
  }
  if (pin.kind === "youtube") {
    const url = youtubeEmbedUrl(youtubeId(pin.src), { muted: pin.muted });
    return url ? { mode: "web", url, embed: "youtube" } : null;
  }
  if (pin.kind === "url") {
    const url = httpUrl(pin.src);
    return url ? { mode: "web", url } : null;
  }
  if (pin.kind === "app") return { mode: "app", target: pin.src };
  if (pin.kind === "note") {
    const color = pin.extra && NOTE_COLORS.includes(pin.extra.color) ? pin.extra.color : NOTE_COLORS[0];
    return { mode: "note", text: pin.src, color, colors: NOTE_COLORS };
  }
  if (pin.kind === "widget") {
    const launch = pin.widget === "launch" && pin.extra ? launchTarget(pin.extra.launch) : null;
    return launch ? { mode: "app", target: launch } : { mode: "widget", widget: pin.widget };
  }
  return null;
}

/** Where the embedded page sits inside the pin window: below the grab strip. */
function viewBounds(bounds) {
  const w = Math.max(1, Math.round(bounds.width));
  const h = Math.max(1, Math.round(bounds.height));
  return { x: 0, y: STRIP, width: w, height: Math.max(1, h - STRIP) };
}

/** A new pin's place: centred on the cursor, kept inside the work area. */
function placeAt(point, size, workArea, margin = 8) {
  const w = Math.min(size.width, Math.max(80, workArea.width - margin * 2));
  const h = Math.min(size.height, Math.max(60, workArea.height - margin * 2));
  const x = Math.round(Math.min(Math.max(point.x - w / 2, workArea.x + margin), workArea.x + workArea.width - w - margin));
  const y = Math.round(Math.min(Math.max(point.y - h / 2, workArea.y + margin), workArea.y + workArea.height - h - margin));
  return { x, y, width: Math.round(w), height: Math.round(h) };
}

/**
 * A remembered position that no longer lands on any display (a monitor was
 * unplugged) is pulled onto the first display's work area.
 */
function visibleBounds(bounds, workAreas = []) {
  const areas = Array.isArray(workAreas) ? workAreas : [];
  if (!areas.length) return bounds;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const on = areas.some((a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height);
  if (on) return bounds;
  const a = areas[0];
  return placeAt({ x: a.x + a.width / 2, y: a.y + a.height / 2 }, bounds, a);
}

const KIND_LABEL = Object.freeze({
  app: "App", url: "Page", youtube: "YouTube", gif: "GIF", image: "Image", widget: "Widget", note: "Note",
});

/**
 * The Pins list (tray submenu, quick menu, launcher `pins`): newest on top, at
 * most MAX_LIST rows and ONE "+N more" -- never a silent cut.
 */
function listSummary(store, max = MAX_LIST) {
  const pins = [...normalizeStore(store).pins].sort((a, b) => b.z - a.z);
  const rows = pins.slice(0, max).map((p) => ({
    id: p.id,
    label: `${KIND_LABEL[p.kind] || p.kind}: ${p.title}${p.hidden ? " (hidden)" : ""}${p.locked ? " (locked)" : ""}`,
    kind: p.kind,
    hidden: p.hidden,
    locked: p.locked,
  }));
  return { rows, more: Math.max(0, pins.length - rows.length), total: pins.length };
}

module.exports = {
  NOTE_COLORS,
  VERSION, MAX_PINS, MAX_LIST, STRIP, STORE_FILE, PATCHABLE, KIND_LABEL,
  httpUrl, launchTarget, launchPin, normalizeRecord, normalizeStore, emptyStore, addPin, patchPin, removePin, raisePin,
  youtubeEmbedUrl, contentFor, viewBounds, placeAt, visibleBounds, listSummary,
};
