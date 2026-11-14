"use strict";

/**
 * toolkit-core.cjs -- the pure rules of the desk's LOCAL toolkit (owner 2026-11-13: "what
 * about the local awdesk tools and integrations, like right-click access to drawing,
 * graphics, GIFs, playing notes, typing, drawing/painting, opening a whiteboard, pinning
 * notes to the desktop, sending things away, etc.?").
 *
 * Electron-free and side-effect-free so `node --test` asserts every rule:
 *
 *   MENU            the ONE short right-click / tray / Alt+Space list, three groups
 *                   (Create / Capture / Send). Each row is a registry command id, so a
 *                   tool that is missing from this build simply drops out.
 *   SEND_TARGETS    every "Send to..." destination and the capture `to` it files under
 *                   (Genesis POST /v1/capture, AitherOS #16722).
 *   workspaceKey    the active profile/workspace as a filesystem-safe key. Hard isolation
 *                   (owner-hard-workspace-isolation): a local item carries the key it was
 *                   made in, and `mayDeliver` refuses to sync it into any other workspace.
 *   parseVoiceCommand  "record this" / "draw" / "open whiteboard" / "send to jason" ->
 *                   a command id, else null (the words go to the agents as speech).
 *   frameBudget     the avatar's idle frame policy (performance, owner 2026-11-13 22:04).
 *   cropRect        a DIP region -> device pixels inside one display frame.
 */

/** The menu: short, grouped, one line per tool. */
const MENU = Object.freeze([
  Object.freeze({ group: "Create", items: Object.freeze([
    Object.freeze({ id: "ink.toggle", short: "Draw on screen" }),
    Object.freeze({ id: "sketch.new", short: "Sketch pad" }),
    Object.freeze({ id: "board.new", short: "Whiteboard" }),
    Object.freeze({ id: "sticky.new", short: "Sticky note" }),
    Object.freeze({ id: "scratch.new", short: "Quick type" }),
    Object.freeze({ id: "piano.open", short: "Play notes" }),
    Object.freeze({ id: "gif.open", short: "GIFs" }),
  ]) }),
  Object.freeze({ group: "Capture", items: Object.freeze([
    Object.freeze({ id: "snip.region", short: "Snip" }),
    Object.freeze({ id: "record.region", short: "Record (MP4)" }),
    Object.freeze({ id: "record.region.gif", short: "Record GIF" }),
    Object.freeze({ id: "region.box", short: "Box a region" }),
    Object.freeze({ id: "present.start", short: "Present" }),
    Object.freeze({ id: "graphics.open", short: "Edit an image" }),
  ]) }),
  Object.freeze({ group: "Send", items: Object.freeze([
    Object.freeze({ id: "send.last", short: "Send last capture" }),
    Object.freeze({ id: "voice.talk", short: "Talk" }),
    Object.freeze({ id: "interact.toggle", short: "Interact mode" }),
  ]) }),
]);

const MENU_IDS = Object.freeze(MENU.flatMap((g) => g.items.map((i) => i.id)));

/** The menu rows a registry can run: groups keep order; an empty group is dropped. */
function menuGroups(has = () => true) {
  const out = [];
  for (const g of MENU) {
    const items = g.items.filter((i) => {
      try { return Boolean(has(i.id)); } catch { return false; }
    });
    if (items.length) out.push({ group: g.group, items: items.map((i) => ({ ...i })) });
  }
  return out;
}

/**
 * "Send to..." destinations. `via`: capture (Genesis /v1/capture, `to` value), strata
 * (Online Drive folder), relay (the Relay post), ask (the desk's vision lane), local.
 */
const SEND_TARGETS = Object.freeze([
  Object.freeze({ id: "aither", label: "Aither chat", via: "ask" }),
  Object.freeze({ id: "inbox", label: "My inbox (private)", via: "capture", to: "inbox" }),
  Object.freeze({ id: "notes", label: "Notes", via: "capture", to: "notebook:desk-notes" }),
  Object.freeze({ id: "task", label: "Project task", via: "capture", to: "task:" }),
  Object.freeze({ id: "room", label: "Company room (Relay)", via: "capture", to: "thread:company" }),
  Object.freeze({ id: "relay", label: "Relay #agents", via: "relay" }),
  Object.freeze({ id: "drive", label: "Drive", via: "strata", folder: "files" }),
  Object.freeze({ id: "discord", label: "Discord (copy + open)", via: "discord" }),
  Object.freeze({ id: "clipboard", label: "Clipboard", via: "local" }),
]);

function targetById(id) {
  return SEND_TARGETS.find((t) => t.id === String(id || "")) || null;
}

/** The public list a page renders (no `via` internals). */
function publicTargets(online = true) {
  return SEND_TARGETS
    .filter((t) => online || t.via === "local" || t.via === "discord")
    .map((t) => ({ id: t.id, label: t.label }));
}

const MAX_CAPTURE_B64 = 20_000_000;

