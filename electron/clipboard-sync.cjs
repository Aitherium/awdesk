"use strict";

/**
 * clipboard-sync.cjs -- the local clipboard, mirrored into AitherOS Online's
 * clipboard app (owner 2026-11-01: "a snip or copy on the local desktop must show
 * up in AitherOS Online synced").
 *
 * About once a second it reads the clipboard, fingerprints what it finds, and
 * when that changed queues it for the owner's Strata `clipboard` folder through
 * strata-sync.cjs:
 *   text  -> clip-YYYYMMDD-HHMMSS-<hash8>.json  {text, created_at, source_host, truncated?}
 *   image -> clip-YYYYMMDD-HHMMSS-<hash8>.png
 *
 * OFF BY DEFAULT. The switch is cast.json `clipboard.sync` (cast-config.cjs,
 * read through desk-settings.cjs on every tick, so the tray toggle, the Cast pane
 * or an `awsettings` pull all land within a second, no restart).
 *
 * SECRETS NEVER LEAVE. A clipboard is where keys travel: text that looks like a
 * credential is NOT pushed, and the skip is counted, never logged with its value.
 * looksSecret() covers the secret-safety.md prefixes (sk-, sk-ant-, ghp_, ghs_,
 * gho_, github_pat_, AKIA, pk_live_, sk_live_, xoxb-, xoxp-, aither_sk_), PEM
 * headers, JWTs, `password=` style assignments, and a long single token mixing
 * upper, lower and digits with high entropy. secrets-window.cjs has a token
 * MASKER (safeError) -- it is not exported and is deliberately broader (any 32+
 * run), which would refuse every long URL; this is the DETECTOR. Over-blocking a
 * look-alike is the fail-safe direction: it simply does not sync.
 *
 * Electron-free core: the clipboard reader, the queue, the switch and the clock
 * are injected, so clipboard-sync.test.cjs runs it under `node --test`.
 * electronReader() is the only part that touches Electron, lazily.
 */

const nodeCrypto = require("node:crypto");
const os = require("node:os");

const POLL_MS = 1000;
const MAX_TEXT_BYTES = 64 * 1024;
/** Images above this are not mirrored (a 4K PNG is ~10 MB; the route caps at 100). */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const SECRET_PATTERNS = Object.freeze([
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/,
  /(?<![A-Za-z0-9])(?:ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{20,}/,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/,
  /(?<![A-Za-z0-9])xox[bpars]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])aither_sk_[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PGP)[A-Z0-9 ]*-----/,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"']{8,}/i,
]);

/** Shannon entropy in bits per character. */
function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A lone token that reads like a key: 20-512 key-alphabet chars, no URL scheme,
 * upper AND lower AND digit (so hex SHAs, UUIDs and plain words pass), entropy >= 3.5.
 */
function looksLikeKeyToken(text) {
  const t = String(text || "").trim();
  if (t.length < 20 || t.length > 512 || /\s/.test(t) || t.includes("://")) return false;
  if (!/^[A-Za-z0-9+/=_\-.~]+$/.test(t)) return false;
  if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/[0-9]/.test(t)) return false;
  return entropy(t) >= 3.5;
}

/** True when the text must not leave the machine. */
function looksSecret(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (SECRET_PATTERNS.some((re) => re.test(t))) return true;
  return looksLikeKeyToken(t);
}

function hash(value) {
  return nodeCrypto.createHash("sha256").update(value).digest("hex");
}

