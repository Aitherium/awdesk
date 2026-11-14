"use strict";

/**
 * browser-adblock-cosmetic.cjs -- element hiding for the Aither Browser's ad blocker.
 *
 * Cancelling an ad request leaves the box it would have filled: an empty frame, a
 * "sponsored" strip, a placeholder. EasyList names those boxes with CSS selectors:
 *   ##.ad-banner               hide on every site (generic)
 *   example.com##.promo        hide on example.com and its subdomains
 *   example.com#@#.ad-banner   do NOT hide on example.com (exception)
 *   ~example.com##.ad-banner   generic, except on example.com
 * This module parses them once into a small index and answers "the style sheet for a
 * page on this host". browser-window.cjs injects it as a user style sheet.
 *
 * A list is someone else's text going into every page, so:
 *   - a selector is checked before it is kept (balanced brackets and quotes, nothing
 *     that could close the rule and start another, no at-rules);
 *   - selectors go into the sheet in small groups, one CSS rule each. A selector this
 *     Chromium does not understand voids only its own group, never the sheet;
 *   - the number of selectors is capped.
 * Procedural rules (`#?#`, `:has-text()`, `:xpath()`...), scriptlets (`##+js`) and HTML
 * filters (`##^`) need code running in the page; they are skipped and counted.
 */

const MAX_SELECTOR = 300;
const DEFAULT_BATCH = 20;
const HIDE = "{display:none!important}";

/** Pseudo-classes that are not CSS: uBlock/AdGuard/ABP procedural operators. */
const PROCEDURAL = /:(?:has-text|contains|-abp-[a-z-]+|xpath|matches-css(?:-before|-after)?|matches-attr|matches-path|matches-media|matches-property|matches-prop|min-text-length|nth-ancestor|upward|watch-attr|remove|remove-attr|remove-class|style|others|if|if-not|shadow|spath)\(/i;

/**
 * Is `sel` safe to put into a style sheet as a selector? Not "valid CSS" (only a
 * browser knows that); it cannot escape its rule.
 */
function safeSelector(sel) {
  const s = String(sel || "");
  if (!s || s.length > MAX_SELECTOR) return false;
  if (PROCEDURAL.test(s)) return false;
  let quote = 0;
  let square = 0;
  let round = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return false; // control characters, new lines
    if (c === 92) { // backslash: escapes the next character, which must exist
      if (i + 1 >= s.length) return false;
      i += 1;
      continue;
    }
    if (quote) { if (c === quote) quote = 0; continue; }
    if (c === 34 || c === 39) { quote = c; continue; }
    if (c === 91) square += 1;
    else if (c === 93) { square -= 1; if (square < 0) return false; }
    else if (c === 40) round += 1;
    else if (c === 41) { round -= 1; if (round < 0) return false; }
    else if (c === 123 || c === 125 || c === 59 || c === 64 || c === 60) return false; // { } ; @ <
    else if (c === 47 && s.charCodeAt(i + 1) === 42) return false; // a comment opening
    else if (c === 44 && !square && !round) return false; // a top-level comma is two selectors
  }
  return !quote && !square && !round;
}

/** A rule's domain: lower case, dotted or a single label (localhost), plain. */
function cleanDomain(d) {
  const s = String(d || "").trim().toLowerCase();
  return s && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s) ? s : null;
}

/**
 * One element hiding rule, or null when the line is not one this module handles.
 * @returns {null | {exception: boolean, include: string[], exclude: string[], selector: string}}
 */
function parseCosmetic(raw) {
  const line = String(raw || "").trim();
  if (!line || line[0] === "!" || line[0] === "[") return null;
  const at = line.indexOf("#");
  if (at < 0) return null;
  let exception = false;
  let rest;
  if (line.startsWith("##", at)) rest = line.slice(at + 2);
  else if (line.startsWith("#@#", at)) { exception = true; rest = line.slice(at + 3); }
  else return null; // #?# #$# #%# and anything else
  const selector = rest.trim();
  if (!selector || selector[0] === "+" || selector[0] === "^") return null; // scriptlet, HTML filter
  if (!safeSelector(selector)) return null;
  const include = [];
  const exclude = [];
  const head = line.slice(0, at);
  if (head) {
    for (const part of head.split(",")) {
      const no = part[0] === "~";
      const d = cleanDomain(no ? part.slice(1) : part);
      if (!d) return null; // entity rules (google.*) and anything odd
      (no ? exclude : include).push(d);
    }
  }
  return { exception, include, exclude, selector };
}

