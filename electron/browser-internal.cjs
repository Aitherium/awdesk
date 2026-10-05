"use strict";

/**
 * browser-internal.cjs -- the `aither://` scheme: every Aither Console pane as a
 * page of the Aither Browser (plan slices 8 and 9, docs/AITHER-BROWSER-PLAN.md).
 *
 * Owner, 2026-10-04: "make the browser the console". The console's panes already
 * exist as pages with their own preloads; this module gives each one an address:
 *
 *   kind "file"    aither://<id>/          that pane's HTML from electron/
 *   kind "view"    aither://<id>/?<query>  the renderer bundle with its query flag
 *   kind "hosted"  aither://<id>/          AitherOS Online, opened as a HOSTED tab
 *                                          in the pane's own (signed-in) partition
 *
 * The mapping is derived from console-window.cjs PANES at call time and never
 * listed here, so a pane added there (files, secrets, strata, ...) gets its
 * aither:// page with no edit to this file.
 *
 * The fence, in four layers:
 *   1. The protocol handler is installed on ONE session, INTERNAL_PARTITION, used
 *      only by internal tabs. A web tab's session has no `aither` handler at all,
 *      so a web page cannot load, fetch or frame an aither:// URL.
 *   2. navigationVerdict(): a web tab may never navigate (or frame) to aither://;
 *      an internal tab may never show web content (a link opens a web tab).
 *   3. Every response carries frame-ancestors 'none' / X-Frame-Options DENY and
 *      CORP same-origin, so even a session that somehow resolved it could not
 *      embed it.
 *   4. The pane's IPC arrives only through browser-internal-preload.cjs, which an
 *      internal tab alone is built with, and which requires exactly ONE pane
 *      preload -- the one for the page on screen -- and only on an aither: origin.
 *
 * Pure (no electron at module load) so all of it is asserted under `node --test`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const SCHEME = "aither";
const PROTOCOL = `${SCHEME}:`;
/** The ONE session that resolves aither://. Web tabs live in the browser's own partition. */
const INTERNAL_PARTITION = "persist:aither-internal";
const INTERNAL_PRELOAD = "browser-internal-preload.cjs";
/** Where a hosted pane goes when main injected no URL for it. */
const DEFAULT_HOSTED_URL = "https://app.aitherium.com/";
const ELECTRON_DIR = __dirname;
const PANE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const PRELOAD_NAME = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?preload\.cjs$/;

/**
 * Pane preloads by HTML file -- the same pairs console-preload.cjs picks by href.
 * A pane not listed here may declare `preload:` in PANES, or follow the
 * `<stem>-preload.cjs` convention (files.html -> files-preload.cjs); see preloadFor.
 */
const PRELOAD_BY_FILE = Object.freeze({
  "command.html": "command-preload.cjs",
  "sessions.html": "sessions-preload.cjs",
  "stage.html": "stage-preload.cjs",
  "cast.html": "cast-preload.cjs",
  "fleet-control.html": "fleet-preload.cjs",
  "ops.html": "ops-preload.cjs",
  "settings.html": "settings-preload.cjs",
});
/**
 * Pane pages that SHARE one preload, matched by file name -- the regex arms of
 * console-preload.cjs (`/\/plane-[a-z]+\.html/` -> plane-preload.cjs: one page
 * script and one bridge for every platform plane). The tests run console-preload
 * itself against every PANES file, so this table and that chain cannot drift.
 */
const PRELOAD_BY_PATTERN = Object.freeze([
  Object.freeze({ pattern: /^plane-[a-z]+\.html$/, preload: "plane-preload.cjs" }),
]);
/** The renderer bundle's preload (?deck=1, ?chat=1, ?characters=1). */
const VIEW_PRELOAD = "preload.cjs";

/** Files an aither:// page may load from electron/: pages, styles, images, fonts. Never code. */
const ELECTRON_ASSET_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
});
/**
 * Page scripts a file pane may load from electron/ -- ONLY a `<script src>` its own
 * HTML names (plane-page.js for every plane-*.html). Never .cjs (main-process and
 * preload code), never a script that pane's page does not load.
 */
