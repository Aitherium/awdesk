"use strict";

/**
 * local-stack-window.cjs — the "Install the full local stack" window (tray, palette, and
 * on its own once after "Connect this computer"). All logic lives in local-stack.cjs; this
 * only wires a sandboxed window to it. The renderer sees three verbs and gets step rows
 * and redacted log lines back, never a token.
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const { LocalStack } = require("./local-stack.cjs");

function createLocalStackWindow({ BrowserWindow, ipcMain, shell, dataDir, log = () => {} }) {
  let win = null;
  const stack = new LocalStack({
    spawn,
    openExternal: (url) => shell.openExternal(url),
    stateFile: path.join(dataDir, "local-stack", "state.json"),
    log,
  });
  stack.on("progress", (ev) => {
    if (ev.kind === "line") log(`local-stack: ${ev.line}`);
    if (win && !win.isDestroyed()) win.webContents.send("local-stack:progress", ev);
  });

  const mine = (event) => Boolean(win && event.sender === win.webContents);
  ipcMain.handle("local-stack:state", (event) => (mine(event) ? stack.snapshot() : null));
  ipcMain.handle("local-stack:run", (event) => {
    if (!mine(event)) return null;
    void stack.run();
    return stack.snapshot();
  });
  ipcMain.on("local-stack:close", (event) => { if (mine(event)) win.close(); });

  function open() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return win;
    }
    win = new BrowserWindow({
      width: 560,
      height: 620,
      title: "Install the full local stack",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "local-stack-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.on("closed", () => { win = null; });
    win.loadFile(path.join(__dirname, "local-stack.html"));
    return win;
  }

  /** After "Connect this computer" (and on a launch where that already happened): once. */
  function maybeAutoStart() {
    if (!stack.maybeAutoStart()) return false;
    open();
    return true;
  }

  return { open, maybeAutoStart, stack };
}

module.exports = { createLocalStackWindow };
