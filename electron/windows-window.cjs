"use strict";

/**
 * windows-window.cjs -- aither://windows: main's half (window-manager.cjs). main tells it
 * which windows have names of their own (setRegistered: browser, avatar, overlay, popped
 * tabs); every other desk window is listed by its title. Answers only aither://windows.
 */

const { createWindowManager } = require("./window-manager.cjs");

let wired = false;
let registeredImpl = () => ({});
let mgr = null;
const manager = () => mgr || (mgr = createWindowManager({ registered: () => registeredImpl() }));

function setRegistered(fn) {
  registeredImpl = typeof fn === "function" ? fn : () => ({});
}

function fromWindowsPage(sender) {
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "windows";
  } catch {
    return false;
  }
}

function windowsHandlers(m = manager(), { isPage = fromWindowsPage } = {}) {
  const guard = (fn) => async (event, ...args) => {
    if (!event || !event.sender || !isPage(event.sender)) return { ok: false, error: "not the windows page" };
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  return {
    "desk:windows-state": guard(() => ({ ok: true, windows: m.list(), displays: m.displays(), layouts: m.layouts() })),
    "desk:windows-move": guard((key, displayId) => m.moveTo(String(key), Number(displayId))),
    "desk:windows-show": guard((key) => m.show(String(key))),
    "desk:windows-hide": guard((key) => m.hide(String(key))),
    "desk:windows-ontop": guard((key, on) => m.setOnTop(String(key), Boolean(on))),
    "desk:windows-save": guard((name) => m.save(String(name || "").trim())),
    "desk:windows-restore": guard((name) => m.restore(String(name))),
    "desk:windows-remove": guard((name) => m.remove(String(name))),
  };
}

function ensureWindowsIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(windowsHandlers())) ipcMain.handle(channel, handler);
}

module.exports = { ensureWindowsIpc, fromWindowsPage, manager, setRegistered, windowsHandlers };