/** The Genesis /v1/capture body for one target + payload; null when the target is not a capture. */
function captureBody(target, payload = {}, { source = "desk" } = {}) {
  const t = typeof target === "string" ? targetById(target) : target;
  if (!t || t.via !== "capture") return null;
  const body = {
    text: String(payload.text || "").slice(0, 100_000),
    title: String(payload.title || payload.name || "").slice(0, 300),
    source: String(source).slice(0, 20),
    to: t.to,
    attachments: [],
  };
  if (payload.dataB64) {
    if (payload.dataB64.length > MAX_CAPTURE_B64) return { error: "the file is over the 15 MB send limit" };
    body.attachments.push({
      name: String(payload.name || "item").slice(0, 200),
      mime: String(payload.mime || "application/octet-stream").slice(0, 100),
      data_b64: payload.dataB64,
    });
  }
  if (!body.text && !body.attachments.length) return { error: "nothing to send" };
  return body;
}

/** A filesystem- and URL-safe key for the active workspace (null tenant = personal). */
function workspaceKey(tenant) {
  const raw = tenant && typeof tenant === "object"
    ? (tenant.id || tenant.tenantId || tenant.host || tenant.name || "")
    : String(tenant || "");
  const key = String(raw).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64);
  return key || "personal";
}

/** Hard isolation: an item syncs only into the workspace it was made in. */
function mayDeliver(itemKey, activeKey) {
  if (!itemKey || !activeKey) return { ok: false, reason: "no workspace on the item or the desk" };
  if (itemKey !== activeKey) {
    return { ok: false, reason: `made in workspace "${itemKey}", the desk is in "${activeKey}" -- switch back to send it` };
  }
  return { ok: true };
}

/** Saved files: <tool>-<YYYYMMDD-HHMMSS>.<ext>, never a path. */
function fileName(tool, ext, now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const t = String(tool || "item").replace(/[^a-z0-9-]/gi, "").slice(0, 24) || "item";
  const e = String(ext || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
  return `${t}-${stamp}.${e}`;
}

/** A page-supplied name reduced to a safe base name with an allowed extension. */
const SAVE_EXT = Object.freeze({
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "audio/midi": "mid", "audio/wav": "wav", "text/plain": "txt", "text/markdown": "md",
  "application/pdf": "pdf", "application/json": "json",
});
function safeSaveName(name, mime, tool, now = new Date()) {
  const ext = SAVE_EXT[String(mime || "").toLowerCase()];
  if (!ext) return null;
  const base = String(name || "").split(/[\\/]/).pop().replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9 _.-]/g, "").replace(/^\.+/, "").trim().slice(0, 80);
  return base ? `${base}.${ext}` : fileName(tool, ext, now);
}

/**
 * Voice control (owner 2026-11-13: voice commands for control: "record this", "draw",
 * "send to Jason", "open whiteboard"). Only a SHORT utterance that starts with a verb is
 * a command; anything else is conversation and goes to the agents.
 */
const VOICE_RULES = Object.freeze([
  [/^(stop|end) (the )?(recording|record)$/, "record.stop"],
  [/^(start )?(record|recording)( (this|the screen|a region|it))?$/, "record.region"],
  [/^(make|record) (a )?gif$/, "record.region.gif"],
  [/^(draw|start drawing|ink|annotate)( on (the )?screen)?$/, "ink.toggle"],
  [/^(stop drawing|done drawing)$/, "ink.toggle"],
  [/^(laser|laser pointer)$/, "ink.laser"],
  [/^(clear|clear (the )?(drawings?|ink|screen))$/, "ink.clear"],
  [/^(snip|screenshot|take a screenshot|capture( this)?)$/, "snip.region"],
  [/^(open |new )?(a )?(whiteboard|board)$/, "board.new"],
  [/^(new |add |pin )?(a )?(sticky( note)?|note)$/, "note.new"],
  [/^(open |new )?(a )?(sketch( pad)?|paint|painting)$/, "sketch.new"],
  [/^(open |play )?(the )?(piano|keyboard)$/, "piano.open"],
  [/^(quick type|scratch ?pad|type)$/, "scratch.new"],
  [/^(box|box (a|this) region|watch (this|a) region)$/, "region.box"],
  [/^(start )?(present|presentation|start (the )?presentation)$/, "present.start"],
  [/^(interact|interact mode)$/, "interact.toggle"],
  [/^(mute|mute (the )?mic|stop listening)$/, "audio.mic.mute"],
]);

/**
 * The optional wake word (cast.json voice.wakeWord, e.g. "aither"): with the open mic on,
 * only an utterance that STARTS with it is acted on, and the word is stripped. Push-to-talk
 * is an explicit press, so it never needs one. Returns {pass, text}.
 */
function wakeGate(said, { wakeWord = "", openMic = false } = {}) {
  const text = String(said || "").trim();
  const word = String(wakeWord || "").trim().toLowerCase();
  if (!openMic || !word) return { pass: Boolean(text), text };
  const re = new RegExp(`^(hey |ok |okay )?${word.replace(/[^a-z0-9 ]/g, "")}[\\s,.!?:]+`, "i");
  const m = text.match(re);
  if (!m) return { pass: false, text: "" };
  return { pass: true, text: text.slice(m[0].length).trim() };
}

