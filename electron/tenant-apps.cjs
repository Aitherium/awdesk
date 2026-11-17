"use strict";

/**
 * tenant-apps -- WHERE an AitherOS Online app opens while the desk sits in a tenant workspace.
 *
 * Owner, 2026-11-17: garg.aitherium.com/solo/?app=aeon printed "Aeon did not open here". His
 * desk was switched into the Garg workspace (desk-tenant.cjs, source "owner-switch"), and every
 * rail app then opened at the Garg host (browser-internal.onlineUrl). Garg's pack grants 39
 * panels; Aeon is a tab of the Terminal window and the pack grants neither, so the page drew a
 * card instead of the app. Veil now says why (solo-app.tsx soloNotOpened). This module makes the
 * desk put the app where it opens.
 *
 *   An app opens on the TENANT unless ALL of these hold:
 *     1. the desk is the platform owner's own switch (tenant.ownerSwitch) -- a customer's desk
 *        never leaves their workspace: a tenant must not quietly become the platform's storefront
 *        (Veil tenant-catalog.ts states the same rule for the launcher);
 *     2. the tenant's own entitlement was READ and is fresh (state "ready");
 *     3. neither the app nor any window it lands on is in that entitlement.
 *   Then it opens on the platform (app.aitherium.com), in the owner's signed-in partition.
 *   Anything unknown (not yet fetched, backend down, an odd answer) opens where it always did.
 *
 * "Lands on" is Veil's own rule (solo-app.tsx judges `COLLAPSED_INTO[id]?.app ?? id`, the same as
 * openApp): the generated catalogue's `aliasTo` (app-aliases.ts + merged-apps.ts), plus the two
 * tables the generator does not carry. They mirror, by name:
 *   COLLAPSED_ONTO       app-registry.tsx COLLAPSED_INTO, its explicit entries
 *   WORKSPACE_ADMIN_IDS  apps/workspace-admin/sections.ts LEGACY_SECTION (nine tiles -> one window)
 * Measured 2026-11-17 against Veil's real tables and Garg's real entitlement, all 95 online ids:
 * no app this module sends to the platform is one Veil opens on Garg, and none that Veil refuses
 * stays on Garg. tenant-apps.test.cjs pins that partition. If the generator ever emits `landsOn`,
 * it wins over both tables.
 *
 * The entitlement is the SAME answer Veil's own page reads: `<api base>/api/config/embed`, the api
 * base being the `window.__AITHER_API_BASE__` line of the tenant's public config.js, asked with the
 * owner's cookies (their entitlement can be wider or narrower than the public one). Only a
 * first-party aitherium.com host is ever asked, and cookies go to no other.
 *
 * Electron-free; every edge (the config.js fetch, the signed-in fetch, the clock) is injected, so
 * tenant-apps.test.cjs runs under node.
 */

const deskTenant = require("./desk-tenant.cjs");
const tenantAuto = require("./desk-tenant-auto.cjs");
const catalogue = require("./desk-apps.generated.json");

const EMBED_PATH = "/api/config/embed";
const API_BASE_RE = /window\.__AITHER_API_BASE__\s*=\s*"(https:\/\/[^"\s]{1,253})"/;
const MAX_EMBED_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
/** A ready answer is trusted this long; the next open after it asks again (and meanwhile uses it). */
const READY_TTL_MS = 10 * 60 * 1000;
/** After a failed ask, no new ask sooner than this. */
const RETRY_MS = 30 * 1000;
/** Apps a tenant desktop opens whatever its pack grants (Veil tenant-entitlement.ts TENANT_SHELL_APPS). */
const SHELL_APPS = Object.freeze(["auth"]);

/** app-registry.tsx COLLAPSED_INTO, explicit entries: an id that opens a tab of another window. */
const COLLAPSED_ONTO = Object.freeze({
  elysium: "online", greeter: "terminal", aeon: "terminal", forums: "online", commons: "online",
  "web:radiant": "online", "web:galaxy": "online", "web:neural": "online",
});

/** apps/workspace-admin/sections.ts LEGACY_SECTION: ids that open Workspace Admin on a section. */
const WORKSPACE_ADMIN_IDS = Object.freeze([
  "analytics", "audit", "inference-config", "llm-config", "lockbox", "secrets", "settings",
  "sso-settings", "workspace-config", "workspace-members",
]);

/** Entitled app ids out of an embed payload: its `desktop_apps`, then its `panels` (strings or {id}). */
function entitledIdsFrom(payload) {
  const out = new Set();
  if (!payload || typeof payload !== "object") return out;
  if (Array.isArray(payload.desktop_apps)) {
    for (const a of payload.desktop_apps) if (typeof a === "string" && a.trim()) out.add(a.trim());
  }
  if (Array.isArray(payload.panels)) {
    for (const p of payload.panels) {
      const id = typeof p === "string" ? p : (p && typeof p.id === "string" ? p.id : "");
      if (id.trim()) out.add(id.trim());
    }
  }
  return out;
}

/** The window an id lands on in Veil, or the id itself. */
function landsOn(id, cat = catalogue) {
  const own = String(id || "");
  if (cat && cat.landsOn && typeof cat.landsOn[own] === "string") return cat.landsOn[own];
  if (Object.prototype.hasOwnProperty.call(COLLAPSED_ONTO, own)) return COLLAPSED_ONTO[own];
  if (WORKSPACE_ADMIN_IDS.includes(own)) return "workspace-admin";
  const alias = cat && cat.aliasTo && cat.aliasTo[own];
  return typeof alias === "string" && alias ? alias : own;
}

