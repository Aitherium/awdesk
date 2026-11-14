"use strict";

/**
 * browser-adblock-rules.cjs -- Adblock Plus network rules with paths and options.
 *
 * browser-adblock.cjs blocks whole hosts. Many ads are served from a host that also
 * serves the page (`||news.example/ads/banner^`) or from a path any host may carry
 * (`/adframe.js`), and many rules only apply to one kind of request (`$script`), to
 * third parties (`$third-party`) or on some sites (`$domain=a.com|~b.a.com`). This
 * module parses those rules and answers "does a rule match this request".
 *
 * Every request passes through here, so nothing backtracks:
 *   - A pattern is split on `*` into literal pieces. Pieces are found left to right
 *     with indexOf; `^` (a separator, or the end of the address) is checked a
 *     character at a time. No list rule ever becomes a regular expression, and list
 *     rules that ARE regular expressions (`/.../`) are skipped.
 *   - Rules are indexed, so a request only tests the few that could match: by the
 *     hostname of `||host/...` rules, else by one word of the pattern that must appear
 *     whole in the address, else (a rule with no usable word) by the sites named in
 *     its `$domain=`. A rule that fits none of the three is dropped and counted.
 *
 * Page-level exceptions are the lists' own "this site breaks" valves and are kept, with
 * `rule.page` saying which: `@@||site^$document` (block nothing on these pages),
 * `$elemhide` (hide nothing), `$generichide` (hide only what is written for the site;
 * `@@||www.youtube.com^$generichide` is one).
 *
 * Not supported, skipped and counted: `$csp`, `$redirect`, `$rewrite`, `$removeparam`,
 * `$popup`, blocking `$document`, `$genericblock`, `$badfilter`, `$match-case`,
 * `$header` and regular-expression rules.
 */

const TYPE_BITS = Object.freeze({
  script: 1, image: 2, stylesheet: 4, xmlhttprequest: 8, subdocument: 16, media: 32,
  font: 64, websocket: 128, ping: 256, object: 512, other: 1024,
});
const ALL_TYPES = 2047;
const TYPE_ALIASES = Object.freeze({
  xhr: "xmlhttprequest", css: "stylesheet", frame: "subdocument", "object-subrequest": "object", beacon: "ping",
});
/** Electron's webRequest resourceType -> the list's request type. */
const ELECTRON_TYPES = Object.freeze({
  script: 1, image: 2, stylesheet: 4, xhr: 8, subFrame: 16, media: 32, font: 64,
  webSocket: 128, ping: 256, object: 512, cspReport: 1024, other: 1024,
});

/** Page-level exception options -> the bit in `rule.page`. */
const PAGE_DOCUMENT = 1;
const PAGE_ELEMHIDE = 2;
const PAGE_GENERICHIDE = 4;
const PAGE_OPTIONS = Object.freeze({
  document: PAGE_DOCUMENT, doc: PAGE_DOCUMENT, elemhide: PAGE_ELEMHIDE, ehide: PAGE_ELEMHIDE,
  generichide: PAGE_GENERICHIDE, ghide: PAGE_GENERICHIDE,
});

const START = 1; // |pattern
const END = 2; // pattern|
const HOST = 4; // ||pattern

/** Words too common in addresses to index a rule under when it has any other. */
const COMMON = new Set(["http", "https", "www", "com", "net", "org", "js", "html", "htm", "php", "css",
  "png", "jpg", "gif", "svg", "json", "min", "static", "cdn", "assets", "images", "img", "api", "v1", "v2"]);

const MAX_PATTERN = 400;

