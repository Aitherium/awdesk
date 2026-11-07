"use strict";

/**
 * search-window.cjs -- main's half of aither://search (search-client.cjs). Every
 * channel answers only the aither://search page: it starts processes (awfind,
 * awresearch) on the owner's machine, so no other page may reach it.
 *
 * It also owns the LAUNCHER (Alt+Space, the Start-search replacement): the SAME
 * search.html in a small frameless window, opened on its "This PC" mode
 * (universal-search.cjs). The launcher loads the page from file:// with
 * search-preload.cjs, so it works before the Aither Browser ever registered the
 * aither:// scheme; its webContents is the one other sender these channels answer.
 *
 * A universal result is launched BY KEY: main remembers what it handed the page and
 * opens only that (shell.openPath on a shortcut / file the search found, a desk
 * command id from the registry, text it read off the clipboard). The renderer never
 * names a path, so a page cannot ask main to open something the search did not find.
 */

const path = require("node:path");
const { createSearchClient } = require("./search-client.cjs");
const { APPS_FOLDER_PREFIX, encodedCommand } = require("./universal-search.cjs");

/** Env var the constant launch script reads the AppsFolder target from. */
const APPS_FOLDER_ENV = "AWDESK_APPS_FOLDER_TARGET";
// Measured 2026-11-01 on the owner's box, launching Calculator by its AppID:
//   explorer.exe <target>            spawned, exit 1, NO app started
//   shell.openExternal(target)       "The system cannot find the path specified"
//   shell.openPath(target)           hung past 10 s
//   cmd /c start "" <target>         hung 15 s (argv quoting)
//   PowerShell Start-Process target  CalculatorApp started -- the one that works.
// So the launch is ShellExecute through PowerShell: a CONSTANT script reading the
// target from the environment, never the command line (the WSEARCH pattern).
const APPS_FOLDER_SCRIPT = `Start-Process -FilePath $env:${APPS_FOLDER_ENV} -ErrorAction Stop`;

/** Open one AppsFolder entry. Resolves "" when it launched, a reason otherwise; never rejects. */
function openAppsFolderEntry(target, { execFile = require("node:child_process").execFile, env = process.env } = {}) {
  const t = String(target || "");
  if (!t.startsWith(APPS_FOLDER_PREFIX) || t.includes('"') || [...t].some((c) => c.charCodeAt(0) < 0x20)) {
    return Promise.resolve("not an app id");
  }
  return new Promise((resolve) => {
    try {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodedCommand(APPS_FOLDER_SCRIPT)],
      { windowsHide: true, timeout: 15_000, env: { ...env, [APPS_FOLDER_ENV]: t } },
      (error, _stdout, stderr) => resolve(error
        ? String(stderr || (error && error.message) || error).trim().split(/\r?\n/)[0].slice(0, 200) || "launch failed"
        : ""));
    } catch (e) {
      resolve(String((e && e.message) || e));
    }
  });
}

const LAUNCHER_SIZE = Object.freeze({ width: 720, height: 520 });
const REMEMBERED_MAX = 4_000;
/** Alt+Space first; PowerToys Run (and some window managers) hold it, so a fallback. */
const LAUNCHER_ACCELS = Object.freeze(["Alt+Space", "Ctrl+Alt+Space"]);
/**
 * How long a chat send may take to REFUSE before it counts as accepted. An agent
 * reply takes many seconds and lands in the Chat pane; the launcher must not sit
 * open for it, but a send that fails at once (no agent, refused) must say so.
 */
const CHAT_ACCEPT_MS = 1_500;
/** The error when main never handed this module a runner: restarting cannot fix that. */
const UNWIRED = Object.freeze({
  action: "1 desk action not wired in main.cjs — use the palette (Ctrl+K) until setActionRunner lands",
  chat: "Aither chat not wired in main.cjs — open Chat from the tray until setChatSender lands",
});

let wired = false;
let clientImpl = null;
let universalImpl = null;
let openForge = null;
let openWeb = null;
let runAction = null;
let sendToChat = null;
let launcherWindow = null;
const remembered = new Map();

