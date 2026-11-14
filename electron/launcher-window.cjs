"use strict";

/**
 * launcher-window.cjs -- the ONE Alt+Space key (owner 2026-11-02: "SHOULD ALT+SPACE
 * JUST BE THE MAIN HOT KEY FOR EVERYTHING AWDESK? ... PRESS AND HOLD TO BRING UP A
 * RADIAL MENU ... KIND OF LIKE ALFRED ON MAC?").
 *
 * The key already belongs to the "search.universal" row. This module changes what a
 * PRESS does, without a keyboard hook:
 *
 *   press            show this window AT ONCE (show + focus) so its renderer can see
 *                    the key coming up; a 280 ms timer arms the radial.
 *   release < 280 ms the renderer reports keyup -> the launcher stays (a TAP).
 *   release >= 280 ms the radial (quick-menu.cjs) took the window at 280 ms and its
 *                    renderer reports keyup -> the slice under the pointer runs.
 *   focus refused    Windows' foreground lock can deny focus; without focus nobody
 *                    can report keyup, so the press degrades to a TAP launcher.
 *   auto-repeat      the OS repeats a held key; pressDecision() swallows it.
 *
 * The launcher is one box with one input, grouped results capped at five with a
 * real "+N more", and three prefixes:
 *
 *   (verbs)  a first word the desk owns: draw, gif, pin, youtube, board (desk-verbs.cjs)
 *            and the Aither Browser's -- a bare address, go, search, private, history,
 *            bookmark, tab, find, extension (browser-verbs.cjs).
 *   (plain)  universal search: apps, desk actions, files, screenshots, clipboard,
 *            agents/tools, and the web (search-client.cjs's awfind path, registered
 *            as one more provider -- never a parallel indexer).
 *   >        an awsh / `adk desk ...` command line, spawned without a shell.
 *   ?        Ask Aither down the desk's existing /command path (or orb.ask when a
 *            parallel lane lands it).
 *   @        the Spirit when this build has a spirit command; an honest "not in this
 *            build" line when it does not.
 *
 * Pure timing/selection/ranking lives in launcher-core.cjs and is tested there; this
 * file owns the window, the state machine and the IPC.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const core = require("./launcher-core.cjs");

/** Alfred-sized, upper third of the cursor's display. */
const SIZE = Object.freeze({ width: 760, height: 480 });

/** A held key's first repeat can land before the focus check; give focus this long. */
const FOCUS_CHECK_MS = 90;

/** After a focus-locked press, ignore auto-repeats this long (else it closes itself). */
const LOCKED_IGNORE_MS = 1_000;

/** How long a spawned command may take before it is killed and its output shown. */
const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 200_000;

let wired = false;
let win = null;

function message(error) {
  return String((error && error.message) || error || "no reason").slice(0, 200);
}

/** A PATH entry list, without empties. */
function pathDirs() {
  return String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
}

/** The first regular file matching `names` on PATH, or null. */
function findOnPath(names) {
  for (const dir of pathDirs()) {
    for (const name of names) {
      const full = path.join(dir, name);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* not here */ }
    }
  }
  return null;
}

/** adk ships as adk.exe (a Python console script); a .cmd shim cannot be spawned without a shell. */
function resolveAdk() {
  return process.platform === "win32" ? findOnPath(["adk.exe", "adk"]) : findOnPath(["adk"]);
}

/**
 * awsh is an npm package whose bin shim is a .cmd — CreateProcess cannot run it
 * without a shell, which this module never uses. Resolve the JS entry instead and run
 * it with the system node.exe; that keeps `shell: false`. Never Electron-as-node:
 * the packaged Desk disables the RunAsNode fuse (electron-fuses.test.cjs), so that
 * route would work in dev and silently fail in the installed app.
 */
function resolveAwsh() {
  const rel = path.join("node_modules", "@aitherium", "awsh", "dist", "main.js");
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", rel));
  for (const dir of pathDirs()) candidates.push(path.join(dir, rel));
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  return null;
}

function homeDir() {
  try { return os.homedir(); } catch { return process.cwd(); }
}

/**
 * Run an allowed command line. No shell, no window, output captured.
 * Returns {ok:true, output, code, timedOut} — the panel is the surface — or
 * {ok:false, error} in the desk's "<count> <thing> — <remedy>" shape.
 */
