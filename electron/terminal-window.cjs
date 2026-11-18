"use strict";

/**
 * terminal-window.cjs -- main's half of aither://terminal (the awsh layer).
 *
 * The page asks; this answers over terminal-client.cjs and streams each attached
 * session's events back to the ONE webContents that attached it. Every handler
 * refuses a sender that is not an aither://terminal page: a shell is the most
 * powerful thing the desk can hand out, so no other pane, web tab or window may
 * reach these channels even if a preload were mis-wired.
 */

const { createTerminalClient } = require("./terminal-client.cjs");

function electron() {
  return require("electron");
}

let wired = false;
let clientImpl = null;
/**
 * The browser window's dock verbs (browser-window.cjs installs {run(action, arg)}):
 * open/close/toggle the bottom dock, pop a session out to a full terminal tab.
 */
let dockHost = null;
function setDockHost(host) {
  dockHost = host && typeof host.run === "function" ? host : null;
}
/**
 * Who hears about a session being attached or detached: the browser window records the
 * ids on the STAGE that was active (browser-window.cjs), so a stage remembers the shells
 * it was working in. Optional; absent everywhere but the browser.
 */
let sessionWatcher = null;
function setSessionWatcher(fn) {
  sessionWatcher = typeof fn === "function" ? fn : null;
}
/** `${webContentsId}:${sessionId}` -> AbortController of its stream. */
const streams = new Map();

function client() {
  if (!clientImpl) clientImpl = createTerminalClient();
  return clientImpl;
}

/** Is this sender the terminal page? (aither://terminal/, any path or query) */
function fromTerminalPage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "terminal";
  } catch {
    return false;
  }
}

function stopStream(key) {
  const ctl = streams.get(key);
  if (ctl) ctl.abort();
  streams.delete(key);
}

/** The handler table, pure over an injected client so it is testable without Electron. */
function terminalHandlers(c = client(), { isTerminal = fromTerminalPage, dock = () => dockHost, onSession = () => sessionWatcher } = {}) {
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !isTerminal(event.sender)) return { ok: false, error: "not the terminal page" };
    try {
      return await fn(event, ...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  /** Tell the watcher (the active stage's record) that a session came or went. Never breaks a session. */
  const note = (id, action) => {
    const watch = onSession();
    if (typeof watch !== "function") return;
    try { watch(String(id || ""), action); } catch { /* recording is bookkeeping, never terminal I/O */ }
  };
  return {
    "desk:terminal-harnesses": guard(() => c.harnesses()),
    /** Machines a node shell can open (ssh_config aliases + online tailnet peers). */
    "desk:terminal-nodes": guard(() => c.nodes()),
    "desk:terminal-list": guard(() => c.list()),
    /** Claude Code tabs the daemon DISCOVERED (not its own): resumable here, never typed into. */
    "desk:terminal-external": guard(() => c.external()),
    "desk:terminal-resume": guard((_e, id, cwd) => c.resume(id, { cwd })),
    /** The bottom dock's window verbs; a terminal page with no browser window gets a refusal. */
    "desk:terminal-dock": guard((_e, action, arg) => {
      const host = dock();
      if (!host) return { ok: false, error: "no browser window holds a terminal dock" };
      return host.run(String(action || ""), arg == null ? null : String(arg));
    }),
    "desk:terminal-create": guard((_e, opts) => c.create(opts || {})),
    "desk:terminal-input": guard((_e, id, text) => c.input(id, text)),
    "desk:terminal-resize": guard((_e, id, rows, cols) => c.resize(id, rows, cols)),
    "desk:terminal-interrupt": guard((_e, id) => c.interrupt(id)),
    "desk:terminal-close": guard(async (event, id) => {
      stopStream(`${event.sender.id}:${id}`);
      const closed = await c.close(id);
      // Only a session that really closed leaves the stage's list; a refusal keeps it.
      if (closed && closed.ok) note(id, "detach");
      return closed;
    }),
    /** Attach: stream events to this page from `since`; detach on page close or re-attach. */
    "desk:terminal-attach": guard((event, id, since) => {
      const sender = event.sender;
      const key = `${sender.id}:${id}`;
      stopStream(key);
      const ctl = new AbortController();
      streams.set(key, ctl);
      if (typeof sender.once === "function") sender.once("destroyed", () => stopStream(key));
      const send = (payload) => {
        if (!sender.isDestroyed || !sender.isDestroyed()) sender.send("desk:terminal-event", id, payload);
      };
      note(id, "attach");
      void c.stream(id, since, (ev) => send({ type: "event", event: ev }), ctl.signal).then((r) => {
        if (streams.get(key) === ctl) streams.delete(key);
        if (!ctl.signal.aborted) send({ type: "end", ok: Boolean(r && r.ok), error: r && r.error });
      });
      return { ok: true };
    }),
    "desk:terminal-detach": guard((event, id) => {
      stopStream(`${event.sender.id}:${id}`);
      note(id, "detach");
      return { ok: true };
    }),
  };
}

function ensureTerminalIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  for (const [channel, handler] of Object.entries(terminalHandlers())) ipcMain.handle(channel, handler);
}

module.exports = { ensureTerminalIpc, fromTerminalPage, setDockHost, setSessionWatcher, terminalHandlers };
