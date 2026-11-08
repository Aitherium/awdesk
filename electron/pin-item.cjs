"use strict";

/**
 * pin-item.cjs -- ONE card model for everything the desk pins: a card on an
 * aither://canvas board (boards-core `pins`), a card pinned straight onto the desktop
 * (desk-pins-ink), and an item in an AitherOne Spatial Canvas scene (Veil
 * components/aitherone-canvas/types.ts SceneItem).
 *
 *   {id, kind: "app"|"url"|"youtube"|"gif"|"image"|"widget"|"note",
 *    src, title, widget?, bounds: {x, y, width, height}, locked, opacity, z, extra?}
 *
 * `src` per kind:
 *   app      an aither:// page (a desk page; a live view on the desk)
 *   url      any http(s) page
 *   youtube  the privacy embed, https://www.youtube-nocookie.com/embed/<id>
 *   gif      the .gif / Tenor / Giphy media URL
 *   image    an image URL (http(s), or a data:image/ URL)
 *   widget   "" -- `widget` names a canvas-widgets/<id>.cjs read-out
 *   note     the note's text
 * `extra` is OPTIONAL and only ever set by fromSceneItem: the AitherOne fields a pin
 * has no slot for (favicon, fontSize, fill ...), carried so a scene item that passes
 * through the desk comes back to AitherOne unchanged.
 *
 * AitherOne mapping (toSceneItem / fromSceneItem), lossless both ways:
 *   app, url      -> SceneItem "link"  (url)
 *   youtube       -> SceneItem "embed" (url = the watch page, embedUrl = src, provider youtube)
 *   gif, image    -> SceneItem "image" (src)
 *   widget, note  -> SceneItem "sticky" (text) -- AitherOne shows the title / the note
 * Desk-only data (kind, locked, opacity, widget) rides in the SceneItem's `aw`
 * sub-field, which AitherOne keeps verbatim (sceneFromJson keeps unknown item keys).
 * A SceneItem AitherOne made itself (no `aw`) maps by its own kind; shapes, files and
 * folders are not pins (fromSceneItem returns null and the caller keeps them as-is).
 *
 * Pure: no electron, no fs, no network.
 */

const PIN_KINDS = Object.freeze(["app", "url", "youtube", "gif", "image", "widget", "note"]);
/** Kinds whose card body is a live page view (the rest draw in the page's own DOM). */
const LIVE_KINDS = Object.freeze(["app", "url", "youtube", "gif", "image"]);
const LIMITS = Object.freeze({ title: 160, note: 20000, url: 4096, dataUrl: 2_000_000, coord: 100000,
  minW: 40, minH: 30, maxW: 8000, maxH: 8000 });
const DEFAULT_SIZE = Object.freeze({
  app: { width: 480, height: 320 }, url: { width: 480, height: 320 }, youtube: { width: 480, height: 270 },
  gif: { width: 320, height: 240 }, image: { width: 320, height: 240 }, widget: { width: 240, height: 160 },
  note: { width: 220, height: 180 },
});
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const WIDGET_ID = /^[a-z][a-z0-9-]{0,39}$/;
const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
const IMAGE_EXT = /\.(png|jpe?g|webp|avif|svg|bmp)$/i;
const GIF_HOSTS = /(^|\.)(tenor\.com|giphy\.com)$/i;
const YT_EMBED = "https://www.youtube-nocookie.com/embed/";

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, max) : "");

function num(v, min, max, fallback) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parse(url) {
  try { return new URL(String(url || "").trim()); } catch { return null; }
}

/** The YouTube video id of a watch / shorts / live / embed / youtu.be URL, else null. */
function youtubeId(url) {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = /^\/(embed|shorts|live)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[2];
    }
  }
  return id && YT_ID.test(id) ? id : null;
}

/** The privacy embed for a YouTube URL (no cookies until play), else null. */
function youtubeEmbed(url) {
  const id = youtubeId(url);
  return id ? `${YT_EMBED}${id}` : null;
}

function isGifUrl(u) {
  return /\.gif$/i.test(u.pathname) || GIF_HOSTS.test(u.hostname) || /^media\d*\.(tenor|giphy)\.com$/i.test(u.hostname);
}

