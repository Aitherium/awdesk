"use strict";

/**
 * browser-user-agent.cjs -- the Aither Browser says it is Chrome, like Edge does.
 *
 * Electron's default user agent carries two extra product tokens, the app's own and
 * "Electron/39.x". Google sign-in, banks and many "unsupported browser" walls refuse a
 * browser that names itself that way. Web pages now see the plain Chrome string: the
 * default with every product token but Chrome and Safari removed, and Chrome's version
 * reduced to "<major>.0.0.0" the way real Chrome sends it.
 *
 * Two places need it (measured on Electron 39.8.10):
 *   - each page SESSION (owner, agent, InPrivate): session.setUserAgent covers a tab's
 *     navigator.userAgent, its request header and its dedicated workers.
 *   - the app-wide FALLBACK: a window.open popup and a service worker do not read the
 *     session's value; they read app.userAgentFallback. Without it a sign-in popup still
 *     said "Electron" in both its header and its navigator.userAgent.
 *
 * navigator.userAgentData already names only "Chromium" (no Electron brand), and Electron
 * sends no Sec-CH-UA header; Electron 39 has no API to add a "Google Chrome" brand, so
 * the brands are left as they are -- they do not contradict the string.
 *
 * Pure: no electron at module load.
 */

/** The product tokens a real Chrome sends after the platform comment. */
const KEPT_PRODUCTS = Object.freeze(["Chrome", "Safari"]);

/**
 * The plain Chrome user agent for this build.
 * @param {string} defaultUa Electron's own user agent (session.getUserAgent() / app.userAgentFallback)
 * @returns {string} the same string without the app and Electron tokens; "" when it is not a Chromium user agent
 */
function chromeUserAgent(defaultUa) {
  const ua = String(defaultUa || "").trim();
  // "Mozilla/5.0 (<platform>) AppleWebKit/537.36 (KHTML, like Gecko) <products...>"
  const m = /^(Mozilla\/5\.0 \([^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\))((?: \S+)+)$/.exec(ua);
  if (!m) return "";
  const products = m[2].trim().split(/\s+/)
    .filter((p) => KEPT_PRODUCTS.includes(p.split("/")[0]))
    .map((p) => p.replace(/^Chrome\/(\d+)\.[\d.]+$/, "Chrome/$1.0.0.0"));
  if (!products.some((p) => p.startsWith("Chrome/")) || !products.some((p) => p.startsWith("Safari/"))) return "";
  return `${m[1]} ${products.join(" ")}`;
}

/** True when a user agent names Electron or any product a real Chrome does not send. */
function namesTheApp(ua) {
  const text = String(ua || "");
  return /Electron\//i.test(text) || chromeUserAgent(text) !== text;
}

/**
 * Put the plain Chrome user agent on one page session and on the app-wide fallback.
 * Safe to call for every session; a user agent this module cannot read is left alone.
 * @param {{getUserAgent: Function, setUserAgent: Function}} ses
 * @param {{userAgentFallback: string}} app
 * @returns {string} the user agent now in force ("" = nothing was changed)
 */
function install(ses, app) {
  let source;
  try { source = (app && app.userAgentFallback) || (ses && ses.getUserAgent()) || ""; } catch { source = ""; }
  const ua = chromeUserAgent(source);
  if (!ua) return "";
  try { if (app && app.userAgentFallback !== ua) app.userAgentFallback = ua; } catch { /* the sessions still get it */ }
  try { if (ses && ses.getUserAgent() !== ua) ses.setUserAgent(ua); } catch { return ""; }
  return ua;
}

module.exports = { KEPT_PRODUCTS, chromeUserAgent, install, namesTheApp };