const PAGE_SCRIPT_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
});
/** Where a view page reads a roster character's model (deck thumbnails): /_models/<name>.vrm */
const MODEL_PREFIX = "/_models/";
const MODEL_TYPES = Object.freeze({ ".vrm": "model/gltf-binary", ".glb": "model/gltf-binary" });
/** What the console granted its panes (main.cjs grantMic): the microphone, nothing else. */
const INTERNAL_PERMISSIONS = Object.freeze(new Set(["media", "audioCapture", "microphone"]));
/** The built renderer bundle (dist/) may also serve its scripts, data and models. */
const BUNDLE_ASSET_TYPES = Object.freeze({
  ...ELECTRON_ASSET_TYPES,
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".vrm": "model/gltf-binary",
  ".glb": "model/gltf-binary",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
});

/** On every aither:// response: never framed, never embedded cross-origin, never cached. */
const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
});

/** console-window.cjs PANES, read at call time so a pane added there appears here. */
function consolePanes() {
  return require("./console-window.cjs").PANES;
}

function paneById(id, panes = consolePanes()) {
  const want = String(id || "").toLowerCase();
  return panes.find((pane) => pane && pane.id === want) || null;
}

/** "aither://settings/x.css" -> { paneId: "settings", pathname: "/x.css", search } or null. */
function parseInternalUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== PROTOCOL) return null;
  const paneId = parsed.hostname.toLowerCase();
  if (!PANE_ID.test(paneId)) return null;
  return { paneId, pathname: parsed.pathname || "/", search: parsed.search || "" };
}

function isInternalUrl(url) {
  return Boolean(parseInternalUrl(url));
}

/**
 * The aither:// address of a pane. `param` is the console's focus parameter (a card
 * id): it rides as `card=` exactly as console.html's applyFocus adds it to a frame.
 */
function internalUrl(paneOrId, param = null, panes = consolePanes()) {
  const pane = typeof paneOrId === "object" && paneOrId ? paneOrId : paneById(paneOrId, panes);
  if (!pane || !PANE_ID.test(String(pane.id || ""))) return null;
  const query = [];
  if (pane.kind === "view" && pane.query) query.push(String(pane.query));
  if (param != null && param !== "") query.push(`card=${encodeURIComponent(String(param))}`);
  return `${SCHEME}://${pane.id}/${query.length ? `?${query.join("&")}` : ""}`;
}

/** Every pane as an internal page: { id, label, hint, kind, url }. Generic over PANES. */
function internalPages(panes = consolePanes()) {
  return panes
    .filter((pane) => pane && PANE_ID.test(String(pane.id || "")))
    .map((pane) => ({
      id: pane.id,
      label: pane.label || pane.id,
      hint: pane.hint || "",
      kind: pane.kind,
      url: internalUrl(pane, null, panes),
    }));
}

/**
 * The preload an internal page gets: the pane's own, never another's. Order:
 * an explicit `preload` on the pane, the PRELOAD_BY_FILE pair, the
 * `<stem>-preload.cjs` convention when that file exists, else none.
 */
function preloadFor(pane, { exists = (name) => fs.existsSync(path.join(ELECTRON_DIR, name)) } = {}) {
  if (!pane) return null;
  if (pane.kind === "hosted") return null;
  const named = typeof pane.preload === "string" ? pane.preload : null;
  if (named) return PRELOAD_NAME.test(named) && exists(named) ? named : null;
  if (pane.kind === "view") return VIEW_PRELOAD;
  if (pane.kind !== "file" || typeof pane.file !== "string") return null;
  const paired = PRELOAD_BY_FILE[pane.file];
  if (paired) return paired;
  const shared = PRELOAD_BY_PATTERN.find((row) => row.pattern.test(pane.file));
  if (shared) return shared.preload;
  const stem = pane.file.replace(/\.html$/i, "");
  const guess = `${stem}-preload.cjs`;
  return PRELOAD_NAME.test(guess) && exists(guess) ? guess : null;
}

/** The preload for the page at `url`, or null (a web URL, an unknown pane). */
function preloadForUrl(url, panes = consolePanes(), opts = {}) {
  const parsed = parseInternalUrl(url);
  if (!parsed) return null;
  return preloadFor(paneById(parsed.paneId, panes), opts);
}

/** Resolve `rel` under `root`, or null when it escapes, is hidden, or is not a plain path. */
function safeJoin(root, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rel || ""));
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\:]/.test(decoded)) return null;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === "." || part.startsWith("."))) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  return full.startsWith(base + path.sep) ? full : null;
}

function typeFor(file, table) {
  return table[path.extname(file).toLowerCase()] || null;
}

