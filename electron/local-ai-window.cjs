"use strict";

/**
 * local-ai-window.cjs -- main's half of aither://local-ai (local-ai.html): the channels
 * the Local AI page uses, and the offline watch that points the person at it.
 * Every decision lives in local-ai.cjs; this only wires it to Electron.
 */

const localAi = require("./local-ai.cjs");

let wired = false;
let aiImpl = null;
const ai = () => aiImpl || (aiImpl = localAi.createLocalAi({ log: (l) => console.log(`[desk] ${l}`) }));

function tenantHost() {
  try {
    const t = require("./desk-tenant.cjs").currentTenant();
    return t && typeof t.host === "string" ? t.host : "";
  } catch {
    return "";
  }
}

/** The Local AI page, as a pane (aither://local-ai) or its file (console iframe). */
function fromLocalAiPage(event) {
  const urls = [event && event.senderFrame && event.senderFrame.url,
    event && event.sender && typeof event.sender.getURL === "function" ? event.sender.getURL() : ""];
  return urls.some((raw) => {
    try {
      const url = new URL(String(raw || ""));
      if (url.protocol === "aither:") return url.hostname === "local-ai";
      return url.protocol === "file:" && url.pathname.endsWith("/electron/local-ai.html");
    } catch {
      return false;
    }
  });
}

/** Where a chat should go right now, with what the page shows about it. */
async function route(a = ai(), { probe = localAi.probeCloud, host = tenantHost } = {}) {
  const h = host();
  const [cloud, s] = await Promise.all([probe(h), a.status()]);
  const local = { installed: Boolean(s && s.ok && s.installed), running: Boolean(s && s.ok && s.running) };
  return { ...localAi.decideChatTarget(cloud, local), cloud, workspace: h || null,
    port: (s && s.port) || localAi.DEFAULT_PORT, local: s, localNote: localAi.COPY.localOnly };
}

function localAiHandlers(a = ai(), { isPage = fromLocalAiPage, probe, host } = {}) {
  const guard = (fn) => async (event, ...args) => {
    if (!isPage(event)) return { ok: false, error: "not the Local AI page" };
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  return {
    "desk:localai-status": guard(() => a.status()),
    "desk:localai-install": guard((model) => a.install(String(model || ""))),
    "desk:localai-remove": guard(() => a.remove()),
    "desk:localai-job": guard(() => a.jobStatus()),
    "desk:localai-chat": guard((messages, port) => a.chat(messages, Number(port) || localAi.DEFAULT_PORT)),
    "desk:localai-route": guard(() => route(a, { probe, host })),
  };
}

function ensureLocalAiIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(localAiHandlers())) ipcMain.handle(channel, handler);
}

/** Toast once when the workspace drops and the local model can answer. `open` shows the page. */
function startOfflineWatch(open) {
  const { Notification } = require("electron");
  return localAi.createOfflineWatch({
    tenantHost,
    probe: (h) => localAi.probeCloud(h),
    local: () => localAi.localRunning(),
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on("click", onClick);
      n.show();
    },
    open,
  }).start();
}

module.exports = { localAiHandlers, ensureLocalAiIpc, fromLocalAiPage, route, startOfflineWatch };
