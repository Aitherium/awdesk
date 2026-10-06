"use strict";

/**
 * connections — is every piece of the Aither world on this machine actually joined up?
 *
 * Owner, 2026-10-03: integrate the desk with "aitherium.com/aitheros online/aitherdesktop
 * + awconnect + awsh/awdk/awnode". Each of those already works on its own; what the owner
 * could not see was WHICH of them is connected right now. Measured the same day: the adk
 * daemon answered healthy with `gateway_connected: false` -- running, and joined to
 * nothing -- and nothing on the desk said so.
 *
 * One row per link, with an action where the desk can fix it. Electron-free: `fetchJson`,
 * `linkStatus` and the awconnect status are injected so the verdicts are unit-tested.
 */

const LOCAL = Object.freeze({
  gateway: "http://127.0.0.1:8182/health", // awnode / AitherOS MCP gateway
  adk: "http://127.0.0.1:9001/health", // awdk daemon
  awsh: "http://127.0.0.1:8362/health", // awsh harness daemon
});

async function defaultFetchJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function probe(fetchJson, url) {
  try {
    return { ok: true, data: await fetchJson(url) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** Build every row. Never throws: a probe that fails IS the answer for its row. */
async function connections({ fetchJson = defaultFetchJson, linkStatus, awconnect } = {}) {
  const [gateway, adk, awsh, link] = await Promise.all([
    probe(fetchJson, LOCAL.gateway),
    probe(fetchJson, LOCAL.adk),
    probe(fetchJson, LOCAL.awsh),
    linkStatus ? linkStatus().catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }))
      : Promise.resolve({ ok: false, error: "not checked" }),
  ]);
  const rows = [];

  const ld = (link && link.ok && link.data) || {};
  rows.push({
    id: "account", label: "aitherium.com account",
    ok: Boolean(ld.linked),
    detail: !link || !link.ok ? `could not check (${(link && link.error) || "adk link"})`
      : ld.linked ? `linked as ${ld.username || "you"}${ld.role ? ` (${ld.role})` : ""}`
        : ld.signed_in ? "signed in on this machine, not linked to aitherium.com" : "not linked",
    action: ld.linked ? null : { id: "link", label: "Link" },
  });

  rows.push({
    id: "gateway", label: "AitherOS gateway (awnode / MCP)",
    ok: gateway.ok && gateway.data && gateway.data.status === "healthy",
    detail: gateway.ok ? `${gateway.data.status || "answered"} on :8182` : `not answering on :8182 (${gateway.error})`,
    action: null,
  });

  // The daemon's PLATFORM-TOOL attach is `tools` (mode/registered/last_error), not
  // `gateway_connected` -- that one is the opt-in cloud agent registry.
  const tools = (adk.ok && adk.data && adk.data.tools) || {};
  const adkJoined = adk.ok && tools.mode !== "builtin-only" && Number(tools.registered || 0) > 0;
  // A down (or un-attached) daemon points at the ONE door this product already has
  // for exactly this: "Install the full local stack" (local-stack.cjs -- desk
  // sign-in, setup code, install.sh, nothing typed). Owner 2026-10-05: the row said
  // "not answering on :9001" and offered no way to fix it from the desk.
  rows.push({
    id: "adk", label: "awdk daemon",
    ok: Boolean(adkJoined),
    detail: !adk.ok ? `not answering on :9001 (${adk.error}) — Set up installs it on this computer`
      : adkJoined ? `v${adk.data.version || "?"}, ${tools.registered} platform tools from the gateway`
        : `v${adk.data.version || "?"} running with built-in tools only`
          + (tools.last_error ? ` -- ${String(tools.last_error).slice(0, 160)}` : ""),
    action: adkJoined ? null : { id: "local.install", label: adk.ok ? "Fix" : "Set up" },
  });

  const awshUp = Boolean(awsh.ok && awsh.data && awsh.data.ok === true);
  rows.push({
    id: "awsh", label: "awsh harness daemon",
    ok: awshUp,
    detail: awsh.ok ? `${(awsh.data.harnesses_installed || []).length} harnesses, ${awsh.data.sessions ?? 0} sessions on :8362`
      : `not answering on :8362 (${awsh.error}) — Set up installs it on this computer`,
    action: awshUp ? { id: "console.open", label: "Sessions" }
      : { id: "local.install", label: "Set up" },
  });

  const state = awconnect && awconnect.state;
  rows.push({
    id: "awconnect", label: "awconnect browser extension",
    ok: state === "installed",
    detail: state ? state.replace(/_/g, " ") : "not checked yet",
    action: state === "installed" ? null : { id: "awconnect.setup", label: state ? "Fix" : "Check" },
  });

  return rows;
}

/** Action ids the Settings page may ask main to run. */
const RUNNABLE = Object.freeze(["link", "awconnect.setup", "console.open", "local.install"]);

module.exports = { connections, LOCAL, RUNNABLE };
