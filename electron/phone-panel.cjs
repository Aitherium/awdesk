"use strict";

/**
 * phone-panel -- "This phone": the window the "Phone connected" toast opens.
 *
 * Owner, 2026-11-16: he clicked the toast and nothing happened. The click now links the
 * cable (phone-link.cjs) and ALWAYS opens this panel, so there is a visible outcome whether
 * the link worked, needs the owner's tap on the phone, or failed: it names the next step in
 * plain words and lists what the phone can do for Aither, each row honest about whether it
 * works now, works inside the Aither app, or does not exist yet.
 *
 * describePhone() is pure (the test pins every state); the window and IPC at the bottom are
 * the audio-control.cjs shape: one window, one set of channels, only that window may call them.
 */

const path = require("node:path");

const VERBS = Object.freeze(["link", "unlink", "open-app", "capture", "forget"]);

/** What the phone can do for Aither. `state` is per-link; see describePhone. */
function capabilitiesFor(status) {
  const linked = status === "linked";
  const noCable = status === "unplugged" || status === "unauthorized" || status === "offline";
  return [
    {
      id: "control", label: "Drive this PC from the phone",
      detail: "Show or hide the desktop, open tabs and terminals, start agent tasks, swap files and the clipboard.",
      state: linked ? "ready" : "after-link",
    },
    {
      id: "notifications", label: "Notifications",
      detail: "Aither's decisions and alerts reach the phone as notifications while the Aither app is installed. Reading the phone's own notifications is not built.",
      state: "in-app",
    },
    {
      id: "voice", label: "Voice",
      detail: "Talk to Aither from the phone: the app's assistant and microphone. Wake-word listening is not on by default.",
      state: "in-app",
    },
    {
      id: "camera", label: "Camera as eyes",
      detail: "Point the camera and ask Aither what it sees (Describe, and pages that ask for the camera). It asks before every use.",
      state: "in-app",
    },
    {
      id: "screen", label: "Screen",
      detail: "Capture what is on the phone's screen over the cable and keep it in Downloads > From phone. Live screen sharing is not built yet.",
      state: noCable ? "needs-cable" : "ready",
      action: "capture",
    },
  ];
}

/**
 * The panel's whole state from what the desk knows.
 *   phone: {serial, state, model} from phone-usb, or null (unplugged)
 *   link:  {serial, deviceId, model} from phone-link.links(), or undefined
 *   busy / error: the act in flight / its failure, in words
 *   lastCapture: path of the last screen capture
 */
function describePhone({ phone = null, link, busy = "", error = "", lastCapture = "" } = {}) {
  const model = (phone && phone.model) || (link && link.model) || "your phone";
  let status;
  let headline;
  let next;
  if (!phone) {
    status = "unplugged";
    headline = `${model} is not connected`;
    next = "Plug the phone in with its USB cable.";
  } else if (phone.state === "unauthorized") {
    status = "unauthorized";
    headline = `${model} is waiting for you`;
    next = "On the phone, tap Allow on the USB debugging prompt, then come back here.";
  } else if (phone.state !== "device") {
    status = "offline";
    headline = `${model} is ${phone.state}`;
    next = "Unplug and re-plug the cable, and unlock the phone.";
  } else if (link && link.deviceId) {
    status = "linked";
    headline = `${model} is linked to Aither`;
    next = "It is ready. Use the rows below.";
  } else if (link) {
    status = "waiting-app";
    headline = `${model} is connected`;
    next = "Open Aither on the phone and tap Use this PC. Say Allow here when this PC asks.";
  } else {
    status = "not-linked";
    headline = `${model} is connected`;
    next = "Link it so the phone can use this PC.";
  }
  const verbs = [];
  if (phone && phone.state === "device") {
    if (!link) verbs.push({ verb: "link", label: "Use this phone with Aither", primary: true });
    else {
      verbs.push({ verb: "open-app", label: "Open Aither on the phone", primary: !link.deviceId });
      verbs.push({ verb: "unlink", label: "Unlink" });
      if (link.deviceId) verbs.push({ verb: "forget", label: "Forget this phone" });
    }
  }
  return {
    serial: (phone && phone.serial) || (link && link.serial) || "",
    model, status, headline, next,
    busy: String(busy || ""), error: String(error || ""), lastCapture: String(lastCapture || ""),
    verbs, capabilities: capabilitiesFor(status),
  };
}

// ── window + IPC ────────────────────────────────────────────────────────────────

let wired = false;
let win = null;
let deps = { snapshot: async () => describePhone(), act: async () => ({ ok: false, error: "phone panel not configured" }) };
let current = { serial: "", busy: "", error: "", lastCapture: "" };

function electron() {
  return require("electron");
}

/** main.cjs injects `snapshot(serial, ctx) -> describePhone(...)` and `act(serial, verb) -> {ok, error?, file?}`. */
function configurePhonePanel(next = {}) {
  deps = { ...deps, ...next };
}

async function state() {
  return deps.snapshot(current.serial, current);
}

async function refresh() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send("phone-panel:changed", await state()); } catch { /* window closing */ }
}

function fromPanel(event) {
  const sender = event && event.sender;
  try { return Boolean(win && !win.isDestroyed() && sender && win.webContents === sender); } catch { return false; }
}

function ensureWired() {
  if (wired) return;
  wired = true;
  const { ipcMain } = electron();
  ipcMain.handle("phone-panel:state", async (event) => (fromPanel(event) ? state() : describePhone()));
  ipcMain.handle("phone-panel:act", async (event, verb) => {
    if (!fromPanel(event)) return { ok: false, error: "not the phone panel" };
    if (!VERBS.includes(verb)) return { ok: false, error: "unknown action" };
    current = { ...current, busy: verb, error: "" };
    void refresh();
    let r;
    try {
      r = await deps.act(current.serial, verb);
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    current = {
      ...current, busy: "", error: r && r.ok === false ? String(r.error || "failed").slice(0, 300) : "",
      lastCapture: r && r.file ? String(r.file) : current.lastCapture,
    };
    await refresh();
    return { ok: !(r && r.ok === false), error: current.error };
  });
  ipcMain.handle("phone-panel:close", (event) => { if (fromPanel(event)) win.close(); return true; });
}

/** Open (or raise) the panel for one phone. `show:false` builds it hidden (tests). */
function openPhonePanel(serial, { show = true } = {}) {
  let BrowserWindow;
  try {
    ({ BrowserWindow } = electron());
  } catch { return null; }
  current = { ...current, serial: String(serial || ""), error: "" };
  ensureWired();
  if (win && !win.isDestroyed()) {
    if (show) { win.show(); win.focus(); }
    void refresh();
    return win;
  }
  win = new BrowserWindow({
    width: 480, height: 680, minWidth: 380, minHeight: 480,
    show: false, backgroundColor: "#050507", title: "This phone", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "phone-panel-preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => { if (show && win && !win.isDestroyed()) { win.show(); win.focus(); } });
  win.on("closed", () => { win = null; });
  void win.loadFile(path.join(__dirname, "phone-panel.html"));
  return win;
}

module.exports = {
  VERBS, capabilitiesFor, configurePhonePanel, describePhone, fromPanel, openPhonePanel, refreshPhonePanel: refresh,
};
