"use strict";

/**
 * browser-passwords.cjs -- the Aither Browser's password manager and login autofill.
 *
 * Saved logins live in one JSON file in the desk's userData, written atomically
 * (tmp + rename). Each password is encrypted with Electron safeStorage (DPAPI on
 * Windows) and stored as base64; when encryption is unavailable nothing is saved,
 * because a plaintext password file is worse than no password manager.
 *
 * Web tabs have no preload. Capture, detection and fill run from main through
 * executeJavaScriptInIsolatedWorld, so the page's own scripts never see the stash or
 * the fill code. Only the owner's tabs get fill or capture: an agent never receives
 * a password, and nothing here is reachable from an agent tool.
 *
 * Only https origins (and http on localhost / 127.0.0.1) are accepted. An origin is
 * scheme + host + port, so a login saved for one site never fills on another.
 */

const nodeFs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const VERSION = 1;
const MAX_ENTRIES = 2000;
const MAX_FIELD = 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalise a URL to its origin (scheme + host + port), or null when logins are never
 * kept for it: anything but https, http on localhost, or a URL that does not parse.
 * @param {string} url
 * @returns {string|null}
 */
function normalizeOrigin(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "https:") return u.origin;
    if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return u.origin;
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether the browser may offer to save or fill a login in this tab. Fails closed:
 * only the owner's tab ("you") on an https (or localhost) page. Agent tabs, aither://,
 * chrome-extension:, file:, data: and plain http never qualify.
 * @param {{tabBy?: string, url?: string}} opts
 * @returns {boolean}
 */
function shouldOffer({ tabBy, url } = {}) {
  if (tabBy !== "you") return false;
  return normalizeOrigin(url) !== null;
}

function emptyData() {
  return { version: VERSION, entries: [] };
}

function validEntry(e) {
  return Boolean(e && typeof e.id === "string" && typeof e.enc === "string" && typeof e.username === "string"
    && typeof e.origin === "string" && normalizeOrigin(e.origin) === e.origin);
}

function readFile(fsImpl, file) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.entries)) return emptyData();
    return { version: VERSION, entries: parsed.entries.filter(validEntry) };
  } catch {
    return emptyData();
  }
}

/**
 * Open (or create) the vault.
 * @param {{file: string, safeStorage: {isEncryptionAvailable(): boolean, encryptString(s: string): Buffer,
 *   decryptString(b: Buffer): string}, fsImpl?: typeof import("node:fs"), now?: () => number}} opts
 */
function createVault({ file, safeStorage, fsImpl = nodeFs, now = () => Date.now() } = {}) {
  if (!file) throw new Error("createVault needs a file");
  if (!safeStorage) throw new Error("createVault needs safeStorage");
  const data = readFile(fsImpl, file);

  function encryptionReady() {
    try { return Boolean(safeStorage.isEncryptionAvailable()); } catch { return false; }
  }

  function save() {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(data));
      fsImpl.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  function find(id) {
    return data.entries.find((e) => e.id === id) || null;
  }

  return {
    /**
     * Save a login. Same origin + username updates the password in place.
     * @param {{origin: string, username?: string, password: string}} login
     * @returns {{ok: boolean, updated?: boolean, id?: string, error?: string}}
     */
    add({ origin, username = "", password } = {}) {
      const o = normalizeOrigin(origin);
      if (!o) return { ok: false, error: "logins are saved only for https sites (or localhost)" };
      if (typeof password !== "string" || !password) return { ok: false, error: "no password to save" };
      if (password.length > MAX_FIELD) return { ok: false, error: "password too long" };
      if (!encryptionReady()) return { ok: false, error: "OS encryption is unavailable; nothing was saved" };
      const user = String(username || "").slice(0, MAX_FIELD);
      let enc;
      try { enc = Buffer.from(safeStorage.encryptString(password)).toString("base64"); } catch {
        return { ok: false, error: "encryption failed; nothing was saved" };
      }
      const existing = data.entries.find((e) => e.origin === o && e.username === user);
      const at = now();
      if (existing) {
        const prior = { enc: existing.enc, at: existing.at };
        existing.enc = enc;
        existing.at = at;
        if (!save()) { Object.assign(existing, prior); return { ok: false, error: "could not write the vault" }; }
        return { ok: true, updated: true, id: existing.id };
      }
      if (data.entries.length >= MAX_ENTRIES) return { ok: false, error: "the vault is full" };
      const entry = { id: randomBytes(8).toString("hex"), origin: o, username: user, enc, at };
      data.entries.push(entry);
      if (!save()) { data.entries.pop(); return { ok: false, error: "could not write the vault" }; }
      return { ok: true, updated: false, id: entry.id };
    },

    /**
     * Logins saved for the origin of a URL. Never includes a password.
     * @param {string} originOrUrl
     * @returns {{id: string, username: string}[]}
     */
    forOrigin(originOrUrl) {
      const o = normalizeOrigin(originOrUrl);
      if (!o) return [];
      return data.entries.filter((e) => e.origin === o).sort((a, b) => b.at - a.at)
        .map((e) => ({ id: e.id, username: e.username }));
    },

    /**
     * Decrypt one password, for fill into the owner's tab or the owner's vault UI only.
     * @param {string} id
     * @returns {string|null}
     */
    reveal(id) {
      const e = find(id);
      if (!e || !encryptionReady()) return null;
      try { return safeStorage.decryptString(Buffer.from(e.enc, "base64")); } catch { return null; }
    },

    /** Forget one login. Returns false when there was nothing to remove. */
    remove(id) {
      const i = data.entries.findIndex((e) => e.id === id);
      if (i < 0) return false;
      const [gone] = data.entries.splice(i, 1);
      if (!save()) { data.entries.splice(i, 0, gone); return false; }
      return true;
    },

    /** Every saved login, newest first, without passwords. */
    list() {
      return data.entries.slice().sort((a, b) => b.at - a.at)
        .map((e) => ({ id: e.id, origin: e.origin, username: e.username, at: e.at }));
    },

    /** How many logins are saved. */
    count() {
      return data.entries.length;
    },
  };
}

