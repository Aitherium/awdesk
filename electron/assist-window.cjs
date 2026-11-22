"use strict";

/**
 * assist-window.cjs -- the Aither pop-up that opens AT THE CARET of whatever app has the
 * focus (Edge's "Ask Edge to help me write", for every Windows app, not one browser).
 *
 * Flow: hotkey / tray / palette -> `open()` captures the focus FIRST (caret, selection,
 * field text -- assist-caret.cjs, before this window can steal focus) -> the window shows
 * a prompt box, offline suggestion chips (a model may refine them, only when
 * assist-core.mayAutoSuggest allows), verb chips when text is selected, and the exact
 * disclosure of what would be sent -> a result is shown with Accept / Retry / Undo / Copy.
 * Accept pastes it at the caret (replacing the selection) in the ORIGINAL window; Undo
 * sends Ctrl+Z there. Nothing is typed into any app until the owner presses Accept.
 *
 * All state lives here in main. The renderer (assist.html) holds no window handle, no
 * context beyond what it displays, and cannot name the key chord or the target window:
 * `assist:accept` / `assist:undo` act on the window captured at open().
 *
 * Electron is injected so `node --test` runs the pure placement and the IPC guard.
 */

const path = require("node:path");
const core = require("./assist-core.cjs");
const linkOpener = require("./link-opener.cjs");
const caretLib = require("./assist-caret.cjs");

const SIZE = Object.freeze({ width: 460, height: 440 });
const MAX_INSERT = 20000;
/** A terminal host would EXECUTE pasted newlines: never a paste target (Copy still works). */
const TERMINAL_APPS = new Set(["windowsterminal", "cmd", "powershell", "pwsh", "conhost", "openconsole", "wsl", "wslhost", "bash", "mintty", "alacritty", "wezterm-gui", "kitty", "putty", "ttermpro", "mobaxterm"]);
const VERB_ORDER = Object.freeze(["explain", "rewrite", "translate", "summarize", "reply", "ask-agent", "send-agent", "send-workflow", "save-memory", "save-note"]);

