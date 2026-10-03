"use strict";

/**
 * The "Connect this computer" window (device-connect.html): the first-run path where no
 * desk:// link can arrive yet. A typed code goes through the same enrollment as a link
 * (device-identity.cjs: this computer's own key, the owner's single-use pairing code).
 */

const fs = require("node:fs");
const path = require("node:path");

const PAGE = "https://app.aitherium.com/family/device";
const CODE = /^[A-Z0-9]{6,16}$/;

function createDeviceConnect({ BrowserWindow, ipcMain, shell, runtime, dataDir }) {
  let win = null;
  const shownFlag = path.join(dataDir, "device", "connect-shown");

  ipcMain.handle("device-connect:enroll", async (event, code) => {
    if (!win || event.sender !== win.webContents) return { ok: false };
    const c = String(code || "").trim().toUpperCase();
    if (!CODE.test(c)) return { ok: false, status: 400 };
    return runtime.enrollCode(c);
  });
  ipcMain.handle("device-connect:open-page", (event) => {
    if (win && event.sender === win.webContents) void shell.openExternal(PAGE);
  });
  ipcMain.handle("device-connect:state", (event) => {
    if (!win || event.sender !== win.webContents) return null;
    const st = runtime.identity.enrolled();
    return st ? { deviceId: st.deviceId } : null;
  });

  function open() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return win;
    }
    win = new BrowserWindow({
      width: 520,
      height: 430,
      resizable: false,
      title: "Connect this computer",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "device-connect-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.on("closed", () => { win = null; });
    win.loadFile(path.join(__dirname, "device-connect.html"));
    return win;
  }

  /** On first run of an unconnected computer, once. */
  function maybeOpenFirstRun() {
    if (runtime.identity.enrolled() || fs.existsSync(shownFlag)) return false;
    try {
      fs.mkdirSync(path.dirname(shownFlag), { recursive: true });
      fs.writeFileSync(shownFlag, String(Date.now()));
    } catch { /* shown again next time: harmless */ }
    open();
    return true;
  }

  return { open, maybeOpenFirstRun };
}

module.exports = { CODE, PAGE, createDeviceConnect };
