"use strict";

/** Desk finds the signed-in user's workspace by itself (no desk-tenant.json needed).
 *
 *  Owner, 2026-10-14: a customer's Desk opened the platform apex although he belongs to
 *  a workspace with its own host -- the only way into it was a hand-written
 *  ~/.aither/desk-tenant.json. "This all needs to be EASY": no terminal, no file.
 *
 *  Sources, all non-secret:
 *    1. Identity /auth/me (the call desk-session.checkToken already makes to validate
 *       the window's session) names the user's `tenant_id` / `tenant_slug` /
 *       `workspace_slug`. Nothing else from that body is kept.
 *    2. Each tenant host publishes `https://<label>.aitherium.com/config.js`, a PUBLIC
 *       file ("NEVER put secrets here -- this file is public") that declares
 *       `window.__AITHER_TENANT__ = "<label>"` and its brand.
 *  A host is adopted ONLY when it declares the tenant whose canonical id
 *  (`tnt_<label with - as _>`, Identity's _canonical_tenant_id) equals the signed-in
 *  user's tenant_id. A same-named first-party host (docs, api, ...) declares no tenant,
 *  so it can never be picked; the platform tenant (`platform`) never maps to a host.
 *
 *  No customer name or host is compiled in: Desk stays a public build.
 *  Electron-free and every edge injected, so desk-tenant-auto.test.cjs runs under node.
 */

const deskTenant = require("./desk-tenant.cjs");

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TENANT_DECL_RE = /window\.__AITHER_TENANT__\s*=\s*["']([a-z0-9-]{1,63})["']/;
const BRAND_RE = /window\.__AITHER_TENANT_BRAND__\s*=\s*(\{.*\})\s*;?\s*$/m;
const MAX_CONFIG_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 8000;

/** The tenant fields of an Identity /auth/me body; nothing else survives. */
function tenantIdentity(body) {
  if (!body || typeof body !== "object") return null;
  const str = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const out = { tenantId: str(body.tenant_id), tenantSlug: str(body.tenant_slug), workspaceSlug: str(body.workspace_slug) };
  return out.tenantId ? out : null;
}

/** Identity's canonical tenant id for a host label (AitherIdentity._canonical_tenant_id). */
function tenantIdForLabel(label) {
  return `tnt_${String(label).replace(/-/g, "_")}`;
}

/** Host labels worth asking about, most likely first. [] for the platform tenant. */
function candidateLabels(identity) {
  if (!identity || typeof identity.tenantId !== "string" || !identity.tenantId.startsWith("tnt_")) return [];
  const fromId = identity.tenantId.slice(4).replace(/_/g, "-");
  const out = [];
  for (const raw of [fromId, identity.tenantSlug, identity.workspaceSlug]) {
    const label = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!LABEL_RE.test(label) || out.includes(label)) continue;
    // Only a label whose canonical id IS the user's tenant can ever be adopted;
    // asking about any other would be a wasted request.
    if (tenantIdForLabel(label) !== identity.tenantId) continue;
    out.push(label);
  }
  return out;
}

/** The tenant a public config.js declares, or null. */
function declaredTenant(text) {
  if (typeof text !== "string") return null;
  const m = TENANT_DECL_RE.exec(text);
  return m ? m[1] : null;
}

/** Brand name/accent a public config.js declares ({} when absent or malformed). */
function declaredBrand(text) {
  if (typeof text !== "string") return {};
  const m = BRAND_RE.exec(text);
  if (!m) return {};
  try {
    const brand = JSON.parse(m[1]);
    if (!brand || typeof brand !== "object") return {};
    return {
      name: typeof brand.name === "string" ? brand.name : undefined,
      accent: typeof brand.accent === "string" ? brand.accent : undefined,
    };
  } catch {
    return {};
  }
}

