"use strict";

/**
 * browser-window.cjs -- the Aither Browser: a browser window INSIDE awdesk (not a
 * Chromium fork) where an agent browses while the owner watches and can take
 * over, and where the owner can simply browse.
 *
 * Three surfaces in one BrowserWindow, each with the least privilege it needs:
 *
 *   window webContents  browser-chrome.html + browser-chrome-preload.cjs: URL bar,
 *                       back/forward/reload, the "Agent is driving" banner and
 *                       the Take over / Let the agent continue button.
 *   page view           a WebContentsView in its OWN partition, contextIsolation,
 *                       sandbox, no node, and NO preload -- web content gets no
 *                       bridge into the desk at all.
 *   panel view          ONE self-contained, swappable assistant view, created by
 *                       createAssistantPanel() -- today browser-panel.html (a
 *                       URL/title header + "Ask about this page", which hands the
 *                       page, fenced as untrusted data, to the desk's one
 *                       CommandAgent). awconnect is being rebuilt on awkit and its
 *                       Connect panel will replace this one: that PR changes
 *                       ASSISTANT_PANEL and nothing else. Take over lives on the
 *                       toolbar, not the panel, so a swapped panel cannot lose it.
 *
 * Every decision (URL scheme, permissions, the take-over gate, the ask prompt)
 * lives in browser-policy.cjs so it is tested without a window; this module is
 * the Electron wiring. Agent control arrives through mcp-server.cjs's browser_*
 * tools -> browserAgent() -> the gate -> the driver below.
 */

const path = require("node:path");
const policy = require("./browser-policy.cjs");

const PARTITION = "persist:aither-browser";
const CHROME_HEIGHT = 84; // toolbar (44) + banner (40); browser-chrome.html matches
const PANEL_WIDTH = 340;
// The assistant panel: one HTML file + one preload. Point these at the awkit
// Connect panel to swap it (see createAssistantPanel).
const ASSISTANT_PANEL = Object.freeze({
  html: "browser-panel.html",
  preload: "browser-panel-preload.cjs",
});
// Page scripts run in an isolated world: the page's own JS cannot patch
// querySelector/click under the agent (they share the DOM, not the globals).
const ISOLATED_WORLD_ID = 1017;
const READ_TEXT_CHARS = 20_000;
const READ_LINKS = 60;
const IDLE_WAIT_MS = 10_000;
/** browser_snapshot lists at most this many elements; `truncated` says when it cut. */
const SNAPSHOT_MAX = 200;
/** browser_screenshot is scaled down to this width so one image stays readable in a turn. */
const SCREENSHOT_MAX_WIDTH = 1280;
/** PRESSABLE_KEYS (browser-policy) -> Electron sendInputEvent keyCode. */
const KEY_CODES = Object.freeze({
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Space: "Space", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End",
});

function electron() {
  return require("electron");
}

let win = null;
let pageView = null;
let panelView = null;
let ipcWired = false;
let sessionHardened = false;
let askAgent = null;
let agentHandle = null;
const gate = new policy.AgentGate();
gate.on("change", (snap) => {
  pushState();
  // An agent handing the wheel over must be SEEN: raise the window and flash it.
  if (snap && snap.handoff && win && !win.isDestroyed()) {
    win.show();
    win.focus();
    win.flashFrame(true);
  }
});

function homeUrl() {
  const verdict = policy.sanitizeUrl(process.env.DESK_BROWSER_HOME || "https://aitherium.com");
  return verdict.ok ? verdict.url : "https://aitherium.com/";
}

function alive(view) {
  return Boolean(view && view.webContents && !view.webContents.isDestroyed());
}

function state() {
  if (!alive(pageView)) return { open: false, agent: gate.snapshot() };
  const wc = pageView.webContents;
  const history = wc.navigationHistory;
  return {
    open: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: history ? history.canGoBack() : false,
    canGoForward: history ? history.canGoForward() : false,
    agent: gate.snapshot(),
  };
}

function pushState() {
  const payload = state();
  if (win && !win.isDestroyed()) win.webContents.send("desk:browser-state", payload);
  if (alive(panelView)) panelView.webContents.send("desk:browser-state", payload);
}