/** Cap at maxBytes of UTF-8 without splitting a character. */
function capText(text, maxBytes = MAX_TEXT_BYTES) {
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= maxBytes) return { text: String(text), truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-`
    + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function clipName(kind, digest, date) {
  return `clip-${stamp(date)}-${digest.slice(0, 8)}.${kind === "image" ? "png" : "json"}`;
}

/**
 * The text payload Veil's clipboard app renders.
 * @returns {{name:string, bytes:Buffer, truncated:boolean}}
 */
function textPayload(text, { now = new Date(), host = os.hostname() } = {}) {
  const capped = capText(text);
  const body = { text: capped.text, created_at: now.toISOString(), source_host: host };
  if (capped.truncated) body.truncated = true;
  return {
    name: clipName("text", hash(text), now),
    bytes: Buffer.from(JSON.stringify(body), "utf8"),
    truncated: capped.truncated,
  };
}

/**
 * The sync loop.
 *
 * @param {object} deps
 * @param {() => {text?: string, image?: {fingerprint: string, png: () => Buffer}|null}} deps.read
 * @param {(item: object) => {ok: boolean}} deps.enqueue   strata-sync queue.enqueue
 * @param {() => boolean} deps.enabled                     cast.json clipboard.sync
 * @param {() => Date} [deps.now]
 * @param {string} [deps.host]
 * @param {Function} [deps.every] (fn, ms) => handle; [deps.stopEvery] (handle) => void
 */
function createClipboardSync({
  read, enqueue, enabled,
  now = () => new Date(),
  host = os.hostname(),
  every = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; },
  stopEvery = (t) => clearInterval(t),
  intervalMs = POLL_MS,
} = {}) {
  let lastText = null;
  let lastImage = null;
  let timer = null;
  const stats = { pushedText: 0, pushedImage: 0, skippedSecret: 0, skippedLarge: 0, errors: 0 };

  function snapshot() {
    let seen;
    try { seen = read() || {}; } catch { stats.errors += 1; return null; }
    return {
      textKey: typeof seen.text === "string" && seen.text.trim() ? hash(seen.text) : null,
      text: seen.text,
      imageKey: seen.image && seen.image.fingerprint ? String(seen.image.fingerprint) : null,
      image: seen.image || null,
    };
  }

  /**
   * Mark what is on the clipboard RIGHT NOW as already seen, without pushing it.
   * Called when the switch turns on (no backfill of an old copy) and by the
   * snipping tool after it puts a screenshot there (it uploads to `screenshots`
   * itself; mirroring it into `clipboard` too would double every snip).
   */
  function adoptCurrent() {
    const s = snapshot();
    if (!s) return;
    lastText = s.textKey;
    lastImage = s.imageKey;
  }

  /** One poll. Returns what it did, for tests and the log line. */
  function tick() {
    let on;
    try { on = Boolean(enabled()); } catch { on = false; }
    if (!on) return { action: "off" };
    const s = snapshot();
    if (!s) return { action: "error" };
    const date = now();
    if (s.imageKey && s.imageKey !== lastImage) {
      lastImage = s.imageKey;
      lastText = s.textKey; // a copied image often carries alt text; the image is the clip
      let png;
      try { png = s.image.png(); } catch { stats.errors += 1; return { action: "error" }; }
      if (!png || !png.length) return { action: "none" };
      if (png.length > MAX_IMAGE_BYTES) { stats.skippedLarge += 1; return { action: "skipped-large" }; }
      const verdict = enqueue({ folder: "clipboard", name: clipName("image", hash(png), date), bytes: png, contentType: "image/png" });
      if (verdict && verdict.ok) stats.pushedImage += 1; else stats.errors += 1;
      return { action: "image", ok: Boolean(verdict && verdict.ok) };
    }
    if (s.textKey && s.textKey !== lastText) {
      lastText = s.textKey;
      if (!s.imageKey) lastImage = null;
      if (looksSecret(s.text)) { stats.skippedSecret += 1; return { action: "skipped-secret" }; }
      const payload = textPayload(s.text, { now: date, host });
      const verdict = enqueue({ folder: "clipboard", name: payload.name, bytes: payload.bytes, contentType: "application/json" });
      if (verdict && verdict.ok) stats.pushedText += 1; else stats.errors += 1;
      return { action: "text", ok: Boolean(verdict && verdict.ok), truncated: payload.truncated };
    }
    return { action: "none" };
  }

  function start() {
    if (timer) return;
    adoptCurrent();
    timer = every(() => { try { tick(); } catch { stats.errors += 1; } }, intervalMs);
  }

  function stop() {
    if (timer) { stopEvery(timer); timer = null; }
  }

  return { start, stop, tick, adoptCurrent, stats: () => ({ ...stats }), running: () => Boolean(timer) };
}

/**
 * The Electron clipboard as a read() for createClipboardSync. The image
 * fingerprint is a hash of a 32-px-wide thumbnail's bitmap plus the full size:
 * cheap enough for a 1 s poll on a 4K image, and the full PNG is encoded only
 * when that fingerprint changed.
 */
function electronReader(clipboard = require("electron").clipboard) {
  return () => {
    const formats = clipboard.availableFormats();
    const text = formats.some((f) => f.startsWith("text/")) ? clipboard.readText() : "";
    let image = null;
    if (formats.some((f) => f.startsWith("image/"))) {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        const size = img.getSize();
        const thumb = img.resize({ width: 32 });
        image = {
          fingerprint: `${size.width}x${size.height}:${hash(thumb.toBitmap())}`,
          png: () => img.toPNG(),
        };
      }
    }
    return { text, image };
  };
}

/** cast.json clipboard.sync, live (desk-settings caches on the file's mtime). */
function syncEnabled() {
  try {
    const c = require("./desk-settings.cjs").current();
    return Boolean(c && c.clipboard && c.clipboard.sync === true);
  } catch {
    return false;
  }
}

/** Persist the switch. Returns the new state; throws only if cast.json refused the write. */
function setSyncEnabled(on, { file } = {}) {
  const cast = require("./cast-config.cjs");
  const result = cast.write((draft) => {
    const prev = draft.clipboard && typeof draft.clipboard === "object" && !Array.isArray(draft.clipboard) ? draft.clipboard : {};
    draft.clipboard = { ...prev, sync: Boolean(on) };
  }, file ? { file } : undefined);
  if (!result.ok) throw new Error(result.error || "cast.json write failed");
  return Boolean(on);
}

module.exports = {
  POLL_MS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, SECRET_PATTERNS,
  looksSecret, looksLikeKeyToken, entropy, capText, clipName, textPayload,
  createClipboardSync, electronReader, syncEnabled, setSyncEnabled,
};