function client() {
  if (!clientImpl) {
    let dataDir = null;
    try { dataDir = require("node:path").join(require("electron").app.getPath("userData"), "research"); } catch { /* tests */ }
    // The resident discovery worker (search-client.cjs): ~47 ms per agents/tools
    // lookup instead of a 5.9 s `adk discover` cold start; the CLI stays the fallback.
    clientImpl = createSearchClient({ dataDir, discoveryWorker: require("./search-client.cjs").createDiscoveryWorker() });
  }
  return clientImpl;
}

/** The universal search (universal-search.cjs), with the Electron clipboard as its "now" reader. */
function universal() {
  if (!universalImpl) {
    let readClipboard = () => "";
    try {
      const { clipboard } = require("electron");
      readClipboard = () => clipboard.readText();
    } catch { /* tests */ }
    universalImpl = require("./universal-search.cjs").createUniversalSearch({ searchClient: client(), readClipboard });
  }
  return universalImpl;
}

function launcherContents() {
  return launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow.webContents : null;
}

function fromSearchPage(sender) {
  const launcher = launcherContents();
  if (launcher && sender && sender === launcher) return true;
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "aither:" && url.hostname === "search";
  } catch {
    return false;
  }
}

/** main says how a Media Forge URL opens (a web tab in the browser). */
function setForgeOpener(fn) {
  openForge = typeof fn === "function" ? fn : null;
}

/** main says how a WEB result opens (a tab in the Aither browser). */
function setWebOpener(fn) {
  openWeb = typeof fn === "function" ? fn : null;
}

/**
 * main says how a desk command runs: (id) => verdict. The verdict is reported, not
 * assumed: {ok:false, ...} or {cancelled:true} (a confirm the owner cancelled) is a
 * failure the launcher shows and stays open for (failureOf).
 */
function setActionRunner(fn) {
  runAction = typeof fn === "function" ? fn : null;
}

/** main says how a query reaches Aither chat (Tab in the box, or an agent/tool row): (text) => verdict (sendChat). */
function setChatSender(fn) {
  sendToChat = typeof fn === "function" ? fn : null;
}

/**
 * The view a page gets of a universal run: every item WITHOUT its target (a path or
 * clipboard text stays in main), remembered by key for launchItem.
 */
function publicRun(r) {
  if (!r || !r.ok) return r;
  if (remembered.size > REMEMBERED_MAX) remembered.clear();
  const groups = r.groups.map((g) => ({
    id: g.id, label: g.label, total: g.total,
    items: g.items.map((it) => {
      remembered.set(it.key, it);
      const row = { key: it.key, kind: it.kind, title: it.title, subtitle: it.subtitle, score: it.score };
      // A CARD row carries its own options so the launcher can number them and
      // send the number back. Keys and labels only -- the card's summary is the
      // raiser's text, and the value of a credential card never travels at all.
      if (it.kind === "card") {
        row.cardId = it.cardId;
        row.defaultKey = it.defaultKey;
        row.options = (Array.isArray(it.options) ? it.options : []).map((o) => ({
          index: o.index, key: o.key, label: o.label, recommended: o.recommended === true,
        }));
      }
      return row;
    }),
  }));
  return { ok: true, query: r.query, phase: r.phase, groups, total: r.total, errors: r.errors, notes: r.notes, tookMs: r.tookMs };
}

/**
 * What a runner's answer means. A runner reports failure as {ok:false, error|reason|
 * reply|message}, a cancelled confirm (runFleetCommand's Cancel) as {cancelled:true};
 * anything else -- including undefined, which most desk commands return -- ran.
 *
 * Args:
 *   result  what the action runner or chat sender resolved to
 *   thing   "desk action" | "chat message", for the error line
 * Returns: null when it ran, else the "<count> <thing> — <remedy>" error.
 */
function failureOf(result, thing) {
  if (!result || typeof result !== "object") return null;
  if (result.cancelled) return `1 ${thing} cancelled — nothing ran`;
  if (result.ok !== false) return null;
  const why = [result.error, result.reason, result.reply, result.message].find((v) => typeof v === "string" && v.trim());
  return `1 ${thing} failed — ${why ? why.trim().slice(0, 200) : "no reason given; try it from the palette (Ctrl+K)"}`;
}

