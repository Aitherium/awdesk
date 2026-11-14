"use strict";

/**
 * browser-adblock.cjs -- ad and tracker blocking for the Aither Browser.
 *
 * Edge users run an ad blocker as an extension. Electron cannot run the MV3 blockers
 * (no declarativeNetRequest), so the browser blocks at the network layer itself:
 * a request from a page to a known ad, tracker or malware host is cancelled before
 * it leaves the machine.
 *
 * Three layers, all built once when the lists load:
 *   - hosts: Steven Black's unified hosts and the lists' plain `||host^` rules, in a
 *     Set. A third-party request to one of them is cancelled.
 *   - rules: the lists' path and option rules (`||host/ads^$script,domain=a.com`),
 *     which also catch ads served from the page's own host. browser-adblock-rules.cjs.
 *   - cosmetic: the boxes the cancelled ads leave behind are hidden with a style sheet
 *     per page (`##.ad-banner`). browser-adblock-cosmetic.cjs.
 * An exception in the lists (`@@`) always wins over a block, and the lists' page-level
 * exceptions are honoured: nothing is blocked on a `$document` page, nothing hidden on an
 * `$elemhide` page, only site-specific boxes on a `$generichide` page (YouTube is one).
 *
 * Two tracking protections ride the same request hooks (browser-tracking.cjs): click
 * identifiers are removed from the address of a page before it loads, and every request
 * says Sec-GPC: 1.
 *
 * Lists are downloaded into userData and refreshed weekly; a small built-in seed blocks
 * the biggest ad networks before the first download. The owner pauses it per site (the
 * site's pages then load everything, unhidden, with their parameters) or everywhere.
 * The page you navigate to is never blocked, only what it pulls in.
 */

const fs = require("node:fs");
const path = require("node:path");
const rulesMod = require("./browser-adblock-rules.cjs");
const cosmeticMod = require("./browser-adblock-cosmetic.cjs");
const tracking = require("./browser-tracking.cjs");

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
 * One Adblock Plus list, sorted into what each layer reads:
 *   block / allow     plain host rules (`||host^`, `||host^$third-party`) and their
 *                     exceptions (`@@||host^`), as Sets of hostnames;
 *   rules             every other network rule this browser can judge (paths, options),
 *                     parsed by browser-adblock-rules.cjs; `rule.exception` marks `@@`;
 *   pages             page-level exceptions (`@@||site^$generichide`), `rule.page` says which;
 *   cosmetic          element hiding rules, parsed by browser-adblock-cosmetic.cjs;
 *   skipped           lines that are rules but not ones handled here (regexes, `$csp`,
 *                     procedural hiding...), counted.
 */
function parseAbp(text) {
  const block = new Set();
  const allow = new Set();
  const rules = [];
  const pages = [];
  const cosmetic = [];
  let skipped = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "!" || line[0] === "[") continue;
    if (cosmeticMod.looksCosmetic(line)) {
      const c = cosmeticMod.parseCosmetic(line);
      if (c) cosmetic.push(c);
      else skipped += 1;
      continue;
    }
    const rule = rulesMod.parseRule(line);
    if (!rule) { skipped += 1; continue; }
    if (rulesMod.isPlainHostRule(rule)) {
      const host = cleanHost(rule.host);
      if (host) (rule.exception ? allow : block).add(host);
      else skipped += 1;
      continue;
    }
    (rule.page ? pages : rules).push(rule);
  }
  return { block, allow, rules, pages, cosmetic, skipped };
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
 * The toolbar shield's menu as data: what happened on this page, then the two pauses.
 * Items are {id, label, enabled?, checked?} or {type: "separator"}; main maps ids to
 * actions. `facts` = {enabled, siteOff, blocked, host, web}.
 */
