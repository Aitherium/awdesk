"use strict";

/**
 * sprite-core.cjs -- the desk fairy IS the owner's AitherSprite (owner 2026-11-02:
 * "the fairy becomes my AitherSprite, not a second creature").
 *
 * The sprite already exists end to end: the engine (AitherOS/lib/companion/
 * AitherSprite.py, to_public_dict), the AitherSprite service behind the portal's
 * /api/sprite/* proxy (Veil app/api/sprite route -> aitheros-sprite
 * /api/v1/aither-sprite), owner-scoped by the caller's bearer, and the awkit
 * SpritePanel. This module adds NO engine: it reads GET /api/sprite/me (name,
 * stage, mood_label) and POSTs /api/sprite/me/teach ({kind,title,content}, the
 * TeachBody limits 120 / 4000), exactly what SpritePanel and the sprite_* MCP
 * tools call.
 *
 * Identity is the desk's ONE sign-in (browserWindow.onlineToken, the bearer
 * awconnect also gets), else the `adk login` profile -- notebooks-client
 * ownerToken, so there is no second credential path and no secret in code.
 *
 * Degrade silently: no bearer, a refused bearer, no sprite hatched, the portal
 * down or a body that is not a sprite all yield `null`, and the fairy stays the
 * plain fairy (white, "Aither"). Only an explicit `sprite.status` / `sprite.teach`
 * says WHY in the bubble.
 *
 * Pure except createSpriteClient, which takes fetch by injection.
 */

const path = require("node:path");

const CONTROL_PLANE = "https://api.aitherium.com";
const SPRITE_PAGE = "https://aitherium.com/workspace/sprite";
const STAGES = Object.freeze(["egg", "baby", "child", "teen", "adult", "elder"]);
const TITLE_MAX = 120;
const CONTENT_MAX = 4000;

/**
 * Mood -> fairy tint. The labels are SpriteState.mood_label()'s whole vocabulary
 * (joyful, content, curious, sleepy, grumpy, sad, dormant); an unknown label
 * gets no tint, so the fairy keeps its default rather than a guessed colour.
 */
const MOOD_TINTS = Object.freeze({
  joyful: "#ffd166",
  content: "#9be7a8",
  curious: "#7cc8ff",
  sleepy: "#b8a6ff",
  grumpy: "#ff8a5c",
  sad: "#8fa3c8",
  dormant: "#8a8f98",
});

