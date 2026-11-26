"use strict";

/**
 * tenant-context.cjs -- Resolves owner vs. customer workspace (e.g. GargBot)
 * context for Unified AitherBrowser from ../desk-tenant.cjs & ../desk-posture.cjs.
 *
 * Guarantees:
 *   - Customer workspace installs (e.g. GargBot at garg.aitherium.com) boot into
 *     their tenant origin (`https://garg.aitherium.com/`) in full opaque `desktop`
 *     mode (never `?shell=aither-desktop`, never owner `aithr.net` fleet chrome),
 *     branded with the tenant name + accent and isolated in `persist:aither-work-<slug>`.
 *   - Owner machines stay on `https://aithr.net` in `workbench` mode (even when
 *     peeking into a customer workspace via `ownerSwitch: true`), with 1-click
 *     access to GargBot in an isolated workspace tab/stage.
 *
 * Pure Node CJS (zero Electron imports).
 */

const deskTenant = require("../desk-tenant.cjs");
const { deskPosture } = require("../desk-posture.cjs");
const { DEFAULT_HOME_URL } = require("./morph-state.cjs");

const GARG_DEFAULT_ORIGIN = "https://garg.aitherium.com/";
const GARG_ACCENT = "#e05254";

function slugFromHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h || h === "aithr.net" || h.endsWith(".aithr.net")) return "";
  if (h === "aitherium.com" || h === "www.aitherium.com" || h === "app.aitherium.com") return "";
  const first = h.split(".")[0] || "";
  return first.replace(/[^a-z0-9_-]/g, "");
}

function resolveUnifiedTenant({ tenant = undefined, env = process.env } = {}) {
  const resolved = tenant === undefined ? deskTenant.currentTenant({ log: () => {} }) : tenant;
  const posture = deskPosture({ env, tenant: resolved });
  const customer = Boolean(posture.customer);
  const host = resolved && typeof resolved.host === "string" ? resolved.host.toLowerCase() : "";
  const slug = slugFromHost(host);
  const isGarg = slug === "garg" || /garg/i.test(String(resolved?.name || ""));

  const homeUrl = customer
    ? deskTenant.baseUrl(resolved, DEFAULT_HOME_URL)
    : DEFAULT_HOME_URL;

  const brandName = customer
    ? (resolved?.name || (isGarg ? "GargBot" : slug ? slug.toUpperCase() : "Workspace"))
    : "AitherBrowser";

  const accent = customer
    ? (resolved?.accent || (isGarg ? GARG_ACCENT : "#7c8cff"))
    : "#7c8cff";

  return {
    customer,
    reason: posture.reason,
    posture,
    tenant: resolved || null,
    host,
    workspaceSlug: customer ? slug : "",
    homeUrl,
    brandName,
    accent,
    defaultMode: customer ? "desktop" : "workbench",
    windowTitle: customer ? brandName : deskTenant.decorateTitle("AitherBrowser", resolved),
    quickWorkspaces: customer
      ? [{ slug, name: brandName, url: homeUrl, accent }]
      : [
          { slug: "", name: "AitherNet · aithr.net", url: DEFAULT_HOME_URL, accent: "#7c8cff" },
          { slug: "garg", name: "GargBot · garg.aitherium.com", url: GARG_DEFAULT_ORIGIN, accent: GARG_ACCENT },
        ],
  };
}

module.exports = {
  GARG_DEFAULT_ORIGIN,
  GARG_ACCENT,
  slugFromHost,
  resolveUnifiedTenant,
};