/** The relative `<script src>` names a page loads ("plane-page.js"); remote/absolute ones skipped. */
function scriptSources(html) {
  const out = [];
  const re = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const src = m[1].trim().replace(/^\.\//, "").split(/[?#]/)[0];
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) continue;
    out.push(src);
  }
  return out;
}

/** Does this file pane's own HTML load `file` as a script? */
function paneLoadsScript(pane, file, electronDir, readText) {
  let html;
  try {
    html = readText(path.join(electronDir, pane.file));
  } catch {
    return false;
  }
  return scriptSources(html).some((src) => safeJoin(electronDir, src) === file);
}

/** "/_models/Aria.vrm" -> "Aria", or null. Whether the NAME is a character is main's call. */
function modelNameOf(rel) {
  const text = String(rel || "");
  if (!text.startsWith(MODEL_PREFIX)) return null;
  let name;
  try {
    name = decodeURIComponent(text.slice(MODEL_PREFIX.length));
  } catch {
    return null;
  }
  if (!/\.vrm$/i.test(name)) return null;
  name = name.slice(0, -4);
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 128 || /[\u0000-\u001f/\\:]/.test(name) || name.startsWith(".")) return null;
  return name;
}

/**
 * deck-state `characterModels` (file:// URLs only main knows) re-addressed for a page
 * on an aither:// origin, where a file: subresource is refused: each becomes the
 * page's own /_models/<name>.vrm, which resolveRequest serves from the roster file.
 */
function internalModelUrls(characterModels) {
  const out = {};
  for (const [name, url] of Object.entries(characterModels || {})) {
    const rel = `${MODEL_PREFIX}${encodeURIComponent(name)}.vrm`;
    if (url && modelNameOf(rel) === name) out[name] = rel;
  }
  return out;
}

/**
 * May an aither:// page have `permission`? The microphone only (Inbox dictation, the
 * Settings "Grant mic" button) -- the one grant the console's default session gave
 * its panes -- and only for a requester on an aither: origin. Never the camera.
 */
function allowInternalPermission(permission, requestingUrl, details = {}) {
  if (!INTERNAL_PERMISSIONS.has(String(permission || ""))) return false;
  if (schemeOf(requestingUrl) !== PROTOCOL) return false;
  const types = [].concat((details && (details.mediaTypes || details.mediaType)) || []);
  return !types.includes("video");
}

/** Install that rule on the internal session, both the request and the check handler. */
function installInternalPermissions(ses) {
  if (!ses || typeof ses.setPermissionRequestHandler !== "function") {
    throw new Error("installInternalPermissions needs a session");
  }
  const urlOf = (wc, details, fallback) => {
    const given = details && (details.requestingUrl || details.securityOrigin);
    if (given) return given;
    if (fallback) return fallback;
    try {
      return wc && typeof wc.getURL === "function" ? wc.getURL() : "";
    } catch {
      return "";
    }
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowInternalPermission(permission, urlOf(wc, details, null), details)));
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    allowInternalPermission(permission, urlOf(wc, details, origin), details));
  return true;
}

/**
 * Decide what an aither:// request is. Pure.
 *
 * @returns {{type: "file", file: string, contentType: string}
 *   | {type: "proxy", url: string}
 *   | {type: "hosted", url: string, partition: string|null}
 *   | {type: "missing", status: number, reason: string}}
 */
