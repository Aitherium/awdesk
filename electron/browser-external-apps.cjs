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
 *     most MAX_LINK characters, no control characters, no whitespace, no quotes or
 *     backticks, and it must parse as a URL of that scheme. A link that fails is refused.
 *   - "Always for this site" is remembered per site and per app, only for a secure page
 *     (https, or this computer), never InPrivate. It is honoured only for a link in the
 *     page's own top frame, on a page the owner has clicked or typed in (main reads the
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
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const scheme = parsed.protocol.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(APPS, scheme)) return null;
  return { url, scheme, app: APPS[scheme] };
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
 * What to do with one app link.
 *
 * @param {object} req
 * @param {string} req.url          the link
 * @param {{by?: string, kind?: string, private?: boolean}|null} req.tab the tab it came from
 * @param {string} req.pageUrl      the address of the page on that tab
 * @param {boolean} [req.mainFrame] the link was followed in the page's own top frame
 * @param {boolean} [req.gesture]   the owner has clicked or typed in that page
 * @param {number} [req.sinceAuto]  ms since this tab last opened an app with no question
 * @param {{get: Function}|null} [req.store] the remembered "Always" answers
 * @returns {{verdict: "deny"} | {verdict: "open"|"prompt", url: string, scheme: string, app: string,
 *   origin: string, canAlways: boolean}}
 */
function judge({ url, tab, pageUrl, mainFrame = false, gesture = false, sinceAuto = Infinity, store = null } = {}) {
  const deny = { verdict: "deny" };
  const link = launchable(url);
  if (!link) return deny;
  if (!tab || tab.by !== "you" || !["web", "hosted"].includes(tab.kind || "web")) return deny;
  const origin = originOf(pageUrl);
  if (!origin) return deny;
  // Remembered only for a secure page's own top frame, and never InPrivate.
  const canAlways = Boolean(mainFrame) && !tab.private && promptableOrigin(origin) === origin;
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
        if (Object.prototype.hasOwnProperty.call(APPS, scheme)) kept[scheme] = Number(at) || 0;
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
      if (!site || site !== origin || !Object.prototype.hasOwnProperty.call(APPS, scheme)) return false;
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
  APPS, AUTO_OPEN_GAP_MS, INTERACTED_SCRIPT, KIND_PREFIX, MAX_LINK,
  createExternalStore, isAction, judge, labelFor, launchable, noticeFor, promptText, withExternal,
};
