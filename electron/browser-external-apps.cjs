"use strict";

/**
 * browser-external-apps.cjs -- links that open another app (mailto:, tel:, Zoom, Teams...).
 *
 * A web tab only ever follows http(s), so a "Join in Zoom" button, a mailto: link and a
 * "tel:" number did nothing at all. For a short allow-list of schemes the OWNER is now
 * asked "Open <App>?" in the toolbar, with Open / Always for this site / Not now, and
 * the link is handed to the system (shell.openExternal) only on their answer.
 *
 * The rules, all in judge():
 *   - only the owner's own web or hosted tab. An agent's tab gets nothing: no notice,
 *     no launch. An agent must not start programs on the owner's computer.
 *   - only the schemes in APPS. Everything else stays refused exactly as before
 *     (file:, javascript:, ms-msdt:, search-ms:, any scheme a site invents).
 *   - the address is passed on EXACTLY as the page gave it, after a shape check: at
 *     most MAX_LINK characters, no control characters, no whitespace (ASCII or not),
 *     no quotes, backticks or backslashes, raw or percent-encoded, and it must parse as a URL of that scheme. A link that fails is refused.
 *   - the question names WHO asks (whoAsks): the page when the page itself followed the
 *     link, the redirecting site when a web address redirected to an app link, the
 *     frame's or the other window's site otherwise. A link on a trusted site that
 *     redirects through another, or a popup that sets opener.location, is never
 *     credited to the page the tab happens to show.
 *   - "Always for this site" is remembered per site and per app, only for a secure page
 *     (https, or this computer), never InPrivate, never for Steam or VS Code (their
 *     links can run things: asked every time). It is honoured only when the page
 *     itself followed the link, on a page the owner has clicked or typed in (main reads the
 *     page's user-activation flag in the isolated world; Chromium has already spent the
 *     click itself by the time a link reaches main, measured on Electron 39), and at
 *     most once every AUTO_OPEN_GAP_MS per tab. Anything else asks again, so a page
 *     cannot start an app in a loop. It is listed and taken back on aither://permissions
 *     like every other remembered answer.
 *   - Open is dead for the prompt's first half second (browser-permissions ALLOW_ARM_MS),
 *     so a page cannot slide the question under a click meant for something else.
 *
 * Pure: no electron at module load.
 */

const fs = require("node:fs");
const path = require("node:path");
const { promptHost, promptableOrigin } = require("./browser-permissions.cjs");

const VERSION = 1;
const MAX_SITES = 2000;
const MAX_LINK = 2048;
/** A remembered "Always" opens without a question at most this often per tab. */
const AUTO_OPEN_GAP_MS = 5000;
/** Run in the page's isolated world: has the owner clicked or typed in this page? */
const INTERACTED_SCRIPT = "Boolean(navigator.userActivation && navigator.userActivation.hasBeenActive)";
/** The review page's kind for a remembered "Always": "open:<scheme>". */
const KIND_PREFIX = "open:";
/**
 * Apps whose links can run things on this computer (a Steam "run" link, a VS Code
 * extension or file link): the owner is asked EVERY time, "Always" is never offered,
 * stored or honoured for them.
 */