async function fetchConfigJs(host, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    // redirect: "manual" -- a host that bounces elsewhere has not declared anything.
    // No credentials: this is a public file and nothing of the user's rides along.
    const res = await fetchImpl(`https://${host}/config.js`, {
      redirect: "manual", credentials: "omit", cache: "no-store",
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res || res.status !== 200) return null;
    const text = await res.text();
    return typeof text === "string" && text.length <= MAX_CONFIG_BYTES ? text : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** {host, label, name?, accent?} for the user's own tenant host, or null. */
async function discoverTenantHost(identity, { fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  for (const label of candidateLabels(identity)) {
    const verdict = deskTenant.validateHost(`${label}.${deskTenant.APEX_HOST}`);
    if (!verdict.ok || !verdict.firstParty) continue;
    const text = await fetchConfigJs(verdict.host, { fetchImpl, timeoutMs });
    if (declaredTenant(text) !== label) continue;
    return { host: verdict.host, label, ...declaredBrand(text) };
  }
  return null;
}

/**
 * After a sign-in: point Desk at the signed-in account's own workspace host.
 *
 *   - A tenant from argv/env or a file a person/installer wrote is never touched.
 *   - No tenant yet: discover the host and write desk-tenant.json (source "sign-in").
 *   - A sign-in-written file for THIS tenant: nothing to do.
 *   - A sign-in-written file for ANOTHER tenant (a shared PC, an owner's test sign-in):
 *     replaced by this account's host, or removed when this account has none -- so a
 *     wrong pin is undone by signing in, never by deleting a file in a terminal.
 *
 * Resolves { adopted, host?, file?, replaced?, cleared?, reason? }; `adopted` or
 * `cleared` means the tenant changed and windows should follow.
 */
async function autoResolveTenant(identity, {
  current = () => deskTenant.currentResolution(), homedir, fsImpl, fetchImpl, timeoutMs,
} = {}) {
  let resolution;
  try {
    resolution = current();
  } catch {
    resolution = null;
  }
  const tenant = resolution && resolution.tenant;
  if (tenant && !tenant.auto) return { adopted: false, reason: "tenant already configured" };
  if (!identity || !identity.tenantId) return { adopted: false, reason: "no tenant on this account" };
  if (tenant && tenant.auto && tenant.tenantId === identity.tenantId) {
    return { adopted: false, reason: "already this account's workspace" };
  }
  const found = candidateLabels(identity).length ? await discoverTenantHost(identity, { fetchImpl, timeoutMs }) : null;
  if (!found) {
    if (tenant && tenant.auto) {
      const gone = deskTenant.forgetAutoTenant({ homedir, fsImpl });
      if (gone.removed) return { adopted: false, cleared: true, reason: "another account's workspace forgotten" };
    }
    return { adopted: false, reason: candidateLabels(identity).length ? "no host declares this tenant" : "no workspace host for this account" };
  }
  const wrote = deskTenant.persistAutoTenant({ ...found, tenantId: identity.tenantId }, { homedir, fsImpl });
  if (!wrote.written) return { adopted: false, reason: wrote.reason };
  return { adopted: true, host: found.host, file: wrote.file, replaced: Boolean(wrote.replaced) };
}

// ── One adopter for the whole process ───────────────────────────────────────────
// Two doors learn who signed in: the Living Desktop's session sync (its partition's
// cookie, auth.json, the vault) and the Online tab's own sign-in (main's watchOnlineAuth,
// the same partition read through browserWindow.onlineToken()). Both land here, so a
// sign-in is acted on once and every window (overlay, app window, Online tab, taskbar,
// tray) follows from ONE change notice.
const listeners = new Set();
let lastTenantId = null;
let inFlight = null;

/** Subscribe to "the tenant changed" ({adopted|cleared, host?}). Returns unsubscribe. */
function onWorkspaceChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(result) {
  for (const fn of [...listeners]) {
    try { fn(result); } catch { /* one window failing to follow must not stop the rest */ }
  }
}

/**
 * Act on a signed-in identity. The same tenant twice in a row costs nothing; a
 * different account signing in is looked at again. Never throws.
 */
async function adoptIdentity(identity, opts = {}) {
  if (!identity || typeof identity.tenantId !== "string" || !identity.tenantId) {
    return { adopted: false, reason: "no tenant on this account" };
  }
  if (inFlight && inFlight.tenantId === identity.tenantId) return inFlight.promise;
  if (lastTenantId === identity.tenantId) return { adopted: false, reason: "already looked at this account" };
  const promise = (async () => {
    let result;
    try {
      result = await autoResolveTenant(identity, opts);
    } catch (err) {
      result = { adopted: false, reason: `lookup failed (${err && err.name ? err.name : "error"})` };
    }
    lastTenantId = identity.tenantId;
    if (result.adopted || result.cleared) notify(result);
    return result;
  })();
  inFlight = { tenantId: identity.tenantId, promise };
  try {
    return await promise;
  } finally {
    if (inFlight && inFlight.promise === promise) inFlight = null;
  }
}

/**
 * A bearer from any door (the Online tab's partition cookie): ask Identity who it is,
 * then adoptIdentity. `check` defaults to desk-session.checkToken. Never throws.
 */
async function adoptFromToken(token, { check, ...opts } = {}) {
  if (typeof token !== "string" || !token) return { adopted: false, reason: "no session" };
  let verdict;
  try {
    const checker = check || ((t) => require("./desk-session.cjs").checkToken(t));
    verdict = await checker(token);
  } catch {
    return { adopted: false, reason: "session check failed" };
  }
  if (!verdict || verdict.state !== "valid" || !verdict.identity) return { adopted: false, reason: "no tenant identity" };
  return adoptIdentity(verdict.identity, opts);
}

/** An explicit Sign out: forget a sign-in-written workspace (never a hand-written one),
 *  so the next account starts from the apex and is looked at fresh. Never throws. */
function signedOut(opts = {}) {
  lastTenantId = null;
  let gone;
  try {
    gone = deskTenant.forgetAutoTenant(opts);
  } catch {
    gone = { removed: false };
  }
  if (gone.removed) notify({ adopted: false, cleared: true, reason: "signed out" });
  return gone;
}

function _resetForTests() {
  listeners.clear();
  lastTenantId = null;
  inFlight = null;
}

module.exports = {
  tenantIdentity, tenantIdForLabel, candidateLabels, declaredTenant, declaredBrand,
  fetchConfigJs, discoverTenantHost, autoResolveTenant,
  onWorkspaceChange, adoptIdentity, adoptFromToken, signedOut, _resetForTests,
};
