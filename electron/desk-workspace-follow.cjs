"use strict";

/** The desk remembers the workspace the owner picks INSIDE the Aitherium menu.
 *
 *  The Veil account menu switches workspace by navigating the overlay to that workspace's
 *  own host. The desk used to learn nothing from it: the choice lived in the page, so a
 *  relaunch started in the old workspace (desk-tenant.json still named the old host).
 *
 *  No new preload or IPC surface: the MAIN process already sees every top-level navigation
 *  of the overlay, so it follows the host the page moved to and reuses the owner-only paths
 *  the tray picker uses (desk-tenant-auto.openOwnerWorkspace / backToApex). Both re-check
 *  the signed-in owner and that the host itself declares the tenant, so a page that merely
 *  navigates somewhere cannot write a workspace into the desk. Pure of electron; tested. */

const deskTenant = require("./desk-tenant.cjs");
const { tenantIdForLabel } = require("./desk-tenant-auto.cjs");

/** Single labels under aitherium.com that are the platform itself, never a customer workspace.
 *  This is a deny list, so an unknown label is treated as a workspace host. That is safe only
 *  because the follow is a UX convenience and the guard is elsewhere: openOwnerWorkspace refuses
 *  anything but an owner switching to a workspace, and the tenant backend refuses a foreign
 *  tenant's token. A label missing here can at worst make the desk try an owner switch that
 *  openOwnerWorkspace then refuses; it never grants access. */
const PLATFORM_LABELS = new Set([
  "app", "www", "portal", "api", "idp", "relay", "mcp", "artifact", "blog", "shop", "docs",
  "forums", "status", "mail", "admin", "auth", "login",
]);

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The https hostname of a URL, lower-cased; "" for anything else. */
function hostOf(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" ? u.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** What a top-level navigation to `url` means for the desk's remembered workspace.
 *  {action: "noop"} | {action: "back"} | {action: "open", label, tenantId, host}. */
function classifyNavigation(url, tenant) {
  const host = hostOf(url);
  if (!host) return { action: "noop" };
  const apex = deskTenant.APEX_HOST;
  if (host === apex) return tenant && tenant.ownerSwitch ? { action: "back" } : { action: "noop" };
  const suffix = `.${apex}`;
  if (!host.endsWith(suffix)) return { action: "noop" };
  const label = host.slice(0, -suffix.length);
  if (!LABEL_RE.test(label)) return { action: "noop" };
  if (PLATFORM_LABELS.has(label)) return tenant && tenant.ownerSwitch ? { action: "back" } : { action: "noop" };
  // A tenant API host (garg-api) is a backend, not a desktop.
  if (label.endsWith("-api")) return { action: "noop" };
  if (tenant && tenant.host === host) return { action: "noop" };
  return { action: "open", label, host, tenantId: tenantIdForLabel(label) };
}

function isPlatformHost(h) {
  if (h === deskTenant.APEX_HOST) return true;
  const suffix = `.${deskTenant.APEX_HOST}`;
  return h.endsWith(suffix) && PLATFORM_LABELS.has(h.slice(0, -suffix.length));
}

/** Does moving the overlay's base to `nextBase` need a reload, given the page is on `pageUrl`?
 *  Not when the page is already on that workspace's host (the owner just navigated there),
 *  nor when both are the platform's own hosts. */
function needsReload(pageUrl, nextBase) {
  const page = hostOf(pageUrl);
  const next = hostOf(nextBase);
  if (!page || !next) return true;
  return !(page === next || (isPlatformHost(page) && isPlatformHost(next)));
}

/** Follow one top-level navigation. `open(tenantId)` / `back()` are the owner paths. */
async function followNavigation(url, { currentTenant, open, back } = {}) {
  let tenant = null;
  try { tenant = typeof currentTenant === "function" ? currentTenant() : null; } catch { tenant = null; }
  const verdict = classifyNavigation(url, tenant);
  if (verdict.action === "open" && typeof open === "function") {
    const result = await open(verdict.tenantId);
    return { ...verdict, done: Boolean(result && result.opened) };
  }
  if (verdict.action === "back" && typeof back === "function") {
    const result = await back();
    return { ...verdict, done: Boolean(result && result.removed) };
  }
  return { ...verdict, done: false };
}

module.exports = { PLATFORM_LABELS, hostOf, classifyNavigation, needsReload, followNavigation };
