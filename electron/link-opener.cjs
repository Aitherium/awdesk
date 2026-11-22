"use strict";

/**
 * link-opener -- where a link the desk opens goes: AitherBrowser or the system browser.
 *
 * Owner, 2026-11-16: "no option for aitherbrowser?" Measured that day: the Windows
 * "open with" list had no Aither Browser at all (the HKCU registration was only ever
 * written by "Make Aither your default browser..."), several desk doors handed
 * aitherium.com links straight to shell.openExternal, and the fairy's card menu had
 * "Copy link" but no "Open". The rule this module holds:
 *
 *   an Aitherium URL (aitherium.com and its subdomains, the tenant hosts) -> AitherBrowser
 *   anything else                                                        -> the system browser
 *   every chooser offers BOTH, AitherBrowser first
 *
 * PURE: no electron. node --test electron/link-opener.test.cjs.
 */

const AITHERIUM_HOSTS = Object.freeze(["aitherium.com", "aitherium.ai", "openaw.org", "aionyn.com", "wesyn.com"]);

function hostOf(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Is this one of ours (the apex, a subdomain or a tenant host)? */
function isAitheriumUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return AITHERIUM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Only http(s) links are opened by any door here. */
function isWebUrl(url) {
  return Boolean(hostOf(url));
}

/**
 * Which opener a link gets by default: "aither" for an Aitherium URL, "system" for the
 * rest. `prefer` ("aither" | "system") is an explicit pick and always wins.
 */
function openerFor(url, prefer = "") {
  if (!isWebUrl(url)) return "";
  if (prefer === "aither" || prefer === "system") return prefer;
  return isAitheriumUrl(url) ? "aither" : "system";
}

/**
 * The "open with" rows for a link, AitherBrowser first and marked when it is the
 * default. {id, label, hint, default?}. Ids: "open-aither", "open-system", "copy-link".
 */
function openWithItems(url, { copy = true } = {}) {
  if (!isWebUrl(url)) return [];
  const ours = openerFor(url) === "aither";
  const items = [
    { id: "open-aither", label: ours ? "Open in AitherBrowser (default)" : "Open in AitherBrowser", hint: "The desk's own browser, signed in", default: ours },
    { id: "open-system", label: ours ? "Open in your other browser" : "Open in your browser (default)", hint: "The system default browser", default: !ours },
  ];
  if (copy) items.push({ id: "copy-link", label: "Copy link", hint: "To the clipboard" });
  return items;
}

/**
 * Run one opener. `openAither(url)` and `openSystem(url)` are injected (electron lives
 * in main). Returns {ok, via, url} or {ok:false, error}.
 */
function openLink(url, { prefer = "", openAither, openSystem } = {}) {
  const via = openerFor(url, prefer);
  if (!via) return { ok: false, error: "not a web link" };
  const fn = via === "aither" ? openAither : openSystem;
  if (typeof fn !== "function") return { ok: false, error: `no ${via} opener in this build` };
  try {
    const r = fn(String(url));
    if (r && typeof r === "object" && r.ok === false) return { ...r, via };
    return { ok: true, via, url: String(url) };
  } catch (error) {
    return { ok: false, via, error: String((error && error.message) || error) };
  }
}

module.exports = { AITHERIUM_HOSTS, hostOf, isAitheriumUrl, isWebUrl, openerFor, openWithItems, openLink };
