"use strict";

/**
 * browser-permissions.cjs -- what a site may use, asked once and remembered per site.
 *
 * Until now every permission a page asked for was denied (browser-policy
 * allowPermission), so a video call had no camera and a map had no location. Five
 * permissions now ASK the owner, like Edge does: camera, microphone, location,
 * notifications and reading the clipboard. Everything else stays denied.
 *
 * The rules, all in decide():
 *   - only the OWNER's web tab is ever asked. An agent's tab is denied without a
 *     prompt, also when it rides the owner's session, so an agent cannot switch a
 *     camera on. Console pages, hosted pages and extension pages are not asked here.
 *   - only a secure page (https, or this computer) and only its top frame.
 *   - Allow and Block are remembered per site (origin) in one JSON file in userData;
 *     the review page (aither://permissions) lists them and takes them back.
 *   - an InPrivate tab is asked every time and its answer is never written. A site
 *     the owner blocked stays blocked there.
 *   - the prompt always shows the END of the site's name. The start of a long host is
 *     what an attacker picks ("accounts.google.com.sign-in.x.evil.example"); the end is
 *     who really asks. Allow does nothing for the first half second a prompt is up, so
 *     a page cannot slide it under a click meant for something else.
 *   - taking an Allow back takes it from the pages that are open too (revokeGranted).
 *
 * Pure: no electron at module load. browser-window.cjs does the wiring.
 */

const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const MAX_SITES = 2000;
const MAX_PROMPT_HOST = 32; // characters of the host a prompt shows, counted from its end
const ALLOW_ARM_MS = 500; // a prompt's Allow is dead for this long after it appears

/** The permissions the owner is asked about, with the words the prompt uses. */
const KINDS = Object.freeze({
  camera: "use your camera",
  microphone: "use your microphone",
  geolocation: "know your location",
  notifications: "show notifications",
  "clipboard-read": "read what you copied",
});

/** Short names for the review page. */
const LABELS = Object.freeze({
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  "clipboard-read": "Clipboard",
});

/**
 * Electron's permission name (+ its details) as our kinds. "media" is the camera, the
 * microphone or both, by `mediaTypes` (a request) or `mediaType` (a check). A
 * permission that is not one of the five answers [] and stays denied.
 */
function kindsOf(permission, details = {}) {
  const name = String(permission || "");
  if (name === "media") {
    const types = [].concat((details && (details.mediaTypes || details.mediaType)) || []);
    const out = [];
    if (types.includes("video")) out.push("camera");
    if (types.includes("audio")) out.push("microphone");
    return out;
  }
  return Object.prototype.hasOwnProperty.call(KINDS, name) ? [name] : [];
}

/** The site a prompt is about: an https origin, or this computer over http. Else null. */
function promptableOrigin(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  // Chromium serves every *.localhost name from this computer, like localhost itself.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.origin;
  return null;
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== VERSION || !parsed.sites || typeof parsed.sites !== "object") return {};
    const sites = {};
    for (const [origin, kinds] of Object.entries(parsed.sites)) {
      if (promptableOrigin(origin) !== origin || !kinds || typeof kinds !== "object") continue;
      const row = {};
      for (const [kind, v] of Object.entries(kinds)) {
        if (!Object.prototype.hasOwnProperty.call(KINDS, kind) || !v) continue;
        if (v.value === "allow" || v.value === "block") row[kind] = { value: v.value, at: Number(v.at) || 0 };
      }
      if (Object.keys(row).length) sites[origin] = row;
    }
    return sites;
  } catch {
    return {};
  }
}

/**
 * The owner's remembered answers. One JSON file, written atomically.
 * @param {{file: string, now?: () => number}} opts
 */
function createPermissionStore({ file, now = () => Date.now() } = {}) {
  if (!file) throw new Error("createPermissionStore needs a file");
  let sites = readFile(file);

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, sites }));
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** "allow" | "block" | null for one site and one kind. */
    get(origin, kind) {
      const row = sites[String(origin || "")];
      return row && row[kind] ? row[kind].value : null;
    },

    /** Remember the owner's answer for these kinds on this site. */
    set(origin, kinds, value) {
      const site = promptableOrigin(origin);
      if (!site || site !== origin || (value !== "allow" && value !== "block")) return false;
      const list = [].concat(kinds || []).filter((k) => Object.prototype.hasOwnProperty.call(KINDS, k));
      if (!list.length) return false;
      if (!sites[site] && Object.keys(sites).length >= MAX_SITES) return false;
      const row = sites[site] || {};
      for (const kind of list) row[kind] = { value, at: now() };
      sites[site] = row;
      return save();
    },

    /** Take back one answer, or (no kind) every answer for the site. The site is asked again. */
    remove(origin, kind = null) {
      const row = sites[String(origin || "")];
      if (!row) return false;
      if (kind == null) delete sites[origin];
      else {
        if (!row[kind]) return false;
        delete row[kind];
        if (!Object.keys(row).length) delete sites[origin];
      }
      save();
      return true;
    },

    clear() {
      const n = Object.keys(sites).length;
      sites = {};
      save();
      return n;
    },

    /** Every remembered answer, by site then kind: {origin, kind, label, value, at}. */
    list() {
      const out = [];
      for (const origin of Object.keys(sites).sort()) {
        for (const kind of Object.keys(KINDS)) {
          const v = sites[origin][kind];
          if (v) out.push({ origin, kind, label: LABELS[kind], value: v.value, at: v.at });
        }
      }
      return out;
    },
  };
}

