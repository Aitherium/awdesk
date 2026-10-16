"use strict";

/** Desk tenant mode: which aitherium host this Desk belongs to.
 *
 *  Desk is a PUBLIC build: no customer name or host is ever compiled in. A tenant
 *  install writes ~/.aither/desk-tenant.json at install time
 *    { "host": "<label>.aitherium.com", "name": "...", "accent": "#rrggbb",
 *      "icon_url": "https://...", "allowed_hosts": ["exact.custom.host"] }
 *  or hands the host over once as `--tenant-host=<host>` (first run; persisted to that
 *  file) or `AITHER_DESK_TENANT_HOST`. Precedence: argv > env > file.
 *
 *  Host validation is strict and fail-to-apex: https only, a single DNS label under
 *  aitherium.com, or an exact host listed in the config file's `allowed_hosts`. No
 *  port, path, query, userinfo or IP literal. Anything else logs a warning and the
 *  Desk behaves exactly as it does with no tenant config (the apex).
 *
 *  No tenant config -> resolveTenant() returns { tenant: null } and every helper
 *  returns the apex value it was given, so behaviour is unchanged.
 *
 *  Trust split: an `allowed_hosts` (non-aitherium) host is NOT first-party. It may be the
 *  Aither Browser home and the tray "Open workspace" target, but never the Living Desktop
 *  overlay base -- the overlay webContents holds the privileged desk IPC planes (host
 *  bearer, daemon relay, host-page). overlayBaseUrl() enforces that. `allowed_hosts` only
 *  authorises the FILE's own host; argv/env may only name a single aitherium.com label.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APEX_HOST = "aitherium.com";
const APEX_URL = `https://${APEX_HOST}/`;
const ARG_PREFIX = "--tenant-host=";
const ENV_KEY = "AITHER_DESK_TENANT_HOST";
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const ACCENT_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const MAX_NAME = 64;
const MAX_FILE_BYTES = 64 * 1024;
/** `source` of a desk-tenant.json written by sign-in discovery (never by a person). */
const AUTO_SOURCE = "sign-in";
const TENANT_ID_RE = /^[a-z0-9_]{1,80}$/;

function configPath(homedir = os.homedir()) {
  return path.join(homedir, ".aither", "desk-tenant.json");
}

/** Normalise one host candidate to a bare lowercase hostname, or null.
 *  Accepts `host` or `https://host` / `https://host/`; nothing else. */
function normaliseHost(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text || text.length > 300) return null;
  if (/[\s\\@?#%]/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (!/^https:\/\//i.test(text)) return null; // http:, javascript:, file:, ...
    text = text.slice("https://".length);
    if (text.endsWith("/")) text = text.slice(0, -1);
  }
  if (text.includes("/") || text.includes(":")) return null; // path or port
  text = text.toLowerCase();
  if (text.endsWith(".")) return null;
  if (!HOSTNAME_RE.test(text)) return null; // also rejects IPv4 literals (TLD must start with a letter)
  return text;
}

/** {ok, host} | {ok:false, reason}. `allowedHosts` = exact hosts from the config FILE. */
/** True for the apex or a single label under it (the overlay's first-party family). */
function isFirstPartyHost(host) {
  if (typeof host !== "string") return false;
  if (host === APEX_HOST) return true;
  const suffix = `.${APEX_HOST}`;
  return host.endsWith(suffix) && LABEL_RE.test(host.slice(0, -suffix.length));
}

/** An allowed_hosts entry may not impersonate the brand: any label equal to (or containing)
 *  "aitherium" outside the real aitherium.com family is refused (aitherium.com.evil.io). */
function isApexLookalike(host) {
  return host.split(".").some((label) => label.includes("aitherium"));
}

function validateHost(raw, allowedHosts = []) {
  const host = normaliseHost(raw);
  if (!host) return { ok: false, reason: "not a bare https hostname" };
  const suffix = `.${APEX_HOST}`;
  if (host.endsWith(suffix)) {
    if (isFirstPartyHost(host)) return { ok: true, host, firstParty: true };
    return { ok: false, reason: `only a single label under ${APEX_HOST} is accepted` };
  }
  if (isApexLookalike(host)) return { ok: false, reason: `looks like ${APEX_HOST} but is not under it` };
  const allowed = (Array.isArray(allowedHosts) ? allowedHosts : [])
    .map(normaliseHost).filter((h) => h && !isApexLookalike(h));
  if (allowed.includes(host)) return { ok: true, host, firstParty: false };
  return { ok: false, reason: `not under ${APEX_HOST} and not in allowed_hosts` };
}

/** Log-safe preview of an untrusted value; never throws (no String() on hostile objects). */
function preview(raw) {
  if (typeof raw === "string") return JSON.stringify(raw.slice(0, 80));
  if (raw === null) return "null";
  return `<${Array.isArray(raw) ? "array" : typeof raw}>`;
}

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return text ? text.slice(0, MAX_NAME) : null;
}