function execPlan(plan) {
  return new Promise((resolve) => {
    let child;
    const argv = plan.argv;
    try {
      if (plan.exe === "awsh") {
        const script = resolveAwsh();
        if (!script) {
          resolve({ ok: false, error: "1 awsh command unavailable — awsh is not installed in this PATH (npm i -g @aitherium/awsh)" });
          return;
        }
        const node = process.platform === "win32" ? findOnPath(["node.exe"]) : findOnPath(["node"]);
        if (!node) {
          resolve({ ok: false, error: "1 awsh command unavailable — node is not on this PATH (install Node.js)" });
          return;
        }
        child = spawn(node, [script, ...argv.slice(1)], { windowsHide: true, shell: false, cwd: homeDir() });
      } else {
        const exe = resolveAdk();
        if (!exe) {
          resolve({ ok: false, error: "1 adk command unavailable — adk.exe is not on this PATH (pip install -e the adk tree)" });
          return;
        }
        child = spawn(exe, argv.slice(1), { windowsHide: true, shell: false, cwd: homeDir() });
      }
    } catch (error) {
      resolve({ ok: false, error: `1 command did not start — ${message(error)}` });
      return;
    }
    let output = "";
    let timedOut = false;
    const collect = (chunk) => {
      if (output.length >= OUTPUT_CAP) return;
      output += String(chunk);
      if (output.length > OUTPUT_CAP) output = `${output.slice(0, OUTPUT_CAP)}\n… output truncated at ${OUTPUT_CAP} characters`;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => resolve({
      ok: false, error: `1 command did not start — ${error && error.code === "ENOENT" ? "the executable was not found; install it or use the terminal" : message(error)}`,
    }));
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, COMMAND_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: true, output: output || "(no output)", code, timedOut });
    });
  });
}

/**
 * @param {object} opts
 * @param {object} opts.electron  require("electron")
 * @param {object} opts.registry  command-registry.cjs
 * @param {Function} opts.run     (id) => void
 * @param {Function} [opts.ask]   (text) => verdict | Promise<verdict>
 * @param {Function} [opts.spirit] (text) => verdict | Promise<verdict>
 * @param {object} opts.quickMenu createQuickMenu() -- the radial
 * @param {Function} [opts.now]
 */