/**
 * What to do with one permission request.
 *
 * @param {object} req
 * @param {string} req.permission Electron's permission name
 * @param {object} [req.details]  Electron's details (mediaTypes / mediaType, isMainFrame)
 * @param {string} req.url        the requesting page's address (or origin)
 * @param {{by?: string, kind?: string, private?: boolean}|null} req.tab the tab it came from
 * @param {{get: Function}|null} req.store the remembered answers
 * @returns {{verdict: "allow"|"deny"|"prompt", origin: string|null, kinds: string[]}}
 */
function decide({ permission, details = {}, url, tab, store } = {}) {
  const kinds = kindsOf(permission, details);
  const origin = promptableOrigin(url);
  const deny = { verdict: "deny", origin, kinds };
  if (!kinds.length || !origin) return deny;
  // The owner's own web tab only: never an agent's, a console page's or an unknown sender's.
  if (!tab || tab.by !== "you" || (tab.kind || "web") !== "web") return deny;
  if (details && details.isMainFrame === false) return deny;
  const answers = kinds.map((kind) => (store ? store.get(origin, kind) : null));
  if (answers.includes("block")) return deny;
  // InPrivate: a remembered Allow does not carry over, and nothing is written.
  if (!tab.private && answers.every((a) => a === "allow")) return { verdict: "allow", origin, kinds };
  return { verdict: "prompt", origin, kinds };
}

/**
 * The site's name as a prompt shows it: whole when short, else its END after an
 * ellipsis. The registrable domain is at the end, so that is the part never cut.
 */
function promptHost(origin, max = MAX_PROMPT_HOST) {
  let host = String(origin || "");
  try { host = new URL(host).host; } catch { /* shown as given */ }
  return host.length > max ? `…${host.slice(1 - max)}` : host;
}

/** "meet.example.com wants to use your camera and microphone." Short enough to show whole. */
function promptText(origin, kinds) {
  const list = [].concat(kinds || []);
  const wants = list.includes("camera") && list.includes("microphone")
    ? ["use your camera and microphone", ...list.filter((k) => k !== "camera" && k !== "microphone").map((k) => KINDS[k])]
    : list.map((k) => KINDS[k]);
  return `${promptHost(origin)} wants to ${wants.filter(Boolean).join(" and ") || "use a device"}.`;
}

/** May Allow be pressed yet? Not in the first half second the prompt is on screen. */
function armed(shownAt, now) {
  return Number.isFinite(shownAt) && now - shownAt >= ALLOW_ARM_MS;
}

/**
 * The owner took an answer back on the review page: the pages that are open lose it
 * too, so the site asks again without a reload.
 * @param {Map<any, Set<string>>} granted tab id -> Set("origin kind") allowed for the page on screen
 * @param {string|null} origin null = every site
 * @param {string|null} [kind] null = every kind of that site
 * @returns {number} how many grants were taken back
 */
function revokeGranted(granted, origin = null, kind = null) {
  let n = 0;
  for (const [id, set] of granted) {
    for (const key of [...set]) {
      const cut = key.lastIndexOf(" ");
      if (origin != null && key.slice(0, cut) !== origin) continue;
      if (origin != null && kind != null && key.slice(cut + 1) !== kind) continue;
      set.delete(key);
      n += 1;
    }
    if (!set.size) granted.delete(id);
  }
  return n;
}

/**
 * The prompts waiting on the owner, per tab, oldest first. A page that asks twice for
 * the same thing waits on ONE prompt; every waiting callback gets the one answer.
 */
function createPrompts() {
  const byTab = new Map(); // tab id -> [{origin, kinds, callbacks}]
  const same = (a, origin, kinds) => a.origin === origin && a.kinds.join() === kinds.join();
  const settle = (entry, allow) => {
    for (const cb of entry.callbacks) {
      try { cb(Boolean(allow)); } catch { /* the page is gone */ }
    }
  };
  return {
    ask(tabId, { origin, kinds }, callback) {
      const queue = byTab.get(tabId) || [];
      const have = queue.find((e) => same(e, origin, kinds));
      if (have) have.callbacks.push(callback);
      else queue.push({ origin, kinds: kinds.slice(), callbacks: [callback] });
      byTab.set(tabId, queue);
      return this.head(tabId);
    },
    /** The prompt on screen for this tab: {origin, kinds, text}, or null. */
    head(tabId) {
      const first = (byTab.get(tabId) || [])[0];
      return first ? { origin: first.origin, kinds: first.kinds.slice(), text: promptText(first.origin, first.kinds) } : null;
    },
    /** The owner answered the prompt on screen. Returns what it was about, or null. */
    answer(tabId, allow) {
      const queue = byTab.get(tabId) || [];
      const first = queue.shift();
      if (!queue.length) byTab.delete(tabId);
      if (!first) return null;
      settle(first, allow);
      return { origin: first.origin, kinds: first.kinds };
    },
    /** The page left or the tab closed: everything waiting is denied, nothing remembered. */
    cancel(tabId) {
      const queue = byTab.get(tabId) || [];
      byTab.delete(tabId);
      for (const entry of queue) settle(entry, false);
      return queue.length;
    },
    pending(tabId) {
      return (byTab.get(tabId) || []).length;
    },
  };
}

module.exports = {
  ALLOW_ARM_MS, KINDS, LABELS, MAX_PROMPT_HOST,
  armed, createPermissionStore, createPrompts, decide, kindsOf, promptHost, promptText, promptableOrigin, revokeGranted,
};
