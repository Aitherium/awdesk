"use strict";

/**
 * upload-notices.cjs -- tell the person at the desk what their big workspace upload is
 * doing, without them watching a browser tab.
 *
 * Measured 2026-10-22: a 6.6 GB zip paused at piece 101 of 199 and nothing on the desktop
 * said so. The workspace answers GET /api/documents/uploads with the caller's own
 * in-flight uploads (uploading with bytes received and idle seconds, processing with the
 * step it is on, or failed with a plain reason), scoped to the signed-in session. This
 * loop reads it with the Aither Browser's cookie jar (the same session the person signed
 * in with on the workspace page) and shows ONE native notice per upload per state:
 *
 *   paused  -- uploading and idle past PAUSED_AFTER_S, with pieces still missing
 *   ready   -- a row we saw processing is gone from the list (finished jobs drop out)
 *   failed  -- the row says failed; the reason is the server's own sentence
 *
 * Cadence: a slow discovery read (DISCOVER_MS) while nothing is in flight; ACTIVE_MS
 * while an upload is listed and for RECENT_MS after the last one left the list. A 404
 * (a workspace image without the route) backs off to MISSING_MS; no session (401/403,
 * a redirect, a non-JSON answer) or no workspace host is silence -- never a notice,
 * never an error line per poll.
 *
 * Throttle: a notice key (`<upload id>:<state>`) is remembered in `store` (a small JSON
 * file in userData) for KEEP_MS, so a Desk restart does not repeat what it already said.
 *
 * Electron-free: every edge is injected, so upload-notices.test.cjs runs it under
 * `node --test`.
 */

const ROUTE = "/api/documents/uploads";
const PAUSED_AFTER_S = 120;
const ACTIVE_MS = 30_000;
const DISCOVER_MS = 5 * 60_000;
const RECENT_MS = 10 * 60_000;
const MISSING_MS = 60 * 60_000;
const ERROR_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** How long a shown notice is remembered (a failed row stays listed 24 h server-side). */
const KEEP_MS = 48 * 60 * 60_000;
const MAX_NAME = 80;

/** A file name fit for one notification line: no control characters, bounded. */
function cleanName(raw) {
  // eslint-disable-next-line no-control-regex
  const text = String(raw || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return "your file";
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text;
}

/** Whole percent received, never 100 while pieces are missing. */
function percentOf(row) {
  const size = Number(row.size) || 0;
  const got = Number(row.received_bytes) || 0;
  if (size <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor((got / size) * 100)));
}

/** The exact notice copy. `app` = the workspace's display name. */
const COPY = Object.freeze({
  paused: (file, pct, app) => ({
    title: "Upload paused",
    body: `Your upload of ${file} paused at ${pct}%. Open ${app} and drop the same file to resume.`,
  }),
  ready: (file, n) => ({
    title: "Upload finished",
    body: n > 0
      ? `${file} is ready. ${n} ${n === 1 ? "file" : "files"} added to Documents.`
      : `${file} is ready. It's in Documents now.`,
  }),
  failed: (file, reason) => ({
    title: "Upload failed",
    body: `${file} could not be added. ${String(reason || "").trim() || "Upload it again."}`,
  }),
});

/** A getter's answer as trimmed text; a throwing getter is "". */
function safeText(fn) {
  try { return String(fn() || "").trim(); } catch { return ""; }
}

function keyOf(row) {
  return String(row.upload_id || row.id || "");
}

/**
 * Decide the notices one poll's rows earn. Pure: no I/O, no clock but `now`.
 * @param {Map<string, object>} prev  key -> the row seen last poll
 * @param {object[]} rows             this poll's rows
 * @param {(key: string) => boolean} already  true when that notice was shown before
 * @param {string} app                 the workspace's display name
 * @returns {{notices: {key: string, title: string, body: string}[], seen: Map<string, object>}}
 */
function decide(prev, rows, already, app) {
  const notices = [];
  const seen = new Map();
  const say = (key, note) => {
    if (already(key)) return;
    notices.push({ key, ...note });
  };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = keyOf(row);
    if (!id) continue;
    seen.set(id, row);
    const file = cleanName(row.filename);
    if (row.state === "uploading") {
      const missing = Number(row.received_chunks) < Number(row.total_chunks);
      if (missing && Number(row.idle_seconds) > PAUSED_AFTER_S) {
        say(`${id}:paused`, COPY.paused(file, percentOf(row), app));
      }
    } else if (row.state === "failed") {
      say(`${id}:failed`, COPY.failed(file, row.detail));
    }
  }
  // Finished jobs leave the list: a row last seen PROCESSING that is gone is ready.
  // (An uploading row that disappears was abandoned or expired; say nothing.)
  for (const [id, row] of prev) {
    if (seen.has(id) || row.state !== "processing") continue;
    const n = Number(row.total_files) || Number(row.processed_files) || 0;
    say(`${id}:ready`, COPY.ready(cleanName(row.filename), n));
  }
  return { notices, seen };
}