/** Deny-by-default permissions and agent-time downloads on the page partition. */
function hardenSession(ses) {
  if (sessionHardened) return;
  sessionHardened = true;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(policy.allowPermission(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => policy.allowPermission(permission));
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
  // A download an AGENT triggers lands on the owner's disk unseen; while the agent
  // drives (and the owner has not taken over) downloads are cancelled. The owner
  // takes over to download.
  ses.on("will-download", (_event, item) => {
    const g = gate.snapshot();
    if (g.driving && !g.paused) item.cancel();
  });
}

async function loadInView(url) {
  try {
    await pageView.webContents.loadURL(url);
  } catch (error) {
    // A redirect or a client-side navigation aborts the first load (-3); the
    // page still arrives. Anything else is a real failure.
    if (!/ERR_ABORTED|\(-3\)/.test(String(error && error.message))) throw error;
  }
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const bodyH = Math.max(0, height - CHROME_HEIGHT);
  const panelW = Math.min(PANEL_WIDTH, Math.floor(width / 2));
  if (alive(pageView)) pageView.setBounds({ x: 0, y: CHROME_HEIGHT, width: Math.max(0, width - panelW), height: bodyH });
  if (alive(panelView)) panelView.setBounds({ x: width - panelW, y: CHROME_HEIGHT, width: panelW, height: bodyH });
}

function wirePage(wc) {
  // Popups stay in the view (http/https only); nothing opens a second window.
  wc.setWindowOpenHandler(({ url }) => {
    if (policy.isNavigable(url)) void loadInView(url).catch(() => {});
    return { action: "deny" };
  });
  const guard = (event, url) => {
    if (!policy.isNavigable(url)) event.preventDefault();
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.on("will-attach-webview", (event) => event.preventDefault());
  for (const name of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"]) {
    wc.on(name, () => pushState());
  }
}

/**
 * Open (or raise) the Aither Browser.
 * @param {{askAgent?: (prompt: string) => Promise<{ok?: boolean, reply?: string}>, url?: string}} [opts]
 */
function createBrowserWindow({ askAgent: ask = null, url = null } = {}) {
  if (typeof ask === "function") askAgent = ask;
  wireIpc();
  const target = url ? policy.sanitizeUrl(url) : null;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (target && target.ok) void loadInView(target.url).catch(() => {});
    return win;
  }
  const { BrowserWindow, WebContentsView, session } = electron();
  hardenSession(session.fromPartition(PARTITION));

  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Aither Browser",
    backgroundColor: "#0f1218",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "browser-chrome-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  pageView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Deliberately no preload -- web content gets no bridge into the desk.
    },
  });
  panelView = createAssistantPanel(WebContentsView);
  wirePage(pageView.webContents);

  win.contentView.addChildView(pageView);
  win.contentView.addChildView(panelView);
  win.on("resize", layout);
  win.once("ready-to-show", () => {
    layout();
    win.show();
    win.focus();
    pushState();
  });
  win.on("closed", () => {
    for (const view of [pageView, panelView]) {
      if (alive(view)) view.webContents.close();
    }
    win = null;
    pageView = null;
    panelView = null;
    gate.release();
  });

  void win.loadFile(path.join(__dirname, "browser-chrome.html"));
  layout();
  void loadInView(target && target.ok ? target.url : homeUrl()).catch(() => {});
  return win;
}

/**
 * The ONE loader for the assistant panel: builds the view, locks it down and
 * loads ASSISTANT_PANEL. Swapping in the awkit Connect panel means changing
 * ASSISTANT_PANEL (or this function) only -- the window, page view, toolbar,
 * take-over gate and MCP tools do not know which panel is mounted. The panel
 * speaks only the three desk:browser-state / desk:browser-ask channels.
 * @param {typeof import("electron").WebContentsView} WebContentsView
 */
function createAssistantPanel(WebContentsView, panel = ASSISTANT_PANEL) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, panel.preload),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => event.preventDefault());
  void view.webContents.loadFile(path.join(__dirname, panel.html));
  return view;
}

function waitForIdle(wc, timeoutMs = IDLE_WAIT_MS) {
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      wc.removeListener("did-stop-loading", done);
      resolve();
    }
    wc.once("did-stop-loading", done);
  });
}

