"use strict";

/** The Chat window the AitherOS desktop pops out (Veil `/embed/chat`).
 *
 *  The living-desktop overlay is a frameless, transparent, work-area-sized window. A page
 *  in it that calls window.open() gets a child window cut from the same cloth unless the
 *  open handler says otherwise, so the chat would arrive as an invisible full-screen
 *  sheet. This decides what the Chat popout looks like: an ordinary framed window you can
 *  move, resize, minimise and alt-tab to, in the same partition (same sign-in) and with
 *  the same hardened webPreferences as the desktop. Anything else keeps the old answer. */

const CHAT_POPOUT_PATH = "/embed/chat";

function isChatPopoutUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return p === CHAT_POPOUT_PATH;
  } catch {
    return false;
  }
}

/** The setWindowOpenHandler answer for an aitherium-family URL. `base` is the preload and
 *  partition the opener already uses. */
function openHandlerAnswer(rawUrl, base) {
  if (!isChatPopoutUrl(rawUrl)) return { action: "allow" };
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      width: 880,
      height: 640,
      minWidth: 560,
      minHeight: 420,
      frame: true,
      transparent: false,
      hasShadow: true,
      roundedCorners: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      autoHideMenuBar: true,
      show: true,
      title: "Chat",
      backgroundColor: "#0a0a14",
      webPreferences: {
        partition: base.partition,
        preload: base.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  };
}

module.exports = { CHAT_POPOUT_PATH, isChatPopoutUrl, openHandlerAnswer };