function resolveRequest(url, { panes = consolePanes(), rendererUrl = "", hostedUrl = null,
  electronDir = ELECTRON_DIR, modelFile = null,
  readText = (file) => fs.readFileSync(file, "utf8") } = {}) {
  const parsed = parseInternalUrl(url);
  if (!parsed) return { type: "missing", status: 404, reason: "not an aither:// page" };
  const pane = paneById(parsed.paneId, panes);
  if (!pane) return { type: "missing", status: 404, reason: `no Aither page called ${parsed.paneId}` };
  const rel = parsed.pathname === "/" ? "" : parsed.pathname;

  if (pane.kind === "hosted") {
    const target = typeof hostedUrl === "function" ? hostedUrl(pane.id) : hostedUrl;
    return { type: "hosted", url: String(target || DEFAULT_HOSTED_URL), partition: pane.partition || null };
  }

  if (pane.kind === "file") {
    const file = safeJoin(electronDir, rel || pane.file);
    // A script only when THIS pane's own page names it (plane-page.js); .cjs never.
    const script = file && typeFor(file, PAGE_SCRIPT_TYPES);
    if (script) {
      return paneLoadsScript(pane, file, electronDir, readText)
        ? { type: "file", file, contentType: script }
        : { type: "missing", status: 403, reason: `${pane.file} does not load ${path.basename(file)}` };
    }
    const contentType = file && typeFor(file, ELECTRON_ASSET_TYPES);
    if (!file || !contentType) return { type: "missing", status: 403, reason: "not an Aither page asset" };
    // A pane's origin serves ITS page and shared assets -- never another page, which
    // would run under this pane's preload (aither://settings/command.html).
    if (contentType.startsWith("text/html") && path.basename(file) !== pane.file) {
      return { type: "missing", status: 403, reason: `aither://${pane.id} serves only ${pane.file}` };
    }
    return { type: "file", file, contentType };
  }

  if (pane.kind === "view" && rel.startsWith(MODEL_PREFIX)) {
    // A roster character's model, for the deck's thumbnails (internalModelUrls).
    const name = modelNameOf(rel);
    let file;
    try {
      file = name && typeof modelFile === "function" ? modelFile(name) : null;
    } catch {
      file = null;
    }
    const found = file ? String(file) : "";
    const contentType = found && path.isAbsolute(found) && typeFor(found, MODEL_TYPES);
    if (!contentType) return { type: "missing", status: 404, reason: "no such character model" };
    return { type: "file", file: found, contentType };
  }

  if (pane.kind === "view") {
    const base = String((typeof rendererUrl === "function" ? rendererUrl() : rendererUrl) || "");
    if (!base) return { type: "missing", status: 503, reason: "the renderer bundle is not resolved" };
    let baseUrl;
    try {
      baseUrl = new URL(base);
    } catch {
      return { type: "missing", status: 503, reason: "the renderer URL is not a URL" };
    }
    if (baseUrl.protocol === "file:") {
      const indexFile = fileURLToPath(baseUrl);
      const dist = path.dirname(indexFile);
      const file = rel ? safeJoin(dist, rel) : indexFile;
      const contentType = file && typeFor(file, BUNDLE_ASSET_TYPES);
      if (!file || !contentType) return { type: "missing", status: 403, reason: "not a bundle asset" };
      return { type: "file", file, contentType };
    }
    // The dev server (VITE_DEV_SERVER_URL): loopback only, the same path and query.
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname);
    if (baseUrl.protocol !== "http:" || !loopback) {
      return { type: "missing", status: 403, reason: "the renderer dev server must be loopback http" };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\\]/.test(rel) || rel.split("/").includes("..")) {
      return { type: "missing", status: 403, reason: "not a bundle path" };
    }
    return { type: "proxy", url: `${baseUrl.origin}${rel || "/"}${parsed.search}` };
  }

  return { type: "missing", status: 404, reason: `pane ${pane.id} has no page` };
}

/**
 * The pane pages carry a meta CSP written for file:// (`style-src ... file:`), so
 * served from aither:// their shared stylesheet would be refused. Every directive
 * that trusts `file:` also trusts 'self' -- the page's own aither://<pane> origin
 * -- and nothing else is widened. Generic, so a new pane's copied CSP works too.
 */
function adaptHtml(html) {
  // The policy is double-quoted (its sources are single-quoted: 'none', 'self').
  return String(html).replace(
    /(<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=")([^"]*)(")/gi,
    (_m, head, policy, tail) => head + policy.split(";").map((directive) => {
      const tokens = directive.trim().split(/\s+/);
      if (tokens.includes("file:") && !tokens.includes("'self'")) {
        return ` ${tokens[0]} 'self' ${tokens.slice(1).join(" ")}`.replace(/\s+$/, "");
      }
      return directive;
    }).join(";") + tail,
  );
}

function respond(body, status, headers = {}) {
  return new Response(body, { status, headers: { ...headers, ...SECURITY_HEADERS } });
}

/**
 * Install the aither:// handler on `ses` -- and only ever call this with the
 * INTERNAL_PARTITION session. `readFile` and `fetch` are injected for the tests.
 */