function shieldMenuSpec({ enabled = true, siteOff = false, blocked = 0, host = "", web = false } = {}) {
  const n = Number(blocked) || 0;
  let status;
  if (!enabled) status = "Blocking is paused everywhere";
  else if (!web) status = "Nothing is blocked on this kind of page";
  else if (siteOff) status = `Blocking is paused on ${host || "this site"}`;
  else status = n ? `${n.toLocaleString("en-US")} ad and tracker request${n === 1 ? "" : "s"} blocked on this page` : "Nothing blocked on this page yet";
  return [
    { id: "status", label: status, enabled: false },
    { type: "separator" },
    { id: "pause-site", label: `Pause on ${host || "this site"}`, checked: Boolean(siteOff), enabled: Boolean(enabled && web) },
    { id: "pause-all", label: "Pause everywhere", checked: !enabled },
  ];
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
  let blockRules = rulesMod.createRuleSet();
  let allowRules = rulesMod.createRuleSet();
  // The lists' page-level exceptions, one set per kind: document, elemhide, generichide.
  let pageRules = [rulesMod.createRuleSet(), rulesMod.createRuleSet(), rulesMod.createRuleSet()];
  let cosmetic = cosmeticMod.createCosmeticIndex();
  let listStats = { hosts: blocked.size, rules: 0, exceptions: 0, cosmetic: 0, skipped: 0, parseMs: 0 };
  let settings = { enabled: true, offSites: [], stripParams: true, gpc: true };
  let loadedAt = 0;
  let refreshing = null;
  const counts = new Map(); // webContents id -> blocked requests on its current page
  const sessions = new Set(); // every session attach() wired, for the header hook
  let stripped = 0; // addresses cleaned of tracking parameters this run
  let lastPage = { url: null, host: null, site: "", off: false, private: false }; // the page most requests come from
  // What an InPrivate tab chose for a site: site -> paused (true) or blocking (false).
  // Memory only. It wins over offSites in InPrivate tabs and is unknown to the others.
  const privateSites = new Map();

  try {
    const s = JSON.parse(fsImpl.readFileSync(settingsFile, "utf8"));
    settings = {
      enabled: s.enabled !== false,
      offSites: Array.isArray(s.offSites) ? s.offSites.filter((x) => typeof x === "string").slice(0, 500) : [],
      stripParams: s.stripParams !== false,
      gpc: s.gpc !== false,
    };
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
    const t0 = Date.now();
    const next = new Set(SEED);
    const ok = new Set();
    const blockSet = rulesMod.createRuleSet();
    const allowSet = rulesMod.createRuleSet();
    const hide = cosmeticMod.createCosmeticIndex();
    const pageSets = [rulesMod.createRuleSet(), rulesMod.createRuleSet(), rulesMod.createRuleSet()];
    let pageCount = 0;
    let skipped = 0;
    for (const list of LISTS) {
      const text = texts[list.id];
      if (!text) continue;
      if (list.format === "hosts") for (const h of parseHosts(text)) next.add(h);
      else {
        const parsed = parseAbp(text);
        for (const h of parsed.block) next.add(h);
        for (const h of parsed.allow) ok.add(h);
        for (const rule of parsed.rules) (rule.exception ? allowSet : blockSet).add(rule);
        for (const c of parsed.cosmetic) hide.add(c);
        for (const rule of parsed.pages) {
          if (rule.page & rulesMod.PAGE_DOCUMENT) pageSets[0].add(rule);
          if (rule.page & rulesMod.PAGE_ELEMHIDE) pageSets[1].add(rule);
          if (rule.page & rulesMod.PAGE_GENERICHIDE) pageSets[2].add(rule);
          pageCount += 1;
        }
        skipped += parsed.skipped;
      }
    }
    const b = blockSet.freeze();
    const a = allowSet.freeze();
    const c = hide.freeze();
    for (const set of pageSets) set.freeze();
    pageRules = pageSets;
    blocked = next;
    allowed = ok;
    blockRules = blockSet;
    allowRules = allowSet;
    cosmetic = hide;
    lastPage = { url: null, host: null, site: "", off: false, private: false };
    listStats = { hosts: next.size, rules: b.rules, exceptions: a.rules + ok.size + pageCount,
      cosmetic: c.generic + c.specific, skipped: skipped + b.dropped + a.dropped + c.capped, parseMs: Date.now() - t0 };
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

  /** Is blocking paused on this site, as an ordinary tab or (`inPrivate`) an InPrivate tab sees it? */
  function sitePaused(site, inPrivate) {
    if (inPrivate && privateSites.has(site)) return privateSites.get(site);
    return settings.offSites.includes(site);
  }

  function siteOff(pageUrl, { private: inPrivate = false } = {}) {
    const host = hostOf(pageUrl);
    return Boolean(host) && sitePaused(siteOf(host), inPrivate);
  }

  /**
   * What the lists except on the page itself: {document, elemhide, generichide}.
   * Asked once per page, never per request.
   */
  function pageExceptions(pageUrl, host) {
    const req = host ? rulesMod.describeRequest(pageUrl, "mainFrame", host, false) : null;
    if (!req) return { document: false, elemhide: false, generichide: false };
    req.type = rulesMod.ALL_TYPES;
    return { document: pageRules[0].match(req), elemhide: pageRules[1].match(req), generichide: pageRules[2].match(req) };
  }

  /** The page a request comes from, worked out once (a page makes hundreds of requests). */
  function pageOf(pageUrl, inPrivate = false) {
    const url = String(pageUrl || "");
    if (lastPage.url === url && lastPage.private === inPrivate) return lastPage;
    const host = hostOf(url);
    const site = host ? siteOf(host) : "";
    // Off: the owner paused the site, or the lists say to block nothing on this page.
    const off = Boolean(host) && (sitePaused(site, inPrivate) || pageExceptions(url, host).document);
    lastPage = { url, host, site, off, private: inPrivate };
    return lastPage;
  }

  /**
   * Should this request be cancelled? Never the page itself (mainFrame), never a
   * request from a site the owner paused blocking on, never an exception the lists
   * allow. A listed HOST is blocked only as a third party (the page's own site is left
   * alone); a path rule decides for itself (`$third-party`, `$domain=`, `$script`).
   *
   * Every request passes through here. The cost is a few Map lookups (the host and its
   * parents, each word of the address) and no regular expression from a list.
   */
  function shouldBlock({ url, resourceType, pageUrl, private: inPrivate = false }) {
    if (!settings.enabled || resourceType === "mainFrame") return false;
    const u = String(url || "");
    if (!/^(?:https?|wss?):\/\//i.test(u)) return false;
    const page = pageOf(pageUrl, Boolean(inPrivate));
    if (page.off) return false;
    const req = rulesMod.describeRequest(u, resourceType, page.host || "", true);
    if (!req || !req.host) return false;
    if (page.host) req.thirdParty = page.site !== siteOf(req.host);
    let hit = req.thirdParty && matches(blocked, req.host);
    if (!hit) hit = blockRules.match(req);
    if (!hit) return false;
    return !matches(allowed, req.host) && !allowRules.match(req);
  }

  /**
   * The style sheet that hides ad boxes on the page at `pageUrl`: "" when blocking is
   * off, paused on that site, or the address is not a web page.
   */
  function cssFor(pageUrl, { private: inPrivate = false } = {}) {
    if (!settings.enabled) return "";
    const host = hostOf(pageUrl);
    if (!host || !/^https?:/i.test(String(pageUrl)) || siteOff(pageUrl, { private: inPrivate })) return "";
    const except = pageExceptions(String(pageUrl), host);
    if (except.document || except.elemhide) return "";
    return cosmetic.cssFor(host, { generic: !except.generichide });
  }

  /**
   * The address a page navigation should load instead (tracking parameters removed),
   * or null to load it as asked. Off with the setting, and on a paused site.
   */
  function cleanNavigation(url, method = "GET", { private: inPrivate = false } = {}) {
    if (!settings.stripParams || String(method || "GET").toUpperCase() !== "GET") return null;
    if (siteOff(url, { private: inPrivate })) return null;
    return tracking.stripTrackingParams(url);
  }

  function wireHeaders(ses) {
    if (!ses || !ses.webRequest || typeof ses.webRequest.onBeforeSendHeaders !== "function") return;
    if (!settings.gpc) { ses.webRequest.onBeforeSendHeaders(null); return; }
    ses.webRequest.onBeforeSendHeaders({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      callback({ requestHeaders: tracking.withPrivacyHeaders(details.requestHeaders) });
    });
  }

  return {
    LISTS,
    loadCached,
    refresh,
    shouldBlock,
    cssFor,
    cleanNavigation,
    hostCount: () => blocked.size,
    /** What the loaded lists hold: {hosts, rules, exceptions, cosmetic, skipped, parseMs}. */
    stats: () => ({ ...listStats }),
    strippedCount: () => stripped,
    enabled: () => settings.enabled,
    setEnabled(on) { settings.enabled = Boolean(on); saveSettings(); return settings.enabled; },
    stripParams: () => settings.stripParams,
    setStripParams(on) { settings.stripParams = Boolean(on); saveSettings(); return settings.stripParams; },
    gpc: () => settings.gpc,
    /** Send Sec-GPC / DNT (true) or stop (false), on every session already wired. */
    setGpc(on) {
      settings.gpc = Boolean(on);
      saveSettings();
      for (const ses of sessions) { try { wireHeaders(ses); } catch { /* a closed session */ } }
      return settings.gpc;
    },
    siteOff,
    /**
     * Turn blocking off (true) or back on (false) for the site of `pageUrl`.
     * `private: true` is an InPrivate tab asking: the choice holds for InPrivate tabs
     * until clearPrivate(), and the site's name is never written to disk.
     */
    setSiteOff(pageUrl, off, { private: inPrivate = false } = {}) {
      const host = hostOf(pageUrl);
      if (!host) return false;
      const site = siteOf(host);
      lastPage = { url: null, host: null, site: "", off: false, private: false };
      if (inPrivate) {
        privateSites.set(site, Boolean(off));
        return Boolean(off);
      }
      settings.offSites = settings.offSites.filter((s) => s !== site);
      if (off) settings.offSites.unshift(site);
      saveSettings();
      return Boolean(off);
    },
    /** The last InPrivate tab closed: what InPrivate tabs chose is forgotten. */
    clearPrivate() {
      privateSites.clear();
      lastPage = { url: null, host: null, site: "", off: false, private: false };
    },
    blockedOn: (wcId) => counts.get(wcId) || 0,
    resetCount: (wcId) => counts.delete(wcId),
    /**
     * Wire into one Electron session. Only one onBeforeRequest and one
     * onBeforeSendHeaders listener exist per session; nothing else in the desk sets
     * either on the browser's partitions (checked 2026-11-13: no other caller).
     * `private: true` marks the InPrivate session: its pages follow the in-memory pauses.
     */
    attach(ses, { onBlocked = null, private: inPrivate = false, guard = null } = {}) {
      if (!ses || !ses.webRequest) return false;
      sessions.add(ses);
      wireHeaders(ses);
      ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
        // One listener per session: the workspace policy's request guard (browser-workspace.cjs
        // cancelsRequest) is asked first, and cancels whether or not blocking is on.
        if (typeof guard === "function") {
          let stop;
          try { stop = guard(details) === true; } catch { stop = true; }
          if (stop) { callback({ cancel: true }); return; }
        }
        if (details.resourceType === "mainFrame") {
          // The page itself is never cancelled; its address may lose its click identifiers.
          const clean = cleanNavigation(details.url, details.method, { private: inPrivate });
          if (clean) { stripped += 1; callback({ redirectURL: clean }); return; }
          callback({ cancel: false });
          return;
        }
        let pageUrl = "";
        try { pageUrl = details.webContents ? details.webContents.getURL() : ""; } catch { /* gone */ }
        if (!pageUrl) pageUrl = details.referrer || "";
        const cancel = shouldBlock({ url: details.url, resourceType: details.resourceType, pageUrl, private: inPrivate });
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

module.exports = { LISTS, REFRESH_MS, SEED, createAdblock, hostOf, matches, parseAbp, parseHosts, shieldMenuSpec, siteOf };
