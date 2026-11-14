"use strict";

/**
 * browser-tracking.cjs -- two cheap tracking protections for the Aither Browser.
 *
 * 1. Links carry click identifiers (`?utm_source=...&fbclid=...`) that tell the site,
 *    and every script on it, which ad or post sent the reader. They are removed from
 *    the address before a page loads. Only names known to be identifiers are removed;
 *    the other parameters keep their order and their exact spelling.
 * 2. Requests carry `Sec-GPC: 1` (Global Privacy Control, a legal opt-out of sale and
 *    sharing in several jurisdictions) and the older `DNT: 1`.
 *
 * Pure. browser-adblock.cjs applies both from the session's request hooks.
 */

/** Exact parameter names that only identify a click, a campaign or a mail recipient. */
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "ysclid", "twclid",
  "ttclid", "li_fat_id", "igshid", "igsh", "mc_eid", "mc_cid", "_hsenc", "_hsmi", "__hssc", "__hstc",
  "__hsfp", "hsctatracking", "mkt_tok", "vero_id", "vero_conv", "oly_enc_id", "oly_anon_id",
  "_openstat", "wickedid", "rb_clickid", "s_cid", "ml_subscriber", "ml_subscriber_hash", "srsltid",
  "_ga", "_gl", "epik", "ref_src", "ref_url", "cmpid", "soc_src", "soc_trk", "trk_contact",
  "trk_msg", "trk_module", "trk_sid", "guce_referrer", "guce_referrer_sig",
]);

/** Name prefixes: every `utm_*` (and its copies) is a campaign tag. */
const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_", "stm_"];

function isTrackingParam(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  if (TRACKING_PARAMS.has(n)) return true;
  for (const p of TRACKING_PREFIXES) if (n.startsWith(p) && n.length > p.length) return true;
  return false;
}

/**
 * `url` without its tracking parameters, or null when it has none (or is not a web
 * address). The path, the other parameters and the fragment are returned byte for byte.
 */
function stripTrackingParams(url) {
  const s = String(url || "");
  if (!/^https?:\/\//i.test(s) || s.length > 8192) return null;
  const hash = s.indexOf("#");
  const body = hash < 0 ? s : s.slice(0, hash);
  const q = body.indexOf("?");
  if (q < 0 || q === body.length - 1) return null;
  const parts = body.slice(q + 1).split("&");
  const kept = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    let name = eq < 0 ? part : part.slice(0, eq);
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* an odd name is kept */ }
    if (!isTrackingParam(name)) kept.push(part);
  }
  if (kept.length === parts.length) return null;
  return body.slice(0, q) + (kept.length ? `?${kept.join("&")}` : "") + (hash < 0 ? "" : s.slice(hash));
}

/** The request headers with the privacy signals added (a new object; names as given). */
function withPrivacyHeaders(headers) {
  return { ...(headers || {}), "Sec-GPC": "1", DNT: "1" };
}

module.exports = { TRACKING_PARAMS, TRACKING_PREFIXES, isTrackingParam, stripTrackingParams, withPrivacyHeaders };
