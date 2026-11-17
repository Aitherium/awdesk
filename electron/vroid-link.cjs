"use strict";

/**
 * vroid-link.cjs -- link his VRoid Hub account from the desk, and browse/download within the
 * licence through the platform's broker (market-client.cjs -> /api/avatars/vroid/*).
 *
 * The platform already holds the registered VRoid Hub app (vault VROID_HUB_CLIENT_ID/SECRET,
 * redirect http://127.0.0.1:47835/callback, scope `default`). Linking is HIS approval on
 * hub.vroid.com: the broker hands back an authorize URL (PKCE, state), the desk opens it in his
 * browser and catches the return on 127.0.0.1:47835 for a few minutes, then finishes the link
 * with POST /vroid/link-web {code, state}. When the port cannot be held (Windows moves its
 * reserved ranges across reboots), the page offers the broker's own fallback: paste the address
 * the browser landed on.
 *
 * Audience: a model rated above the active profile is not listed at all (no name, no picture),
 * and a download lands in "My avatars" UNASSIGNED with VRoid's own rating.
 */

const http = require("node:http");

const CATCH_HOST = "127.0.0.1";
const CATCH_PORT = 47835;
const CATCH_MS = 5 * 60 * 1000;
/** Where VRoid Hub serves model pictures. Anything else is not fetched. */
const IMAGE_HOSTS = [/\.pximg\.net$/i, /(^|\.)vroid\.com$/i];

/** The model's tier from VRoid's own flags (broker shape: r15 / r18 booleans). */
function tierOfModel(m) {
  if (m && m.r18) return "mature";
  if (m && m.r15) return "teen";
  return "everyone";
}

/** Models the audience may see, plus how many it hides. Never names a hidden one. */
function visibleModels(models, cap, tierAllowed) {
  const out = [];
  let hidden = 0;
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m.id !== "string") continue;
    const tier = tierOfModel(m);
    if (!tierAllowed(tier, cap)) { hidden += 1; continue; }
    out.push({
      id: m.id,
      name: String(m.name || m.id).slice(0, 80),
      image: typeof m.image === "string" ? m.image : "",
      downloadable: m.downloadable === true,
      hearts: Number(m.hearts) || 0,
      tier,
      url: typeof m.url === "string" ? m.url : "",
    });
  }
  return { models: out, hidden };
}

function imageAllowed(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && IMAGE_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

/** A VRoid picture as a data URL (the page's CSP allows no remote images). */
async function imageData(raw, { fetchImpl = globalThis.fetch, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!imageAllowed(raw) || typeof fetchImpl !== "function") return null;
  try {
    const res = await fetchImpl(String(raw), { headers: { Accept: "image/*" } });
    if (!res.ok) return null;
    const type = String(res.headers.get("content-type") || "").split(";")[0];
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** code + state from a callback URL (or the address he pasted). */
function codeAndState(raw) {
  try {
    const u = new URL(String(raw || ""), `http://${CATCH_HOST}:${CATCH_PORT}`);
    const code = u.searchParams.get("code") || "";
    const state = u.searchParams.get("state") || "";
    return code && state ? { code, state } : null;
  } catch {
    return null;
  }
}

const DONE_PAGE = (ok, text) => `<!doctype html><meta charset="utf-8"><title>VRoid Hub</title>
<body style="font:16px system-ui;background:#0b0c10;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div><h2>${ok ? "VRoid Hub is linked" : "VRoid Hub was not linked"}</h2><p>${text}</p></div></body>`;

/**
 * Start a link: ask the broker for the authorize URL, hold the loopback catcher, open the URL.
 * deps: storeRequest(path, opts), openExternal(url), onLinked(result), createServer (test seam).
 * Returns {ok, opened, paste} -- `paste: true` when the catcher could not listen.
 */
async function startLink({ storeRequest, openExternal, onLinked = () => {}, createServer = http.createServer, catchMs = CATCH_MS } = {}) {
  const start = await storeRequest("/vroid/authorize-web", { method: "POST", json: {} });
  if (!start.ok || !start.body || typeof start.body.authorize_url !== "string") {
    return { ok: false, reason: (start && start.reason) || "VRoid Hub linking is not available right now" };
  }
  const authorizeUrl = start.body.authorize_url;
  let paste = false;
  await new Promise((resolve) => {
    let server;
    const stop = () => { try { server.close(); } catch { /* closed */ } };
    try {
      server = createServer(async (req, res) => {
        const got = codeAndState(req.url);
        if (!req.url || !req.url.startsWith("/callback") || !got) {
          res.writeHead(404).end();
          return;
        }
        const r = await storeRequest("/vroid/link-web", { method: "POST", json: got });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE(r.ok, r.ok ? "You can close this tab; the desk's gallery shows your VRoid Hub now." : String(r.reason || "Try again from the gallery.")));
        stop();
        onLinked({ ok: r.ok, reason: r.ok ? null : r.reason });
      });
      server.on("error", () => { paste = true; resolve(); });
      server.listen(CATCH_PORT, CATCH_HOST, () => resolve());
      const t = setTimeout(stop, catchMs);
      if (typeof t.unref === "function") t.unref();
    } catch {
      paste = true;
      resolve();
    }
  });
  openExternal(authorizeUrl);
  return { ok: true, opened: true, paste };
}

/** Finish a link from the address he pasted. */
async function finishPasted(raw, { storeRequest }) {
  const got = codeAndState(raw);
  const r = await storeRequest("/vroid/link-web", { method: "POST", json: got || { url: String(raw || "") } });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason || "that address did not finish the link" };
}

module.exports = { CATCH_PORT, tierOfModel, visibleModels, imageAllowed, imageData, codeAndState, startLink, finishPasted };
