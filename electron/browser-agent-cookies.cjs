"use strict";

/**
 * browser-agent-cookies.cjs -- which SESSION an agent's tab rides (BROWSER-M3).
 *
 * Until 2026-10-29 every tab in the Aither Browser -- the owner's and the agent's
 * -- lived in ONE partition ("persist:aither-browser"), so an agent tab inherited
 * every site the owner was signed into. browser-tabs.cjs kept the agent out of the
 * owner's TABS; it did nothing about the cookies inside the agent's own tab. An
 * agent told to "check my order" arrived already signed in as the owner.
 *
 * The owner's decision (2026-10-29): "FLIP IT". The rule now:
 *
 *   agent tab, site not allowed  -> AGENT_PARTITION ("persist:agent")   the default
 *   agent tab, site ALLOWED      -> the owner's partition               opt-in
 *   owner tab                    -> the owner's partition               unchanged
 *
 * The allow is per SITE (host, exactly -- a subdomain is its own site), default
 * OFF for every site, persisted with the rest of the owner's layout
 * (browser-layout.json, browser-rail.normalizeLayout) and revoked from the same
 * toolbar control that grants it ("Let the agent use my sign-in").
 *
 * Pure and electron-free: the wiring lives in browser-window.cjs, this module only
 * answers "which partition" and keeps the list honest.
 */

/** The session an agent's tab rides when the owner has not allowed its site. */
const AGENT_PARTITION = "persist:agent";
/** How many sites the owner may allow; the list is shown in the toolbar. */
const MAX_SITES = 50;
const MAX_HOST = 253;
/** A DNS label: letters, digits, inner hyphens. No wildcards, no ports, no paths. */
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * One site name as it is stored: lower case, no trailing dot, or "" when it is not
 * a hostname (a URL, a wildcard, an IP with a path, junk).
 */
function normalizeHost(value) {
  const host = String(value == null ? "" : value).trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > MAX_HOST) return "";
  if (!host.split(".").every((label) => HOST_LABEL.test(label))) return "";
  // A site has a dot (or is the dev alias). "42" is an address the owner never meant.
  return host === "localhost" || host.includes(".") ? host : "";
}

/**
 * The site an address belongs to -- its host -- or "" for anything that is not a
 * web page (aither://, about:blank, data:, garbage). A port is not part of it.
 */
function hostOf(url) {
  try {
    const parsed = new URL(String(url == null ? "" : url));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return normalizeHost(parsed.hostname);
  } catch {
    return "";
  }
}

/** The stored list, sanitized: hosts only, lower case, unique, capped. Hand-edited file safe. */
function normalizeSites(raw, { max = MAX_SITES } = {}) {
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const host = normalizeHost(value);
    if (!host || out.includes(host)) continue;
    out.push(host);
    if (out.length >= max) break;
  }
  return out;
}

/** Is `url`'s site on the owner's list? */
function isAllowed(sites, url) {
  const host = hostOf(url);
  return Boolean(host) && normalizeSites(sites).includes(host);
}

/**
 * THE picker: the partition a new tab for `by` at `url` is created in.
 * @param {{by: string, url: string, sites?: string[], ownerPartition: string, agentPartition?: string}} args
 * @returns {string} a session partition name
 */
function partitionFor({ by, url, sites = [], ownerPartition, agentPartition = AGENT_PARTITION } = {}) {
  if (by !== "agent") return ownerPartition;
  return isAllowed(sites, url) ? ownerPartition : agentPartition;
}

/**
 * The owner allowing a site from a page they are looking at (their tab's address, or
 * a bare host from the revoke list). A page with no site (an Aither page) cannot be
 * allowed -- there is no session to share.
 * @returns {{ok: true, host: string, sites: string[]} | {ok: false, error: string}}
 */
function allow(sites, url) {
  const host = hostOf(url) || normalizeHost(url);
  if (!host) return { ok: false, error: "this page has no site to allow" };
  const list = normalizeSites(sites);
  if (!list.includes(host) && list.length >= MAX_SITES) {
    return { ok: false, error: `the agent may use your sign-in on ${MAX_SITES} sites; revoke one first` };
  }
  return { ok: true, host, sites: list.includes(host) ? list : [...list, host] };
}

/** The owner taking it back. Revoking a site that is not on the list is not an error. */
function revoke(sites, url) {
  const host = hostOf(url) || normalizeHost(url);
  if (!host) return { ok: false, error: "this page has no site to revoke" };
  return { ok: true, host, sites: normalizeSites(sites).filter((h) => h !== host) };
}

/**
 * What the toolbar shows for one page: the site, whether the agent may ride the
 * owner's sign-in there, and the whole list (to see and revoke).
 */
function stateFor(sites, url) {
  const host = hostOf(url);
  const list = normalizeSites(sites);
  return { host, allowed: Boolean(host) && list.includes(host), sites: list };
}

module.exports = {
  AGENT_PARTITION,
  MAX_SITES,
  allow,
  hostOf,
  isAllowed,
  normalizeHost,
  normalizeSites,
  partitionFor,
  revoke,
  stateFor,
};
