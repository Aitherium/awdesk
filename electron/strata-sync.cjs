"use strict";

/**
 * strata-sync.cjs -- the ONE way the desk pushes a local file into the owner's
 * AitherOS Online folders (owner 2026-11-01: "a snip or a copy on the desktop must
 * show up in AitherOS Online"). Used by the snipping tool (folder `screenshots`)
 * and clipboard sync (folder `clipboard`); the Veil clipboard app lists both.
 *
 * The wire (Veil src/app/api/strata/upload/route.ts):
 *   POST {origin}/api/strata/upload   multipart: file, folder
 *   Authorization: Bearer <the user's aitherium token from ~/.aither/auth.json>
 * The route takes the tenant from the VERIFIED session only (lib/strata-scope.ts)
 * and writes hot/{tenant}/{folder}/{name}. So this module never names a tenant or a
 * user: there is no field to send, and a caller cannot write into anybody else's
 * folder by construction. List: GET {origin}/api/strata/files?folder=<folder>.
 *
 * The origin is the desk's page host (browser-internal.cjs onlineUrl(), i.e.
 * app.aitherium.com, DESK_ONLINE_URL-overridable) unless AWDESK_SYNC_ORIGIN names
 * another. An override must be https, or http on loopback only -- the bearer is
 * never sent in clear text across a network.
 *
 * THE QUEUE never blocks the caller. enqueue() copies the payload into a spool
 * directory (so a capture survives a desk restart and a later edit of the source
 * file), answers at once, and a single drain loop uploads one job at a time with
 * exponential backoff. Signed out / offline / 5xx / 401 retry later; a 4xx the
 * server will never accept (400 bad name, 413 too big) is dropped and reported.
 *
 * Electron-free: fetch, fs, timers and the token reader are injected, so
 * strata-sync.test.cjs runs it against a real local HTTP server under node --test.
 * Same degradation contract as every desk client: {ok:false, reason}, never throws.
 * The token is read per attempt and NEVER logged, returned or put in a reason.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const FOLDERS = Object.freeze(["screenshots", "clipboard"]);
const UPLOAD_PATH = "/api/strata/upload";
const LIST_PATH = "/api/strata/files";
const UPLOAD_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;
/** A spool bigger than this drops its OLDEST jobs: a week offline must not fill a disk. */
const SPOOL_MAX_JOBS = 500;
/** Statuses that will never succeed by retrying the same bytes. */
const PERMANENT = new Set([400, 404, 409, 413, 415, 422]);

function isLoopback(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * The upload origin: AWDESK_SYNC_ORIGIN when it is safe to carry a bearer, else
 * the desk's page host. Returns {origin, from}; never throws.
 *
 * @param {{env?: object, onlineUrl?: () => string}} [opts]
 */
function syncOrigin({ env = process.env, onlineUrl } = {}) {
  const wanted = String((env && env.AWDESK_SYNC_ORIGIN) || "").trim();
  if (wanted) {
    try {
      const u = new URL(wanted);
      if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname))) {
        return { origin: u.origin, from: "env.AWDESK_SYNC_ORIGIN" };
      }
    } catch { /* unparseable: fall through to the page host */ }
  }
  let page = "https://app.aitherium.com/";
  try {
    page = (onlineUrl || require("./browser-internal.cjs").onlineUrl)();
  } catch { /* resolver unavailable: the documented default */ }
  try {
    return { origin: new URL(page).origin, from: "onlineUrl" };
  } catch {
    return { origin: "https://app.aitherium.com", from: "builtin" };
  }
}

/** The bearer for uploads: the user's own login (desk-session.cjs). Null when signed out. */
function defaultToken() {
  try {
    const picked = require("./desk-session.cjs").readAuthStoreToken();
    if (!picked) return null;
    return typeof picked === "string" ? picked : (picked.token || null);
  } catch {
    return null;
  }
}

/**
 * ONE upload attempt. Resolves {ok:true, status, data} | {ok:false, status, reason,
 * permanent}. Never rejects; the reason never contains the token.
 *
 * @param {{origin: string, folder: string, name: string, bytes: Buffer,
 *          contentType?: string, token: string|null, fetchImpl?: Function,
 *          timeoutMs?: number}} args
 */