// --- isolated-world scripts -------------------------------------------------------
// Shared helpers, inlined into each script (each runs as its own expression).
const HELPERS = `
  const visible = (el) => {
    if (!el || el.disabled || el.type === "hidden") return false;
    const r = el.getClientRects();
    if (!r || !r.length) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const TEXTISH = new Set(["", "text", "email", "tel"]);
  const scopeOf = (pw) => pw.form || document;
  const passwordsIn = (scope) => Array.from(scope.querySelectorAll("input[type=password]")).filter(visible);
  const usernameFor = (pw) => {
    const scope = scopeOf(pw);
    const inputs = Array.from(scope.querySelectorAll("input")).filter((el) =>
      visible(el) && TEXTISH.has(String(el.getAttribute("type") || "").toLowerCase())
      && (pw.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING));
    if (inputs.length) return inputs[inputs.length - 1];
    return scope.querySelector("input[autocomplete~=username]") || document.querySelector("input[autocomplete~=username]");
  };
`;

/**
 * Capture: run in the isolated world on did-stop-loading (and did-navigate-in-page).
 * Attaches once per document; on a login submit it stashes {origin, username,
 * password, at} in an isolated-world variable that PENDING_SCRIPT reads and clears.
 * @type {string}
 */
const CAPTURE_SCRIPT = `(() => {
  const KEY = Symbol.for("aither.passwords.capture");
  if (window[KEY]) return false;
  window[KEY] = true;
  ${HELPERS}
  const grab = (scope) => {
    const pws = passwordsIn(scope).filter((el) => el.value);
    if (!pws.length) return;
    // A change-password form (current, new, confirm): keep the new one.
    let pw = pws[0];
    if (pws.length >= 2 && pws[pws.length - 1].value === pws[pws.length - 2].value) pw = pws[pws.length - 1];
    const u = usernameFor(pw);
    window[Symbol.for("aither.passwords.pending")] = {
      origin: location.origin,
      username: u ? String(u.value || "") : "",
      password: String(pw.value),
      at: Date.now(),
    };
  };
  document.addEventListener("submit", (ev) => {
    try { if (ev.target && ev.target.tagName === "FORM") grab(ev.target); } catch { /* never break the page */ }
  }, true);
  document.addEventListener("click", (ev) => {
    try {
      const t = ev.target && ev.target.closest ? ev.target.closest("button, input[type=submit], input[type=image], [role=button]") : null;
      if (!t) return;
      const type = String(t.getAttribute("type") || "").toLowerCase();
      if (t.tagName === "BUTTON" && type && type !== "submit") return;
      grab(t.form || t.closest("form") || document);
    } catch { /* never break the page */ }
  }, true);
  document.addEventListener("keydown", (ev) => {
    try {
      if (ev.key === "Enter" && ev.target && ev.target.type === "password") grab(ev.target.form || document);
    } catch { /* never break the page */ }
  }, true);
  return true;
})()`;

/**
 * Pending: returns the stashed login ({origin, username, password, at}) or null,
 * and clears it. Main checks the returned origin against the tab's URL itself.
 * @type {string}
 */