// Shared by every page script. Pure strings; nothing here reads an argument.
const PAGE_HELPERS = `
  const clean = (t, n = 120) => String(t == null ? "" : t).replace(/\\s+/g, " ").trim().slice(0, n);
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && clean(aria)) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && clean(l.innerText)) return clean(l.innerText);
      } catch (e) { /* an id CSS.escape cannot handle */ }
    }
    const wrap = el.closest("label");
    if (wrap) {
      // The label's OWN words: a <select> inside its label would otherwise lend it
      // every option ("Support topic 1. Multiplayer Other").
      const copy = wrap.cloneNode(true);
      copy.querySelectorAll("select, textarea, input, button, option").forEach((n) => n.remove());
      if (clean(copy.textContent)) return clean(copy.textContent);
    }
    if (el.placeholder) return clean(el.placeholder);
    const tag = el.tagName;
    if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || el.getAttribute("role")) {
      const t = clean(el.innerText || el.value);
      if (t) return t;
    }
    if (el.title) return clean(el.title);
    if (el.name) return clean(el.name);
    return "";
  };
`;

/**
 * The page-side script for one agent action. Pure; every argument is embedded
 * with JSON.stringify so a selector, ref or text can never break out of its literal.
 *
 * Element actions take a TARGET: {ref} from the last browser_snapshot (the map
 * lives in the isolated world, so page JS can neither read nor forge it, and a
 * navigation clears it), or {selector}.
 */
function scriptFor(action, args = {}) {
  if (action === "read") {
    return `(() => ({ ok: true, url: location.href, title: document.title,
      text: (document.body ? document.body.innerText : "").slice(0, ${READ_TEXT_CHARS}),
      links: Array.from(document.querySelectorAll("a[href]")).slice(0, ${READ_LINKS})
        .map((a) => ({ text: (a.innerText || "").trim().slice(0, 120), href: a.href })) }))()`;
  }
  if (action === "snapshot") {
    return `(() => { ${PAGE_HELPERS}
      const refs = new Map();
      window.__aitherRefs = refs;
      const SELECTOR = 'input:not([type=hidden]), textarea, select, button, a[href], summary, [contenteditable=""], '
        + '[contenteditable="true"], [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], '
        + '[role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox]';
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
      };
      const elements = [];
      let total = 0;
      for (const el of document.querySelectorAll(SELECTOR)) {
        if (!visible(el)) continue;
        total += 1;
        if (elements.length >= ${SNAPSHOT_MAX}) continue;
        const ref = "e" + (elements.length + 1);
        refs.set(ref, el);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const item = { ref, tag, label: labelOf(el) };
        if (role) item.role = role;
        if (tag === "input") item.type = String(el.type || "text").toLowerCase();
        if (el.disabled) item.disabled = true;
        if (el.required) item.required = true;
        const box = item.type === "checkbox" || item.type === "radio" || role === "checkbox" || role === "radio" || role === "switch";
        if (box) {
          item.checked = typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true";
        } else if (tag === "select") {
          const chosen = el.options[el.selectedIndex];
          item.value = chosen ? clean(chosen.text, 80) : "";
          item.options = Array.from(el.options).slice(0, 30).map((o) => clean(o.text, 80));
        } else if (tag === "input" || tag === "textarea") {
          // A password's VALUE never leaves the page; only whether it is filled.
          item.value = item.type === "password" ? (el.value ? "(filled)" : "") : clean(el.value, 160);
        } else if (el.isContentEditable) {
          item.value = clean(el.innerText, 160);
        }
        if (tag === "a") item.href = String(el.href).slice(0, 200);
        elements.push(item);
      }
      const frames = document.querySelectorAll("iframe").length;
      const out = { ok: true, url: location.href, title: document.title, count: elements.length, total,
        truncated: total > elements.length, elements };
      if (frames) {
        out.frames = frames;
        out.note = "Elements inside iframes (captchas, embedded sign-in, card fields) are not listed. "
          + "Hand those steps to the owner with browser_hand_to_owner.";
      }
      return out; })()`;
  }
  const target = args.target && typeof args.target === "object" ? args.target : { selector: String(args.selector || "") };
  const find = `${PAGE_HELPERS}
      const target = ${JSON.stringify({ ref: target.ref || null, selector: target.selector || null })};
      const el = (() => {
        if (target.ref) {
          const map = window.__aitherRefs;
          const hit = map && map.get(target.ref);
          return hit && hit.isConnected ? hit : { stale: true };
        }
        try { return document.querySelector(target.selector); }
        catch (e) { return { invalid: String(e && e.message || e) }; }
      })();
      if (!el) return { ok: false, error: "no element matches the selector" };
      if (el.stale) return { ok: false, error: "ref " + target.ref + " is stale (the page changed or navigated); call browser_snapshot again" };
      if (el.invalid) return { ok: false, error: "invalid selector: " + el.invalid };
      const label = labelOf(el);`;
  if (action === "click") {
    return `(() => { ${find}
      el.scrollIntoView({ block: "center" }); el.click();
      return { ok: true, clicked: el.tagName.toLowerCase(), label, text: clean(el.innerText || el.value) }; })()`;
  }
  if (action === "type") {
    return `(() => { ${find}
      const text = ${JSON.stringify(String(args.text ?? ""))};
      el.scrollIntoView({ block: "center" });
      el.focus();
      let now;
      if (el.isContentEditable) { el.textContent = text; now = el.textContent; }
      else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
        if (desc && desc.set) desc.set.call(el, text); else el.value = text;
        now = el.value;
      } else { return { ok: false, error: "element is not a text field (" + el.tagName.toLowerCase() + ")", label }; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Read it back: a field that rewrote or refused the text says so here.
      return { ok: now === text, typed: text.length, into: el.tagName.toLowerCase(), label,
        error: now === text ? undefined : "the field did not keep the text (it holds " + String(now).length + " characters)" }; })()`;
  }
  if (action === "select") {
    return `(() => { ${find}
      if (el.tagName !== "SELECT") return { ok: false, error: "element is not a <select> (" + el.tagName.toLowerCase() + "); click it and its options instead", label };
      const want = ${JSON.stringify(String(args.option ?? ""))};
      const options = Array.from(el.options);
      let i = options.findIndex((o) => o.value === want);
      if (i < 0) i = options.findIndex((o) => clean(o.text) === clean(want));
      if (i < 0) i = options.findIndex((o) => clean(o.text).toLowerCase().includes(clean(want).toLowerCase()));
      if (i < 0) return { ok: false, error: "no option matches", label, options: options.slice(0, 30).map((o) => clean(o.text, 80)) };
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (desc && desc.set) desc.set.call(el, options[i].value); else el.value = options[i].value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const chosen = el.options[el.selectedIndex];
      return { ok: el.selectedIndex === i, selected: chosen ? clean(chosen.text, 80) : "", label }; })()`;
  }
  if (action === "check") {
    return `(() => { ${find}
      const want = ${JSON.stringify(Boolean(args.checked))};
      const read = () => (typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true");
      const isBox = el.type === "checkbox" || el.type === "radio" || ["checkbox", "radio", "switch"].includes(el.getAttribute("role"));
      if (!isBox) return { ok: false, error: "element is not a checkbox, radio or switch", label };
      if (read() !== want) { el.scrollIntoView({ block: "center" }); el.click(); }
      const now = read();
      return { ok: now === want, checked: now, label,
        error: now === want ? undefined : "the box did not change (the page may handle it elsewhere; click its label)" }; })()`;
  }
  if (action === "highlight") {
    return `(() => { ${find}
      el.scrollIntoView({ block: "center" });
      el.style.outline = "3px solid #a855f7";
      el.style.outlineOffset = "3px";
      return { ok: true, label }; })()`;
  }
  if (action === "focus") {
    return `(() => { ${find}
      el.scrollIntoView({ block: "center" }); el.focus();
      return { ok: true, label }; })()`;
  }
  throw new Error(`no page script for ${action}`);
}