function installInternalProtocol(ses, {
  panes = null, rendererUrl = "", hostedUrl = null, electronDir = ELECTRON_DIR, modelFile = null,
  readFile = (file) => fs.promises.readFile(file), fetch = null,
} = {}) {
  if (!ses || !ses.protocol || typeof ses.protocol.handle !== "function") {
    throw new Error("installInternalProtocol needs a session");
  }
  if (typeof ses.protocol.isProtocolHandled === "function" && ses.protocol.isProtocolHandled(SCHEME)) {
    return false;
  }
  const handler = async (request) => {
    const route = resolveRequest(request.url, {
      panes: panes || consolePanes(), rendererUrl, hostedUrl, electronDir, modelFile,
    });
    if (route.type === "file") {
      try {
        const bytes = await readFile(route.file);
        const body = route.contentType.startsWith("text/html") ? adaptHtml(bytes.toString("utf8")) : bytes;
        return respond(body, 200, { "content-type": route.contentType });
      } catch {
        return respond("This Aither page is missing from the install.", 404, { "content-type": "text/plain" });
      }
    }
    if (route.type === "proxy") {
      const get = fetch || require("electron").net.fetch;
      try {
        const upstream = await get(route.url);
        const type = upstream.headers.get("content-type") || "application/octet-stream";
        const bytes = Buffer.from(await upstream.arrayBuffer());
        return respond(type.startsWith("text/html") ? adaptHtml(bytes.toString("utf8")) : bytes,
          upstream.status, { "content-type": type });
      } catch (error) {
        return respond(`The renderer dev server did not answer: ${(error && error.message) || error}`, 502,
          { "content-type": "text/plain" });
      }
    }
    if (route.type === "hosted") {
      // Opened as a hosted TAB by the browser (its own partition); a request that
      // still reaches here is answered with a link, never a silent blank.
      return respond(`AitherOS Online opens in its own tab: ${route.url}`, 409, { "content-type": "text/plain" });
    }
    return respond(route.reason, route.status, { "content-type": "text/plain" });
  };
  ses.protocol.handle(SCHEME, handler);
  return true;
}

/**
 * Before app ready, once: aither:// is a standard, secure origin (so relative URLs,
 * localStorage and 'self' work per pane) that supports fetch. It is NOT
 * CORS-enabled and NOT bypassing CSP: a web origin gets nothing from it.
 */
const PRIVILEGED_SCHEME = Object.freeze({
  scheme: SCHEME,
  privileges: Object.freeze({ standard: true, secure: true, supportFetchAPI: true, stream: true }),
});

function registerPrivilegedScheme(protocol) {
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== "function") return false;
  protocol.registerSchemesAsPrivileged([{ scheme: PRIVILEGED_SCHEME.scheme, privileges: { ...PRIVILEGED_SCHEME.privileges } }]);
  return true;
}

/** Hosts a hosted (signed-in) tab may stay on: the aitherium.com family. */
function isHostedSite(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "aitherium.com" || host.endsWith(".aitherium.com");
  } catch {
    return false;
  }
}

function schemeOf(url) {
  try {
    return new URL(String(url || "")).protocol;
  } catch {
    return "";
  }
}

/**
 * May a tab of `tabKind` navigate (or frame, when `frame` is set) to `url`?
 *
 *   "allow"    load it in this tab
 *   "web-tab"  not here -- open it in a new WEB tab of the owner's
 *   "deny"     refuse it
 *
 * A web or hosted tab NEVER reaches aither:// -- a page cannot open the console's
 * IPC by linking to it. An internal tab never shows web content: it runs with the
 * pane's preload, so a web page in it would sit beside the desk's bridges.
 */
function navigationVerdict(tabKind, url, { frame = false } = {}) {
  const scheme = schemeOf(url);
  const web = scheme === "http:" || scheme === "https:";
  if (tabKind === "internal") {
    if (scheme === PROTOCOL && isInternalUrl(url)) return "allow";
    if (frame) return scheme === "about:" || scheme === "data:" ? "allow" : "deny";
    return web ? "web-tab" : "deny";
  }
  if (scheme === PROTOCOL || scheme === "file:") return "deny";
  if (frame) return "allow";
  if (tabKind === "hosted") {
    if (isHostedSite(url)) return "allow";
    return web ? "web-tab" : "deny";
  }
  return web ? "allow" : "deny";
}

/**
 * What a tab built for this target looks like: its kind, partition and preload.
 * Web content NEVER gets a preload and is always sandboxed; an internal page is
 * not sandboxed only so its preload can require the pane's real preload (the same
 * trade the console makes, console-window.cjs), with contextIsolation on and
 * nodeIntegration off.
 */