/**
 * Send a chat text and wait at most `acceptMs` for a refusal. A sender that rejects
 * or answers {ok:false} inside the window is a failure; one still working is accepted
 * (its reply lands in the Chat pane) and its late failure is only logged.
 *
 * Returns: {ok: true, did} | {ok: false, error}
 */
async function sendChat(send, text, { acceptMs = CHAT_ACCEPT_MS } = {}) {
  const PENDING = Symbol("pending");
  let timer;
  const work = Promise.resolve().then(() => send(text));
  const waited = await Promise.race([
    work.then((v) => ({ v }), (e) => ({ e })),
    new Promise((resolve) => { timer = setTimeout(() => resolve(PENDING), acceptMs); if (timer.unref) timer.unref(); }),
  ]).finally(() => clearTimeout(timer));
  if (waited === PENDING) {
    work.then((v) => { const bad = failureOf(v, "chat message"); if (bad) console.warn(`[search] ${bad}`); },
      (e) => console.warn(`[search] 1 chat message failed — ${String((e && e.message) || e).slice(0, 200)}`));
    return { ok: true, did: "sent to Aither chat" };
  }
  if (waited.e !== undefined) return { ok: false, error: `1 chat message failed — ${String((waited.e && waited.e.message) || waited.e).slice(0, 200)}` };
  const bad = failureOf(waited.v, "chat message");
  return bad ? { ok: false, error: bad } : { ok: true, did: "sent to Aither chat" };
}

/**
 * Launch one remembered item.
 *
 * Args:
 *   key    an item key from a recent run (publicRun)
 *   query  what the owner typed; an agent/tool row carries it to chat
 *   io     {shell, clipboard} (Electron's), plus the action runner and chat sender
 * Returns: {ok: true, did} | {ok: false, error}, the error as "<count> <thing> — <remedy>".
 *   An action or chat row reports the RUNNER's verdict: a failed command or a
 *   cancelled confirm is {ok:false}, never "ran X".
 */
async function launchItem(key, query, { shell, clipboard, action = runAction, chat = sendToChat, acceptMs,
  openAppsFolder = openAppsFolderEntry } = {}) {
  const item = remembered.get(String(key || ""));
  if (!item) return { ok: false, error: "1 result is gone — search again" };
  // A Store/packaged app (universal-search.cjs loadStartApps) has no file to open:
  // explorer.exe launches shell:AppsFolder\<AppID>, the id as ONE argv entry.
  if (item.kind === "app" && String(item.target).startsWith(APPS_FOLDER_PREFIX)) {
    const err = await openAppsFolder(item.target);
    return err ? { ok: false, error: `1 app did not open — ${err}` } : { ok: true, did: `opened ${item.title}` };
  }
  if (item.kind === "app" || item.kind === "file" || item.kind === "screenshot") {
    const err = await shell.openPath(item.target);
    return err ? { ok: false, error: `1 ${item.kind} did not open — ${err}` } : { ok: true, did: `opened ${item.title}` };
  }
  if (item.kind === "clip") {
    clipboard.writeText(item.target);
    return { ok: true, did: "copied to the clipboard" };
  }
  if (item.kind === "action") {
    if (!action) return { ok: false, error: UNWIRED.action };
    let result;
    try {
      result = await action(item.target);
    } catch (error) {
      return { ok: false, error: `1 desk action failed — ${String((error && error.message) || error).slice(0, 200)}` };
    }
    const bad = failureOf(result, "desk action");
    return bad ? { ok: false, error: bad } : { ok: true, did: `ran ${item.title}` };
  }
  if (item.kind === "agent") {
    if (!chat) return { ok: false, error: UNWIRED.chat };
    return sendChat(chat, require("./universal-search.cjs").chatPrompt(query, item), acceptMs ? { acceptMs } : {});
  }
  // The Alt+Space launcher adds a WEB group through search-client.cjs's awfind path;
  // a web tab is the one thing a URL may open (never an app row, never a path).
  if (item.kind === "web") {
    const url = String(item.target || "");
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: "1 web result has no address — search again" };
    if (!openWeb) return { ok: false, error: "1 web result not wired in main.cjs — use the search page's Web tab until setWebOpener lands" };
    try { await openWeb(url); } catch (error) {
      return { ok: false, error: `1 web result did not open — ${String((error && error.message) || error).slice(0, 200)}` };
    }
    return { ok: true, did: `opened ${item.title}` };
  }
  return { ok: false, error: `1 ${item.kind} row cannot launch — search again` };
}