async function runInPage(action, args) {
  if (!alive(pageView)) return { ok: false, error: "The Aither Browser is not open; call browser_open first." };
  const wc = pageView.webContents;
  await waitForIdle(wc);
  const result = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: scriptFor(action, args) }], false);
  return result && typeof result === "object" ? result : { ok: false, error: "page returned nothing" };
}

const driver = {
  async open(url) {
    createBrowserWindow({ url: null });
    await loadInView(url);
    const s = state();
    return { ok: true, url: s.url, title: s.title };
  },
  read: () => runInPage("read", {}),
  snapshot: () => runInPage("snapshot", {}),
  click: (target) => runInPage("click", { target }),
  type: (target, text) => runInPage("type", { target, text }),
  select: (target, option) => runInPage("select", { target, option }),
  check: (target, checked) => runInPage("check", { target, checked }),
  highlight: (target) => runInPage("highlight", { target }),
  /** A key goes to whatever has focus in the page, as a real input event. */
  async press(key) {
    if (!alive(pageView)) return { ok: false, error: "The Aither Browser is not open; call browser_open first." };
    const keyCode = KEY_CODES[key];
    if (!keyCode) return { ok: false, error: `no key mapping for ${key}` };
    const wc = pageView.webContents;
    await waitForIdle(wc);
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode });
    if (key === "Enter" || key === "Space") wc.sendInputEvent({ type: "char", keyCode: key === "Enter" ? "\r" : " " });
    wc.sendInputEvent({ type: "keyUp", keyCode });
    return { ok: true, pressed: key };
  },
  /** The page as a PNG, scaled to SCREENSHOT_MAX_WIDTH. */
  async screenshot() {
    if (!alive(pageView)) return { ok: false, error: "The Aither Browser is not open; call browser_open first." };
    const wc = pageView.webContents;
    await waitForIdle(wc);
    let image = await wc.capturePage();
    const size = image.getSize();
    if (size.width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH });
    const out = image.getSize();
    return { ok: true, url: wc.getURL(), title: wc.getTitle(), width: out.width, height: out.height,
      png: image.toPNG().toString("base64") };
  },
};

