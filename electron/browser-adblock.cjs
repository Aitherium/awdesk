"use strict";

/**
 * browser-adblock.cjs -- ad and tracker blocking for the Aither Browser.
 *
 * Edge users run an ad blocker as an extension. Electron cannot run the MV3 blockers
 * (no declarativeNetRequest), so the browser blocks at the network layer itself:
 * a request from a page to a known ad, tracker or malware host is cancelled before
 * it leaves the machine. Cosmetic filtering (hiding empty ad boxes) is not done.
 *
 * Lists: Steven Black's unified hosts (ads + malware) and EasyList/EasyPrivacy's
 * plain host rules (`||host^`, optionally `$third-party`). Downloaded into userData,
 * refreshed weekly; a small built-in seed blocks the biggest ad networks before the
 * first download. The owner turns it off per site (the site's own pages then load
 * everything) or entirely. The page you navigate to is never blocked, only what it
 * pulls in.
 */

const fs = require("node:fs");
const path = require("node:path");

const LISTS = Object.freeze([
  { id: "stevenblack", url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts", format: "hosts" },
  { id: "easylist", url: "https://easylist.to/easylist/easylist.txt", format: "abp" },
  { id: "easyprivacy", url: "https://easylist.to/easylist/easyprivacy.txt", format: "abp" },
]);

const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Blocks the largest ad networks before the first list download lands. */
const SEED = Object.freeze([
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
  "google-analytics.com", "googletagservices.com", "adnxs.com", "advertising.com", "taboola.com",
  "outbrain.com", "criteo.com", "criteo.net", "amazon-adsystem.com", "scorecardresearch.com",
  "quantserve.com", "moatads.com", "pubmatic.com", "rubiconproject.com", "openx.net",
  "casalemedia.com", "adsrvr.org", "bidswitch.net", "smartadserver.com", "yieldmo.com",
  "hotjar.com", "mixpanel.com", "zedo.com", "adform.net", "media.net", "teads.tv",
]);

/** A hostname a list may name: lower case, at least one dot, no wildcards or IPs. */
function cleanHost(h) {
  const host = String(h || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || !host.includes(".") || /[^a-z0-9.-]/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  return host;
}

/** Hosts from a hosts file (`0.0.0.0 ads.example.com`). */
function parseHosts(text) {
  const out = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !/^(0\.0\.0\.0|127\.0\.0\.1)$/.test(parts[0])) continue;
    for (const name of parts.slice(1)) {
      const host = cleanHost(name);
      if (host) out.add(host);
    }
  }
  return out;
}

/**
 * Plain host rules from an Adblock Plus list: `||host^` and `||host^$third-party`.
 * Path rules, regexes, cosmetic rules and other options are skipped (the network
 * layer here judges hosts only); exceptions `@@||host^` are returned separately.
 */
function parseAbp(text) {
  const block = new Set();
  const allow = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(@@)?\|\|([a-z0-9.-]+)\^(\$third-party)?$/i.exec(line);
    if (!m) continue;
    const host = cleanHost(m[2]);
    if (!host) continue;
    (m[1] ? allow : block).add(host);
  }
  return { block, allow };
}

