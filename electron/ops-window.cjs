"use strict";

/**
 * ops-window.cjs — the Ops pane's standalone twin, and the owner of its IPC.
 *
 * Same shape as sessions-window.cjs (ensure<X>Ipc/create/close/isOpen): the
 * handlers live HERE, not in console-window.cjs, so a detached Ops window works
 * even if the console never opened this session.
 *
 * Transport: ops-client.cjs -> gateway-mcp.cjs, nothing else. Every handler
 * answers {ok:true, data} or {ok:false, error} and never throws across the
 * bridge -- a pane that shows "error: HTTP 503" beats one that shows nothing.
 *
 * The pane may only PLAN/RUN the ops in RUNNABLE_OPS. backups.restore is
 * destructive and deliberately not reachable from the desk; approval of a
 * guarded run happens in Veil/ActionHub, never here.
 */

const path = require("node:path");

function electron() {
  return require("electron");
}

const RUNNABLE_OPS = Object.freeze(["backups.state", "backups.verify", "backups.run"]);
const DELEGATES = Object.freeze(["", "genesis"]);

let opsWindow = null;
let wired = false;
let clientImpl = null;

function client() {
  if (!clientImpl) clientImpl = require("./ops-client.cjs");
  return clientImpl;
}

async function answer(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

function checkOp(op, delegateTo) {
  const id = String(op || "");
  if (!RUNNABLE_OPS.includes(id)) throw new Error(`op ${id || "(none)"} is not runnable from the desk`);
  const who = String(delegateTo || "");
  if (!DELEGATES.includes(who)) throw new Error(`cannot delegate to ${who}`);
  return { id, who };
}

/** The handler table, pure over an injected client so it is testable without Electron. */
function opsHandlers(ops = client()) {
  return {
    "desk:ops-catalog": () => answer(() => ops.catalog()),
    "desk:ops-state": (_e, noun) => answer(() => ops.state(String(noun || "backups"))),
    "desk:ops-plan": (_e, op, opts) => answer(() => {
      const { id, who } = checkOp(op, opts && opts.delegateTo);
      return ops.plan(id, "", { delegateTo: who });
    }),
    "desk:ops-run": (_e, op, opts) => answer(() => {
      const { id, who } = checkOp(op, opts && opts.delegateTo);
      return ops.run(id, "", { delegateTo: who });
    }),
    "desk:ops-status": (_e, query) => answer(() => ops.status(
      typeof query === "string" ? query : { noun: (query && query.noun) || "backups", limit: (query && query.limit) || 20 })),
    "desk:ops-cancel": (_e, runId) => answer(() => ops.cancel(String(runId || ""))),
    // Live run view: main polls, the frame that asked hears every change.
    "desk:ops-watch": (event, runId) => answer(() => ops.watch(String(runId || ""), (run, error) => {
      const sender = event && event.sender;
      if (!sender || (typeof sender.isDestroyed === "function" && sender.isDestroyed())) return;
      try {
        sender.send("desk:ops-run-update", { runId: String(runId || ""), run: run || null,
          error: error ? String(error.message || error) : null });
      } catch { /* a frame mid-navigation */ }
    }, { intervalMs: 2000, timeoutMs: 15 * 60 * 1000 })),
  };
}

function ensureOpsIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(opsHandlers())) ipcMain.handle(channel, handler);
}

function createOpsWindow() {
  ensureOpsIpc();
  const { BrowserWindow } = electron();
  if (opsWindow && !opsWindow.isDestroyed()) {
    opsWindow.show();
    opsWindow.focus();
    return opsWindow;
  }
  opsWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 640,
    minHeight: 460,
    show: false,
    title: "Aither Ops",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "ops-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  opsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  opsWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  opsWindow.once("ready-to-show", () => {
    opsWindow.show();
    opsWindow.focus();
  });
  opsWindow.on("closed", () => {
    opsWindow = null;
  });
  void opsWindow.loadFile(path.join(__dirname, "ops.html"));
  return opsWindow;
}

function closeOpsWindow() {
  if (opsWindow && !opsWindow.isDestroyed()) opsWindow.close();
}

function isOpsWindowOpen() {
  return Boolean(opsWindow && !opsWindow.isDestroyed());
}

module.exports = {
  ensureOpsIpc, createOpsWindow, closeOpsWindow, isOpsWindowOpen, opsHandlers, RUNNABLE_OPS,
};