/** The dispatcher the MCP browser_* tools call (gate first, then the driver). */
function browserAgent({ askAgent: ask = null } = {}) {
  if (typeof ask === "function") askAgent = ask;
  if (!agentHandle) agentHandle = policy.createBrowserAgent({ gate, driver });
  return agentHandle;
}

function fromChrome(event) {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
}

function fromPanel(event) {
  return Boolean(alive(panelView) && event.sender === panelView.webContents);
}

function wireIpc() {
  if (ipcWired) return;
  ipcWired = true;
  const { ipcMain } = electron();
  // Every handler checks its sender: only OUR chrome/panel pages may drive
  // these, never the page view (which has no preload anyway) or another window.
  ipcMain.handle("desk:browser-state", (event) => (fromChrome(event) || fromPanel(event) ? state() : null));
  ipcMain.handle("desk:browser-navigate", async (event, input) => {
    if (!fromChrome(event)) return { ok: false, reason: "not the browser toolbar" };
    const verdict = policy.sanitizeUrl(input);
    if (!verdict.ok || !alive(pageView)) return verdict.ok ? { ok: false, reason: "browser closed" } : verdict;
    void loadInView(verdict.url).catch(() => {});
    return { ok: true, url: verdict.url };
  });
  ipcMain.on("desk:browser-nav", (event, verb) => {
    if (!fromChrome(event) || !alive(pageView)) return;
    const wc = pageView.webContents;
    const history = wc.navigationHistory;
    if (verb === "back" && history.canGoBack()) history.goBack();
    else if (verb === "forward" && history.canGoForward()) history.goForward();
    else if (verb === "reload") wc.reload();
    else if (verb === "stop") wc.stop();
  });
  ipcMain.on("desk:browser-takeover", (event) => {
    if (fromChrome(event)) gate.takeOver();
  });
  ipcMain.on("desk:browser-handback", (event) => {
    if (fromChrome(event)) gate.handBack();
  });
  ipcMain.handle("desk:browser-ask", async (event, question) => {
    if (!fromPanel(event)) return { ok: false, reply: "not the browser panel" };
    if (typeof askAgent !== "function") return { ok: false, reply: "The desk's agent is not wired to this window." };
    // The OWNER's read: not an agent tool call, so it does not pass the gate.
    const page = await runInPage("read", {}).catch((error) => ({ ok: false, error: String(error.message || error) }));
    if (!page || page.ok === false) return { ok: false, reply: `Could not read the page: ${page && page.error}` };
    const prompt = policy.buildAskPrompt({
      url: page.url, title: page.title, text: page.text, question: typeof question === "string" ? question.slice(0, 2000) : "",
    });
    try {
      const result = await askAgent(prompt);
      return { ok: result?.ok !== false, reply: String(result?.reply || "") };
    } catch (error) {
      return { ok: false, reply: String(error?.message || error) };
    }
  });
}

function closeBrowserWindow() {
  if (win && !win.isDestroyed()) win.close();
}

function isBrowserWindowOpen() {
  return Boolean(win && !win.isDestroyed());
}

module.exports = {
  ASSISTANT_PANEL,
  CHROME_HEIGHT,
  ISOLATED_WORLD_ID,
  KEY_CODES,
  PARTITION,
  browserAgent,
  closeBrowserWindow,
  createAssistantPanel,
  createBrowserWindow,
  getGate: () => gate,
  isBrowserWindowOpen,
  scriptFor,
};
