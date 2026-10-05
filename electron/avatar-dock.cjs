"use strict";

/**
 * avatar-dock.cjs -- the avatar window docked into the Aither Browser's rail.
 *
 * Owner, 2026-10-04: "the awdesk/avatar should be attached to the Aither Browser and
 * the browser just forms around it like a shell". The avatar stays ONE window (one
 * renderer, one stage, the same clicks and right-click menu); docking makes it an
 * OWNED window of the browser sitting on the rail's avatar slot:
 *
 *   docked    parent = the browser window, not always-on-top, not on every
 *             workspace, bounds = the slot, following every move/resize; it
 *             minimizes and restores with the browser because it is owned.
 *   floating  what it always was: no parent, always-on-top "floating", on every
 *             workspace, the bounds it had before it docked.
 *
 * Closing the browser floats the avatar back (never strands it hidden). The wish
 * ("docked") is remembered separately from the fact, so the next browser open docks
 * again without asking.
 *
 * Electron-free: windows are injected, so the state machine is asserted under
 * `node --test` with plain stubs.
 */

const FLOAT_MIN = Object.freeze({ width: 320, height: 480 });
/**
 * Docked, the rail already holds every door the bead column offers (Inbox, apps,
 * browser, chat, Online), and a 248 px slot cannot fit both a body and a column of
 * buttons -- owner screenshot 2026-10-04. The bubble stays, inside the slot.
 * Injected by main with webContents.insertCSS, so no renderer rebuild is needed.
 */
const DOCKED_CSS = [
  ".beads { display: none !important; }",
  ".speech-bubble-nudge { max-width: calc(100vw - 12px) !important; left: 6px !important; right: 6px !important; }",
  ".speech-bubble { font-size: 11px !important; max-height: 34vh !important; overflow: hidden !important; }",
].join("\n");
const DOCKED_MIN = Object.freeze({ width: 120, height: 160 });

/**
 * @param {{
 *   avatar: () => object|null,          the avatar BrowserWindow (or null)
 *   browser: () => object|null,         the Aither Browser BrowserWindow (or null)
 *   slotRect: () => object|null,        the rail slot in screen DIP (browser-rail avatarSlotRect)
 *   load?: () => boolean,               the remembered wish
 *   save?: (docked: boolean) => void,
 *   onChange?: (state: object) => void,
 * }} deps
 */
function createAvatarDock({ avatar, browser, slotRect, load = () => true, save = () => {}, onChange = () => {} }) {
  let wish = Boolean(load());
  let docked = false;
  let floatBounds = null;

  const live = (w) => Boolean(w && !(typeof w.isDestroyed === "function" && w.isDestroyed()));
  const snapshot = () => ({ wish, docked });

  function float({ restore = true } = {}) {
    const a = avatar();
    const was = docked;
    docked = false;
    if (!live(a)) return was;
    if (typeof a.setParentWindow === "function") a.setParentWindow(null);
    a.setMinimumSize(FLOAT_MIN.width, FLOAT_MIN.height);
    a.setAlwaysOnTop(true, "floating");
    if (typeof a.setVisibleOnAllWorkspaces === "function") a.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (restore && floatBounds) a.setBounds(floatBounds);
    return was;
  }

  /** Put the avatar on the slot if the wish, the browser and the slot all allow it. */
  function sync() {
    const a = avatar();
    const b = browser();
    const rect = wish && live(b) ? slotRect() : null;
    if (!rect || !live(a)) {
      const changed = float();
      if (changed) onChange(snapshot());
      return snapshot();
    }
    if (!docked) {
      floatBounds = a.getBounds();
      a.setAlwaysOnTop(false);
      if (typeof a.setVisibleOnAllWorkspaces === "function") a.setVisibleOnAllWorkspaces(false);
      a.setMinimumSize(DOCKED_MIN.width, DOCKED_MIN.height);
      if (typeof a.setParentWindow === "function") a.setParentWindow(b);
      docked = true;
      onChange(snapshot());
    }
    a.setBounds(rect);
    return snapshot();
  }

  function setWish(next) {
    wish = Boolean(next);
    save(wish);
    const state = sync();
    // Docking is a request to SEE it there. A geometry sync never shows a hidden
    // avatar ("Hide avatar" stays hidden); only this explicit click does.
    const a = avatar();
    if (docked && live(a) && typeof a.isVisible === "function" && !a.isVisible()) a.showInactive();
    onChange(state);
    return state;
  }

  return {
    sync,
    dock: () => setWish(true),
    undock: () => setWish(false),
    toggle: () => setWish(!wish),
    /** The browser is going away: float now, keep the wish for the next open. */
    browserClosed() {
      if (float()) onChange(snapshot());
    },
    isDocked: () => docked,
    wantsDock: () => wish,
    state: snapshot,
  };
}

module.exports = { DOCKED_CSS, DOCKED_MIN, FLOAT_MIN, createAvatarDock };