/** What `^` matches: anything that is not a letter, a digit or one of _ - . % */
function isSeparatorCode(c) {
  return !((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 46 || c === 37);
}

/** A `$domain=` name: lower case, dotted, plain. */
function cleanDomain(d) {
  const s = String(d || "").trim().toLowerCase();
  return s && /^[a-z0-9.-]+$/.test(s) && !s.startsWith(".") ? s : null;
}

/**
 * One network rule, or null when the line is not one this module handles.
 * @returns {null | {exception: boolean, pattern: string, segs: string[], anchors: number,
 *   types: number, party: 0|1|2, include: string[]|null, exclude: string[]|null, host: string|null,
 *   page: number}}
 */
function parseRule(raw) {
  let line = String(raw || "").trim();
  if (!line || line[0] === "!" || line[0] === "[") return null;
  if (/#[@?$%]?#/.test(line)) return null; // cosmetic and scriptlet rules
  if (line.length > 2000) return null;
  let exception = false;
  if (line.startsWith("@@")) { exception = true; line = line.slice(2); }

  let types = 0;
  let notTypes = 0;
  let party = 0;
  let page = 0;
  let include = null;
  let exclude = null;
  const dollar = line.lastIndexOf("$");
  const tail = dollar >= 0 ? line.slice(dollar + 1) : "";
  // Options this parser cannot read (`$csp=script-src 'self'`): the rule is skipped,
  // never kept as a pattern with the options glued on.
  if (tail && !/^[a-z0-9_,~=|.*-]+$/i.test(tail) && /^~?[a-z-]+(=|,|$)/i.test(tail)) return null;
  if (tail && /^[a-z0-9_,~=|.*-]+$/i.test(tail)) {
    const opts = line.slice(dollar + 1).toLowerCase().split(",");
    line = line.slice(0, dollar);
    for (const opt of opts) {
      if (!opt) continue;
      const neg = opt[0] === "~";
      const name = neg ? opt.slice(1) : opt;
      const type = TYPE_BITS[TYPE_ALIASES[name] || name];
      if (type) { if (neg) notTypes |= type; else types |= type; continue; }
      if (PAGE_OPTIONS[name]) {
        if (neg || !exception) return null; // a blocking $document rule cancels a page: never done here
        page |= PAGE_OPTIONS[name];
        continue;
      }
      if (name === "third-party" || name === "3p") { party = neg ? 2 : 1; continue; }
      if (name === "first-party" || name === "1p") { party = neg ? 1 : 2; continue; }
      if (name === "all") { types = ALL_TYPES; continue; }
      if (name === "important") continue;
      if (name.startsWith("domain=") || name.startsWith("from=")) {
        if (neg) return null;
        for (const part of name.slice(name.indexOf("=") + 1).split("|")) {
          const no = part[0] === "~";
          const d = cleanDomain(no ? part.slice(1) : part);
          if (!d) return null; // wildcards and entity names (google.*) are not handled
          if (no) (exclude = exclude || []).push(d);
          else (include = include || []).push(d);
        }
        continue;
      }
      return null; // an option this module does not implement
    }
  }
  if (page) types = ALL_TYPES; // judged against the page, whatever else the rule lists
  else if (!types) types = notTypes ? (ALL_TYPES & ~notTypes) : ALL_TYPES;
  else if (notTypes) types &= ~notTypes;
  if (!types) return null;

  if (line.length > 1 && line[0] === "/" && line[line.length - 1] === "/") return null; // a regular expression
  let anchors = 0;
  if (line.startsWith("||")) { anchors |= HOST; line = line.slice(2); }
  else if (line.startsWith("|")) { anchors |= START; line = line.slice(1); }
  if (line.endsWith("|")) { anchors |= END; line = line.slice(0, -1); }
  let pattern = line.toLowerCase().replace(/\*{2,}/g, "*");
  // A leading or trailing * says nothing, and cancels the anchor beside it.
  if (pattern.startsWith("*")) { pattern = pattern.replace(/^\*+/, ""); anchors &= ~(HOST | START); }
  if (pattern.endsWith("*")) { pattern = pattern.replace(/\*+$/, ""); anchors &= ~END; }
  if (pattern.length > MAX_PATTERN || /\s/.test(pattern)) return null;
  // Nothing left: the rule is its options (`$script,domain=a.com`). It needs a site to
  // be indexed under, or it would be tested against every request there is.
  if (!pattern && !include) return null;

  // `||example.com/ads^`: the hostname the rule is tied to, when it names a whole one.
  let host = null;
  if (anchors & HOST) {
    const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[\^/:?]|$)/.exec(pattern);
    if (m) host = m[1];
  }
  return { exception, pattern, segs: pattern ? pattern.split("*") : [], anchors, types, party, include, exclude, host, page };
}

/**
 * Is this the plain host rule the host set already handles (`||host^`, optionally
 * `$third-party`)? browser-adblock.cjs keeps those in a Set, not here.
 */
function isPlainHostRule(rule) {
  return Boolean(rule && !rule.page && rule.host && rule.anchors === HOST && rule.pattern === `${rule.host}^`
    && rule.types === ALL_TYPES && rule.party !== 2 && !rule.include && !rule.exclude);
}

/** Does `seg` match `url` starting exactly at `i`? The index after the match, or -1. */
function matchAt(url, seg, i) {
  const n = url.length;
  for (let k = 0; k < seg.length; k += 1) {
    const c = seg.charCodeAt(k);
    if (c === 94) { // ^
      if (i >= n) continue; // the end of the address is a separator, and takes no character
      if (!isSeparatorCode(url.charCodeAt(i))) return -1;
      i += 1;
    } else {
      if (i >= n || url.charCodeAt(i) !== c) return -1;
      i += 1;
    }
  }
  return i;
}

/**
 * The first match of `seg` in `url` at or after `from`: the index after it, or -1.
 * `mustEnd` asks for a match that ends at the end of the address.
 */
function findSeg(url, seg, from, mustEnd) {
  const n = url.length;
  const hat = seg.indexOf("^");
  if (hat < 0) {
    if (mustEnd) return n - seg.length >= from && url.endsWith(seg) ? n : -1;
    const at = url.indexOf(seg, from);
    return at < 0 ? -1 : at + seg.length;
  }
  if (hat > 0) {
    // Jump between occurrences of the literal before the first ^.
    const lead = seg.slice(0, hat);
    for (let at = url.indexOf(lead, from); at >= 0; at = url.indexOf(lead, at + 1)) {
      const end = matchAt(url, seg, at);
      if (end >= 0 && (!mustEnd || end === n)) return end;
    }
    return -1;
  }
  for (let at = from; at <= n; at += 1) {
    if (at < n && !isSeparatorCode(url.charCodeAt(at))) continue;
    const end = matchAt(url, seg, at);
    if (end >= 0 && (!mustEnd || end === n)) return end;
  }
  return -1;
}

/** The remaining pieces after the first, left to right. */
function matchRest(url, segs, anchors, from) {
  let at = from;
  for (let k = 1; k < segs.length; k += 1) {
    const last = k === segs.length - 1;
    at = findSeg(url, segs[k], at, last && Boolean(anchors & END));
    if (at < 0) return false;
  }
  return true;
}

/**
 * Does the rule's pattern match the (lower case) address? `hostStart`/`hostEnd` bound
 * the hostname inside `url`, for `||`.
 */
function matchPattern(rule, url, hostStart, hostEnd) {
  const segs = rule.segs;
  if (!segs.length) return true;
  const anchors = rule.anchors;
  const only = segs.length === 1;
  const endHere = only && Boolean(anchors & END);
  if (anchors & START) {
    const end = matchAt(url, segs[0], 0);
    if (end < 0 || (endHere && end !== url.length)) return false;
    return matchRest(url, segs, anchors, end);
  }
  if (anchors & HOST) {
    // The start of the hostname, or just after any of its dots.
    for (let at = hostStart; at >= 0 && at < hostEnd;) {
      const end = matchAt(url, segs[0], at);
      if (end >= 0 && (!endHere || end === url.length) && matchRest(url, segs, anchors, end)) return true;
      const dot = url.indexOf(".", at);
      if (dot < 0 || dot >= hostEnd) break;
      at = dot + 1;
    }
    return false;
  }
  const end = findSeg(url, segs[0], 0, endHere);
  return end >= 0 && matchRest(url, segs, anchors, end);
}

/** Is `host` the domain `d` or under it? */
function underDomain(host, d) {
  return host === d || (host.length > d.length && host.endsWith(d) && host.charCodeAt(host.length - d.length - 1) === 46);
}

function optionsMatch(rule, req) {
  if (!(rule.types & req.type)) return false;
  if (rule.party === 1 && !req.thirdParty) return false;
  if (rule.party === 2 && req.thirdParty) return false;
  if (rule.include) {
    let ok = false;
    for (const d of rule.include) { if (underDomain(req.pageHost, d)) { ok = true; break; } }
    if (!ok) return false;
  }
  if (rule.exclude) {
    for (const d of rule.exclude) { if (underDomain(req.pageHost, d)) return false; }
  }
  return true;
}

function anyMatch(list, req) {
  for (let i = 0; i < list.length; i += 1) {
    const rule = list[i];
    if (optionsMatch(rule, req) && matchPattern(rule, req.url, req.hostStart, req.hostEnd)) return true;
  }
  return false;
}

/** The words of a pattern that must appear whole in any address it matches. */
function patternTokens(rule) {
  const p = rule.pattern;
  const out = [];
  const re = /[a-z0-9%]+/g;
  for (let m = re.exec(p); m; m = re.exec(p)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start === 0 ? ((rule.anchors & (START | HOST)) ? "|" : "") : p[start - 1];
    const after = end === p.length ? ((rule.anchors & END) ? "|" : "") : p[end];
    // Open on either side (the pattern's edge, or a *): the address word may be longer.
    if (!before || before === "*" || !after || after === "*") continue;
    if (m[0].length < 2) continue; // one character indexes nothing useful
    out.push(m[0]);
  }
  return out;
}

/**
 * An indexed set of rules. add() every rule, then freeze() once; match() after that.
 */
function createRuleSet() {
  let pending = [];
  const byHost = new Map(); // hostname -> rules
  const byToken = new Map(); // word -> rules
  const byPage = new Map(); // $domain= site -> rules with no usable word
  const stats = { rules: 0, byHost: 0, byToken: 0, byPage: 0, dropped: 0 };

  function push(map, key, rule) {
    const list = map.get(key);
    if (list) list.push(rule);
    else map.set(key, [rule]);
  }

  return {
    add(rule) {
      if (rule) pending.push(rule);
    },
    /** Build the index. Rules are kept as small as they can be: only what match() reads. */
    freeze() {
      const counts = new Map();
      const tokensOf = new Map();
      for (const rule of pending) {
        if (rule.host) continue;
        const tokens = patternTokens(rule);
        tokensOf.set(rule, tokens);
        for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      }
      for (const rule of pending) {
        const slim = { segs: rule.segs, anchors: rule.anchors, types: rule.types, party: rule.party,
          include: rule.include, exclude: rule.exclude };
        stats.rules += 1;
        if (rule.host) { push(byHost, rule.host, slim); stats.byHost += 1; continue; }
        // The rarest word among the rule's own; a common address word only as a last resort.
        let best = null;
        let bestScore = Infinity;
        for (const t of tokensOf.get(rule)) {
          const score = (counts.get(t) || 0) + (COMMON.has(t) ? 1e6 : 0);
          if (score < bestScore) { best = t; bestScore = score; }
        }
        if (best) { push(byToken, best, slim); stats.byToken += 1; continue; }
        if (rule.include) { for (const d of rule.include) push(byPage, d, slim); stats.byPage += 1; continue; }
        stats.rules -= 1;
        stats.dropped += 1;
      }
      pending = [];
      return stats;
    },
    stats: () => ({ ...stats }),
    /**
     * Does any rule match? `req` = {url (lower case), host, hostStart, hostEnd, tokens,
     * type (bit), thirdParty, pageHost}.
     */
    match(req) {
      const test = (list) => anyMatch(list, req);
      if (byHost.size) {
        for (let h = req.host; h; ) {
          const list = byHost.get(h);
          if (list && test(list)) return true;
          const dot = h.indexOf(".");
          if (dot < 0) break;
          h = h.slice(dot + 1);
        }
      }
      if (byToken.size) {
        const tokens = req.tokens;
        for (let i = 0; i < tokens.length; i += 1) {
          const list = byToken.get(tokens[i]);
          if (list && test(list)) return true;
        }
      }
      if (byPage.size && req.pageHost) {
        for (let h = req.pageHost; h; ) {
          const list = byPage.get(h);
          if (list && test(list)) return true;
          const dot = h.indexOf(".");
          if (dot < 0) break;
          h = h.slice(dot + 1);
        }
      }
      return false;
    },
  };
}

/**
 * The parts of a request the rule sets read, computed once per request. `url` must be
 * an http(s)/ws(s) address; null when it is not.
 */
function describeRequest(url, resourceType, pageHost, thirdParty) {
  const lower = String(url || "").toLowerCase();
  const scheme = lower.indexOf("://");
  if (scheme < 0) return null;
  let hostStart = scheme + 3;
  let hostEnd = lower.length;
  for (let i = hostStart; i < lower.length; i += 1) {
    const c = lower.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) { hostEnd = i; break; } // / ? #
  }
  const at = lower.lastIndexOf("@", hostEnd - 1);
  if (at >= hostStart) hostStart = at + 1;
  let nameEnd = hostEnd;
  const colon = lower.indexOf(":", hostStart);
  if (colon >= 0 && colon < hostEnd && lower.charCodeAt(hostStart) !== 91) nameEnd = colon; // not [ipv6]
  // Words past the first 2,000 characters are not looked up (a data-carrying address).
  const tokens = lower.length > 2000 ? lower.slice(0, 2000).match(/[a-z0-9%]+/g) : lower.match(/[a-z0-9%]+/g);
  return {
    url: lower, host: lower.slice(hostStart, nameEnd), hostStart, hostEnd: nameEnd,
    tokens: tokens || [], type: ELECTRON_TYPES[resourceType] || TYPE_BITS.other,
    thirdParty: Boolean(thirdParty), pageHost: String(pageHost || ""),
  };
}

module.exports = {
  ALL_TYPES, ELECTRON_TYPES, PAGE_DOCUMENT, PAGE_ELEMHIDE, PAGE_GENERICHIDE, TYPE_BITS,
  createRuleSet, describeRequest, isPlainHostRule, matchPattern, parseRule, patternTokens,
};