function hostOf(url) {
  try {
    const u = new URL(String(url || ""));
    return /^(https?|wss?):$/.test(u.protocol) ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The last two labels (three under a two-letter country second level, e.g. co.uk). */
function siteOf(host) {
  const labels = String(host || "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tail2 = labels.slice(-2);
  const n = tail2[1].length === 2 && /^(co|com|net|org|ac|gov|edu|ne|or)$/.test(tail2[0]) ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Is `host` or any parent domain of it in `set`? */
function matches(set, host) {
  let h = String(host || "");
  while (h) {
    if (set.has(h)) return true;
    const dot = h.indexOf(".");
    if (dot < 0) return false;
    h = h.slice(dot + 1);
    if (!h.includes(".")) return false; // never match a bare TLD
  }
  return false;
}

/**
 * The blocker. `dir` holds the downloaded lists and the owner's settings.
 * @param {{dir: string, fetchImpl?: Function, now?: () => number, fsImpl?: typeof fs}} opts
 */
function createAdblock({ dir, fetchImpl = globalThis.fetch, now = () => Date.now(), fsImpl = fs } = {}) {
  if (!dir) throw new Error("createAdblock needs a dir");
  const settingsFile = path.join(dir, "adblock.json");
  let blocked = new Set(SEED);
  let allowed = new Set();
  let settings = { enabled: true, offSites: [] };
  let loadedAt = 0;
  let refreshing = null;
  const counts = new Map(); // webContents id -> blocked requests on its current page

  try {
    const s = JSON.parse(fsImpl.readFileSync(settingsFile, "utf8"));
    settings = { enabled: s.enabled !== false, offSites: Array.isArray(s.offSites) ? s.offSites.filter((x) => typeof x === "string").slice(0, 500) : [] };
  } catch { /* defaults: on, no exceptions */ }

  function saveSettings() {
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      const tmp = `${settingsFile}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fsImpl.renameSync(tmp, settingsFile);
    } catch { /* the setting holds for this run */ }
  }

  function listFile(id) { return path.join(dir, `adblock-${id}.txt`); }

  function rebuild(texts) {
    const next = new Set(SEED);
    const ok = new Set();
    for (const list of LISTS) {
      const text = texts[list.id];
      if (!text) continue;
      if (list.format === "hosts") for (const h of parseHosts(text)) next.add(h);
      else {
        const { block, allow } = parseAbp(text);
        for (const h of block) next.add(h);
        for (const h of allow) ok.add(h);
      }
    }
    blocked = next;
    allowed = ok;
  }

  /** Read the cached lists from disk (synchronous; called once at start). */
  function loadCached() {
    const texts = {};
    // Fresh = the newest download is under a week old (a list that failed to
    // download is retried on the next weekly refresh, not on every start).
    let newest = 0;
    for (const list of LISTS) {
      try {
        texts[list.id] = fsImpl.readFileSync(listFile(list.id), "utf8");
        newest = Math.max(newest, fsImpl.statSync(listFile(list.id)).mtimeMs);
      } catch { /* not downloaded yet */ }
    }
    rebuild(texts);
    loadedAt = newest;
    return blocked.size;
  }

  /** Download every list (when stale or forced) and rebuild. Never throws. */
  function refresh({ force = false } = {}) {
    if (refreshing) return refreshing;
    if (!force && loadedAt && now() - loadedAt < REFRESH_MS) return Promise.resolve({ ok: true, fresh: true, hosts: blocked.size });
    if (typeof fetchImpl !== "function") return Promise.resolve({ ok: false, error: "no fetch" });
    refreshing = (async () => {
      const errors = [];
      for (const list of LISTS) {
        try {
          const res = await fetchImpl(list.url, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (text.length < 1000) throw new Error("list too short");
          fsImpl.mkdirSync(dir, { recursive: true });
          fsImpl.writeFileSync(listFile(list.id), text);
        } catch (error) {
          errors.push(`${list.id}: ${String((error && error.message) || error)}`);
        }
      }
      loadCached();
      return { ok: errors.length < LISTS.length, hosts: blocked.size, errors };
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function siteOff(pageUrl) {
    const host = hostOf(pageUrl);
    return Boolean(host) && settings.offSites.includes(siteOf(host));
  }

  /**
   * Should this request be cancelled? Never the page itself (mainFrame), never a
   * request from a site the owner turned blocking off for, never a first-party
   * request (the page's own site), never an exception the lists allow.
   */
  function shouldBlock({ url, resourceType, pageUrl }) {
    if (!settings.enabled || resourceType === "mainFrame") return false;
    const host = hostOf(url);
    if (!host || !matches(blocked, host) || matches(allowed, host)) return false;
    const pageHost = hostOf(pageUrl);
    if (pageHost) {
      if (siteOff(pageUrl)) return false;
      if (siteOf(pageHost) === siteOf(host)) return false;
    }
    return true;
  }

  return {
    LISTS,
    loadCached,
    refresh,
    shouldBlock,
    hostCount: () => blocked.size,
    enabled: () => settings.enabled,
    setEnabled(on) { settings.enabled = Boolean(on); saveSettings(); return settings.enabled; },
    siteOff,
    /** Turn blocking off (true) or back on (false) for the site of `pageUrl`. */
    setSiteOff(pageUrl, off) {
      const host = hostOf(pageUrl);
      if (!host) return false;
      const site = siteOf(host);
      settings.offSites = settings.offSites.filter((s) => s !== site);
      if (off) settings.offSites.unshift(site);
      saveSettings();
      return Boolean(off);
    },
    blockedOn: (wcId) => counts.get(wcId) || 0,
    resetCount: (wcId) => counts.delete(wcId),
    /**
     * Wire into one Electron session. Only one onBeforeRequest listener exists per
     * session; nothing else in the desk sets one on the browser's partitions.
     */
    attach(ses, { onBlocked = null } = {}) {
      if (!ses || !ses.webRequest) return false;
      ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
        let pageUrl = "";
        try { pageUrl = details.webContents ? details.webContents.getURL() : ""; } catch { /* gone */ }
        if (!pageUrl) pageUrl = details.referrer || "";
        const cancel = shouldBlock({ url: details.url, resourceType: details.resourceType, pageUrl });
        if (cancel && details.webContentsId != null) {
          counts.set(details.webContentsId, (counts.get(details.webContentsId) || 0) + 1);
          if (typeof onBlocked === "function") { try { onBlocked(details.webContentsId); } catch { /* ui only */ } }
        }
        callback({ cancel });
      });
      return true;
    },
  };
}

module.exports = { LISTS, REFRESH_MS, SEED, createAdblock, matches, parseAbp, parseHosts, siteOf };