function cleanIconUrl(raw, host, allowedHosts) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === host || hostname === APEX_HOST || validateHost(hostname, allowedHosts).ok) return url.href;
  } catch { /* fall through */ }
  return null;
}

/** Read the config file. {data} | {missing:true} | {error}. Never throws. */
function readConfigFile(file, readFile = fs.readFileSync) {
  let text;
  try {
    text = readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { missing: true };
    return { error: `unreadable (${err && err.code ? err.code : "error"})` };
  }
  if (typeof text !== "string" || text.length > MAX_FILE_BYTES) return { error: "too large or not text" };
  try {
    const data = JSON.parse(text.replace(/^﻿/, ""));
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "not a JSON object" };
    return { data };
  } catch {
    return { error: "malformed JSON" };
  }
}

function argHost(argv) {
  for (const value of Array.isArray(argv) ? argv : []) {
    if (typeof value === "string" && value.startsWith(ARG_PREFIX)) return value.slice(ARG_PREFIX.length);
  }
  return null;
}

/** Resolve the tenant. Pure apart from the injected reader.
 *  Returns { tenant: {host,name,accent,iconUrl,source,origin} | null, warnings: string[],
 *            argHost: <validated host from argv or null> }. */
function resolveTenant({ argv = process.argv, env = process.env, homedir = os.homedir(),
  readFile = fs.readFileSync } = {}) {
  const warnings = [];
  const file = configPath(homedir);
  const read = readConfigFile(file, readFile);
  if (read.error) warnings.push(`desk-tenant: ${file} ignored: ${read.error}`);
  const data = read.data || {};
  const allowedHosts = Array.isArray(data.allowed_hosts) ? data.allowed_hosts : [];

  const candidates = [
    ["argv", argHost(argv)],
    ["env", env && typeof env[ENV_KEY] === "string" && env[ENV_KEY].trim() ? env[ENV_KEY] : null],
    ["file", data.host != null ? data.host : null],
  ];
  let validatedArg = null;
  for (const [source, raw] of candidates) {
    if (raw == null) continue;
    // allowed_hosts authorises only the file's own host; argv/env stay aitherium.com-only.
    const verdict = validateHost(raw, source === "file" ? allowedHosts : []);
    if (!verdict.ok) {
      warnings.push(`desk-tenant: rejected ${source} host ${preview(raw)}: ${verdict.reason}; using ${APEX_HOST}`);
      continue;
    }
    if (source === "argv") validatedArg = verdict.host;
    // name/accent/icon only describe the FILE's host; a different host from argv/env
    // must not inherit another tenant's branding.
    const sameAsFile = normaliseHost(data.host) === verdict.host;
    const name = (sameAsFile && cleanName(data.name)) || verdict.host;
    const accent = sameAsFile && typeof data.accent === "string" && ACCENT_RE.test(data.accent) ? data.accent : null;
    const iconUrl = sameAsFile ? cleanIconUrl(data.icon_url, verdict.host, allowedHosts) : null;
    // `auto`: the file was written by sign-in discovery (desk-tenant-auto.cjs), not by an
    // installer or a person -- the next sign-in may replace or remove it.
    const auto = source === "file" && data.source === AUTO_SOURCE;
    const tenantId = auto && typeof data.tenant_id === "string" && TENANT_ID_RE.test(data.tenant_id) ? data.tenant_id : null;
    return {
      tenant: { host: verdict.host, name, accent, iconUrl, source, origin: `https://${verdict.host}/`,
        firstParty: verdict.firstParty === true, auto, tenantId },
      warnings,
      argHost: validatedArg,
    };
  }
  return { tenant: null, warnings, argHost: validatedArg };
}

/** First run: persist a validated `--tenant-host` when no config file exists yet, so
 *  later launches (autostart, shortcut) keep the tenant. Never overwrites. */
function persistFirstRunHost(host, { homedir = os.homedir(), fsImpl = fs } = {}) {
  const verdict = validateHost(host);
  if (!verdict.ok) return { written: false, reason: verdict.reason };
  const file = configPath(homedir);
  if (fsImpl.existsSync(file)) return { written: false, reason: "config exists" };
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify({ host: verdict.host }, null, 2)}\n`, { flag: "wx" });
  return { written: true, file };
}

/** Is the config file one sign-in discovery wrote (`source: "sign-in"`)? Never throws. */
function isAutoFile(file, fsImpl) {
  const read = readConfigFile(file, (f, enc) => fsImpl.readFileSync(f, enc));
  return Boolean(read.data && read.data.source === AUTO_SOURCE);
}

/** Sign-in discovery (desk-tenant-auto.cjs): persist the signed-in user's own tenant
 *  host. aitherium.com labels only (the overlay must stay first-party). A file a person
 *  or an installer wrote is never touched; one discovery wrote earlier (another account
 *  signed in before on this PC) is replaced. The process-wide tenant is re-resolved so
 *  the next window load lands on the host. */
function persistAutoTenant({ host, name, accent, tenantId } = {}, { homedir = os.homedir(), fsImpl = fs } = {}) {
  const verdict = validateHost(host);
  if (!verdict.ok || !verdict.firstParty) return { written: false, reason: verdict.reason || "not first-party" };
  const file = configPath(homedir);
  const exists = fsImpl.existsSync(file);
  if (exists && !isAutoFile(file, fsImpl)) return { written: false, reason: "config exists" };
  const data = { host: verdict.host, source: AUTO_SOURCE };
  if (typeof tenantId === "string" && TENANT_ID_RE.test(tenantId)) data.tenant_id = tenantId;
  const cleanedName = cleanName(name);
  if (cleanedName) data.name = cleanedName;
  if (typeof accent === "string" && ACCENT_RE.test(accent)) data.accent = accent;
  const text = `${JSON.stringify(data, null, 2)}
