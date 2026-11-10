"use strict";

/**
 * fairy-queue-window.cjs -- the LIST the fairy's "N more waiting ›" link opens.
 *
 * The whisper carries ONE card (fairy-attention.plan); the reason the owner could
 * not find a card a session was stopped on (2026-11-10, 99+ waiting) is that the
 * link opened the Inbox at whatever it last showed. This window is the honest
 * answer to "more": every open card, flat, searchable, repeats collapsed, and the
 * cards that need him pinned first.
 *
 * The rules live in fairy-queue.cjs (pure, node --test'd). This file owns the
 * window, the IPC and the two providers main.cjs hands it:
 *   cards()      -> the ranked open queue (main's openDecisions)
 *   openCard(id) -> the same answer surface every other door uses (openInbox)
 *
 * Read-only by construction: `open` is the ONLY action, and it never answers,
 * dismisses or snoozes anything. The owner's answer is his own.
 */

const path = require("node:path");
const queue = require("./fairy-queue.cjs");

const SIZE = Object.freeze({ width: 820, height: 680 });
const TITLE = "Waiting on you";
const CARD_ID_RE = /^d-[A-Za-z0-9_-]{1,80}$/;

let win = null;
let wired = false;
const providers = { cards: () => [], openCard: () => {} };

/**
 * Hand the window its two providers. Called once at boot; a test may call it with
 * fakes, which is the whole surface this module needs from main.
 *
 * Args:
 *   cards: () => array of ranked open cards.
 *   openCard: (id: string) => unknown -- opens that card on the desk's answer path.
 */
function configure({ cards, openCard } = {}) {
  if (typeof cards === "function") providers.cards = cards;
  if (typeof openCard === "function") providers.openCard = openCard;
}

/** Bounded filter values from the renderer: a page can never make main hold a megabyte. */
function cleanFilters(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  return {
    query: String(f.query == null ? "" : f.query).slice(0, 200),
    source: String(f.source == null ? "" : f.source).slice(0, 120),
    hideSelfAnswering: f.hideSelfAnswering === true,
    needsYouFirst: f.needsYouFirst !== false,
  };
}

/** The view for one render. Never throws into IPC: an empty queue is a valid answer. */
function list(rawFilters) {
  let cards = [];
  try {
    const got = providers.cards();
    if (Array.isArray(got)) cards = got;
  } catch {
    cards = [];
  }
  return queue.queueView(cards, cleanFilters(rawFilters));
}

/** Open one card on the answer path every other surface uses. A bad id never becomes a call. */
function openCard(rawId) {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!CARD_ID_RE.test(id)) return { ok: false, error: "not a card id" };
  try {
    providers.openCard(id);
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || "could not open it").slice(0, 200) };
  }
  return { ok: true, id };
}

function ensureIpc() {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  ipcMain.handle("desk:fairy-queue-list", (_event, filters) => list(filters));
  ipcMain.handle("desk:fairy-queue-open", (_event, id) => openCard(id));
  ipcMain.handle("desk:fairy-queue-close", () => {
    hide();
    return { ok: true };
  });
}

function hide() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

/** Show the list (creating or reusing the window), or focus-and-refresh it. */
function openQueue() {
  const { BrowserWindow } = require("electron");
  ensureIpc();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    try { win.webContents.send("desk:fairy-queue-refresh"); } catch { /* page mid-load: it lists on load */ }
    return { ok: true, shown: true, reused: true };
  }
  win = new BrowserWindow({
    ...SIZE,
    show: false,
    title: TITLE,
    backgroundColor: "#0d1117",
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "fairy-queue-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.on("closed", () => { win = null; });
  // The list shows only its own page; it never navigates or opens windows.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  void win.loadFile(path.join(__dirname, "fairy-queue.html"));
  return { ok: true, shown: true, reused: false };
}

module.exports = {
  SIZE,
  TITLE,
  configure,
  cleanFilters,
  list,
  openCard,
  openQueue,
  hide,
  _resetForTests() {
    win = null;
    wired = false;
    providers.cards = () => [];
    providers.openCard = () => {};
  },
};