/** Is `src` acceptable for `kind`? Returns the cleaned src or null. */
function srcFor(kind, src) {
  if (kind === "widget") return "";
  if (kind === "note") return clean(src, LIMITS.note);
  const s = String(src || "").trim();
  if (kind === "image" && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s.length <= LIMITS.dataUrl ? s : null;
  if (s.length > LIMITS.url) return null;
  const u = parse(s);
  if (!u) return null;
  if (kind === "app") return u.protocol === "aither:" && !/^aither:\/\/canvas(\/|$)/i.test(s) ? s : null;
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
  if (kind === "youtube") return s.startsWith(YT_EMBED) && youtubeId(s) ? s : null;
  return s;
}

/** A pin read back into a usable record, or null when it is not one. */
function normalizePinItem(raw) {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  const kind = PIN_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!id || !kind) return null;
  const src = srcFor(kind, raw.src);
  if (src == null) return null;
  const size = DEFAULT_SIZE[kind];
  const b = isObj(raw.bounds) ? raw.bounds : {};
  const pin = {
    id, kind, src,
    title: clean(raw.title, LIMITS.title),
    bounds: {
      x: Math.round(num(b.x, -LIMITS.coord, LIMITS.coord, 0)),
      y: Math.round(num(b.y, -LIMITS.coord, LIMITS.coord, 0)),
      width: Math.round(num(b.width, LIMITS.minW, LIMITS.maxW, size.width)),
      height: Math.round(num(b.height, LIMITS.minH, LIMITS.maxH, size.height)),
    },
    locked: raw.locked === true,
    opacity: Math.round(num(raw.opacity, 0.1, 1, 1) * 100) / 100,
    z: Math.round(num(raw.z, -1e6, 1e6, 0)),
  };
  if (kind === "widget") {
    if (typeof raw.widget !== "string" || !WIDGET_ID.test(raw.widget)) return null;
    pin.widget = raw.widget;
  }
  if (isObj(raw.extra) && Object.keys(raw.extra).length) pin.extra = JSON.parse(JSON.stringify(raw.extra));
  return pin;
}

function newPinId(rand = Math.random) {
  return `pin-${Date.now().toString(36)}${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** The kind a URL pins as (see the module comment), or null when it cannot be pinned. */
function kindOfUrl(url) {
  const s = String(url || "").trim();
  if (/^data:image\//i.test(s)) return "image";
  const u = parse(s);
  if (!u) return null;
  if (u.protocol === "aither:") return srcFor("app", s) ? "app" : null;
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
  if (youtubeId(s)) return "youtube";
  if (isGifUrl(u)) return "gif";
  if (IMAGE_EXT.test(u.pathname)) return "image";
  return "url";
}

/**
 * A URL -> a pin of the right kind: YouTube (watch, shorts, live, youtu.be) becomes
 * its privacy embed; .gif / Tenor / Giphy a gif; an image extension an image;
 * aither:// an app; anything else http(s) a url. null when it cannot be pinned.
 */
function pinItemFromUrl(url, { id, title = "", bounds = {}, z = 0, rand } = {}) {
  const kind = kindOfUrl(url);
  if (!kind) return null;
  const src = kind === "youtube" ? youtubeEmbed(url) : String(url).trim();
  return normalizePinItem({ id: id || newPinId(rand), kind, src, title, bounds, z });
}

/* ── AitherOne Spatial Canvas (SceneItem) ─────────────────────────────────────── */

/**
 * A pin -> an AitherOne SceneItem (plus `aw`, the desk-only data).
 *
 * A pin that CAME from AitherOne (fromSceneItem) carries the original item in
 * `extra.scene`; it goes back as that item with only what the desk can change
 * (geometry, z, and the content field of its kind) written over it, so a Vimeo embed,
 * a "text" node or a favicon survive the trip untouched.
 */
function toSceneItem(raw) {
  const pin = normalizePinItem(raw);
  if (!pin) return null;
  const b = pin.bounds;
  const original = pin.extra && isObj(pin.extra.scene) ? pin.extra.scene : null;
  const item = { ...(original || {}), id: pin.id, x: b.x, y: b.y, w: b.width, h: b.height, z: pin.z };
  const setTitle = (key) => {
    if (pin.title || (original && key in original)) item[key] = pin.title;
    else delete item[key];
  };
  if (pin.kind === "app" || pin.kind === "url") {
    if (original && original.kind === "embed" && (original.embedUrl === pin.src || original.url === pin.src)) {
      item.kind = "embed";
    } else {
      item.kind = "link";
      item.url = pin.src;
    }
    setTitle("title");
  } else if (pin.kind === "youtube") {
    item.kind = "embed";
    item.provider = "youtube";
    const same = original && youtubeId(original.url) === youtubeId(pin.src);
    item.url = same ? original.url : `https://www.youtube.com/watch?v=${youtubeId(pin.src)}`;
    item.embedUrl = original && original.embedUrl && youtubeId(original.embedUrl) === youtubeId(pin.src) ? original.embedUrl : pin.src;
    setTitle("title");
  } else if (pin.kind === "gif" || pin.kind === "image") {
    item.kind = "image";
    item.src = pin.src;
    setTitle("alt");
  } else if (pin.kind === "widget") {
    item.kind = "sticky";
    item.text = pin.title || pin.widget;
    setTitle("title");
  } else {
    item.kind = original && original.kind === "text" ? "text" : "sticky";
    item.text = pin.src;
    setTitle("title");
  }
  // Desk-only data rides in `aw`; a native item with nothing desk-only gets none.
  const aw = { kind: pin.kind, locked: pin.locked, opacity: pin.opacity };
  if (pin.kind === "widget") aw.widget = pin.widget;
  const deskOnly = !original || pin.locked || pin.opacity !== 1 || pin.kind === "widget" || (original && original.aw);
  if (deskOnly) item.aw = aw;
  else delete item.aw;
  return item;
}

