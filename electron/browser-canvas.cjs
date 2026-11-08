"use strict";

/**
 * browser-canvas.cjs -- main's half of aither://canvas: the IPC, the widget reads,
 * the LIVE views behind page cards, and the AitherOne link.
 *
 * A canvas is a desk WHITEBOARD (boards-core.cjs, the same document the floating
 * board window edits): `store` is boards-window's door onto that one store, and every
 * pin edit is canvas-model.applyPinOp saved through store.update (applySave). No
 * second store exists; the only thing the layout document holds is WHICH board the
 * canvas page shows (a pointer: desk.canvasBoard).
 *
 * The page draws boards, cards, the board's drawing and widgets in its own DOM. A
 * card that IS a page (pin-item LIVE_KINDS: app, url, youtube, gif, image) cannot be
 * an iframe here -- an aither:// document may not frame the web
 * (browser-internal navigationVerdict, frame-ancestors 'none'), and loosening that is
 * what the owner's fence forbids. So its body is a WebContentsView main lays over the
 * card -- built by the browser's ONE page-view builder, in the session a tab of that
 * address would ride, behind the same navigation guard (makeView, injected). The page
 * reports where each card body is and main moves the views.
 *
 * Electron-free at module load: every dependency is injected, so the bookkeeping is
 * asserted under node --test with fake views and a fake store.
 */

const canvasModel = require("./canvas-model.cjs");
const pinItem = require("./pin-item.cjs");
const aitherone = require("./aitherone-link.cjs");
const { loadRegistry } = require("./canvas-widgets.cjs");

const CANVAS_URL = "aither://canvas/";
const CANVAS_PREFIX = /^aither:\/\/canvas(\/|$)/i;