/** Would this line be an element hiding rule of any kind (kept or not)? For counting. */
function looksCosmetic(raw) {
  return /#[@?$%]?#/.test(String(raw || ""));
}

function batchCss(selectors, size) {
  let css = "";
  for (let i = 0; i < selectors.length; i += size) {
    css += `${selectors.slice(i, i + size).join(",")}${HIDE}\n`;
  }
  return css;
}

/**
 * The index. add() every parsed rule, freeze() once, then cssFor(host).
 * @param {{maxGeneric?: number, maxSpecific?: number, batch?: number}} [opts]
 */
function createCosmeticIndex({ maxGeneric = 20000, maxSpecific = 60000, batch = DEFAULT_BATCH } = {}) {
  let generic = new Set();
  const globalOff = new Set(); // `#@#sel` with no site: off everywhere
  const byDomain = new Map(); // site -> selectors hidden there
  const offByDomain = new Map(); // site -> selectors NOT hidden there
  let genericList = [];
  let genericCss = "";
  let frozen = false;
  const cache = new Map(); // host -> css, a few recent
  const stats = { generic: 0, specific: 0, exceptions: 0, capped: 0 };

  function push(map, key, sel) {
    const list = map.get(key);
    if (list) list.push(sel);
    else map.set(key, [sel]);
  }

  return {
    add(rule) {
      if (!rule || frozen) return false;
      const { exception, include, exclude, selector } = rule;
      if (exception) {
        if (!include.length) globalOff.add(selector);
        else for (const d of include) push(offByDomain, d, selector);
        stats.exceptions += 1;
        return true;
      }
      if (!include.length) {
        if (generic.size >= maxGeneric && !generic.has(selector)) { stats.capped += 1; return false; }
        generic.add(selector);
      } else {
        if (stats.specific >= maxSpecific) { stats.capped += 1; return false; }
        for (const d of include) push(byDomain, d, selector);
        stats.specific += 1;
      }
      // `~site##sel`: hidden everywhere (or on the named sites) except there.
      for (const d of exclude) push(offByDomain, d, selector);
      return true;
    },
    freeze() {
      for (const sel of globalOff) generic.delete(sel);
      genericList = [...generic];
      genericCss = batchCss(genericList, batch);
      generic = null;
      stats.generic = genericList.length;
      frozen = true;
      return { ...stats };
    },
    stats: () => ({ ...stats }),
    /** What is hidden on `host`: {generic: string[], specific: string[]} after exceptions. */
    selectorsFor(host) {
      const off = new Set();
      const specific = [];
      const seen = new Set();
      for (let h = String(host || "").toLowerCase(); h; ) {
        const offHere = offByDomain.get(h);
        if (offHere) for (const s of offHere) off.add(s);
        const here = byDomain.get(h);
        if (here) for (const s of here) { if (!seen.has(s)) { seen.add(s); specific.push(s); } }
        const dot = h.indexOf(".");
        if (dot < 0) break;
        h = h.slice(dot + 1);
      }
      return {
        generic: off.size ? genericList.filter((s) => !off.has(s)) : genericList,
        specific: specific.filter((s) => !off.has(s) && !globalOff.has(s)),
        exceptions: off.size,
      };
    },
    /**
     * The style sheet for a page on `host`. Empty string when there is nothing to hide.
     * `generic: false` leaves the every-site rules out (the lists' `$generichide`).
     */
    cssFor(host, { generic: withGeneric = true } = {}) {
      const name = String(host || "").toLowerCase();
      const key = withGeneric ? name : `${name} -generic`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const { generic: g, specific, exceptions } = this.selectorsFor(name);
      const css = (!withGeneric ? "" : exceptions ? batchCss(g, batch) : genericCss) + batchCss(specific, batch);
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(key, css);
      return css;
    },
  };
}

module.exports = { HIDE, PROCEDURAL, createCosmeticIndex, looksCosmetic, parseCosmetic, safeSelector };
