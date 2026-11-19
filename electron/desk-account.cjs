"use strict";

/**
 * desk-account.cjs -- "which account, which workspace" for every Desk surface.
 *
 * Customer report, 2026-11-19: an "Aitherium" workspace kept appearing on his Desk,
 * he could not tell whether he was in his company's workspace or the Aitherium platform
 * app, which account was signed in, or how to pick another. The Desk already KNEW all of
 * it (desk-tenant-auto.cjs: Identity /auth/me + the host's public config.js) and said none
 * of it. This module turns what it knows into:
 *
 *   indicator(...)        one line + tooltip: "<workspace> -- <account email>", the
 *                         workspace named by ITS OWN brand (config.js), "Aitherium" on
 *                         the apex; flags a workspace the account is not a member of.
 *   loadWorkspaceBrand()  the tenant's brand from its public config.js, with its logo
 *                         (favicon, else logo_url) fetched from THAT host as a data: URI
 *                         the rail can show under its `img-src data:` CSP.
 *   choiceDialog()        the "which workspace?" prompt (sign-in with several
 *                         memberships, and "Choose workspace…") as a message-box model.
 *
 * Membership is never decided here: it is `identity.memberships` from the authenticated
 * /auth/me answer (desk-tenant-auto.tenantIdentity). No customer name or host is compiled
 * in (Desk is a public build). Electron-free, every edge injected: desk-account.test.cjs.
 */

const deskTenant = require("./desk-tenant.cjs");
const tenantAuto = require("./desk-tenant-auto.cjs");

const APEX_NAME = "Aitherium";
const MAX_NAME = 64;
const MAX_LOGO_BYTES = 64 * 1024;
const LOGO_TYPES = Object.freeze(["image/svg+xml", "image/png", "image/webp"]);
const FETCH_TIMEOUT_MS = 8000;

function cleanText(raw, max = MAX_NAME) {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, max);
}

/**
 * The account + workspace the Desk is in, as one model every surface renders.
 *   account  living-desktop-window accountStatus() ({signedIn, username, email?, memberships?})
 *   tenant   desk-tenant currentTenant() (null = the Aitherium apex)
 *   brand    loadWorkspaceBrand() result for tenant.host, or null
 * Resolves { signedIn, who, workspace: {name, host, apex, accent?, logo?}, member, line, tooltip }.
 * `member`: true/false when Identity's membership list can say, null when it cannot
 * (the apex, a hand-written tenant without an id, nobody signed in).
 */
function indicator({ account, tenant, brand } = {}) {
  const signedIn = Boolean(account && account.signedIn);
  const who = signedIn ? cleanText(account.email || account.username || "", 254) || "signed in" : "";
  const apex = !(tenant && tenant.host);
  const name = apex
    ? APEX_NAME
    : cleanText(brand && brand.name) || cleanText(tenant.name) || tenant.host;
  const workspace = { name, host: apex ? deskTenant.APEX_HOST : tenant.host, apex };
  const accent = (brand && brand.accent) || (tenant && tenant.accent);
  if (typeof accent === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(accent)) workspace.accent = accent;
  if (brand && typeof brand.logo === "string" && brand.logo.startsWith("data:image/")) workspace.logo = brand.logo;
  let member = null;
  if (signedIn && !apex && tenant.tenantId && Array.isArray(account.memberships)) {
    member = tenantAuto.isMemberOf({ tenantId: "", memberships: account.memberships }, tenant.tenantId);
  }
  const line = !signedIn
    ? `${name} — not signed in`
    : member === false ? `${name} — ${who} (not a member)` : `${name} — ${who}`;
  const tooltip = [
    `Workspace: ${name} (${workspace.host})`,
    signedIn ? `Account: ${who}` : "Account: not signed in",
    ...(member === false ? ["This account is not a member of this workspace: Switch account"] : []),
  ].join("\n");
  return { signedIn, who, workspace, member, line, tooltip };
}

async function fetchWithTimeout(url, init, { fetchImpl, timeoutMs }) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, { ...init, signal: ctl ? ctl.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A same-host image asset as a data: URI (svg/png/webp, <= 64 KB), or null. */
async function fetchLogo(host, assetPath, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (typeof assetPath !== "string" || !/^\/[A-Za-z0-9._\-/]{1,200}$/.test(assetPath) || assetPath.includes("..")) return null;
  try {
    const res = await fetchWithTimeout(`https://${host}${assetPath}`,
      { redirect: "manual", credentials: "omit", cache: "no-store" }, { fetchImpl, timeoutMs });
    if (!res || res.status !== 200) return null;
    const type = String((res.headers && typeof res.headers.get === "function" && res.headers.get("content-type")) || "")
      .split(";")[0].trim().toLowerCase();
    if (!LOGO_TYPES.includes(type)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The workspace's brand from ITS host: name/accent from config.js, the logo (favicon,
 * else logo_url) from the same host. First-party (single label under aitherium.com)
 * hosts only, and only one whose config.js declares a tenant. Resolves
 * {name?, accent?, logo?} or null. Never throws.
 */
async function loadWorkspaceBrand(host, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const verdict = deskTenant.validateHost(host);
  if (!verdict.ok || !verdict.firstParty || verdict.host === deskTenant.APEX_HOST) return null;
  const text = await tenantAuto.fetchConfigJs(verdict.host, { fetchImpl, timeoutMs });
  if (!tenantAuto.declaredTenant(text)) return null;
  const brand = tenantAuto.declaredBrand(text);
  const out = {};
  const name = cleanText(brand.name);
  if (name) out.name = name;
  if (brand.accent) out.accent = brand.accent;
  for (const asset of [brand.favicon, brand.logo]) {
    if (!asset) continue;
    const logo = await fetchLogo(verdict.host, asset, { fetchImpl, timeoutMs });
    if (logo) { out.logo = logo; break; }
  }
  return out;
}

/**
 * The "which workspace?" prompt as a message-box model: one button per workspace (the
 * open one marked), then Cancel. `pick(index)` maps the clicked button back to a tenant
 * id FROM THE LIST, or null (Cancel / anything else).
 */
function choiceDialog(workspaces, { currentHost = "", who = "" } = {}) {
  const rows = (Array.isArray(workspaces) ? workspaces : []).filter((w) => w && w.tenantId && w.host);
  const buttons = rows.map((w) => {
    const name = cleanText(w.name) || w.host;
    return w.host === currentHost ? `${name} (open now)` : name;
  });
  buttons.push("Cancel");
  return {
    title: "Choose a workspace",
    message: who ? `${cleanText(who, 254)} belongs to ${rows.length} workspaces. Which one should Aither open?`
      : `This account belongs to ${rows.length} workspaces. Which one should Aither open?`,
    detail: rows.map((w) => `${cleanText(w.name) || w.host} — ${w.host}`).join("\n"),
    buttons,
    cancelId: buttons.length - 1,
    defaultId: 0,
    pick: (index) => (Number.isInteger(index) && index >= 0 && index < rows.length ? rows[index].tenantId : null),
  };
}

module.exports = {
  APEX_NAME, MAX_LOGO_BYTES, LOGO_TYPES,
  indicator, fetchLogo, loadWorkspaceBrand, choiceDialog,
};