function searchHandlers(c = client(), {
  isSearch = fromSearchPage,
  opener = () => openForge,
  everything = () => universal(),
  io = () => { const { shell, clipboard } = require("electron"); return { shell, clipboard }; },
  chat = () => sendToChat,
  action = () => runAction,
  hide = () => hideLauncher(),
  acceptMs,
} = {}) {
  const guarded = (fn, withSender) => async (event, ...args) => {
    if (!event || !event.sender || !isSearch(event.sender)) return { ok: false, error: "not the search page" };
    try {
      return await (withSender ? fn(event.sender, ...args) : fn(...args));
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  };
  const guard = (fn) => guarded(fn, false);
  // ONE in-flight "all" run per page: a new query (any phase) or a new "all" run aborts
  // the previous one, whose powershell.exe and `adk discover` children die with it
  // (execFile `signal`). Without this every typing pause stacked another pair.
  const inflight = new WeakMap(); // sender -> {query, ctl}
  const runUniversal = async (sender, query, phase) => {
    const q = String(query ?? "");
    const ph = phase === "fast" ? "fast" : "all";
    const prev = inflight.get(sender);
    if (prev && (ph === "all" || prev.query !== q)) {
      prev.ctl.abort();
      inflight.delete(sender);
    }
    if (ph === "fast") return publicRun(await everything().run(q, { phase: ph }));
    const mine = { query: q, ctl: new AbortController() };
    inflight.set(sender, mine);
    try {
      return publicRun(await everything().run(q, { phase: ph, signal: mine.ctl.signal }));
    } finally {
      if (inflight.get(sender) === mine) inflight.delete(sender);
    }
  };
  return {
    "desk:search-run": guard((mode, query) => c.search(String(mode), query)),
    "desk:search-images": guard((query) => c.images(query)),
    "desk:research-start": guard((question, depth) => c.startResearch(question, String(depth || "standard"))),
    "desk:research-list": guard(() => c.listResearch()),
    "desk:research-read": guard((id) => c.readResearch(id)),
    "desk:forge-open": guard(async () => {
      const where = await c.forgeUrl();
      const open = opener();
      if (!where.ok || !open) return where.ok ? { ok: false, error: "no opener wired" } : where;
      open(where.url);
      return { ok: true, url: where.url };
    }),
    // ── "This PC" (universal-search.cjs) ──
    "desk:usearch-run": guarded(runUniversal, true),
    "desk:usearch-launch": guard(async (key, query) => {
      const r = await launchItem(String(key ?? ""), String(query ?? ""), { ...io(), chat: chat(), action: action(), acceptMs });
      if (r.ok) hide(); // a failure keeps the launcher up so the owner sees why
      return r;
    }),
    "desk:usearch-ask": guard(async (query) => {
      const text = require("./universal-search.cjs").chatPrompt(String(query ?? ""));
      if (!text) return { ok: false, error: "type something to ask Aither" };
      const send = chat();
      if (!send) return { ok: false, error: UNWIRED.chat };
      const r = await sendChat(send, text, acceptMs ? { acceptMs } : {});
      if (r.ok) hide();
      return r;
    }),
    "desk:usearch-hide": guard(() => { hide(); return { ok: true }; }),
  };
}

/**
 * How long after the desk starts the universal search is built. Building it starts
 * the background Get-StartApps load (~2.4 s idle, 3.4 s+ on a loaded host just for
 * powershell.exe). Measured 2026-11-01: built lazily by the FIRST query, that query
 * missed Notepad / Calculator even with a 2 s first wait. Warmed here, the first
 * Alt+Space finds them; delayed so it does not compete with the desk's own boot.
 */
const UNIVERSAL_WARM_MS = 10_000;

function ensureSearchIpc({ warmMs = UNIVERSAL_WARM_MS } = {}) {
  if (wired) return;
  wired = true;
  const { ipcMain } = require("electron");
  for (const [channel, handler] of Object.entries(searchHandlers())) ipcMain.handle(channel, handler);
  if (warmMs >= 0) {
    const t = setTimeout(() => { try { universal(); } catch { /* the first query builds it instead */ } }, warmMs);
    if (t.unref) t.unref();
  }
}

// ── the launcher (Alt+Space) ────────────────────────────────────────────────

function hideLauncher() {
  if (launcherWindow && !launcherWindow.isDestroyed() && launcherWindow.isVisible()) launcherWindow.hide();
}

/**
 * Show the launcher centred near the top of the display under the cursor, or hide it
 * when it already has focus (the same key closes it). Created once, hidden on blur,
 * reused: the box is ready the instant the key lands.
 *
 * Returns: {ok: true, shown: boolean}
 */
function toggleLauncher() {
  const { BrowserWindow, screen } = require("electron");
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    if (launcherWindow.isVisible() && launcherWindow.isFocused()) {
      launcherWindow.hide();
      return { ok: true, shown: false };
    }
  } else {
    ensureSearchIpc();
    launcherWindow = new BrowserWindow({
      ...LAUNCHER_SIZE, show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
      fullscreenable: false, minimizable: false, maximizable: false, title: "Search this PC", backgroundColor: "#0d1117",
      webPreferences: {
        preload: path.join(__dirname, "search-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      },
    });
    launcherWindow.on("blur", () => hideLauncher());
    launcherWindow.on("closed", () => { launcherWindow = null; });
    // The launcher shows only its own page; it never navigates or opens windows.
    launcherWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    launcherWindow.webContents.on("will-navigate", (e) => e.preventDefault());
    void launcherWindow.loadFile(path.join(__dirname, "search.html"), { query: { mode: "pc", launcher: "1" } });
  }
  try {
    const at = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    launcherWindow.setBounds({
      x: Math.round(at.x + (at.width - LAUNCHER_SIZE.width) / 2),
      y: Math.round(at.y + at.height * 0.18),
      ...LAUNCHER_SIZE,
    });
  } catch { /* screen unavailable: keep the last spot */ }
  launcherWindow.show();
  launcherWindow.focus();
  try { launcherWindow.webContents.send("desk:usearch-focus"); } catch { /* still loading: the page focuses on load */ }
  return { ok: true, shown: true };
}

/**
 * Bind the launcher key: the first of `accels` the OS grants. Call it AFTER main's
 * applyHotkeys (its unregisterAll() drops every key), every time that runs.
 *
 * Args:
 *   globalShortcut  Electron's (or a fake: {register(accel, fn) -> boolean})
 *   onPress         what the key does (default toggleLauncher)
 *   accels          tried in order (default LAUNCHER_ACCELS)
 * Returns: {ok: true, accel, refused: string[]} | {ok: false, refused, error}
 */
function registerLauncherShortcut(globalShortcut, { onPress = () => toggleLauncher(), accels = LAUNCHER_ACCELS } = {}) {
  const refused = [];
  for (const accel of accels) {
    let got;
    try { got = Boolean(globalShortcut.register(accel, () => { onPress(); })); } catch { got = false; }
    if (got) return { ok: true, accel, refused };
    refused.push(accel);
  }
  return { ok: false, refused,
    error: `${refused.length} launcher keys held by another app (${refused.join(", ")}) — free one (PowerToys Run holds Alt+Space) or use "Search this PC" in the palette` };
}

module.exports = {
  CHAT_ACCEPT_MS, LAUNCHER_ACCELS, UNWIRED,
  client, ensureSearchIpc, failureOf, openAppsFolderEntry, fromSearchPage, hideLauncher, launchItem, publicRun, registerLauncherShortcut,
  searchHandlers, sendChat, setActionRunner, setChatSender, setForgeOpener, setWebOpener, toggleLauncher, universal,
  /** For tests: forget every remembered item. */
  __forget: () => remembered.clear(),
};
