"use strict";

/**
 * Preload for the Aither Browser's taskbar strip (browser-taskbar.cjs: Veil's /embed/taskbar
 * in a view of its own). Owner, 2026-10-28: a terminal button on the taskbar for the
 * browser's bottom terminal dock.
 *
 * The strip used to have NO bridge (it spoke only by navigation and its title). This one is
 * deliberately tiny -- the "desk" plane of aither-host/1 and nothing else:
 *   - it marks the document data-aither-host="desk" (Veil's hasDeskHost), and NOT
 *     data-host="desk": that flag hides [data-os-dock], which here IS the page;
 *   - it answers os-hello with a host-hello naming only the desk plane;
 *   - it relays main's desk-state ({commands, terminalDock}) into the page, so Veil draws a
 *     button only for a command this desk answers (useDeskCommands);
 *   - it forwards a desk-command only when the id is in TASKBAR_COMMANDS and a real click
 *     happened moments ago (user activation). browser-window.cjs fences the IPC to the
 *     strip's own webContents and checks the id again.
 *
 * Sandboxed: require("electron") only. host-protocol.test.cjs runs it in a vm.
 */

const { ipcRenderer } = require("electron");

const HOST_PROTOCOL = "aither-host/1";
/** The desk commands the strip may send. A subset of aither-host-protocol.json deskCommands. */
const TASKBAR_COMMANDS = Object.freeze(["terminal-dock.toggle"]);

function markHost() {
  const d = document.documentElement;
  if (d) d.setAttribute("data-aither-host", "desk");
}
markHost();
window.addEventListener("DOMContentLoaded", markHost);
window.addEventListener("load", markHost);

ipcRenderer.on("desk:taskbar-state", (_event, payload) => {
  markHost(); // hydration may have stripped the attribute
  const commands = Array.isArray(payload && payload.commands)
    ? payload.commands.filter((c) => TASKBAR_COMMANDS.includes(c)) : [];
  const open = Boolean(payload && payload.terminalDock && payload.terminalDock.open);
  window.postMessage({ __aither: "desk-state", commands, terminalDock: { open } }, window.location.origin);
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data.__aither !== "string") return;
  if (data.__aither === "os-hello") {
    window.postMessage({ __aither: "host-hello", protocol: HOST_PROTOCOL, host: "desk", planes: ["desk"],
      chrome: { taskbar: "os" } }, window.location.origin);
    ipcRenderer.send("desk:taskbar-hello");
  } else if (data.__aither === "desk-command") {
    const id = String(data.id || "");
    if (!TASKBAR_COMMANDS.includes(id)) return;
    const activation = navigator.userActivation;
    if (!activation || !activation.isActive) return;
    ipcRenderer.send("desk:taskbar-command", id);
  }
});
