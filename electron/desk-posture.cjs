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
 * Present policy is part of the posture, and it must NAME its choice: desk-posture returning
 * "auto" while present-policy.cjs read `posture.present === "gpu"` made the GPU branch dead
 * (plan 2027 slice S1, 2026-11-18). So:
 *
 *   owner (the fleet box):    software present — measured stall-free there, because the fleet
 *                             polls that adapter (present-policy.cjs docblock: 0 stalls vs
 *                             3-6 per 10 s when the swap chain lands on the dGPU). 487 MB.
 *   customer (a workspace):   GPU present — nothing polls the customer's adapter, and software
 *                             compositing copies every frame GPU→CPU before DWM sees it.
 *
 * Which posture: AWDESK_POSTURE=owner|customer wins; otherwise a tenant host other than
 * the apex (desk-tenant.cjs, written by the setup page's installer) means customer.
 * Pure: no electron, no fs.
 */

const APEX_HOSTS = new Set(["aitherium.com", "www.aitherium.com", "app.aitherium.com"]);

/** @returns {{customer: boolean, reason: string, priority: "normal"|"above", present: "auto"|"software"|"gpu",
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
    // The platform owner looking INTO a customer workspace from his own box ("Open a
    // workspace": desk-tenant's `ownerSwitch`) is still on the owner's machine. Measured
    // 2026-11-22: the fleet box had carried garg.aitherium.com as an owner-switch since
    // 11-12, ran the customer budget (3000 MB) and restarted itself twice in nine minutes
    // ("it was using 3004 MB"); a third time would have quit it for ten.
    const ownerSwitch = Boolean(tenant && tenant.ownerSwitch === true);
    customer = Boolean(host) && !APEX_HOSTS.has(host) && !ownerSwitch;
    reason = customer ? `workspace install (${host})`
      : ownerSwitch && host ? `the owner's box, looking into ${host}` : "no workspace host";
  }
  return {
    customer,
    reason,
    priority: customer ? "normal" : "above",
    present: customer ? "gpu" : "software",
    throttle: customer,
    lendByDefault: !customer,
  };
}

module.exports = { APEX_HOSTS, deskPosture };