function tabPreferences(kind, { webPartition, hostedPartition = null } = {}) {
  if (kind === "internal") {
    return {
      partition: INTERNAL_PARTITION,
      preload: path.join(ELECTRON_DIR, INTERNAL_PRELOAD),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    };
  }
  return {
    partition: kind === "hosted" && hostedPartition ? hostedPartition : webPartition,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

/**
 * The pinned AitherOS Online tab (pane "desktop", hosted) is a DESK HOST: it gets the
 * overlay window's preload (living-desktop-preload.cjs), so desk state, the page plane
 * over the agent's tab and desk commands reach Online in the browser as they reach the
 * overlay (owner, 2026-10-04: "full context experience"). living-desktop-window fences
 * every one of those channels to this tab's webContents. Nothing else gets a preload.
 */
const DESK_HOST_PRELOAD = "living-desktop-preload.cjs";
function withDeskHost(kind, paneId, prefs) {
  if (kind !== "hosted" || paneId !== "desktop") return prefs;
  return { ...prefs, preload: path.join(ELECTRON_DIR, DESK_HOST_PRELOAD) };
}

/**
 * The pinned tabs every console door opens to: the Inbox, AitherOS Online and the
 * Workspace. Online and Workspace share the hosted pane's signed-in partition.
 */
function pinnedTabs({ panes = consolePanes(), workspaceUrl = null } = {}) {
  const hosted = panes.find((pane) => pane && pane.kind === "hosted") || null;
  const inbox = paneById("cards", panes);
  const out = [];
  if (inbox) out.push({ key: "inbox", label: inbox.label || "Inbox", url: internalUrl(inbox, null, panes) });
  if (hosted) {
    out.push({ key: "online", label: hosted.label || "AitherOS Online", url: internalUrl(hosted, null, panes) });
  }
  const workspace = String(workspaceUrl || process.env.DESK_BROWSER_WORKSPACE_URL || "https://app.aitherium.com/workspace");
  if (isHostedSite(workspace)) {
    out.push({ key: "workspace", label: "Workspace", url: workspace,
      hostedPartition: hosted ? hosted.partition || null : null });
  }
  return out;
}

/** Address-bar suggestions for the internal pages: "aither", a pane id or its label. */
function suggestInternal(text, panes = consolePanes(), limit = 8) {
  const q = String(text || "").trim().toLowerCase();
  if (!q) return [];
  const bare = q.replace(/^aither:\/*/, "");
  const all = !bare || (q.length >= 2 && "aither".startsWith(q));
  return internalPages(panes)
    .filter((page) => all || page.id.includes(bare) || page.label.toLowerCase().includes(bare))
    .slice(0, limit)
    .map((page) => ({ url: page.url, title: `Aither · ${page.label}`, kind: "aither" }));
}

/**
 * Where the pinned "AitherOS Online" tab (the hosted pane) goes: app.aitherium.com,
 * the one page host. DESK_ONLINE_URL overrides it, but only to an aitherium.com page.
 */
function onlineUrl(env = process.env) {
  const wanted = String((env && env.DESK_ONLINE_URL) || "");
  return isHostedSite(wanted) ? wanted : DEFAULT_HOSTED_URL;
}

/** DESK_LEGACY_CONSOLE=1 brings back the old console window (rollback). */
function legacyConsole(env = process.env) {
  return String((env && env.DESK_LEGACY_CONSOLE) || "") === "1";
}

module.exports = {
  BUNDLE_ASSET_TYPES,
  DEFAULT_HOSTED_URL,
  ELECTRON_ASSET_TYPES,
  INTERNAL_PARTITION,
  INTERNAL_PERMISSIONS,
  INTERNAL_PRELOAD,
  MODEL_PREFIX,
  PAGE_SCRIPT_TYPES,
  PRELOAD_BY_FILE,
  PRELOAD_BY_PATTERN,
  PRIVILEGED_SCHEME,
  PROTOCOL,
  SCHEME,
  SECURITY_HEADERS,
  VIEW_PRELOAD,
  adaptHtml,
  allowInternalPermission,
  installInternalPermissions,
  installInternalProtocol,
  internalModelUrls,
  internalPages,
  internalUrl,
  isHostedSite,
  isInternalUrl,
  legacyConsole,
  modelNameOf,
  navigationVerdict,
  onlineUrl,
  paneById,
  parseInternalUrl,
  pinnedTabs,
  preloadFor,
  preloadForUrl,
  registerPrivilegedScheme,
  resolveRequest,
  safeJoin,
  scriptSources,
  suggestInternal,
  tabPreferences,
  withDeskHost,
};
