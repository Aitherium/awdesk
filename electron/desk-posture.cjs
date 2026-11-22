"use strict";

/**
 * desk-posture -- is this Desk on the OWNER's machine or on a CUSTOMER's?
 *
 * Several defaults were measured and tuned on the owner's fleet box, where Desk shares a
 * saturated CPU and a contended GPU with the fleet:
 *
 *   process-priority.cjs   every Desk process at ABOVE_NORMAL
 *   present-policy.cjs     software compositing + the integrated adapter on Windows
 *   main.cjs               renderer/occlusion backgrounding off (no 1 fps throttle)
 *   kv-lend.cjs            "Lend memory" on by default (2 GB, the fast GPU)
 *
 * On a customer's PC most of those are a cost with no reason: Garg's Desk measured
 * 2026-10-16 at 31.6 % CPU and 7 GB, and was killed from Task Manager. A workspace
 * (tenant) install therefore runs the light posture:
 *
 *   priority normal, Chromium throttling ON for hidden/occluded windows, Lend memory
 *   OFF until the user turns it on.
 *
 * Present stays SOFTWARE (present-policy.cjs auto), measured on the customer build with
 * the workspace overlay up on a 3840x2112 screen, avatar hidden (2026-10-16):
 *
 *   software present   487 MB private, 7.3 % of one core
 *   GPU present        797 MB private, 16.2 % of one core  (GPU process alone 491 MB)
 *
 * Which posture: AWDESK_POSTURE=owner|customer wins; otherwise a tenant host other than
 * the apex (desk-tenant.cjs, written by the setup page's installer) means customer.
 * Pure: no electron, no fs.
 */

const APEX_HOSTS = new Set(["aitherium.com", "www.aitherium.com", "app.aitherium.com"]);

/** @returns {{customer: boolean, reason: string, priority: "normal"|"above", present: "auto",
 *   throttle: boolean, lendByDefault: boolean}} */
function deskPosture({ env = process.env, tenant = null } = {}) {
  const asked = String((env && env.AWDESK_POSTURE) || "").trim().toLowerCase();
  let customer;
  let reason;
  if (asked === "owner" || asked === "customer") {
    customer = asked === "customer";
    reason = `AWDESK_POSTURE=${asked}`;
  } else {
    const host = tenant && typeof tenant.host === "string" ? tenant.host.toLowerCase() : "";
    customer = Boolean(host) && !APEX_HOSTS.has(host);
    reason = customer ? `workspace install (${host})` : "no workspace host";
  }
  return {
    customer,
    reason,
    priority: customer ? "normal" : "above",
    present: "auto", // measured: software present is lighter on a customer desk too (above)
    throttle: customer,
    lendByDefault: !customer,
  };
}

module.exports = { APEX_HOSTS, deskPosture };
