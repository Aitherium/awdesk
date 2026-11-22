"use strict";

/**
 * browser-client — Aitheros Online awareness: aitherbrowser/aitherdesktop
 * over the shared gateway-mcp transport (owner 2026-08-25: "full FULL
 * SYSTEM AWARENESS"). This is the desk's answer to "what is the user
 * looking at right now":
 *
 *   - the focused window      — sampled on THIS host (host-context.cjs);
 *                               gateway get_active_window only as fallback
 *   - browser_context         — structured agent-friendly content from the
 *                               active browser tab (Aitheros Online)
 *   - browser_context_history — what pages the user has visited
 *
 * Fails soft like every desk client: a dead gateway yields ok:true with
 * ERROR notes, never a half-truth (security-review-patterns #5). The
 * raw-content functions are exported for the IPC bridge; desktopSnapshot is
 * the one call the deck section makes.
 */

const { callTool, parseMaybeJson } = require("./gateway-mcp.cjs");
const { sampleHostContext } = require("./host-context.cjs");

async function activeWindow(call = callTool) {
  const text = await call("get_active_window", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

async function browserContext(call = callTool) {
  const text = await call("browser_context", {});
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

async function browserHistory(limit = 10, call = callTool) {
  const text = await call("browser_context_history", { limit });
  return parseMaybeJson(text) ?? { note: text.slice(0, 300) };
}

/**
 * The focused window, from the HOST first. The desk runs on the owner's machine;
 * the gateway's `get_active_window` runs inside a Linux container and so answers
 * `available:false` ("requires Windows platform") on every machine. The local
 * sample is therefore the primary source, and the gateway is only a fallback
 * when the host probe fails. A failed host probe is never hidden: its reason
 * rides along as `hostReason` so an unavailable line names both causes.
 */
async function focusedWindow(call, sampleHost) {
  let host;
  try {
    host = await sampleHost();
  } catch (error) {
    host = { ok: false, reason: String(error?.message || error) };
  }
  if (host?.ok === true && Number(host.pid) > 0) {
    return {
      available: true,
      source: "host",
      process: host.app || host.exe || `pid ${host.pid}`,
      title: host.title || "",
      pid: host.pid,
      exe: host.exe || "",
      platform: host.platform,
    };
  }
  const hostReason = String(host?.reason || "host probe gave no answer").slice(0, 300);
  const text = await call("get_active_window", {}).catch((error) => `ERROR: ${error.message}`);
  const gateway = parseMaybeJson(text) ?? { note: String(text).slice(0, 300) };
  if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
    return { ...gateway, source: "gateway", hostReason };
  }
  return { note: String(text).slice(0, 300), source: "gateway", hostReason };
}

/** One Aitheros Online snapshot: the focused window + the active tab. */
async function desktopSnapshot(call = callTool, sampleHost = sampleHostContext) {
  try {
    const [window, contextText] = await Promise.all([
      focusedWindow(call, sampleHost),
      call("browser_context", {}).catch((error) => `ERROR: ${error.message}`),
    ]);
    return {
      ok: true,
      window,
      context: parseMaybeJson(contextText) ?? { note: contextText.slice(0, 300) },
      at: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = { activeWindow, browserContext, browserHistory, desktopSnapshot };

if (require.main === module) {
  // Self-test: read-only. Exit 0 = desktop context available, 1 = the
  // platform reports it unavailable (available:false envelopes) or the
  // transport is down, 2 = module broken. An unavailable source is a
  // feature-block, never a quiet zero.
  (async () => {
    try {
      const snap = await desktopSnapshot();
      if (!snap.ok) {
        console.error(`DESKTOP UNAVAILABLE: ${snap.reason}`);
        process.exit(1);
      }
      const winBlocked = snap.window?.available === false
        || snap.window?.note?.startsWith("ERROR:");
      const ctxBlocked = snap.context?.available === false
        || snap.context?.note?.startsWith("ERROR:");
      if (winBlocked || ctxBlocked) {
        const why = (winBlocked && snap.window.message) || (ctxBlocked && snap.context.message)
          || (winBlocked && snap.window.reason) || (ctxBlocked && snap.context.reason)
          || (winBlocked && snap.window.note) || (ctxBlocked && snap.context.note)
          || "platform";
        console.error(`DESKTOP UNAVAILABLE: ${why}`);
        process.exit(1);
      }
      const win = typeof snap.window === "object" ? Object.keys(snap.window).length : "?";
      const ctx = typeof snap.context === "object" ? Object.keys(snap.context).length : "?";
      console.log(`DESKTOP OK: ${win} window key(s), ${ctx} context key(s)`);
      process.exit(0);
    } catch (error) {
      console.error(`MODULE BROKEN: ${error && error.stack ? error.stack : error}`);
      process.exit(2);
    }
  })();
}