/** Is this webContents the canvas page? (Its URL is the fence for every canvas channel.) */
function isCanvasContents(wc) {
  try {
    return Boolean(wc && !wc.isDestroyed() && CANVAS_PREFIX.test(String(wc.getURL())));
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.store  boards-window: allBoards, getBoard, updateBoard, stampLink,
 *                             createCanvasBoard, closeBoard, float, onBoardsChanged
 * @param {() => string|null} deps.getActive        the board the canvas shows (desk.canvasBoard)
 * @param {(id: string) => void} deps.setActive
 * @param {(url: string) => ({ok: true, view: object} | {ok: false, error: string})} deps.makeView
 * @param {(wc: object) => ({window: object, origin: {x: number, y: number}, shown: boolean} | null)} deps.hostOf
 * @param {(url: string) => any} [deps.openTab]    open an address as an owner tab
 * @param {() => object|null} [deps.aitherone]     {client, base} for the linked-doc sync, or null offline
 * @param {object} [deps.widgetCtx]                read-only sources for widgets
 * @param {object} [deps.registry]                 a widget registry (tests)
 */
function createCanvasHost(deps) {
  const registry = deps.registry || loadRegistry();
  const store = deps.store;
  /** canvas page webContents id -> { wc, views: Map<pinId, {view, src, window, zoom}>, report } */
  const pages = new Map();

  const alive = (view) => Boolean(view && view.webContents && !view.webContents.isDestroyed());

  /** The board on screen: the pointer if it still names a listed board, else the newest (made if none). */
  function activeBoard() {
    const boards = store.allBoards();
    let board = boards.find((b) => b.id === deps.getActive()) || boards[0] || null;
    if (!board) {
      const made = store.createCanvasBoard("Canvas");
      board = made.board;
    }
    if (board && deps.getActive() !== board.id) deps.setActive(board.id);
    return board;
  }

  function payload() {
    const board = activeBoard();
    const c = canvasModel.canvasOf(board);
    const link = board.link && board.link.aitherone;
    return {
      ok: true,
      boards: store.allBoards().map((b) => ({ id: b.id, title: b.title, cards: (b.pins || []).length,
        linked: Boolean(b.link && b.link.aitherone) })),
      board: { id: board.id, title: board.title, items: board.items || [], ...c,
        link: link ? { docId: link.docId, kept: (link.keep || []).length, remoteUpdatedAt: link.remoteUpdatedAt } : null },
      widgets: registry.list(),
      aitherone: Boolean(deps.aitherone && deps.aitherone()),
    };
  }

  /**
   * A page that shows pins: the canvas tab (its board is the active one, its window is
   * whatever holds the tab) or a floating BOARD WINDOW (a fixed board id, its own
   * window: `boardId` + `hostOf` given by boards-window).
   */
  function pageFor(wc, { boardId = null, hostOf = null } = {}) {
    let page = pages.get(wc.id);
    if (!page) {
      page = { wc, views: new Map(), report: null, boardId: null, hostOf: null };
      pages.set(wc.id, page);
      wc.once("destroyed", () => dropPage(wc.id));
    }
    if (boardId) page.boardId = boardId;
    if (hostOf) page.hostOf = hostOf;
    return page;
  }

  function removeView(entry) {
    if (!entry) return;
    try { if (entry.window && !entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view); } catch { /* gone */ }
    try { if (alive(entry.view)) entry.view.webContents.close(); } catch { /* closing */ }
  }

  function dropPage(id) {
    const page = pages.get(id);
    if (!page) return;
    for (const entry of page.views.values()) removeView(entry);
    pages.delete(id);
  }

  /**
   * Put every live card's view where the page last said its body is. Called on each
   * report, on every board change, and by browser-window's layout() (the tab moved,
   * was hidden, popped out, or edit-layout mode began).
   */
  function place(page) {
    const report = page.report || { viewport: null, cards: [], hidden: true };
    const host = page.hostOf ? page.hostOf() : deps.hostOf(page.wc);
    const board = page.boardId ? store.getBoard(page.boardId) : activeBoard();
    if (!board) return;
    const c = canvasModel.canvasOf(board);
    const live = c.pins.filter((p) => pinItem.LIVE_KINDS.includes(p.kind));
    const want = new Map(live.map((p) => [p.id, p]));
    for (const [id, entry] of page.views) {
      const pin = want.get(id);
      if (!pin || pin.src !== entry.src) {
        removeView(entry);
        page.views.delete(id);
      }
    }
    const rects = new Map((report.cards || []).map((r) => [r.id, r.rect]));
    // The board window draws at 1:1; the canvas page at its own zoom.
    const zoom = page.boardId ? 1 : Math.max(canvasModel.LIMITS.zoomMin, Math.min(canvasModel.LIMITS.zoomMax, c.view.scale));
    for (const pin of live) {
      const clip = canvasModel.clipRect(rects.get(pin.id), report.viewport);
      const show = Boolean(host && host.shown && !report.hidden && clip);
      let entry = page.views.get(pin.id);
      if (!entry && show) {
        const made = deps.makeView(pin.src);
        if (!made.ok) continue;
        entry = { view: made.view, src: pin.src, window: null, zoom: null };
        page.views.set(pin.id, entry);
      }
      if (!entry) continue;
      // Follow the canvas into whichever window holds it (a popped-out canvas tab).
      if (host && entry.window !== host.window) {
        try { if (entry.window && !entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view); } catch { /* gone */ }
        host.window.contentView.addChildView(entry.view);
        entry.window = host.window;
      }
      try {
        if (show) {
          entry.view.setBounds({ x: host.origin.x + clip.x, y: host.origin.y + clip.y, width: clip.width, height: clip.height });
          if (entry.zoom !== zoom) { entry.view.webContents.setZoomFactor(zoom); entry.zoom = zoom; }
        }
        entry.view.setVisible(show);
      } catch { /* a view mid-teardown */ }
    }
  }

  function relayout() {
    for (const page of pages.values()) if (!page.wc.isDestroyed()) place(page);
  }

  /** Tell every canvas page the board changed (its window, another page, a pin from a tab). */
  function broadcast() {
    if (!pages.size) return;
    let state = null;
    for (const page of pages.values()) {
      if (page.wc.isDestroyed()) continue;
      // A board window hears through boards-window (board:changed); the canvas tab here.
      if (!page.boardId) {
        if (!state) state = payload();
        try { page.wc.send("desk:canvas-boards", state); } catch { /* navigating */ }
      }
      place(page);
    }
  }
  if (typeof store.onBoardsChanged === "function") store.onBoardsChanged(() => broadcast());

  /** Save a canvas-model patch to the active board. */
  function savePatch(board, patch) {
    const saved = store.updateBoard(board.id, patch);
    if (!saved.ok) return { ok: false, error: saved.reason || "the board could not be saved" };
    return { ok: true };
  }

  /** The owner's AitherOne verbs: sync (push/pull, conflicts reported), open, unlink. */
  async function aitheroneOp(board, o) {
    const ao = deps.aitherone ? deps.aitherone() : null;
    if (o.op === "aitherone.unlink") {
      const r = savePatch(board, { link: null });
      return r.ok ? { ok: true, action: "unlinked" } : r;
    }
    if (o.op === "aitherone.open") {
      const link = board.link && board.link.aitherone;
      if (!link) return { ok: false, error: "sync this board with AitherOne first" };
      if (!ao || typeof deps.openTab !== "function") return { ok: false, error: "AitherOS Online is not available" };
      return deps.openTab(aitherone.openUrl(ao.base, link.docId)) || { ok: true };
    }
    if (!ao) return { ok: false, error: "AitherOS Online is not available on this desk" };
    if (o.op === "aitherone.link" && typeof o.docId === "string" && o.docId.trim()) {
      // Link to an EXISTING AitherOne canvas: the next sync pulls it (or reports a conflict).
      const r = savePatch(board, { link: { aitherone: { docId: o.docId.trim(), remoteUpdatedAt: null, localUpdatedAt: null, keep: [] } } });
      if (!r.ok) return r;
      board = store.getBoard(board.id);
    }
    const prefer = o.prefer === "desk" || o.prefer === "aitherone" ? o.prefer : null;
    const result = await aitherone.sync(board, ao.client, { prefer });
    if (result.ok && result.patch) {
      const saved = savePatch(board, result.patch);
      if (!saved.ok) return saved;
      if (result.stamp) store.stampLink(board.id);
      broadcast();
    }
    return result;
  }

  /** A pin op on ONE named board (the floating board window's cards). */
  function applyToBoard(boardId, op) {
    const board = store.getBoard(boardId);
    if (!board) return { ok: false, error: "no such board" };
    const o = op && typeof op === "object" ? op : {};
    if (!String(o.op || "").startsWith("pin.")) return { ok: false, error: "a board window edits cards only" };
    const result = canvasModel.applyPinOp(board, o);
    if (!result.ok) return result;
    const saved = savePatch(board, result.patch);
    if (!saved.ok) return saved;
    broadcast();
    return { ok: true, pin: result.pin || null };
  }

  /** What a board window needs to draw its cards. */
  function boardState(wc, boardId, hostOf) {
    pageFor(wc, { boardId, hostOf });
    const board = store.getBoard(boardId);
    if (!board) return { ok: false, error: "no such board" };
    return { ok: true, pins: canvasModel.canvasOf(board).pins, widgets: registry.list() };
  }

  /** One op from the canvas page, the palette or a tab's "Pin to canvas". */
  async function apply(op) {
    const o = op && typeof op === "object" ? op : {};
    if (o.op === "board.create") {
      const made = store.createCanvasBoard(o.name);
      if (!made.ok) return made;
      deps.setActive(made.board.id);
      broadcast();
      return { ok: true, board: made.board.id };
    }
    if (o.op === "board.select") {
      if (!store.allBoards().some((b) => b.id === o.id)) return { ok: false, error: "no such board" };
      deps.setActive(o.id);
      broadcast();
      return { ok: true, board: o.id };
    }
    const board = activeBoard();
    if (o.op === "board.rename") {
      const name = String(o.name || "").trim().slice(0, 160);
      if (!name) return { ok: false, error: "a board needs a name" };
      const r = savePatch(board, { title: name });
      broadcast();
      return r;
    }
    if (o.op === "board.delete") {
      if (store.allBoards().length <= 1) return { ok: false, error: "the last board stays (remove its cards instead)" };
      const r = store.closeBoard(board.id);
      deps.setActive(null);
      broadcast();
      return r.ok ? { ok: true } : { ok: false, error: r.reason };
    }
    if (o.op === "board.float") {
      const r = store.float(board.id);
      return r.ok ? { ok: true } : { ok: false, error: r.reason };
    }
    if (String(o.op || "").startsWith("aitherone.")) return aitheroneOp(board, o);
    const result = canvasModel.applyPinOp(board, o);
    if (!result.ok) return result;
    const saved = savePatch(board, result.patch);
    if (!saved.ok) return saved;
    // A view change only moves the page's own transform: no broadcast storm per pan.
    if (o.op !== "view") broadcast();
    return { ok: true, pin: result.pin || null };
  }

  /** "Pin to canvas": an address onto the active board, as the kind it is. */
  function pin(url, title = "") {
    return apply({ op: "pin.add", url, title });
  }

  function report(wc, data) {
    const p = data && typeof data === "object" ? data : {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const rect = (r) => (r && typeof r === "object"
      ? { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) } : null);
    const page = pageFor(wc);
    page.report = {
      viewport: rect(p.viewport),
      hidden: p.hidden === true,
      cards: (Array.isArray(p.cards) ? p.cards : []).slice(0, canvasModel.LIMITS.pins)
        .filter((c) => c && typeof c.id === "string").map((c) => ({ id: c.id, rect: rect(c.rect) })),
    };
    place(page);
    return { ok: true };
  }

  function stateFor(wc) {
    pageFor(wc);
    return payload();
  }

  function openCard(id, boardId = null) {
    const board = boardId ? store.getBoard(boardId) : activeBoard();
    const p = board && canvasModel.canvasOf(board).pins.find((x) => x.id === id);
    if (!p || !pinItem.LIVE_KINDS.includes(p.kind)) return { ok: false, error: "no such page card" };
    if (typeof deps.openTab !== "function") return { ok: false, error: "the browser is not open" };
    const target = p.kind === "youtube" ? `https://www.youtube.com/watch?v=${pinItem.youtubeId(p.src)}` : p.src;
    return deps.openTab(target) || { ok: true };
  }

  /** Wire the canvas channels. Every one answers ONLY the canvas page. */
  function wire(ipcMain) {
    const guard = (fn) => (event, ...args) => (isCanvasContents(event.sender)
      ? fn(event.sender, ...args) : { ok: false, error: "not the canvas page" });
    ipcMain.handle("desk:canvas-state", guard((wc) => stateFor(wc)));
    ipcMain.handle("desk:canvas-op", guard((_wc, op) => apply(op)));
    ipcMain.handle("desk:canvas-widget", guard((_wc, id) => registry.read(String(id || ""), deps.widgetCtx || {})));
    ipcMain.handle("desk:canvas-views", guard((wc, data) => report(wc, data)));
    ipcMain.handle("desk:canvas-open", guard((_wc, id) => openCard(String(id || ""))));
  }

  /**
   * The floating board window's door (boards-window.cjs handlers): the same renderer
   * data, the same pin ops, the same live views -- for one fixed board.
   */
  const boardWindow = {
    state: (wc, boardId, hostOf) => boardState(wc, boardId, hostOf),
    op: (boardId, op) => applyToBoard(boardId, op),
    views: (wc, boardId, hostOf, data) => { pageFor(wc, { boardId, hostOf }); return report(wc, data); },
    widget: (id) => registry.read(String(id || ""), deps.widgetCtx || {}),
    open: (boardId, id) => openCard(String(id || ""), boardId),
  };

  return { wire, apply, pin, report, relayout, broadcast, stateFor, openCard, registry, boardWindow, __pages: pages };
}

module.exports = { CANVAS_URL, isCanvasContents, createCanvasHost };