`;
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    if (!exists) {
      // `wx`: a file written meanwhile (an installer) is never overwritten.
      fsImpl.writeFileSync(file, text, { flag: "wx" });
    } else {
      // Replace a discovery-written file whole: write beside it, then rename over it.
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, text, { flag: "w" });
      fsImpl.renameSync(tmp, file);
    }
  } catch (err) {
    return { written: false, reason: err && err.code === "EEXIST" ? "config exists" : "write failed" };
  }
  cached = undefined;
  return { written: true, file, replaced: exists };
}

/** Remove a desk-tenant.json that sign-in discovery wrote (another account, a sign-out),
 *  so Desk is back on the apex with no terminal. A file a person or an installer wrote
 *  is never removed. {removed, reason?}. Never throws. */
function forgetAutoTenant({ homedir = os.homedir(), fsImpl = fs } = {}) {
  const file = configPath(homedir);
  try {
    if (!fsImpl.existsSync(file)) return { removed: false, reason: "no config" };
    if (!isAutoFile(file, fsImpl)) return { removed: false, reason: "config was not written by sign-in" };
    fsImpl.unlinkSync(file);
  } catch {
    return { removed: false, reason: "remove failed" };
  }
  cached = undefined;
  return { removed: true, file };
}

/** The overlay/browser base: the tenant origin, else `fallback` unchanged. */
function baseUrl(tenant, fallback = APEX_URL) {
  return tenant && tenant.origin ? tenant.origin : fallback;
}

/** The Living Desktop overlay base: the tenant origin ONLY for a first-party
 *  (aitherium.com) tenant, because the overlay webContents is trusted with the desk IPC
 *  planes. An allowed_hosts tenant keeps the apex overlay (logged once by the caller). */
function overlayBaseUrl(tenant, fallback = APEX_URL) {
  if (tenant && tenant.origin && tenant.firstParty === true && isFirstPartyHost(tenant.host)) return tenant.origin;
  return fallback;
}

/** "Aither" -> "Aither · <tenant name>"; unchanged with no tenant. */
function decorateTitle(title, tenant) {
  if (!tenant || !tenant.name) return title;
  return `${title} · ${tenant.name}`;
}

/** The tray's "Open workspace" row: present only in tenant mode, opens the tenant origin. */
function tenantTrayItems(tenant, open) {
  if (!tenant || !tenant.origin) return [];
  return [{
    label: `Open workspace — ${tenant.name || tenant.host}`,
    enabled: typeof open === "function",
    click: () => open && open(tenant.origin),
  }];
}

let cached;
let resolveTenantImpl = () => resolveTenant();
/** The process-wide tenant (resolved once, warnings logged once). */
function currentTenant({ log = console.warn } = {}) {
  if (cached === undefined) {
    let result;
    try {
      result = resolveTenantImpl();
    } catch (err) {
      // Fail open to the apex: a hostile/odd config must never stop Desk starting.
      result = { tenant: null, argHost: null,
        warnings: [`desk-tenant: resolver failed (${err && err.name ? err.name : "error"}); using ${APEX_HOST}`] };
    }
    for (const warning of result.warnings) {
      try { log(warning); } catch { /* logging must never break startup */ }
    }
    cached = result;
  }
  return cached.tenant;
}

function currentResolution() {
  currentTenant();
  return cached;
}

function _resetForTests() { cached = undefined; }
function _setResolverForTests(fn) { resolveTenantImpl = fn; }

module.exports = {
  APEX_HOST, APEX_URL, ARG_PREFIX, ENV_KEY,
  configPath, normaliseHost, validateHost, isFirstPartyHost, readConfigFile, resolveTenant,
  AUTO_SOURCE, persistFirstRunHost, persistAutoTenant, forgetAutoTenant, baseUrl, overlayBaseUrl, decorateTitle, tenantTrayItems, currentTenant,
  currentResolution, _resetForTests, _setResolverForTests,
};