/**
 * @param {object} deps
 * @param {() => string} deps.origin       the workspace origin (https://host/), "" when none
 * @param {() => string} [deps.appName]    the workspace's display name
 * @param {(url: string, init: object) => Promise<Response>} deps.fetchImpl  cookie-carrying fetch
 * @param {(title: string, body: string, onClick: () => void) => void} deps.notify
 * @param {(url: string) => void} deps.open  where a click goes
 * @param {{load(): object, save(obj: object): void}} [deps.store]  remembered notices
 * @param {() => number} [deps.now]
 * @param {(fn: Function, ms: number) => unknown} [deps.schedule]
 * @param {(line: string) => void} [deps.log]
 */
function createUploadNotices({ origin, appName = () => "", fetchImpl, notify, open,
  store = null, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms),
  log = () => {} } = {}) {
  let prev = new Map();
  let lastActiveAt = 0;
  let missingLogged = false;
  let running = false;
  let stopped = false;
  let shown = {};
  try { shown = (store && store.load()) || {}; } catch { shown = {}; }
  if (!shown || typeof shown !== "object") shown = {};

  function prune(t) {
    for (const [k, at] of Object.entries(shown)) {
      if (!(Number(at) > t - KEEP_MS)) delete shown[k];
    }
  }

  function remember(key, t) {
    shown[key] = t;
    try { if (store) store.save(shown); } catch { /* a lost write only risks one repeat */ }
  }

  function idleDelay(t) {
    return t - lastActiveAt < RECENT_MS ? ACTIVE_MS : DISCOVER_MS;
  }

  /** One poll. Returns the delay (ms) before the next one. Never throws. */
  async function tick() {
    const t = now();
    const raw = safeText(origin);
    if (!/^https:\/\/[^/]+\/?$/.test(raw)) { prev = new Map(); return DISCOVER_MS; }
    const base = raw.replace(/\/$/, "");
    let res;
    try {
      res = await fetchImpl(`${base}${ROUTE}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return ERROR_MS; // offline: keep what we saw, try again later
    }
    const status = res ? Number(res.status) : 0;
    if (status === 404) {
      if (!missingLogged) { missingLogged = true; log("upload notices: this workspace has no upload list yet"); }
      prev = new Map();
      return MISSING_MS;
    }
    missingLogged = false;
    if (!res || !res.ok) {
      // Signed out (401/403 or a redirect to sign-in): silence. Forget the in-flight
      // rows so a sign-in hours later does not read a vanished row as "ready".
      if (status === 401 || status === 403 || (status >= 300 && status < 400) || status === 0) prev = new Map();
      return status >= 500 ? ERROR_MS : DISCOVER_MS;
    }
    let data;
    try { data = await res.json(); } catch { prev = new Map(); return DISCOVER_MS; }
    if (!data || !Array.isArray(data.uploads)) { prev = new Map(); return DISCOVER_MS; }

    prune(t);
    const app = safeText(appName);
    const result = decide(prev, data.uploads, (k) => k in shown, app || "your workspace");
    prev = result.seen;
    if (result.seen.size > 0 || result.notices.length > 0) lastActiveAt = t;
    const target = `${base}/`;
    for (const note of result.notices) {
      remember(note.key, t);
      try { notify(note.title, note.body, () => open(target)); } catch { /* no notification surface */ }
    }
    return result.seen.size > 0 ? ACTIVE_MS : idleDelay(t);
  }

  function loop() {
    if (stopped) { running = false; return; }
    void tick().catch(() => DISCOVER_MS).then((delay) => schedule(loop, delay || ACTIVE_MS));
  }

  return {
    start() { if (!running) { running = true; stopped = false; loop(); } return this; },
    stop() { stopped = true; },
    tick,
    shown: () => ({ ...shown }),
  };
}

/** A JSON-file store for the remembered notices (`fsImpl` injected for tests). */
function fileStore(file, fsImpl = require("node:fs")) {
  return {
    load() {
      try { return JSON.parse(fsImpl.readFileSync(file, "utf8")); } catch { return {}; }
    },
    save(obj) {
      try { fsImpl.writeFileSync(file, JSON.stringify(obj)); } catch { /* best effort */ }
    },
  };
}

module.exports = {
  ROUTE, PAUSED_AFTER_S, ACTIVE_MS, DISCOVER_MS, RECENT_MS, MISSING_MS, ERROR_MS, KEEP_MS,
  COPY, cleanName, percentOf, decide, createUploadNotices, fileStore,
};