function createLauncher({
  electron, registry, run, ask = null, spirit = null, quickMenu, now = Date.now,
  // () => Promise<host-context sample>. Started the instant Alt+Space goes DOWN,
  // before showAtCursor() takes focus -- sampled any later, the foreground window
  // is the launcher itself. Null = the empty box stays "Type to search".
  hostContext = null,
  // () => cards list (decision-cards.listSnapshot()). The empty box leads with
  // "Needs you (N)" -- the owner's cards ARE the reason to press the key -- and
  // the foreground-window group follows. Null = no card group.
  cards = null,
  // () => {id, title} | null -- the card the fairy is nudging about right now
  // (orb-window.nudgeCard). Non-null: the empty box leads with "Ask the fairy
  // about: <title>"; null: the box is exactly as before.
  fairy = null,
  // (cardId) => verdict -- open the fairy bubble with that card as context.
  askFairy = null,
  // The Aither Browser's lists for `history <words>`, `bookmark <words>` and `tab <words>`
  // (browser-verbs.cjs): {history(words, limit), bookmarks(words, limit), tabs()}, each the
  // OWNER's own -- main hands browser-window's ownerHistory/ownerBookmarks/ownerTabs.
  // Null = those verbs answer with their page row only.
  browser = null,
} = {}) {
  // The "Right now" sample for THIS press. A promise, so the empty search can wait
  // the few hundred ms the probe takes instead of racing it.
  let pressContext = null;
  if (!electron) throw new Error("launcher needs electron");
  if (!quickMenu) throw new Error("launcher needs the quick menu's radial");

  const { BrowserWindow, ipcMain, screen, shell, clipboard } = electron;
  let phase = "idle"; // idle | pending | launcher | radial-hold
  let pressAt = 0;
  let lastPressAt = 0;
  let releasedAt = 0;
  let ignoreUntil = 0;
  let holdTimer = null;
  let focusTimer = null;
  // A HOLD needs proof the key is still down: the OS auto-repeating the hotkey
  // (press() during "pending"). Measured 2026-11-02: a tap released before the
  // window took focus never produced a keyup, so the 280 ms timer read every such
  // tap as a hold and opened the radial. No proof by HOLD_GRACE_MS -> a tap.
  let heldSeen = false;
  let graceTimer = null;
  let searchSeq = 0;
  let inflight = null;
  let webRegistered = false;
  let ccRegistered = false;
  // The rows the last VERB answer offered (desk-verbs.cjs): key -> action. The page
  // runs a row BY KEY; the action never crosses the bridge.
  const verbActions = new Map();

  function alive() {
    return Boolean(win && !win.isDestroyed());
  }

  function clearTimers() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  }

  function send(channel, payload) {
    if (!alive() || !win.webContents || win.webContents.isLoading()) return;
    try { win.webContents.send(channel, payload); } catch { /* window went away */ }
  }

  function boundsFor(point) {
    let area = { x: 0, y: 0, width: 1920, height: 1080 };
    try { area = screen.getDisplayNearestPoint(point).workArea; } catch { /* defaults */ }
    const width = Math.min(SIZE.width, area.width);
    const height = Math.min(SIZE.height, area.height);
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + Math.max(0, Math.round(area.height * 0.16))),
      width, height,
    };
  }

  function create() {
    win = new BrowserWindow({
      ...boundsFor(screen.getCursorScreenPoint()),
      show: false, frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      alwaysOnTop: true, hasShadow: true, backgroundColor: "#00000000", title: "Aither",
      webPreferences: {
        preload: path.join(__dirname, "launcher-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // Clicking away closes the box. Only the settled launcher treats a blur as a
    // dismissal: during `pending` focus may land a beat late, and during a hold the
    // radial has the window.
    win.on("blur", () => { if (phase === "launcher") hide(); });
    win.on("hide", () => {
      if (phase === "pending" || phase === "launcher") { clearTimers(); phase = "idle"; }
    });
    win.on("closed", () => { win = null; phase = "idle"; });
    void win.loadFile(path.join(__dirname, "launcher.html"));
    return win;
  }

  function showAtCursor() {
    if (!alive()) create();
    win.setBounds(boundsFor(screen.getCursorScreenPoint()));
    win.show();
    win.focus();
    send("launcher:focus");
  }

  function hide() {
    if (alive() && win.isVisible()) win.hide();
    if (phase === "pending" || phase === "launcher") { clearTimers(); phase = "idle"; }
  }

  /** The TAP outcome: the box stays and the input takes the caret. */
  function enterLauncher({ locked = false } = {}) {
    clearTimers();
    phase = "launcher";
    if (locked) {
      // No keyup will ever arrive (the window never had focus), so a quick repeat
      // of the hotkey would read as "the owner pressed again" and close the box.
      ignoreUntil = now() + LOCKED_IGNORE_MS;
      releasedAt = 0;
    }
    send("launcher:focus");
  }

  /** The HOLD outcome: the ring takes over; its renderer reports the keyup. */
  function enterRadial() {
    clearTimers();
    phase = "radial-hold";
    if (alive()) win.hide();
    const opened = quickMenu.openRadial({
      at: screen.getCursorScreenPoint(),
      hold: true,
      onDone: () => { phase = "idle"; lastPressAt = pressAt; releasedAt = now(); },
    });
    if (!opened || !opened.ok) {
      // No radial actions in this build: a hold is still a usable launcher.
      phase = "idle";
      showAtCursor();
      enterLauncher();
    }
  }

  /**
   * The global shortcut. Called ONLY for surface "shortcut" (Alt+Space / the
   * fallback); the tray and the palette keep the existing search-page launcher.
   */
  function press() {
    const at = now();
    const decision = core.pressDecision({ phase, now: at, lastPressAt, releasedAt, ignoreUntil });
    if (decision === "ignore") {
      // An auto-repeat while pending IS the proof of a hold.
      if (phase === "pending") {
        heldSeen = true;
        if (!holdTimer && graceTimer) enterRadial();
      }
      return { ok: true, ignored: true };
    }
    if (decision === "close") {
      hide();
      return { ok: true, closed: true };
    }
    phase = "pending";
    pressAt = at;
    lastPressAt = at;
    releasedAt = 0;
    heldSeen = false;
    pressContext = hostContext
      ? Promise.resolve().then(() => hostContext()).catch((error) => ({ ok: false, reason: String((error && error.message) || error) }))
      : null;
    showAtCursor();
    // The key is down; the renderer can only report it coming UP if it has focus.
    focusTimer = setTimeout(() => {
      focusTimer = null;
      if (phase !== "pending") return;
      if (!alive() || !win.isFocused()) enterLauncher({ locked: true });
    }, FOCUS_CHECK_MS);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (phase !== "pending") return;
      if (heldSeen) { enterRadial(); return; }
      // No keyup and no auto-repeat yet: wait for the OS repeat delay; still
      // nothing means the key went up before we had focus -- a tap.
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (phase !== "pending") return;
        enterLauncher({ locked: !(alive() && win.isFocused()) });
      }, core.HOLD_GRACE_MS);
    }, core.HOLD_MS);
    return { ok: true, phase };
  }

  /** The renderer saw Space/Alt come up. */
  function release() {
    const at = now();
    if (phase === "pending") {
      const kind = core.classifyRelease(pressAt, at);
      releasedAt = at;
      if (kind === "tap") {
        enterLauncher();
        return { ok: true, mode: "launcher" };
      }
      // Released at/after the threshold before the timer ran: the ring is still
      // the right outcome, and the key is already up, so select immediately.
      enterRadial();
      const picked = quickMenu.releaseSelection ? quickMenu.releaseSelection() : { ok: true };
      return { ok: true, mode: "radial", picked };
    }
    if (phase === "radial-hold") {
      const picked = quickMenu.releaseSelection ? quickMenu.releaseSelection() : { ok: true };
      phase = "idle";
      lastPressAt = pressAt;
      releasedAt = at;
      return { ok: true, mode: "radial", picked };
    }
    if (phase === "launcher" && !releasedAt) releasedAt = at;
    return { ok: true, ignored: true };
  }

  // ── search ────────────────────────────────────────────────────────────────
  // The web is one more provider on the SAME universal search (universal-search.cjs),
  // run through search-client.cjs's awfind path. Registering it lazily keeps the
  // search page's existing groups unchanged until the launcher first needs it.
  function ensureWeb(universal) {
    if (webRegistered) return;
    if (!universal || !universal.registry || universal.registry.has("web")) { webRegistered = true; return; }
    const sw = require("./search-window.cjs");
    universal.register({
      id: "web", label: "Web", priority: 6, fast: false,
      search: async (query, { signal = null } = {}) => {
        const ctl = new AbortController();
        const deadline = setTimeout(() => ctl.abort(), 15_000);
        if (deadline.unref) deadline.unref();
        const combined = signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, ctl.signal])
          : (signal || ctl.signal);
        try {
          const r = await sw.client().search("q", query, { limit: 8, signal: combined });
          if (!r || !r.ok) return { ok: false, reason: (r && r.error) || "awfind did not answer" };
          return r.results.map((row) => ({
            title: row.title,
            subtitle: String(row.source || row.snippet || "Web").slice(0, 120),
            kind: "web",
            target: row.url,
            score: 30,
          }));
        } catch (error) {
          const aborted = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
          return { ok: false, reason: aborted ? "awfind took over 15 s" : message(error) };
        } finally {
          clearTimeout(deadline);
        }
      },
    });
    webRegistered = true;
  }

  // The COMMAND CENTER (command-center.cjs): agents & runs, work, knowledge, time and
  // people as five more providers on the same registry -- the box stays ONE box.
  function commandCenter() {
    return require("./command-center.cjs").sharedCommandCenter();
  }

  function ensureCommandCenter(universal) {
    if (ccRegistered || !universal || !universal.registry) return;
    for (const p of commandCenter().providers()) {
      if (!universal.registry.has(p.id)) universal.register(p);
    }
    ccRegistered = true;
  }

  /** Open decision cards whose words match the term, as the answerable "Needs you" group. */
  async function matchingCards(term) {
    if (typeof cards !== "function") return null;
    let snapshot;
    try { snapshot = await cards(); } catch { return null; }
    const words = String(term || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const t = String(term).toLowerCase().trim();
    const wantsAll = ["cards", "decisions", "needs you", "approve"].includes(t);
    // A category word ("runs", "agents") asks for that category, not for every card containing it.
    if (!wantsAll && Object.values(require("./command-center.cjs").CATEGORY_WORDS).some((w) => w.includes(t))) return null;
    const hits = (Array.isArray(snapshot) ? snapshot : []).filter((c) => {
      const hay = `${c.title || ""} ${c.summary || ""} ${c.raisedBy || c.raised_by || ""}`.toLowerCase();
      return wantsAll || words.every((w) => hay.includes(w));
    });
    const built = require("./launcher-context.cjs").needsYouGroup(hits);
    if (!built.group) return null;
    const shown = require("./search-window.cjs").publicRun({ ok: true, query: term, phase: "idle", groups: [built.group], total: built.items.length });
    return shown.groups[0] || null;
  }

  /** Carry out a command-center verdict: a URL, a file, a chat line, or text for the pane. */
  async function carryOut(verdict) {
    const sw = require("./search-window.cjs");
    if (!verdict || verdict.ok === false) return verdict || { ok: false, error: "1 action answered nothing" };
    if (verdict.url) {
      const r = await sw.openWebUrl(verdict.url);
      if (!r.ok) return r;
      return { ok: true, did: verdict.did, hide: true };
    }
    if (verdict.file) {
      const err = await shell.openPath(verdict.file);
      return err ? { ok: false, error: `1 file did not open — ${err}` } : { ok: true, did: verdict.did, hide: true };
    }
    if (verdict.chat) {
      if (!ask) return { ok: false, error: "1 Ask path not wired in main.cjs" };
      const sent = await sw.sendChat(ask, verdict.chat);
      return sent.ok ? { ok: true, did: sent.did, hide: true } : sent;
    }
    if (verdict.text != null) return { ok: true, did: verdict.did, pane: { kind: "text", title: verdict.title || "", text: String(verdict.text) } };
    if (verdict.center) {
      // Edge refs stay in main: the pane needs only opaque node ids.
      const edges = (verdict.edges || []).map((e) => ({ to: e.to, label: e.label, source: e.source }));
      return { ok: true, did: verdict.did || "graph", pane: { kind: "graph", center: verdict.center, nodes: verdict.nodes, edges, notes: verdict.notes } };
    }
    return { ok: true, did: verdict.did };
  }

  /** A verb on one result (Ctrl+Enter steer, Ctrl+. stop, Ctrl+T transcript, Ctrl+G graph, Ctrl+P phone link). */
  async function actRow(key, verb, text) {
    const sw = require("./search-window.cjs");
    const k = String(key || "");
    const v = String(verb || "open");
    const remembered = sw.rememberedItem ? sw.rememberedItem(k) : null;
    if (k.startsWith("card:")) {
      const id = (remembered && remembered.cardId) || k.slice("card:".length);
      if (v === "phone") {
        const url = `https://aitherium.com/approve?card=${encodeURIComponent(id)}`;
        clipboard.writeText(url);
        return { ok: true, did: `copied the phone approve link (${url})` };
      }
      return { ok: false, error: "1 card takes 1-9 to answer, or Ctrl+P for its phone approve link" };
    }
    const { CC_KINDS } = require("./command-center.cjs");
    if (!remembered || !CC_KINDS.has(remembered.kind)) {
      return { ok: false, error: "1 result has no agent verbs — steer, stop, transcript and graph work on agents, runs, work, knowledge, time and people" };
    }
    const verdict = await commandCenter().act(remembered.target, v, text);
    const done = await carryOut(verdict);
    if (done && done.hide) { lastPressAt = pressAt; hide(); }
    return done;
  }

  function statusFor(groups, errors, indexing) {
    if (errors && errors.length) return core.statusText({ errors });
    if (groups && groups.length) return core.statusText({ groups, indexing });
    if (indexing) return "Searching — apps, desk actions and screenshots answered; files, agents and the web are still coming";
    return "0 results — try a shorter word, or > for a command and ? to ask Aither";
  }

  /**
   * A desk verb (draw, gif, pin, youtube, board, canvas, pins -- desk-verbs.cjs).
   * Returns the launcher answer, or {extraGroup, status} for a bare verb that keeps
   * the ordinary search underneath its rows.
   */
  async function verbSearch(v, token) {
    const verbs = require("./desk-verbs.cjs");
    const ctx = { hasCanvas: Boolean(registry && registry.byId && registry.byId("canvas.open")) };
    if (v.verb === "gif" && v.arg) {
      try { ctx.gifs = await require("./gif-picker-window.cjs").gifSearch().search(v.arg, { limit: 8 }); }
      catch (error) { ctx.gifs = { ok: false, reason: message(error) }; }
    }
    if (v.verb === "pin" && v.target === "app") {
      try {
        const r = await require("./search-window.cjs").universal().run(v.value, { phase: "fast" });
        const apps = r && r.ok ? r.groups.find((g) => g.id === "apps") : null;
        ctx.apps = apps ? apps.items : [];
      } catch { ctx.apps = []; }
    }
    if (v.verb === "pins") {
      try { ctx.pins = require("./pins-window.cjs").listPins(); } catch { ctx.pins = []; }
    }
    if (token !== searchSeq) return { ok: true, token, ignored: true };
    const { rows, status } = verbs.verbRows(v, ctx);
    verbActions.clear();
    for (const r of rows) verbActions.set(r.key, r.action);
    const group = verbs.verbGroup(v, rows);
    if (v.bare && ["draw", "board", "canvas", "pins"].includes(v.verb)) return { extraGroup: group, status };
    return { ok: true, token, mode: "all", term: v.arg, phase: "idle", groups: group ? core.capGroups([group]) : [], status };
  }

  /**
   * A browser verb (a bare address, go, search, private, history, bookmark, tab, find,
   * extension -- browser-verbs.cjs). Same answer shape as verbSearch: its own rows, or
   * {extraGroup, status} when the ordinary search stays underneath (`keepSearch`).
   */
  async function browserVerbSearch(v, token) {
    const verbs = require("./browser-verbs.cjs");
    const ctx = {};
    const ask = async (name, ...args) => {
      if (!browser || typeof browser[name] !== "function") return [];
      try { const got = await browser[name](...args); return Array.isArray(got) ? got : []; } catch { return []; }
    };
    if (v.verb === "history" && v.target === "match") ctx.history = await ask("history", v.arg, verbs.MAX_ROWS);
    if (v.verb === "bookmark" && v.target === "match") ctx.bookmarks = await ask("bookmarks", v.arg, verbs.MAX_ROWS);
    if (v.verb === "tab") ctx.tabs = await ask("tabs");
    if (token !== searchSeq) return { ok: true, token, ignored: true };
    const { rows, status } = verbs.verbRows(v, ctx);
    verbActions.clear();
    for (const r of rows) verbActions.set(r.key, r.action);
    const group = verbs.verbGroup(v, rows);
    if (v.keepSearch) return { extraGroup: group, status };
    return { ok: true, token, mode: "all", term: v.arg, phase: "idle", groups: group ? core.capGroups([group]) : [], status };
  }

  async function runVerb(key) {
    const action = verbActions.get(String(key || ""));
    if (!action) return { ok: false, error: "1 row expired — type it again" };
    const sw = require("./search-window.cjs");
    let verdict;
    if (action.type === "command") verdict = await run(action.id, action.arg);
    else if (action.type === "pin") verdict = require("./pins-window.cjs").addPin(action.card);
    else if (action.type === "pin-tab") verdict = await run("pins.tab");
    else if (action.type === "gif-pin") verdict = require("./gif-picker-window.cjs").pinGif(action.id);
    else if (action.type === "gif-picker") verdict = require("./gif-picker-window.cjs").openGifPicker(action.query || "");
    else if (action.type === "browse") verdict = require("./pins-window.cjs").openInBrowser(action.url);
    else if (action.type === "pin-show") verdict = require("./pins-window.cjs").showPin(action.id);
    else if (action.type === "pin-close") verdict = require("./pins-window.cjs").closePin(action.id);
    else return { ok: false, error: `1 verb row has an unknown action ${action.type}` };
    const bad = sw.failureOf(verdict, "desk action");
    if (bad) return { ok: false, error: bad };
    lastPressAt = pressAt;
    hide();
    return { ok: true, did: action.type };
  }

  async function search(text) {
    const token = ++searchSeq;
    if (inflight) { try { inflight.ctl.abort(); } catch { /* already done */ } inflight = null; }
    const verb = require("./desk-verbs.cjs").parseDeskVerb(text);
    let verbExtra = null;
    if (verb) {
      const answered = await verbSearch(verb, token);
      if (!("extraGroup" in answered)) return answered;
      verbExtra = answered;
    } else {
      // The Aither Browser's verbs: an address, go, search, private, history, bookmark, tab, find.
      const browserVerb = require("./browser-verbs.cjs").parseBrowserVerb(text);
      if (browserVerb) {
        const answered = await browserVerbSearch(browserVerb, token);
        if (!("extraGroup" in answered)) return answered;
        verbExtra = answered;
      }
    }
    if (token !== searchSeq) return { ok: true, token, ignored: true };
    let cardGroup = null;
    const withVerb = (groups) => {
      const lead = [verbExtra && verbExtra.extraGroup, cardGroup].filter(Boolean);
      return lead.length ? [...lead, ...groups] : groups;
    };
    const parsed = core.parseQuery(text);
    if (parsed.mode === "command") {
      const plan = core.commandPlan(parsed.term);
      return {
        ok: true, token, mode: "command", term: parsed.term, phase: "idle", groups: [],
        needsConfirm: Boolean(plan.ok && plan.needsConfirm),
        status: plan.reason || "Enter runs it",
      };
    }
    if (parsed.mode === "ask") {
      return { ok: true, token, mode: "ask", term: parsed.term, phase: "idle", groups: [],
        status: parsed.term ? "Enter sends this to Aither" : "Type a question after ?" };
    }
    if (parsed.mode === "spirit") {
      const hasSpirit = Boolean(spirit || (registry && registry.byId && registry.byId("spirit.go")));
      return { ok: true, token, mode: "spirit", term: parsed.term, phase: "idle", groups: [],
        status: hasSpirit
          ? (parsed.term ? "Enter sends this to Spirit" : "Type a message after @")
          : "No Spirit command in this build — press ? to Ask Aither" };
    }
    // `!private` / `!hide`: a deliberate, short reveal of the hidden-by-default rows.
    // While TYPING this only shows a hint -- the device check runs on Enter
    // (runRow "reveal:..."), never on a keystroke, so typing "!pri" cannot pop a
    // Windows Hello prompt.
    const raw = String(text || "").trim().toLowerCase();
    if (raw === "!private" || raw === "!hidden" || raw === "!hide") {
      const reveal = require("./private-reveal.cjs").sharedReveal();
      const showing = reveal.active();
      const item = raw === "!hide" || showing
        ? { key: "reveal:lock", kind: "reveal", title: "Hide private results again",
          subtitle: showing ? `Showing them for ${Math.ceil(reveal.remainingMs() / 60000)} more min` : "They are already hidden" }
        : { key: "reveal:unlock", kind: "reveal", title: "Show hidden results for 5 minutes",
          subtitle: "Games and private titles. Asks Windows Hello / Touch ID first." };
      return { ok: true, token, mode: "all", term: "", phase: "idle",
        groups: [{ id: "private", label: "Private", total: 1, shown: [item], items: [item], more: 0 }],
        status: "Enter to confirm" };
    }
    if (!parsed.term) {
      // The empty box is the LISTS: "Needs you (N)" first (the open decision
      // cards, in the store's one rank order), then what the owner is LOOKING AT
      // (launcher-context.cjs). Both groups are rows launchItem can run, so
      // nothing new becomes executable here.
      const sw = require("./search-window.cjs");
      const context = require("./launcher-context.cjs");
      const groups = [];
      let status = "";
      let total = 0;
      if (typeof fairy === "function" && typeof askFairy === "function") {
        let nudge;
        try { nudge = await fairy(); } catch { nudge = null; }
        if (token !== searchSeq) return { ok: true, token, superseded: true, groups: [] };
        const builtFairy = context.fairyGroup(nudge);
        if (builtFairy.group) { groups.push(builtFairy.group); total += builtFairy.items.length; }
      }
      if (typeof cards === "function") {
        let snapshot;
        try { snapshot = await cards(); } catch { snapshot = []; }
        if (token !== searchSeq) return { ok: true, token, superseded: true, groups: [] };
        const builtCards = context.needsYouGroup(snapshot);
        if (builtCards.group) { groups.push(builtCards.group); total += builtCards.items.length; }
      }
      try {
        const hot = await commandCenter().workingNow();
        if (token !== searchSeq) return { ok: true, token, superseded: true, groups: [] };
        if (hot.length) {
          const items = hot.map((r, i) => ({ key: require("./universal-search.cjs").itemKey(r.kind, r.ref), group: "cc-live", kind: r.kind,
            title: r.title, subtitle: r.subtitle, target: r.ref, score: 1 - i / 1000 }));
          groups.push({ id: "cc-live", label: "Working now", total: items.length, items });
          total += items.length;
        }
      } catch { /* the command center is optional on an empty box */ }
      if (pressContext) {
        const sample = await pressContext;
        if (token !== searchSeq) return { ok: true, token, superseded: true, groups: [] };
        const hasAction = (id) => Boolean(registry && registry.byId && registry.byId(id));
        const built = context.rightNowGroup(sample, hasAction);
        if (built.group) { groups.push(built.group); total += built.items.length; }
        if (built.status) status = built.status;
      }
      if (groups.length === 0) {
        return { ok: true, token, mode: "all", term: "", phase: "idle", groups: [], status: status || core.IDLE_STATUS };
      }
      const shown = sw.publicRun({ ok: true, query: "", phase: "idle", groups, total });
      return { ok: true, token, mode: "all", term: "", phase: "idle", groups: core.capGroups(shown.groups), status };
    }
    const sw = require("./search-window.cjs");
    const universal = sw.universal();
    ensureWeb(universal);
    ensureCommandCenter(universal);
    cardGroup = await matchingCards(parsed.term);
    if (token !== searchSeq) return { ok: true, token, ignored: true };
    const ctl = new AbortController();
    inflight = { token, ctl };
    const view = (result) => {
      if (result && result.ok) {
        const shown = sw.publicRun(result);
        return { groups: shown.groups || [], errors: shown.errors || [] };
      }
      if (result && result.superseded) return null;
      return { groups: [], errors: [{ label: "Search", reason: (result && result.reason) || "no answer" }] };
    };
    let fast;
    try { fast = await universal.run(parsed.term, { phase: "fast", signal: ctl.signal }); }
    catch (error) { fast = { ok: false, reason: message(error) }; }
    if (token !== searchSeq) return { ok: true, token, ignored: true };
    const fastView = view(fast) || { groups: [], errors: [] };
    const payload = {
      ok: true, token, mode: "all", term: parsed.term, phase: "fast",
      groups: core.capGroups(withVerb(fastView.groups)),
      status: statusFor(fastView.groups, fastView.errors, true),
    };
    // The slow half (files, agents, the web) lands when it lands; the box is usable
    // the moment the fast half paints.
    void (async () => {
      let all;
      try { all = await universal.run(parsed.term, { phase: "all", signal: ctl.signal }); }
      catch (error) { all = { ok: false, reason: message(error) }; }
      if (token !== searchSeq) return;
      const allView = view(all) || { groups: [], errors: [] };
      send("launcher:results", {
        ok: true, token, mode: "all", term: parsed.term, phase: "all",
        groups: core.capGroups(withVerb(allView.groups)),
        status: statusFor(allView.groups, allView.errors, false),
      });
    })();
    return payload;
  }

  // ── actions ───────────────────────────────────────────────────────────────
  async function runRow(key, query) {
    if (String(key || "").startsWith("verb:")) return runVerb(key);
    if (String(key || "").startsWith("fairy:")) {
      const id = String(key).slice("fairy:".length);
      if (typeof askFairy !== "function") return { ok: false, error: "1 fairy chat not wired in main.cjs" };
      const sw = require("./search-window.cjs");
      const verdict = await askFairy(id);
      const bad = sw.failureOf(verdict, "fairy chat");
      if (bad) return { ok: false, error: bad };
      hide();
      return { ok: true, did: "asked the fairy" };
    }
    if (String(key || "").startsWith("card:")) {
      // A card row: `query` is a NUMBER (the 1-9 keys) or the option the owner
      // typed. Both resolve to the card's own key and are written by awask, so a
      // number key, a click and a typed answer are one implementation (DCS001).
      const sw = require("./search-window.cjs");
      const remembered = sw.rememberedItem ? sw.rememberedItem(key) : null;
      const id = (remembered && remembered.cardId) || String(key).slice("card:".length);
      const text = String(query || "").trim();
      if (!text) return { ok: false, error: "Press Enter to open the card, or 1-9 / type an option to answer" };
      const spec = /^\d+$/.test(text) ? { id, index: Number(text) } : { id, text };
      const verdict = await run("card-answer", spec);
      const bad = sw.failureOf(verdict, "answer");
      if (bad) return { ok: false, error: bad };
      if (verdict && verdict.ok === false) return verdict;
      hide();
      return { ok: true, did: (verdict && verdict.did) || `answered ${id}` };
    }
    if (key === "reveal:unlock" || key === "reveal:lock") {
      const reveal = require("./private-reveal.cjs").sharedReveal();
      if (key === "reveal:lock") return { ...reveal.lock(), did: "hidden results hidden again" };
      const verdict = await reveal.unlock();
      return verdict.ok
        ? { ok: true, did: "showing hidden results for 5 minutes" }
        : { ok: false, error: `Hidden results stay hidden — ${verdict.reason}` };
    }
    {
      const sw = require("./search-window.cjs");
      const item = sw.rememberedItem ? sw.rememberedItem(key) : null;
      if (item && require("./command-center.cjs").CC_KINDS.has(item.kind)) return actRow(key, "open", "");
    }
    const sw = require("./search-window.cjs");
    const remembered = String(key || "").startsWith("ctx:") && sw.rememberedItem ? sw.rememberedItem(key) : null;
    const effective = String(query || "") || (remembered && remembered.prompt) || "";
    const result = await sw.launchItem(String(key || ""), effective, {
      shell, clipboard,
      action: (id) => run(id),
      chat: ask || null,
    });
    if (result && result.ok) { lastPressAt = pressAt; hide(); }
    return result;
  }

  async function runAsk(text) {
    const body = String(text || "").trim();
    if (!body) return { ok: false, error: "0 words to ask — type a question after ?" };
    const orb = registry && registry.byId ? registry.byId("orb.ask") : null;
    const sw = require("./search-window.cjs");
    if (orb) {
      const verdict = await run("orb.ask", body);
      const bad = sw.failureOf(verdict, "ask");
      if (bad) return { ok: false, error: bad };
      hide();
      return { ok: true, did: "asked Aither" };
    }
    if (!ask) return { ok: false, error: "1 Ask path not wired in main.cjs — open Chat from the tray until the ask sender lands" };
    const sent = await sw.sendChat(ask, body);
    if (sent.ok) hide();
    return sent;
  }

  async function runSpirit(text) {
    const body = String(text || "").trim();
    if (!body) return { ok: false, error: "0 words for Spirit — type a message after @" };
    if (spirit) {
      const sw = require("./search-window.cjs");
      const verdict = await spirit(body);
      const bad = sw.failureOf(verdict, "spirit message");
      if (bad) return { ok: false, error: bad };
      hide();
      return { ok: true, did: "sent to Spirit" };
    }
    if (registry && registry.byId && registry.byId("spirit.go")) {
      const verdict = await run("spirit.go", body);
      const sw = require("./search-window.cjs");
      const bad = sw.failureOf(verdict, "spirit message");
      if (bad) return { ok: false, error: bad };
      hide();
      return { ok: true, did: "sent to Spirit" };
    }
    return { ok: false, error: "1 Spirit channel missing — this build has no Spirit command yet; press ? to Ask Aither" };
  }

  async function runLine(text, confirm = false) {
    const plan = core.commandPlan(text);
    if (!plan.ok) return { ok: false, error: plan.reason };
    if (plan.needsConfirm && !confirm) return { ok: true, needsConfirm: true, reason: plan.reason };
    return execPlan(plan);
  }

  // ── IPC ───────────────────────────────────────────────────────────────────
  const guard = (fn) => async (event, ...args) => {
    if (!alive() || !event || event.sender !== win.webContents) return { ok: false, error: "not the launcher" };
    try { return await fn(...args); } catch (error) {
      return { ok: false, error: `1 launcher action failed — ${message(error)}` };
    }
  };

  function ensureIpc() {
    if (wired) return;
    wired = true;
    ipcMain.handle("launcher:search", guard((text) => search(text)));
    ipcMain.handle("launcher:run", guard((key, query) => runRow(key, query)));
    ipcMain.handle("launcher:command", guard((text, confirm) => runLine(text, confirm === true)));
    ipcMain.handle("launcher:ask", guard((text) => runAsk(text)));
    ipcMain.handle("launcher:spirit", guard((text) => runSpirit(text)));
    ipcMain.handle("launcher:act", guard((key, verb, text) => actRow(key, verb, text)));
    ipcMain.handle("launcher:hide", guard(() => { hide(); return { ok: true }; }));
    ipcMain.handle("launcher:release", guard(() => release()));
  }

  /** Create the window after `app.whenReady()` so the first press paints at once. */
  function warm() {
    try {
      ensureIpc();
      if (!alive()) create();
    } catch (error) {
      console.warn(`[desk] launcher warm-up failed: ${message(error)}`);
    }
  }

  return {
    press, release, hide, search, runRow, runAsk, runSpirit, runLine, warm, actRow,
    isVisible: () => Boolean(alive() && win.isVisible()),
    phase: () => phase,
    __state: () => ({ phase, pressAt, lastPressAt, releasedAt, ignoreUntil }),
  };
}

module.exports = { SIZE, FOCUS_CHECK_MS, COMMAND_TIMEOUT_MS, createLauncher, execPlan };