/** May a tenant whose entitlement is `ids` open `id`? Veil tenantMayOpen on the landing window. */
function entitles(ids, id, cat = catalogue) {
  if (!(ids instanceof Set)) return false;
  const own = String(id || "");
  if (SHELL_APPS.includes(own)) return true;
  return ids.has(own) || ids.has(landsOn(own, cat));
}

/** The api base a tenant's public config.js names, only when it is a first-party https origin. */
function apiBaseOf(configJs) {
  if (typeof configJs !== "string") return null;
  const m = API_BASE_RE.exec(configJs);
  if (!m) return null;
  let url;
  try { url = new URL(m[1]); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!deskTenant.isFirstPartyHost(url.hostname.toLowerCase())) return null;
  return url.origin;
}

/**
 * The per-host entitlement cache. `peek` is synchronous (a rail click cannot wait); it starts a
 * refresh when the answer is missing or stale and never throws.
 *
 *   fetchImpl(url, init) -> a fetch Response, SIGNED IN as the owner (the online partition)
 *   fetchConfig(host)    -> the tenant's public config.js text, or null
 */
function createEntitlementStore({ fetchImpl, fetchConfig, now = Date.now, readyTtlMs = READY_TTL_MS,
  retryMs = RETRY_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const byHost = new Map();
  const inflight = new Map();
  const configOf = typeof fetchConfig === "function" ? fetchConfig : (host) => tenantAuto.fetchConfigJs(host);

  async function ask(host) {
    const base = apiBaseOf(await configOf(host));
    if (!base) return { state: "unavailable", reason: "no first-party api base in config.js" };
    if (typeof fetchImpl !== "function") return { state: "unavailable", reason: "no signed-in fetch" };
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(`${base}${EMBED_PATH}`, {
        credentials: "include", headers: { Accept: "application/json" }, cache: "no-store",
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res || res.status !== 200) return { state: "unavailable", reason: `HTTP ${res ? res.status : "none"}` };
      const text = await res.text();
      if (typeof text !== "string" || text.length > MAX_EMBED_BYTES) return { state: "unavailable", reason: "answer too large" };
      const ids = entitledIdsFrom(JSON.parse(text));
      // Veil: an empty entitlement is a real answer ("no apps yet"), never a reason to fall back.
      return { state: "ready", ids };
    } catch (err) {
      return { state: "unavailable", reason: err && err.name ? err.name : "error" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Ask now (deduped per host) and cache the verdict. Resolves to the cached entry; never rejects. */
  function refresh(host) {
    if (typeof host !== "string" || !deskTenant.isFirstPartyHost(host)) {
      return Promise.resolve({ state: "unavailable", reason: "not a first-party host", at: now() });
    }
    if (inflight.has(host)) return inflight.get(host);
    const p = ask(host).then((entry) => {
      const stamped = { ...entry, at: now() };
      byHost.set(host, stamped);
      return stamped;
    }, () => {
      const stamped = { state: "unavailable", reason: "error", at: now() };
      byHost.set(host, stamped);
      return stamped;
    }).finally(() => inflight.delete(host));
    inflight.set(host, p);
    return p;
  }

  /** The last answer for `host` (or null), asking again when it is missing or stale. */
  function peek(host) {
    const entry = byHost.get(host) || null;
    const age = entry ? now() - entry.at : Infinity;
    const stale = !entry || (entry.state === "ready" ? age >= readyTtlMs : age >= retryMs);
    if (stale && !inflight.has(host)) void refresh(host);
    return entry;
  }

  return { peek, refresh, _forget: () => byHost.clear() };
}

/**
 * Where `id` opens right now. Pure given the entitlement entry.
 *   -> { onPlatform: boolean, why: string }
 */
function placeFor(id, { tenant, entry, cat = catalogue } = {}) {
  if (!tenant || !tenant.origin) return { onPlatform: false, why: "no tenant" };
  if (tenant.ownerSwitch !== true) return { onPlatform: false, why: "not the owner's workspace switch" };
  if (!entry || entry.state !== "ready" || !(entry.ids instanceof Set)) return { onPlatform: false, why: "entitlement unknown" };
  if (entitles(entry.ids, id, cat)) return { onPlatform: false, why: "the workspace grants it" };
  return { onPlatform: true, why: "the workspace does not grant it" };
}

/**
 * The whole decision for one open: the base URL, the launch mode and the tab key.
 * `desktop` mode spawns the app on the pinned Online desktop, which is the tenant's: an app that
 * belongs elsewhere opens as a tab instead. A platform tab has its own key, so a tab the tenant
 * host already holds for this id is not mistaken for it.
 */
function plan(id, mode, { tenant, entry, tenantBase, platformBase, cat = catalogue } = {}) {
  const place = placeFor(id, { tenant, entry, cat });
  if (!place.onPlatform) return { base: tenantBase, mode, key: `app:${id}`, onPlatform: false, why: place.why };
  return {
    base: platformBase,
    mode: mode === "desktop" ? "tab" : mode,
    key: `app:${id}:platform`,
    onPlatform: true,
    why: place.why,
  };
}

module.exports = {
  COLLAPSED_ONTO, WORKSPACE_ADMIN_IDS, SHELL_APPS, EMBED_PATH, READY_TTL_MS, RETRY_MS,
  entitledIdsFrom, landsOn, entitles, apiBaseOf, createEntitlementStore, placeFor, plan,
};