const PENDING_SCRIPT = `(() => {
  const KEY = Symbol.for("aither.passwords.pending");
  const p = window[KEY] || null;
  window[KEY] = null;
  return p;
})()`;

/**
 * Detect: true when the page shows a visible password field.
 * @type {string}
 */
const DETECT_LOGIN_SCRIPT = `(() => {
  ${HELPERS}
  return passwordsIn(document).length > 0;
})()`;

/**
 * Fill code for the isolated world: sets the login form's username and password
 * through the native value setter and fires input + change, so framework-managed
 * forms (React) register the values. Returns {filled: boolean}.
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
function fillScript(username, password) {
  // JSON.stringify escapes quotes and backslashes; the extra replaces keep "<", U+2028
  // and U+2029 from ending or breaking the literal in any embedding.
  const lit = (v) => JSON.stringify(String(v == null ? "" : v))
    .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `(() => {
  ${HELPERS}
  const USERNAME = ${lit(username)};
  const PASSWORD = ${lit(password)};
  const pw = passwordsIn(document)[0];
  if (!pw) return { filled: false };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const put = (el, v) => {
    el.focus();
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const u = USERNAME ? usernameFor(pw) : null;
  if (u) put(u, USERNAME);
  put(pw, PASSWORD);
  return { filled: true };
})()`;
}

// --- delivery to main -------------------------------------------------------------
// Measured 2026-11-13: webContents.executeJavaScript* waits for a loading page to
// finish, so a PENDING_SCRIPT read at did-start-navigation runs in the NEW document
// and the login submitted by the old one is lost. WebFrameMain can run code only in the
// page's own world. So the isolated world SENDS the login the moment it is submitted,
// over the one channel it has: a console message, which main receives (console-message)
// before the page unloads. The message is XOR-ed with a per-document random pad and
// carries a per-document token; both live only in the isolated world's source and in
// main. The page cannot read either, so it can neither read the login nor forge one.

/** Prefix of a capture message (an invisible separator, then a name). */
const CHANNEL = "⁣aither-pw:";
const PAD_BYTES = 2048;

/** A fresh key for one document: {token, pad (Buffer)}. */
function newCaptureKey() {
  return { token: randomBytes(16).toString("hex"), pad: randomBytes(PAD_BYTES) };
}

/**
 * CAPTURE_SCRIPT that also delivers each submitted login to main, encrypted with `key`.
 * @param {{token: string, pad: Buffer}} key
 * @returns {string}
 */
function captureScriptFor(key) {
  const send = `
    try {
      const PAD = Uint8Array.from(atob(${JSON.stringify(key.pad.toString("base64"))}), (c) => c.charCodeAt(0));
      const p = window[Symbol.for("aither.passwords.pending")];
      const bytes = new TextEncoder().encode(JSON.stringify({ t: ${JSON.stringify(key.token)}, origin: p.origin, username: p.username, password: p.password }));
      if (bytes.length <= PAD.length) {
        let bin = "";
        for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] ^ PAD[i]);
        console.debug(${JSON.stringify(CHANNEL)} + btoa(bin));
      }
    } catch { /* never break the page */ }`;
  const marker = "      at: Date.now(),\n    };\n";
  if (!CAPTURE_SCRIPT.includes(marker)) throw new Error("CAPTURE_SCRIPT changed: captureScriptFor cannot attach");
  return CAPTURE_SCRIPT.replace(marker, `${marker}${send}\n`).replace('Symbol.for("aither.passwords.capture")', `Symbol.for("aither.passwords.capture.${key.token}")`);
}

/**
 * Decode a console message from captureScriptFor(key): {origin, username, password},
 * or null when it is not one (wrong prefix, wrong key, forged, malformed).
 */
function decodeCaptured(message, key) {
  const text = String(message || "");
  if (!key || !text.startsWith(CHANNEL)) return null;
  try {
    const raw = Buffer.from(text.slice(CHANNEL.length), "base64");
    if (!raw.length || raw.length > key.pad.length) return null;
    const plain = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i += 1) plain[i] = raw[i] ^ key.pad[i];
    const data = JSON.parse(plain.toString("utf8"));
    if (!data || data.t !== key.token || typeof data.password !== "string" || !data.password) return null;
    return { origin: String(data.origin || ""), username: String(data.username || ""), password: data.password };
  } catch {
    return null;
  }
}

module.exports = {
  CHANNEL,
  captureScriptFor,
  decodeCaptured,
  newCaptureKey,
  createVault,
  normalizeOrigin,
  shouldOffer,
  fillScript,
  CAPTURE_SCRIPT,
  PENDING_SCRIPT,
  DETECT_LOGIN_SCRIPT,
  detectLoginScript: DETECT_LOGIN_SCRIPT,
};
