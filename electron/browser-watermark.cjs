"use strict";

/**
 * browser-watermark.cjs -- what the watermark over a governed tab says and where it sits.
 *
 * The overlay itself is main's (browser-workspace.cjs): a frameless, transparent,
 * click-through window of its own over the page's rectangle, with a document main wrote
 * (no script, its own in-memory session). It is NOT page content: the page cannot read
 * it, restyle it or remove it. This file is the pure half -- the text, the document and
 * the rectangle.
 *
 * Pure: no electron.
 */

const PARTITION = "aither-watermark";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

/** Local calendar date, YYYY-MM-DD. */
function dateOf(now = Date.now()) {
  const d = new Date(now);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** "david · acme · 2026-11-13": who is signed in, the workspace, the day. */
function label({ user = "", tenant = "", now = Date.now() } = {}) {
  const printable = (ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127;
  const clean = (s) => [...String(s || "")].filter(printable).join("").trim().slice(0, 80);
  return [clean(user) || "not signed in", clean(tenant), dateOf(now)].filter(Boolean).join(" · ");
}

/** Does this app entry want the overlay? */
function wanted(app) {
  return Boolean(app && app.watermark === true);
}

/** The overlay's document: the label tiled across the page, rotated, faint, no script. */
function page(text) {
  const cell = `<span>${esc(text)}</span>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>watermark</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;pointer-events:none;user-select:none}
#w{position:fixed;inset:-50%;display:flex;flex-wrap:wrap;align-content:flex-start;transform:rotate(-24deg);opacity:.16}
#w span{flex:0 0 auto;padding:44px 56px;font:600 15px/1 system-ui,sans-serif;color:#8a93a3;white-space:nowrap;
text-shadow:0 0 1px #000}</style></head><body><div id="w">${cell.repeat(400)}</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * The overlay window's screen rectangle: the page view's rectangle (relative to the
 * window's content) moved to where that content is on screen. null = nothing to cover.
 */
function screenRect(content, view) {
  if (!content || !view || !(view.width > 0) || !(view.height > 0)) return null;
  return { x: Math.round(content.x + view.x), y: Math.round(content.y + view.y), width: Math.round(view.width), height: Math.round(view.height) };
}

module.exports = { PARTITION, dateOf, label, page, screenRect, wanted };
