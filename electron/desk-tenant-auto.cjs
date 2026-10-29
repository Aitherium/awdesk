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
 *  The platform owner is the exception, by choice not by discovery (owner, 2026-10-29:
 *  "open Garg's workspace from the Desk"): a `platform` principal may OPEN any tenant
 *  Identity lists for him (GET /tenants, admin-only -- the same list Veil's People &
 *  customers page reads), each host validated by the SAME public config.js check. That
 *  writes desk-tenant.json with `source: "owner-switch"`; sign-out and "Back to
 *  Aitherium" remove it, and any NON-platform account signing in replaces or clears it.
 *  Every owner action re-asks Identity /auth/me; a non-platform session is refused.
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
  if (!identity || !identity.tenantId) {
    return { adopted: false, reason: tenant && !tenant.auto ? "tenant already configured" : "no tenant on this account" };
  }
  // The owner's own "Open a workspace" choice stays while the OWNER is signed in; any
  // other account is never left inside a workspace it was not given (replaced/cleared
  // below exactly like a sign-in-written file).
  if (tenant && tenant.ownerSwitch && isPlatformIdentity(identity)) {
    return { adopted: false, reason: "owner opened this workspace" };
  }
  const deskWritten = Boolean(tenant && (tenant.auto || tenant.ownerSwitch));
  if (tenant && !deskWritten) return { adopted: false, reason: "tenant already configured" };
  if (tenant && tenant.auto && tenant.tenantId === identity.tenantId) {
    return { adopted: false, reason: "already this account's workspace" };
  }
  const found = candidateLabels(identity).length ? await discoverTenantHost(identity, { fetchImpl, timeoutMs }) : null;
  if (!found) {
    if (deskWritten) {
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

// ── The platform owner opens a customer workspace ("Open a workspace") ───────────
const PLATFORM_TENANT = "platform";
const MAX_WORKSPACES = 500;

/** True only for Identity's platform principal (tenant_id exactly `platform`). */
function isPlatformIdentity(identity) {
  return Boolean(identity && identity.tenantId === PLATFORM_TENANT);
}

/** The tenant id of the last account the adopter saw sign in (null after sign-out).
 *  A HINT for showing owner rows only -- every owner ACTION re-asks Identity. */
function signedInTenantId() {
  return lastTenantId;
}

/** Ask Identity who `token` is; {identity} for a platform principal, else {refused}. */
async function ownerSession(token, { check } = {}) {
  if (typeof token !== "string" || !token) return { refused: "not signed in" };
  let verdict;
  try {
    const checker = check || ((t) => require("./desk-session.cjs").checkToken(t));
    verdict = await checker(token);
  } catch {
    return { refused: "session check failed" };
  }
  if (!verdict || verdict.state !== "valid") return { refused: "not signed in" };
  if (!isPlatformIdentity(verdict.identity)) return { refused: "only the platform owner can open another workspace" };
  return { identity: verdict.identity };
}

/** Tenant rows from Identity GET /tenants (admin-only; the list Veil's People & customers
 *  page reads through /api/admin/tenants). Nothing but id/slug/name/status survives. */
async function fetchTenantRows(token, { idp, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const oidc = require("./desk-oidc.cjs");
  const base = oidc.checkIdp(idp || oidc.DEFAULT_IDP);
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${base}/tenants?status_filter=active&limit=${MAX_WORKSPACES}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "manual", signal: ctl ? ctl.signal : undefined,
    });
    if (!res || res.status !== 200) return { error: `Identity /tenants answered ${res ? res.status : "nothing"}` };
    const body = await res.json();
    const rows = body && Array.isArray(body.tenants) ? body.tenants : null;
    if (!rows) return { error: "Identity /tenants returned no tenant list" };
    return {
      rows: rows.slice(0, MAX_WORKSPACES).filter((r) => r && typeof r === "object").map((r) => ({
        tenantId: typeof r.tenant_id === "string" ? r.tenant_id.trim().toLowerCase() : "",
        slug: typeof r.slug === "string" ? r.slug.trim().toLowerCase() : "",
        name: typeof r.display_name === "string" ? r.display_name : "",
        status: typeof r.status === "string" ? r.status : "active",
      })),
    };
  } catch (err) {
    return { error: `Identity /tenants unreachable (${err && err.name ? err.name : "error"})` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The workspaces the platform owner may open: every active tenant Identity lists whose
 * host's public config.js declares it (the same check sign-in discovery uses).
 * Resolves { ok, workspaces: [{tenantId, host, label, name, accent?}], error? }.
 * A non-platform session gets { ok:false, refused } and NO Identity /tenants call.
 */
async function listOwnerWorkspaces(token, { check, idp, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  const who = await ownerSession(token, { check });
  if (who.refused) return { ok: false, refused: who.refused, workspaces: [] };
  const listed = await fetchTenantRows(token, { idp, fetchImpl, timeoutMs });
  if (listed.error) return { ok: false, error: listed.error, workspaces: [] };
  const found = await Promise.all(listed.rows
    .filter((r) => r.status === "active" && r.tenantId.startsWith("tnt_"))
    .map(async (r) => {
      const host = await discoverTenantHost({ tenantId: r.tenantId, tenantSlug: r.slug, workspaceSlug: "" },
        { fetchImpl, timeoutMs });
      if (!host) return null;
      return { tenantId: r.tenantId, host: host.host, label: host.label,
        name: host.name || r.name || host.label, ...(host.accent ? { accent: host.accent } : {}) };
    }));
  const workspaces = found.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, workspaces };
}

/**
 * Open one workspace for the platform owner. The tenant id is re-validated here (Identity
 * says the caller is platform; the host's config.js declares the tenant), never trusted
 * from a menu. Writes desk-tenant.json (`source: "owner-switch"`) and notifies every window.
 * A hand-written / installer config is never overwritten.
 */
async function openOwnerWorkspace(token, tenantId, { check, homedir, fsImpl, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  const who = await ownerSession(token, { check });
  if (who.refused) return { opened: false, refused: who.refused };
  const id = typeof tenantId === "string" ? tenantId.trim().toLowerCase() : "";
  if (!id.startsWith("tnt_")) return { opened: false, reason: "not a customer tenant id" };
  const found = await discoverTenantHost({ tenantId: id, tenantSlug: "", workspaceSlug: "" }, { fetchImpl, timeoutMs });
  if (!found) return { opened: false, reason: "no host declares this tenant" };
  const wrote = deskTenant.persistOwnerTenant({ ...found, tenantId: id }, { homedir, fsImpl });
  if (!wrote.written) return { opened: false, reason: wrote.reason };
  const result = { opened: true, adopted: true, ownerSwitch: true, host: found.host, file: wrote.file };
  notify(result);
  return result;
}

/** "Back to Aitherium": drop the owner's workspace choice (never a hand-written file). */
function backToApex(opts = {}) {
  let resolution = null;
  try {
    resolution = (opts.current || (() => deskTenant.currentResolution()))();
  } catch { /* treated as no tenant */ }
  const tenant = resolution && resolution.tenant;
  if (!tenant || !tenant.ownerSwitch) return { removed: false, reason: "no workspace opened by the owner" };
  let gone;
  try {
    gone = deskTenant.forgetAutoTenant({ homedir: opts.homedir, fsImpl: opts.fsImpl });
  } catch {
    gone = { removed: false, reason: "remove failed" };
  }
  if (gone.removed) notify({ adopted: false, cleared: true, reason: "back to Aitherium" });
  return gone;
}

/** Tray rows for the platform owner (empty for anyone else): "Open a workspace…" and,
 *  while one is open, "Back to Aitherium". `tenantId` is the signed-in hint. */
function ownerTrayItems(tenantId, tenant, { pick, back } = {}) {
  if (tenantId !== PLATFORM_TENANT) return [];
  const rows = [{ label: "Open a workspace…", enabled: typeof pick === "function", click: () => pick && pick() }];
  if (tenant && tenant.ownerSwitch) {
    rows.push({ label: "Back to Aitherium", enabled: typeof back === "function", click: () => back && back() });
  }
  return rows;
}

/** The picker the owner sees: one row per workspace (the open one checked), then Back. */
function ownerWorkspaceMenu(listing, tenant, { open, back } = {}) {
  const rows = [];
  if (!listing || listing.refused) {
    rows.push({ label: (listing && listing.refused) || "not signed in", enabled: false });
    return rows;
  }
  if (listing.error) rows.push({ label: `Could not list workspaces: ${listing.error}`, enabled: false });
  for (const w of listing.workspaces || []) {
    const here = Boolean(tenant && tenant.host === w.host);
    rows.push({ label: `${w.name} — ${w.host}`, type: "checkbox", checked: here,
      click: () => open && open(w.tenantId) });
  }
  if (!listing.error && !(listing.workspaces || []).length) rows.push({ label: "No customer workspaces found", enabled: false });
  rows.push({ type: "separator" });
  rows.push({ label: "Back to Aitherium", enabled: Boolean(tenant && tenant.ownerSwitch), click: () => back && back() });
  return rows;
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
  PLATFORM_TENANT, isPlatformIdentity, signedInTenantId, ownerSession, listOwnerWorkspaces,
  openOwnerWorkspace, backToApex, ownerTrayItems, ownerWorkspaceMenu,
};
