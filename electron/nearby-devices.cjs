"use strict";

/**
 * The "Nearby devices" window (nearby-devices.html): devices on this Wi-Fi that someone has
 * put in pairing mode (`_aither-pair._tcp`, see lan-pair.cjs). Listening runs only while the
 * window is open and never longer than 5 minutes per press of "Look again"; closing the
 * window stops it.
 *
 * Approve opens the signed-in approval page for that rid in the system browser, where the
 * member types the code the device shows and checks its 6-digit number. Desk holds no
 * approval authority: Identity decides (signed-in member, never a child account, the number
 * bound to the device's key, 3 wrong numbers deny the request). Only a rid that
 * is in the book right now can be handed over, so the page cannot ask main to open
 * arbitrary URLs.
 */

const path = require("node:path");

const lanPair = require("./lan-pair.cjs");

function defaultMdns() {
  // multicast-dns 7.x (MIT, github.com/mafintosh/multicast-dns); dns-packet, thunky and
  // @leichtgewicht/ip-codec are MIT as well. Lazy: Desk starts without it.
  const make = require("multicast-dns");
  return make({ reuseAddr: true });
}

function createNearbySession({ mdnsFactory = defaultMdns, now = Date.now, windowMs = lanPair.MAX_WINDOW_MS,
  setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, browse = lanPair.browse,
  onChange = () => {} } = {}) {
  let book = null;
  let mdns = null;
  let stopBrowse = null;
  let timer = null;
  let until = 0;

  function stop() {
    if (timer) ct(timer);
    timer = null;
    if (stopBrowse) stopBrowse();
    stopBrowse = null;
    if (mdns) { try { mdns.destroy(); } catch { /* closed */ } }
    mdns = null;
    until = 0;
  }

  function start() {
    stop();
    book = new lanPair.CandidateBook({ now });
    try {
      mdns = mdnsFactory();
    } catch {
      return { listening: false, error: "mdns-unavailable" };
    }
    if (mdns && typeof mdns.on === "function") mdns.on("error", () => stop());
    stopBrowse = browse(mdns, book, { onChange });
    until = now() + Math.min(windowMs, lanPair.MAX_WINDOW_MS);
    timer = st(stop, Math.min(windowMs, lanPair.MAX_WINDOW_MS));
    return { listening: true, until };
  }

  function state() {
    return { listening: Boolean(stopBrowse), until, devices: book ? book.list() : [] };
  }

  /** The approval URL for a rid that is listed right now, else null. */
  function approval(rid) {
    if (!book || typeof rid !== "string" || !book.has(rid)) return null;
    return lanPair.approveUrl(rid);
  }

  return { start, stop, state, approval };
}

function createNearbyDevices({ BrowserWindow, ipcMain, shell, sessionFactory = createNearbySession }) {
  let win = null;
  let session = null;
  const mine = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
  const push = (devices) => {
    if (win && !win.isDestroyed()) win.webContents.send("nearby:changed", devices);
  };

  ipcMain.handle("nearby:start", (event) => (mine(event) && session ? session.start() : null));
  ipcMain.handle("nearby:state", (event) => (mine(event) && session ? session.state() : null));
  ipcMain.handle("nearby:approve", (event, rid) => {
    if (!mine(event) || !session) return { ok: false };
    const url = session.approval(rid);
    if (!url) return { ok: false, reason: "gone" };
    void shell.openExternal(url);
    return { ok: true };
  });

  function open() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return win;
    }
    session = sessionFactory({ onChange: push });
    win = new BrowserWindow({
      width: 460,
      height: 520,
      title: "Nearby devices",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "nearby-devices-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.on("closed", () => {
      if (session) session.stop();
      session = null;
      win = null;
    });
    win.loadFile(path.join(__dirname, "nearby-devices.html"));
    return win;
  }

  return { open };
}

module.exports = { createNearbyDevices, createNearbySession };