const NEVER_ALWAYS = Object.freeze(["steam:", "vscode:"]);
/** Percent-encoded quote, backtick, backslash, line break and NUL: a handler that decodes its link sees the raw character. */
const ENCODED_UNSAFE = /%(?:22|27|60|5c|0a|0d|00)/i;
/** Whitespace outside ASCII (no-break space, line and paragraph separators, ideographic space, BOM...). */
const OTHER_SPACE = /[\u0085\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** The only schemes ever handed to the system, and the app name the owner reads. */
const APPS = Object.freeze({
  "mailto:": "your mail app",
  "tel:": "your phone app",
  "sms:": "your messages app",
  "zoommtg:": "Zoom",
  "zoomus:": "Zoom",
  "msteams:": "Microsoft Teams",
  "slack:": "Slack",
  "spotify:": "Spotify",
  "discord:": "Discord",
  "steam:": "Steam",
  "vscode:": "Visual Studio Code",
});

/** Capitalised for a list row: "Open Zoom", "Open your mail app". */
function labelFor(scheme) {
  return `Open ${APPS[scheme] || scheme}`;
}

/**
 * The link as it will be handed to the system, or null when it is not one we open.
 * @returns {{url: string, scheme: string, app: string} | null}
 */
function launchable(url) {
  if (typeof url !== "string" || !url || url.length > MAX_LINK) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f"'`<>\\^{|}]/.test(url)) return null;
  if (ENCODED_UNSAFE.test(url) || OTHER_SPACE.test(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const scheme = parsed.protocol.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(APPS, scheme)) return null;
  return { url, scheme, app: APPS[scheme] };
}

/** May "Always for this site" exist for this app at all? */
function alwaysEligible(scheme) {
  return Object.prototype.hasOwnProperty.call(APPS, scheme) && !NEVER_ALWAYS.includes(scheme);
}

function originOf(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * WHO asks for an app link: the site the question names, and whether it is the page
 * itself asking (`direct`). The tab's current page is not always the one that started
 * the navigation, and a remembered "Always" belongs to the site that was asked about:
 *
 *   navigate  a link or script navigation in the tab. Direct only when the frame that
 *             started it is known and has the page's own origin. A cross-origin frame
 *             or another window (a popup setting opener.location) is named instead and
 *             is not direct; so is a navigation nobody in a page started.
 *   redirect  a web address that answered with a redirect to an app link. The site that
 *             redirected is named; never direct (the page only linked to a web address).
 *   frame     an app link Chromium refused in a frame or a script (the openExternal
 *             permission). The requesting frame's site is named; never direct.
 *
 * @param {{via?: string, pageUrl?: string, initiatorOrigin?: string|null, redirectFrom?: string|null,
 *   requestingUrl?: string|null}} req
 * @returns {{origin: string|null, direct: boolean}}
 */
function whoAsks({ via = "", pageUrl = "", initiatorOrigin = null, redirectFrom = null, requestingUrl = null } = {}) {
  const page = originOf(pageUrl);
  if (via === "redirect") return { origin: originOf(redirectFrom) || page, direct: false };
  if (via === "frame") return { origin: originOf(requestingUrl) || page, direct: false };
  if (via === "navigate") {
    const from = originOf(initiatorOrigin);
    if (from && page && from === page) return { origin: page, direct: true };
    return { origin: from || page, direct: false };
  }
  return { origin: page, direct: false };
}

/**
 * What to do with one app link.
 *
 * @param {object} req
 * @param {string} req.url          the link
 * @param {{by?: string, kind?: string, private?: boolean}|null} req.tab the tab it came from
 * @param {string} req.pageUrl      the address of the page on that tab
 * @param {string} [req.via]        "navigate" | "redirect" | "frame" (whoAsks)
 * @param {string|null} [req.initiatorOrigin] navigate: the origin of the frame that started it
 * @param {string|null} [req.redirectFrom]    redirect: the address that redirected
 * @param {string|null} [req.requestingUrl]   frame: the address of the frame that asked
 * @param {boolean} [req.gesture]   the owner has clicked or typed in that page
 * @param {number} [req.sinceAuto]  ms since this tab last opened an app with no question
 * @param {{get: Function}|null} [req.store] the remembered "Always" answers
 * @returns {{verdict: "deny"} | {verdict: "open"|"prompt", url: string, scheme: string, app: string,
 *   origin: string, canAlways: boolean}}
 */
function judge({ url, tab, pageUrl, via = "", initiatorOrigin = null, redirectFrom = null, requestingUrl = null,
  gesture = false, sinceAuto = Infinity, store = null } = {}) {
  const deny = { verdict: "deny" };
  const link = launchable(url);
  if (!link) return deny;
  if (!tab || tab.by !== "you" || !["web", "hosted"].includes(tab.kind || "web")) return deny;
  const { origin, direct } = whoAsks({ via, pageUrl, initiatorOrigin, redirectFrom, requestingUrl });
  if (!origin) return deny;
  // Remembered only when a secure page itself asked (not a redirect, a frame or another
  // window), never InPrivate, and never for an app that runs things (NEVER_ALWAYS).
  const canAlways = direct && !tab.private && promptableOrigin(origin) === origin && alwaysEligible(link.scheme);
  const remembered = canAlways && store ? store.get(origin, link.scheme) : false;
  const quiet = remembered && gesture && sinceAuto >= AUTO_OPEN_GAP_MS;
  return { verdict: quiet ? "open" : "prompt", ...link, origin, canAlways };
}

/** "Open Zoom? meet.example.com wants to open a link in it." The END of a long host is shown. */
function promptText(app, origin) {
  return `Open ${app}? ${promptHost(origin)} wants to open a link in it.`;
}

/** The notice the toolbar shows for a "prompt" verdict. */
function noticeFor(verdict, now = Date.now()) {
  const actions = [{ id: "external-open", label: "Open" }];
  if (verdict.canAlways) actions.push({ id: "external-always", label: "Always for this site" });
  actions.push({ id: "dismiss", label: "Not now" });
  return {
    kind: "external-app", at: now, text: promptText(verdict.app, verdict.origin),
    title: `${verdict.origin} — ${verdict.url.slice(0, 300)}`,
    data: { url: verdict.url, scheme: verdict.scheme, app: verdict.app, origin: verdict.origin, canAlways: verdict.canAlways },
    actions,
  };
}

function isAction(actionId) {
  return actionId === "external-open" || actionId === "external-always";
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== VERSION || !parsed.sites || typeof parsed.sites !== "object") return {};
    const sites = {};
    for (const [origin, row] of Object.entries(parsed.sites)) {
      if (promptableOrigin(origin) !== origin || !row || typeof row !== "object") continue;
      const kept = {};
      for (const [scheme, at] of Object.entries(row)) {
        if (alwaysEligible(scheme)) kept[scheme] = Number(at) || 0;
      }
      if (Object.keys(kept).length) sites[origin] = kept;
    }
    return sites;
  } catch {
    return {};
  }
}

/**
 * The owner's "Always for this site" answers. One JSON file, written atomically.
 * @param {{file: string, now?: () => number}} opts
 */
function createExternalStore({ file, now = () => Date.now() } = {}) {
  if (!file) throw new Error("createExternalStore needs a file");
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
    /** true when the owner chose "Always" for this site and this app. */
    get(origin, scheme) {
      const row = sites[String(origin || "")];
      return Boolean(row && Object.prototype.hasOwnProperty.call(row, scheme));
    },
    allow(origin, scheme) {
      const site = promptableOrigin(origin);
      if (!site || site !== origin || !alwaysEligible(scheme)) return false;
      if (!sites[site] && Object.keys(sites).length >= MAX_SITES) return false;
      sites[site] = { ...(sites[site] || {}), [scheme]: now() };
      return save();
    },
    /** Take back one app, or (no scheme) every app for the site. */
    remove(origin, scheme = null) {
      const row = sites[String(origin || "")];
      if (!row) return false;
      if (scheme == null) delete sites[origin];
      else {
        if (!Object.prototype.hasOwnProperty.call(row, scheme)) return false;
        delete row[scheme];
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
    /** Rows for aither://permissions: {origin, kind: "open:<scheme>", label, value: "allow", at}. */
    list() {
      const out = [];
      for (const origin of Object.keys(sites).sort()) {
        for (const scheme of Object.keys(APPS)) {
          if (Object.prototype.hasOwnProperty.call(sites[origin], scheme)) {
            out.push({ origin, kind: `${KIND_PREFIX}${scheme}`, label: labelFor(scheme), value: "allow", at: sites[origin][scheme] });
          }
        }
      }
      return out;
    },
  };
}

/**
 * The site-permission store and the "Always open" store as ONE list for the review
 * page (same shape as browser-permissions createPermissionStore: list / remove / clear).
 */
function withExternal(permissions, external) {
  return {
    list: () => [...permissions.list(), ...external.list()],
    remove(origin, kind = null) {
      if (kind == null) {
        const a = permissions.remove(origin, null);
        const b = external.remove(origin, null);
        return a || b;
      }
      if (String(kind).startsWith(KIND_PREFIX)) return external.remove(origin, String(kind).slice(KIND_PREFIX.length));
      return permissions.remove(origin, kind);
    },
    clear: () => permissions.clear() + external.clear(),
  };
}

module.exports = {
  APPS, AUTO_OPEN_GAP_MS, INTERACTED_SCRIPT, KIND_PREFIX, MAX_LINK, NEVER_ALWAYS,
  alwaysEligible, whoAsks,
  createExternalStore, isAction, judge, labelFor, launchable, noticeFor, promptText, withExternal,
};