/**
 * An AitherOne SceneItem -> a pin, or null for a scene item that is not a pin (shape,
 * file, folder, or junk). With `aw` (it went out from the desk) the desk's own kind
 * comes back exactly; without it the scene's kind decides, and the original item is
 * kept in `extra.scene` so toSceneItem can give it back unchanged.
 */
function fromSceneItem(item) {
  if (!isObj(item) || typeof item.id !== "string") return null;
  const aw = isObj(item.aw) ? item.aw : null;
  let kind = aw && PIN_KINDS.includes(aw.kind) ? aw.kind : null;
  if (!kind) {
    if (item.kind === "link") kind = kindOfUrl(item.url) === "app" ? "app" : "url";
    else if (item.kind === "embed") kind = item.provider === "youtube" || youtubeId(item.embedUrl || item.url) ? "youtube" : "url";
    else if (item.kind === "image") kind = /\.gif(\?|$)/i.test(String(item.src || "")) ? "gif" : "image";
    else if (item.kind === "sticky" || item.kind === "text") kind = "note";
    else return null;
  }
  let src = "";
  let title = typeof item.title === "string" ? item.title : "";
  if (kind === "app" || kind === "url") src = item.kind === "embed" ? (item.embedUrl || item.url) : item.url;
  else if (kind === "youtube") src = youtubeEmbed(item.embedUrl || item.url);
  else if (kind === "gif" || kind === "image") { src = item.src; title = typeof item.alt === "string" ? item.alt : ""; }
  else if (kind === "note") src = item.text || "";
  const scene = JSON.parse(JSON.stringify(item));
  return normalizePinItem({
    id: item.id, kind, src, title,
    widget: aw && aw.widget,
    bounds: { x: item.x, y: item.y, width: item.w, height: item.h },
    locked: aw ? aw.locked === true : false,
    opacity: aw && aw.opacity != null ? aw.opacity : 1,
    z: item.z,
    extra: { scene },
  });
}

module.exports = {
  PIN_KINDS,
  LIVE_KINDS,
  DEFAULT_SIZE,
  LIMITS,
  YT_EMBED,
  youtubeId,
  youtubeEmbed,
  kindOfUrl,
  normalizePinItem,
  pinItemFromUrl,
  newPinId,
  toSceneItem,
  fromSceneItem,
};
