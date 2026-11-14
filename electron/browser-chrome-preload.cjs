"use strict";

// Preload for the Aither Browser's TOOLBAR (browser-chrome.html). The page view
// has no preload at all; this bridge exists only on the desk's own chrome, and
// main checks the sender of every call (browser-window.cjs).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aitherBrowser", {
  state: () => ipcRenderer.invoke("desk:browser-state"),
  navigate: (url) => ipcRenderer.invoke("desk:browser-navigate", String(url ?? "")),
  back: () => ipcRenderer.send("desk:browser-nav", "back"),
  forward: () => ipcRenderer.send("desk:browser-nav", "forward"),
  reload: () => ipcRenderer.send("desk:browser-nav", "reload"),
  stop: () => ipcRenderer.send("desk:browser-nav", "stop"),
  newTab: () => ipcRenderer.invoke("desk:browser-tab-new"),
  suggest: (text) => ipcRenderer.invoke("desk:browser-suggest", String(text ?? "")),
  toggleBookmark: () => ipcRenderer.invoke("desk:browser-bookmark"),
  /** The bookmarks bar: open one of the owner's bookmarks; a folder's menu (drawn by main). */
  openBookmark: (url) => ipcRenderer.invoke("desk:browser-bookmark-open", String(url ?? "")),
  bookmarkFolder: (name) => ipcRenderer.invoke("desk:browser-bookmark-folder", String(name ?? "")),
  activateTab: (id) => ipcRenderer.send("desk:browser-tab-activate", Number(id)),
  closeTab: (id) => ipcRenderer.send("desk:browser-tab-close", Number(id)),
  popOut: (id) => ipcRenderer.invoke("desk:browser-tab-popout", Number(id)),
  dock: (id) => ipcRenderer.invoke("desk:browser-tab-dock", Number(id)),
  /** A tab's right-click menu (Pin to canvas, pop out / dock back, close), drawn by main. */
  tabMenu: (id) => ipcRenderer.invoke("desk:browser-tab-menu", Number(id)),
  /** "Share with agent": an owner tab's URL and title reach the agent only while shared. */
  shareTab: (id, on) => ipcRenderer.invoke("desk:browser-tab-share", Number(id), Boolean(on)),
  /**
   * BROWSER-M3: "Let the agent use my sign-in" for ONE site (a host, or the page's
   * address). On: the agent's tabs for that site ride the owner's session. Off: they
   * go back to the agent's own session. Answers {ok, host, on, sites} or {ok:false, error}.
   */
  agentSignIn: (url, on) => ipcRenderer.invoke("desk:browser-agent-signin", String(url ?? ""), Boolean(on)),
  /** Edge parity: the more-menu, the key icon's account menu, a notice's button. */
  menu: () => ipcRenderer.invoke("desk:browser-menu"),
  passwords: () => ipcRenderer.invoke("desk:browser-passwords"),
  /** The shield: what was blocked on this page, pause on this site, pause everywhere. */
  shield: () => ipcRenderer.invoke("desk:browser-shield"),
  notice: (action) => ipcRenderer.invoke("desk:browser-notice", String(action ?? "")),
  /** Find on page: the text (empty clears), forward or back; stop closes it. */
  find: (text, forward = true) => ipcRenderer.send("desk:browser-find", String(text ?? ""), Boolean(forward)),
  findStop: () => ipcRenderer.send("desk:browser-find-stop"),
  /** A browser action by name (zoom-reset, print, translate...): browser-everyday keyAction's names. */
  action: (name) => ipcRenderer.send("desk:browser-action", String(name ?? "")),
  onFindOpen: (listener) => {
    // `replace`: the desk's `find <words>` opens the bar ON those words, over what it held.
    const handler = (_event, text, replace) => listener(String(text ?? ""), replace === true);
    ipcRenderer.on("desk:browser-find-open", handler);
    return () => ipcRenderer.off("desk:browser-find-open", handler);
  },
  onFocusAddress: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("desk:browser-focus-address", handler);
    return () => ipcRenderer.off("desk:browser-focus-address", handler);
  },
  takeOver: () => ipcRenderer.send("desk:browser-takeover"),
  handBack: () => ipcRenderer.send("desk:browser-handback"),
  /**
   * The rail: "page" <pane id> | "command" <allowlisted id> | "menu" | "collapse" <bool>,
   * and the layout document's verbs (browser-window layoutAction): "edit-layout",
   * "pane-side" "panel:left", "pane-detach"/"pane-attach" <pane>, "preset*", "rail-edit"
   * <JSON op>, "row-menu" <row key>, "layer-move" <JSON>, "layout-export"/"layout-import".
   */
  rail: (action, arg) => ipcRenderer.invoke("desk:browser-rail", String(action ?? ""),
    typeof arg === "boolean" ? arg : String(arg ?? "")),
  onState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desk:browser-state", handler);
    return () => ipcRenderer.off("desk:browser-state", handler);
  },
});