function createAssistWindow({
  electron, engine, caret, agents = [], utils = null, files = null, now = Date.now, onOpen = null,
  openLink = null,
} = {}) {
  if (!electron) throw new Error("assist-window needs electron");
  const { BrowserWindow, ipcMain, screen, clipboard } = electron;
  let win = null;
  let wired = false;
  let shownAt = 0;
  /** What was captured at open(): the pop-up's whole world. Never sent to the renderer raw. */
  let session = null;

  const alive = () => Boolean(win && !win.isDestroyed());
  const fromWin = (event) => Boolean(alive() && event && event.sender === win.webContents);

  /** Electron's clipboard -> the {snapshot, write, restore} assist-caret wants. */
  function clipboardPort() {
    return {
      snapshot: () => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() }),
      write: (text) => clipboard.writeText(String(text)),
      restore: (s) => {
        const hasImage = s.image && !s.image.isEmpty();
        if (!s.text && !s.html && !s.rtf && !hasImage) { clipboard.clear(); return; }
        clipboard.write({ text: s.text || undefined, html: s.html || undefined, rtf: s.rtf || undefined, image: hasImage ? s.image : undefined });
      },
    };
  }
  if (caret && typeof caret.setClipboard === "function") caret.setClipboard(clipboardPort());

  function verbsFor(ctx) {
    const has = Boolean(ctx.selection.trim());
    return VERB_ORDER.map((id) => core.verbById(id)).filter(Boolean).filter((v) => {
      if (v.needs === "selection") return has;
      if (v.needs === "selection-or-thread") return has || ctx.thread.length > 0;
      return true;
    }).map((v) => ({ id: v.id, label: v.label, kind: v.kind, route: v.route || null }));
  }

  /** The link under the selection (one http(s) URL, nothing else), or "". */
  function selectedLink(ctx) {
    const t = String((ctx && ctx.selection) || "").trim();
    return /^\S+$/.test(t) && linkOpener.isWebUrl(t) ? t : "";
  }

  /** "Open in AitherBrowser" / "Open in your browser" for a selected link (owner
   *  2026-11-16: "no option for aitherbrowser?"). AitherBrowser first; ours by default. */
  function linkRows(ctx) {
    const url = selectedLink(ctx);
    if (!url || typeof openLink !== "function") return [];
    return linkOpener.openWithItems(url, { copy: false })
      .map((i) => ({ id: `link:${i.id}`, label: i.label, hint: i.hint, available: true }));
  }

  function publicState() {
    if (!session) return { ok: false, reason: "closed" };
    const s = session;
    return {
      ok: true,
      refused: s.refused || "",
      app: s.ctx.app, title: s.ctx.title, fieldLabel: s.ctx.fieldLabel,
      hasSelection: Boolean(s.ctx.selection.trim()),
      selectionPreview: s.ctx.selection.slice(0, 140),
      canInsert: s.canInsert,
      chips: s.chips, verbs: s.verbs, send: s.send,
      agents, agent: engine.settings().agent,
      utils: [...linkRows(s.ctx), ...(utils ? utils.list() : [])],
      initialVerb: s.initialVerb || null,
      autoRun: s.autoRun || null,
      file: s.file ? {
        name: s.file.name, kind: s.file.kind, size: s.file.size || 0, count: s.file.count || 0, ext: s.file.ext || "",
        textable: Boolean(s.file.textable), image: Boolean(s.file.image), why: s.file.why || "",
        conversions: files && s.file.kind === "file" ? files.conversionsFor(s.file) : [],
      } : null,
    };
  }

  function push() {
    if (alive() && !win.webContents.isLoading()) win.webContents.send("assist:state", publicState());
  }

  function hide() {
    if (alive() && win.isVisible()) win.hide();
  }

  function ensureIpc() {
    if (wired) return;
    wired = true;
    const guard = (event) => (fromWin(event) && session ? null : { ok: false, reason: "no open pop-up" });

    ipcMain.handle("assist:state", (event) => (fromWin(event) ? publicState() : { ok: false, reason: "not the pop-up" }));

    ipcMain.handle("assist:run", async (event, raw = {}) => {
      const bad = guard(event); if (bad) return bad;
      const verb = String(raw.verb || "write");
      const res = await engine.run({ verb, ctx: session.ctx, prompt: String(raw.prompt || "").slice(0, core.MAX_PROMPT), arg: String(raw.arg || "").slice(0, 40), surface: "desk", retryOf: raw.retryOf ? String(raw.retryOf).slice(0, 40) : null });
      if (res.ok) session.last = { id: res.id, verb: res.verb, text: res.text, kind: res.kind, inserted: false };
      return res;
    });

    ipcMain.handle("assist:route", async (event, raw = {}) => {
      const bad = guard(event); if (bad) return bad;
      return engine.route({ verb: String(raw.verb || ""), ctx: session.ctx, agent: String(raw.agent || ""), name: String(raw.name || "").slice(0, 120), surface: "desk" });
    });

    ipcMain.handle("assist:refine", async (event) => {
      const bad = guard(event); if (bad) return bad;
      const fn = session.refine;
      session.refine = null; // once per open
      if (!fn) return { ok: true, chips: [] };
      const chips = await fn();
      if (chips.length && session) { session.chips = chips; }
      return { ok: true, chips };
    });

    ipcMain.handle("assist:accept", async (event, raw = {}) => {
      const bad = guard(event); if (bad) return bad;
      if (!session.canInsert) return { ok: false, reason: "this field cannot take text", error: "Aither cannot type into this field. Use Copy." };
      const text = String(raw.text == null ? (session.last && session.last.text) || "" : raw.text).slice(0, MAX_INSERT);
      if (!text.trim()) return { ok: false, reason: "empty", error: "There is nothing to insert." };
      const logged = engine.note("accepted", { id: session.last && session.last.id, verb: (session.last && session.last.verb) || "write", ctx: session.ctx, text });
      if (!logged.ok) return { ok: false, error: `Not inserted: the action log is not writable (${logged.error}).` };
      session.busy = true;
      hide(); // give the focus back before the paste
      const verdict = await caret.insert({ hwnd: session.hwnd, text });
      session.busy = false;
      if (verdict && verdict.ok) {
        if (session.last) session.last.inserted = true;
        session.insertedAt = now();
        // Bring the pop-up back WITHOUT taking the focus from the app we just typed into, so
        // Undo stays one click away; it leaves by itself after 20 s (or on the next click away).
        if (alive()) { win.showInactive(); shownAt = now(); }
        clearTimeout(session.undoTimer);
        session.undoTimer = setTimeout(() => { if (session && session.last && !session.busy) hide(); }, 20000);
        if (session.undoTimer.unref) session.undoTimer.unref();
      } else if (verdict && alive()) {
        win.show();
      }
      return verdict && verdict.ok ? { ok: true } : { ok: false, reason: verdict && verdict.reason, error: insertFailure(verdict) };
    });

    ipcMain.handle("assist:undo", async (event) => {
      const bad = guard(event); if (bad) return bad;
      if (!session.last || !session.last.inserted) return { ok: false, error: "Nothing was inserted yet." };
      engine.note("undone", { id: session.last.id, verb: session.last.verb, ctx: session.ctx });
      const verdict = await caret.undo({ hwnd: session.hwnd });
      if (verdict && verdict.ok) session.last.inserted = false;
      return verdict && verdict.ok ? { ok: true } : { ok: false, error: insertFailure(verdict) };
    });

    ipcMain.handle("assist:copy", (event, raw = {}) => {
      const bad = guard(event); if (bad) return bad;
      clipboard.writeText(String(raw.text || "").slice(0, MAX_INSERT));
      return { ok: true };
    });

    // Explorer verbs. The renderer names an ACTION and an argument; the file is the one the
    // shell menu opened the pop-up for (session.file), never a path the page supplies.
    ipcMain.handle("assist:file", async (event, raw = {}) => {
      const bad = guard(event); if (bad) return bad;
      if (!files || !session.file) return { ok: false, error: "No file is open." };
      const action = String(raw.action || "");
      const arg = typeof raw.arg === "string" ? raw.arg.slice(0, 2000) : "";
      const info = session.file;
      if (action === "summarize" || action === "ask") {
        const res = await files.runVerb({ verb: action, info, prompt: arg });
        if (res.ok) session.last = { id: res.id, verb: action, text: res.text, kind: "answer", inserted: false };
        return res;
      }
      if (action === "rename-propose") return files.proposeRename(info);
      if (action === "rename-apply") {
        const res = files.applyRename({ from: info.path, name: arg });
        if (res.ok) session.file = { ...info, path: res.to, name: res.to.split("\\").pop() };
        return res;
      }
      if (action === "rename-undo") {
        const res = files.undoRename();
        if (res.ok) session.file = files.inspect(res.restored);
        return res;
      }
      if (action === "convert") return files.convert({ info, to: arg });
      if (action === "pipeline") return files.sendToPipeline({ info });
      if (action === "pack") return files.runPack({ info, pack: arg, agent: engine.settings().agent });
      return { ok: false, error: "Unknown file action." };
    });

    ipcMain.handle("assist:util", async (event, raw = {}) => {
      const bad = guard(event); if (bad) return bad;
      const uid = String(raw.id || "");
      if (uid === "link:open-aither" || uid === "link:open-system") {
        const url = selectedLink(session.ctx);
        if (!url || typeof openLink !== "function") return { ok: false, error: "No link is selected." };
        const r = openLink(url, uid === "link:open-aither" ? "aither" : "system");
        if (r && r.ok) hide();
        return r && typeof r === "object" ? r : { ok: false, error: "could not open it" };
      }
      if (!utils) return { ok: false, error: "Utilities are not available." };
      return utils.run(String(raw.id || ""), { selection: session.ctx.selection, title: session.ctx.title, app: session.ctx.app, pid: session.pid, hwnd: session.hwnd, arg: typeof raw.arg === "string" ? raw.arg.slice(0, 40) : undefined, hide });
    });

    ipcMain.handle("assist:close", (event) => {
      if (!fromWin(event)) return { ok: false };
      if (session && session.last && !session.last.inserted && !session.closedNoted) {
        session.closedNoted = true;
        engine.note("cancelled", { id: session.last.id, verb: session.last.verb, ctx: session.ctx });
      }
      hide();
      return { ok: true };
    });
  }

  function insertFailure(v) {
    const reason = v && v.reason;
    if (reason === "window-gone") return "The window you were typing in is gone.";
    if (reason === "could-not-focus") return "Could not switch back to that window. Click into it and try again, or use Copy.";
    if (reason === "unsupported") return "Typing into other apps is Windows only. Use Copy.";
    return `Could not insert the text${reason ? ` (${reason})` : ""}. Use Copy.`;
  }

  function create() {
    win = new BrowserWindow({
      width: SIZE.width, height: SIZE.height, show: false,
      frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "assist-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("blur", () => {
      // Click-away closes it, except while a paste is in flight (focus is moving on purpose).
      if (now() - shownAt > 400 && !(session && session.busy)) hide();
    });
    win.on("closed", () => { win = null; });
    void win.loadFile(path.join(__dirname, "assist.html"));
    return win;
  }

  /**
   * Open at the caret of the focused app. `verb` (optional) runs straight away on the
   * selection -- the "Explain / Rewrite..." registry commands.
   */
  /**
   * Where the pop-up hangs. A real caret or selection rect wins. A browser that exposes no
   * caret hands back the whole PAGE as the focused element (measured: a 1900 px tall
   * rect that flipped the pop-up to the top-left corner); for a rect that large the
   * mouse -- where the user just clicked into the field -- is the better anchor.
   */
  function anchorCaret(snap) {
    const c = snap && snap.caret;
    if (!c) return null;
    // UI Automation reports PHYSICAL pixels; Electron places windows in DIPs. On a scaled
    // display (measured: 160 %) the two differ, so convert the rect's top and bottom edges.
    const dip = (pt) => (typeof screen.screenToDipPoint === "function" ? screen.screenToDipPoint(pt) : pt);
    const top = dip({ x: c.x, y: c.y });
    const bottom = dip({ x: c.x, y: c.y + c.h });
    const h = Math.max(0, bottom.y - top.y);
    if (c.via === "element" && h > 160) return null;
    return { x: top.x, y: top.y, h, via: c.via };
  }

  /**
   * Read the focused app: caret, selection, field -- WITHOUT showing anything. The Alt+Space
   * launcher calls this on key-down (before it takes the focus); open() calls it too.
   * Returns a session that present() can show, or null when the capture could not run.
   */
  async function captureSession() {
    const snap = await caret.snapshot();
    if (!snap || snap.ok === false) return null;
    const refused = snap.sensitive ? core.refusal({ sensitive: true }) : "";
    const ctx = core.normalizeContext({
      surface: "desk", app: snap.app, title: snap.title,
      selection: refused ? "" : snap.selection, field: refused ? "" : snap.field,
      fieldLabel: snap.fieldLabel, sensitive: Boolean(refused), canInsert: Boolean(snap.canInsert),
    });
    const sug = refused ? { chips: [], send: null, refine: null } : engine.suggest(ctx, { surface: "desk" });
    return {
      snap, ctx, hwnd: snap.hwnd || 0, pid: snap.pid || 0, refused,
      // Never paste into the desk's own window (tray / palette launches focus the desk), nor a
      // terminal host (it would execute pasted newlines).
      canInsert: Boolean(snap.ok !== false && snap.canInsert && (snap.hwnd || 0) > 0 && snap.pid !== process.pid && !TERMINAL_APPS.has(String(snap.app || "").toLowerCase())),
      chips: sug.chips || [], send: sug.send || null, refine: sug.refine || null,
      verbs: refused ? [] : verbsFor(ctx), last: null, initialVerb: null, autoRun: null,
    };
  }

  /** Show a captured session at its caret. `autoRun` {verb, prompt, insert} starts a verb at once. */
  function present(captured, { verb = null, autoRun = null } = {}) {
    ensureIpc();
    session = { ...captured, last: null, initialVerb: verb, autoRun };
    const cursor = screen.getCursorScreenPoint();
    const anchor = anchorCaret(captured.snap);
    const display = screen.getDisplayNearestPoint(anchor ? { x: anchor.x, y: anchor.y } : cursor);
    if (!alive()) create();
    const spot = caretLib.placePopup({ caret: anchor, fallback: cursor, size: SIZE, work: display.workArea });
    win.setBounds({ x: spot.x, y: spot.y, width: SIZE.width, height: SIZE.height });
    shownAt = now();
    win.show();
    win.focus();
    push();
    if (typeof onOpen === "function") { try { onOpen(); } catch { /* observer bug */ } }
    return { ok: true, refused: Boolean(session.refused), app: session.ctx.app, hasSelection: Boolean(session.ctx.selection.trim()) };
  }

  async function open({ verb = null } = {}) {
    ensureIpc();
    if (alive() && win.isVisible()) { hide(); return { ok: true, closed: true }; }
    const captured = await captureSession();
    if (!captured) return { ok: false, error: "Could not read the focused app." };
    return present(captured, { verb });
  }

  /**
   * The Alt+Space integration (launcher-window.cjs `assist`). capture() runs on KEY-DOWN,
   * group() builds the writing rows the box leads with, choose() runs one: the launcher
   * hides first, then the pop-up opens at the ORIGINAL caret and the verb starts at once;
   * a transform result is inserted / replaced there with Undo one click away.
   */
  const launcher = {
    capture: () => captureSession().catch(() => null),
    group(captured, typed) {
      if (!captured || captured.pid === process.pid) return null; // the race was lost: today's behaviour
      const g = core.writingGroup({ snap: captured.snap, typed, insertable: captured.canInsert });
      return g ? g.group : null;
    },
    choose(captured, key, typed) {
      if (!captured) return { ok: false, error: "The window you were in is gone. Press Alt+Space again." };
      const g = core.writingGroup({ snap: captured.snap, typed, insertable: captured.canInsert });
      const action = g && g.plan.get(String(key || ""));
      if (!action) return { ok: false, error: "That row is no longer available. Press Alt+Space again." };
      if (action.run) {
        return present(captured, { autoRun: { verb: action.verb, prompt: action.prompt, insert: action.insert === true } });
      }
      return present(captured, { verb: action.verb }); // translate / send to an agent ask their one question first
    },
  };

  /**
   * Open for a file or folder the Explorer right-click named. No caret to capture and no
   * paste target: the result is shown, copied or acted on, never typed into another app.
   */
  async function openFile({ path: rawPath, verb = null } = {}) {
    ensureIpc();
    const info = files ? files.inspect(rawPath) : { ok: false, error: "Explorer verbs are not available." };
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const ctx = core.normalizeContext({
      surface: "explorer", app: "File Explorer", title: info.ok ? info.name : "", selection: info.ok && info.textable ? info.text : "", canInsert: false,
    });
    session = {
      ctx, hwnd: 0, pid: 0, refused: info.ok ? "" : info.error, canInsert: false, file: info.ok ? info : null,
      chips: [], verbs: [], refine: null, last: null, initialVerb: verb,
      send: core.describeSend({ ...ctx, app: "File Explorer" }, engine.settings()),
    };
    if (!alive()) create();
    const spot = caretLib.placePopup({ caret: null, fallback: cursor, size: SIZE, work: display.workArea });
    win.setBounds({ x: spot.x, y: spot.y, width: SIZE.width, height: SIZE.height });
    shownAt = now();
    win.show();
    win.focus();
    push();
    return { ok: info.ok, error: info.ok ? undefined : info.error, name: info.ok ? info.name : undefined };
  }

  return { open, openFile, hide, launcher, state: publicState, isOpen: () => alive() && win.isVisible() };
}

module.exports = { createAssistWindow, SIZE, VERB_ORDER };