function parseVoiceCommand(text) {
  const spoken = String(text || "").toLowerCase().replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim();
  const addressed = /^(hey |ok |okay )?(aither|desk)\s+/.test(spoken);
  const raw = spoken.replace(/^(hey |ok |okay )?(aither|desk)\s+/, "").replace(/^(please |can you |could you )/, "")
    .replace(/ please$/, "").trim();
  if (!raw || raw.split(" ").length > 6) return null;
  const send = raw.match(/^send (it |this |that )?to (.+)$/);
  // Sending moves the owner's content off the desk: only when the desk was addressed by
  // name ("aither, send it to jason"), never on a stray phrase.
  if (send && !addressed) return null;
  if (send) {
    const who = send[2].trim();
    const target = SEND_TARGETS.find((t) => t.id === who || t.label.toLowerCase() === who);
    if (target) return { id: "send.last", arg: target.id };
    if (who === "notes" || who === "my notes") return { id: "send.last", arg: "notes" };
    if (/^[a-z][a-z0-9 _.-]{0,40}$/.test(who)) return { id: "send.last", arg: `person:${who}` };
    return null;
  }
  for (const [re, id] of VOICE_RULES) if (re.test(raw)) return { id, arg: null };
  return null;
}

/**
 * Avatar frame policy. Before 2026-11-13 the scene redrew at 30 fps forever while idle.
 * Now: 60 while someone speaks or the pointer is on it, 30 for a short tail, 20 when
 * merely idle... (see FRAME), 10 after a minute with nothing happening, 0 when the window is hidden.
 */
const FRAME = Object.freeze({ active: 60, tail: 30, idle: 20, deep: 10, tailMs: 1500, deepAfterMs: 60_000 });

function frameBudget({ hidden = false, audible = false, orbiting = false, sinceInputMs = Infinity } = {}) {
  if (hidden) return 0;
  if (audible || orbiting) return FRAME.active;
  if (sinceInputMs < FRAME.tailMs) return FRAME.tail;
  if (sinceInputMs < FRAME.deepAfterMs) return FRAME.idle;
  return FRAME.deep;
}

/** A DIP rect (screen coords) cropped to one display -> device pixels inside that display's frame. */
function cropRect(rect, display) {
  if (!rect || !display || !display.bounds) return null;
  const b = display.bounds;
  const s = Number(display.scaleFactor) || 1;
  const x0 = Math.max(rect.x, b.x);
  const y0 = Math.max(rect.y, b.y);
  const x1 = Math.min(rect.x + rect.width, b.x + b.width);
  const y1 = Math.min(rect.y + rect.height, b.y + b.height);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return {
    x: Math.round((x0 - b.x) * s), y: Math.round((y0 - b.y) * s),
    width: Math.round((x1 - x0) * s), height: Math.round((y1 - y0) * s),
  };
}

/**
 * Graphics quick actions. `local` ones run in the desk (nativeImage); `mf` ones are Media
 * Forge ops on THIS machine's ComfyUI (127.0.0.1:8200, the owner key) -- never a paid
 * provider: BYO-pay means the desk never spends on the customer's behalf, so no provider
 * key is ever attached here and a paid-only op is refused.
 */
const GRAPHICS = Object.freeze([
  Object.freeze({ id: "resize", label: "Resize", local: true }),
  Object.freeze({ id: "convert", label: "Convert", local: true }),
  Object.freeze({ id: "remove_bg", label: "Remove background", mf: "remove_bg", params: { bg: "transparent" } }),
  Object.freeze({ id: "upscale", label: "Upscale 2x", mf: "upscale", params: { scale: 2 } }),
  Object.freeze({ id: "color_grade", label: "Colour grade (warm)", mf: "color_grade", params: { slope_r: 1.06, slope_b: 0.94 } }),
  Object.freeze({ id: "sharpen", label: "Sharpen", mf: "sharpen", params: { amount: 1 } }),
]);

function graphicsAction(id) {
  return GRAPHICS.find((g) => g.id === String(id || "")) || null;
}

/** Resize target dims: keep aspect, cap 8192, at least 1. */
function resizeDims(size, { width, height, scale } = {}) {
  const w0 = Math.max(1, Number(size && size.width) || 1);
  const h0 = Math.max(1, Number(size && size.height) || 1);
  let w; let h;
  if (Number(scale) > 0) { w = w0 * Number(scale); h = h0 * Number(scale); }
  else if (Number(width) > 0) { w = Number(width); h = Number(height) > 0 ? Number(height) : (w * h0) / w0; }
  else if (Number(height) > 0) { h = Number(height); w = (h * w0) / h0; }
  else return { width: w0, height: h0 };
  const cap = 8192;
  const k = Math.min(1, cap / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

module.exports = {
  MENU, MENU_IDS, menuGroups, SEND_TARGETS, targetById, publicTargets, captureBody,
  workspaceKey, mayDeliver, fileName, safeSaveName, SAVE_EXT, parseVoiceCommand, VOICE_RULES, wakeGate,
  FRAME, frameBudget, cropRect, GRAPHICS, graphicsAction, resizeDims, MAX_CAPTURE_B64,
};