function cleanText(value, max) {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

/**
 * The sprite as the fairy shows it, from GET /api/sprite/me (or /me/status, which
 * may wrap it as {sprite: {...}}). null when the body is not a sprite.
 *
 * @param {object} json  the API body
 * @returns {{name:string, stage:string, mood:string, tint:{name:string,css:string}|null,
 *            line:string, tooltip:string, knowledge:number}|null}
 */
function spriteView(json) {
  const body = json && typeof json === "object" && json.sprite && typeof json.sprite === "object" ? json.sprite : json;
  if (!body || typeof body !== "object") return null;
  const name = cleanText(body.name, 40);
  const stage = cleanText(body.stage, 16).toLowerCase();
  if (!name || !STAGES.includes(stage)) return null;
  const mood = cleanText(body.mood_label || (typeof body.mood === "string" ? body.mood : ""), 16).toLowerCase();
  const css = MOOD_TINTS[mood] || null;
  const knowledge = Number.isFinite(Number(body.knowledge_count)) ? Math.max(0, Math.floor(Number(body.knowledge_count))) : 0;
  const parts = [name, stage, mood].filter(Boolean);
  const line = parts.join(" · ");
  const tooltip = `${line}${knowledge ? ` · knows ${knowledge} thing${knowledge === 1 ? "" : "s"}` : ""}`
    + " — click to open, drag onto a window or avatar to attach, right-click for the menu";
  return {
    name, stage, mood: mood || null,
    tint: css ? { name: `sprite-${mood}`, css } : null,
    line, tooltip, knowledge,
  };
}

/** A one-line status sentence for `sprite.status`, from a view or a failure. */
function statusLine(view, failure = null) {
  if (view) {
    return `${view.name} is a ${view.stage}${view.mood ? `, feeling ${view.mood}` : ""}`
      + `${view.knowledge ? ` · knows ${view.knowledge} thing${view.knowledge === 1 ? "" : "s"}` : ""}.`;
  }
  const why = failure && failure.reason;
  if (why === "signed-out") return "Sign in to AitherOS Online to wake your sprite.";
  if (why === "no-sprite") return "No sprite hatched yet — open Sprite to hatch one.";
  if (why === "refused") return "Your sign-in was refused; sign in again to reach your sprite.";
  return "Your sprite is out of reach right now (AitherOS Online did not answer).";
}

/**
 * Clipboard text that carries a credential is never taught (a sprite's knowledge
 * lands in the owner's wiki). The common token shapes, plus a PEM block.
 */
const SECRET_TEXT = Object.freeze([
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\b[ps]k_live_[A-Za-z0-9]{16,}/, /\bxox[bpas]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
]);
function looksSecret(text) {
  const s = String(text || "");
  return SECRET_TEXT.some((re) => re.test(s));
}

/** Looks like a filesystem path (absolute Windows or POSIX, or ~). */
function looksLikePath(text) {
  const s = String(text || "").trim();
  if (!s || s.includes("\n") || s.length > 400) return false;
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/") || s.startsWith("~/");
}

/**
 * What `sprite.teach` teaches: the typed/bridge arg first, else the clipboard (the
 * selection the owner just copied), else the caption of the last snip the orb
 * answered about. A file path becomes a `link` entry named for the file; text
 * becomes a `fact`. Returns null when there is nothing to teach.
 *
 * `arg` may also be JSON {text?, path?, caption?, title?} (bridge / MCP callers).
 *
 * @returns {{kind:"fact"|"link", title:string, content:string, source:string}|null}
 */
function teachPayload({ arg = null, selection = "", clipboard = "", lastCaption = "" } = {}) {
  let given = arg == null ? "" : String(arg).trim();
  let explicitTitle = "";
  let source = "arg";
  if (given.startsWith("{")) {
    try {
      const o = JSON.parse(given);
      explicitTitle = cleanText(o.title, TITLE_MAX);
      if (o.path) { given = String(o.path); }
      else if (o.caption) { given = String(o.caption); source = "snip"; }
      else given = String(o.text || "");
    } catch { /* not JSON: teach the text as written */ }
  }
  let text = given.trim();
  if (!text) { text = String(selection || "").trim(); source = "selection"; }
  if (!text) { text = String(clipboard || "").trim(); source = "clipboard"; }
  if (!text) { text = String(lastCaption || "").trim(); source = "snip"; }
  if (!text) return null;
  if (looksLikePath(text)) {
    const p = text.replace(/^["']|["']$/g, "");
    const base = path.win32.basename(p) || path.posix.basename(p) || p;
    return { kind: "link", title: cleanText(explicitTitle || base, TITLE_MAX), content: cleanText(p, CONTENT_MAX), source: source === "arg" ? "path" : source };
  }
  const content = cleanText(text, CONTENT_MAX);
  const first = content.split(/\r?\n/, 1)[0];
  const title = explicitTitle || (first.length > 80 ? `${first.slice(0, 79)}…` : first);
  return { kind: "fact", title: cleanText(title, TITLE_MAX) || "A note", content, source };
}

function controlPlane(env = process.env) {
  return String(env.AITHER_PORTAL_URL || env.AITHER_ELYSIUM_URL || CONTROL_PLANE).replace(/\/+$/, "");
}

/**
 * The sprite over the portal, as the signed-in owner.
 *
 * @param {object} opts
 * @param {Function} [opts.fetchImpl]  fetch
 * @param {Function|string|null} [opts.token]  the desk's Online bearer (or a provider)
 * @param {Function} [opts.fallbackToken]  the `adk login` bearer (notebooks-client.ownerToken)
 * @param {object} [opts.env]
 */
function createSpriteClient({ fetchImpl = globalThis.fetch, token = null, fallbackToken = null, env = process.env, timeoutMs = 8000 } = {}) {
  const bearer = async () => {
    let desk;
    try { desk = typeof token === "function" ? await token() : token; } catch { desk = null; }
    if (typeof desk === "string" && desk) return desk;
    try {
      const fb = typeof fallbackToken === "function" ? fallbackToken() : require("./notebooks-client.cjs").ownerToken({ env });
      return typeof fb === "string" ? fb : "";
    } catch {
      return "";
    }
  };
  async function call(method, route, body) {
    const t = await bearer();
    if (!t) return { ok: false, reason: "signed-out" };
    if (typeof fetchImpl !== "function") return { ok: false, reason: "offline" };
    const headers = { Accept: "application/json", Authorization: `Bearer ${t}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetchImpl(`${controlPlane(env)}/api/sprite${route}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: "offline" };
    }
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "refused", status: res.status };
    if (res.status === 404) return { ok: false, reason: "no-sprite", status: 404 };
    if (!res.ok) return { ok: false, reason: "offline", status: res.status };
    return { ok: true, data };
  }
  return {
    /** The fairy's view, or {ok:false, reason} -- never throws. */
    async status() {
      const r = await call("GET", "/me");
      if (!r.ok) return { ok: false, reason: r.reason, view: null };
      const view = spriteView(r.data);
      return view ? { ok: true, view } : { ok: false, reason: "no-sprite", view: null };
    },
    /** Teach one entry (knowledge IS nourishment server-side). */
    async teach(payload) {
      if (!payload || !payload.title) return { ok: false, reason: "empty" };
      const r = await call("POST", "/me/teach", { kind: payload.kind, title: payload.title, content: payload.content });
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, data: r.data };
    },
  };
}

module.exports = {
  CONTROL_PLANE, SPRITE_PAGE, MOOD_TINTS, STAGES, TITLE_MAX, CONTENT_MAX,
  spriteView, statusLine, teachPayload, looksLikePath, looksSecret, createSpriteClient,
};