async function uploadOnce({ origin, folder, name, bytes, contentType = "application/octet-stream",
  token, fetchImpl = globalThis.fetch, timeoutMs = UPLOAD_TIMEOUT_MS }) {
  if (!FOLDERS.includes(folder)) return { ok: false, status: 0, reason: `unknown folder ${folder}`, permanent: true };
  if (!token) return { ok: false, status: 0, reason: "not signed in -- sign in to Aither to sync", permanent: false };
  if (typeof fetchImpl !== "function") return { ok: false, status: 0, reason: "no fetch available", permanent: false };
  const form = new FormData();
  form.append("folder", folder);
  form.append("file", new Blob([bytes], { type: contentType }), name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}${UPLOAD_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: controller.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.ok && (!data || data.success !== false)) return { ok: true, status: res.status, data };
    const said = data && typeof data.error === "string" ? data.error.slice(0, 200) : `HTTP ${res.status}`;
    return { ok: false, status: res.status, reason: said, permanent: PERMANENT.has(res.status) };
  } catch (error) {
    const reason = error && error.name === "AbortError" ? "upload timed out" : String((error && error.message) || error).slice(0, 200);
    return { ok: false, status: 0, reason, permanent: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The listing Veil's clipboard app reads. {ok, files} | {ok:false, reason}.
 */
async function listFolder({ origin, folder, token, fetchImpl = globalThis.fetch }) {
  if (!FOLDERS.includes(folder)) return { ok: false, reason: `unknown folder ${folder}` };
  if (!token) return { ok: false, reason: "not signed in" };
  try {
    const res = await fetchImpl(`${origin}${LIST_PATH}?folder=${encodeURIComponent(folder)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: (data && data.error) || `HTTP ${res.status}` };
    return { ok: true, files: (data && (data.files || data.items)) || [] };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 200) };
  }
}

function backoffMs(attempts, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS) {
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

/**
 * The durable upload queue.
 *
 * @param {object} opts
 * @param {string} [opts.spoolDir]   where jobs wait (default ~/.aither/desk-sync-spool)
 * @param {Function} [opts.upload]   (job + bytes) => uploadOnce verdict (test seam)
 * @param {Function} [opts.token]    () => bearer|null, read per attempt
 * @param {Function} [opts.origin]   () => origin string, read per attempt
 * @param {Function} [opts.now]
 * @param {Function} [opts.schedule] (fn, ms) => handle; [opts.cancel] (handle) => void
 * @param {Function} [opts.onEvent]  ({type, job, verdict}) for the toast / logs
 */
function createUploadQueue({
  spoolDir = path.join(os.homedir(), ".aither", "desk-sync-spool"),
  upload,
  token = defaultToken,
  origin = () => syncOrigin().origin,
  now = Date.now,
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  cancel = (t) => clearTimeout(t),
  onEvent = () => {},
  fsImpl = fs,
  baseMs = BACKOFF_BASE_MS,
  maxMs = BACKOFF_MAX_MS,
} = {}) {
  const send = upload || ((job, bytes) => uploadOnce({
    origin: origin(), folder: job.folder, name: job.name, bytes, contentType: job.contentType, token: token(),
  }));
  let jobs = [];
  let timer = null;
  let draining = null;
  let loaded = false;

  function metaPath(id) { return path.join(spoolDir, `${id}.json`); }
  function dataPath(id) { return path.join(spoolDir, `${id}.bin`); }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      for (const entry of fsImpl.readdirSync(spoolDir)) {
        if (!entry.endsWith(".json")) continue;
        try {
          const job = JSON.parse(fsImpl.readFileSync(path.join(spoolDir, entry), "utf8"));
          if (job && job.id && FOLDERS.includes(job.folder) && fsImpl.existsSync(dataPath(job.id))) jobs.push(job);
        } catch { /* a torn meta file is skipped, its payload swept below */ }
      }
    } catch { /* no spool yet */ }
    jobs.sort((a, b) => a.createdAt - b.createdAt);
  }

  function remove(job) {
    for (const p of [metaPath(job.id), dataPath(job.id)]) {
      try { fsImpl.unlinkSync(p); } catch { /* already gone */ }
    }
    jobs = jobs.filter((j) => j.id !== job.id);
  }

  function persist(job) {
    try {
      fsImpl.writeFileSync(metaPath(job.id), JSON.stringify(job));
    } catch { /* the job still lives in memory for this run */ }
  }

  function arm() {
    if (timer) { cancel(timer); timer = null; }
    if (!jobs.length) return;
    const due = Math.max(0, Math.min(...jobs.map((j) => j.nextAt)) - now());
    timer = schedule(() => { timer = null; void drain(); }, due);
  }

  async function drainOnce() {
    for (const job of [...jobs].sort((a, b) => a.createdAt - b.createdAt)) {
      if (job.nextAt > now()) continue;
      let bytes;
      try {
        bytes = fsImpl.readFileSync(dataPath(job.id));
      } catch {
        remove(job);
        onEvent({ type: "dropped", job, verdict: { ok: false, reason: "spooled payload vanished" } });
        continue;
      }
      let verdict;
      try {
        verdict = await send(job, bytes);
      } catch (error) {
        verdict = { ok: false, reason: String((error && error.message) || error), permanent: false };
      }
      if (verdict && verdict.ok) {
        remove(job);
        onEvent({ type: "uploaded", job, verdict });
      } else if (verdict && verdict.permanent) {
        remove(job);
        onEvent({ type: "dropped", job, verdict });
      } else {
        job.attempts += 1;
        job.lastReason = String((verdict && verdict.reason) || "failed");
        job.nextAt = now() + backoffMs(job.attempts, baseMs, maxMs);
        persist(job);
        onEvent({ type: "retry", job, verdict });
      }
    }
  }

  function drain() {
    if (!draining) {
      draining = drainOnce().finally(() => { draining = null; arm(); });
    }
    return draining;
  }

  /**
   * Queue one file. Returns {ok, id} at once (the upload happens later), or
   * {ok:false, reason} when it could not even be spooled.
   *
   * @param {{folder: string, name: string, bytes?: Buffer, filePath?: string, contentType?: string}} item
   */
  function enqueue({ folder, name, bytes, filePath, contentType = "application/octet-stream" }) {
    try {
      load();
      if (!FOLDERS.includes(folder)) return { ok: false, reason: `unknown folder ${folder}` };
      if (!name) return { ok: false, reason: "no file name" };
      const payload = bytes || fsImpl.readFileSync(filePath);
      fsImpl.mkdirSync(spoolDir, { recursive: true });
      const id = `${now()}-${nodeCrypto.randomBytes(4).toString("hex")}`;
      const job = { id, folder, name: String(name), contentType, createdAt: now(), nextAt: now(), attempts: 0, lastReason: null };
      fsImpl.writeFileSync(dataPath(id), payload);
      persist(job);
      jobs.push(job);
      while (jobs.length > SPOOL_MAX_JOBS) {
        const oldest = jobs[0];
        remove(oldest);
        onEvent({ type: "dropped", job: oldest, verdict: { ok: false, reason: "spool full" } });
      }
      void drain();
      return { ok: true, id };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error).slice(0, 200) };
    }
  }

  /** Resume spooled jobs from a previous run and try them now. */
  function start() {
    load();
    for (const job of jobs) job.nextAt = Math.min(job.nextAt, now());
    void drain();
  }

  function pending() {
    load();
    return jobs.map(({ id, folder, name, attempts, lastReason }) => ({ id, folder, name, attempts, lastReason }));
  }

  function stop() {
    if (timer) { cancel(timer); timer = null; }
  }

  return { enqueue, start, stop, drain, pending };
}

module.exports = {
  FOLDERS, UPLOAD_PATH, LIST_PATH, BACKOFF_BASE_MS, BACKOFF_MAX_MS, SPOOL_MAX_JOBS,
  syncOrigin, uploadOnce, listFolder, backoffMs, createUploadQueue, defaultToken, isLoopback,
};
