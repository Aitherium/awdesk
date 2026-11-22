/* global window, document, requestAnimationFrame, setTimeout, clearTimeout, clearInterval */
/* aither://canvas -- a desk whiteboard (boards-core.cjs) seen as a board of pinned
   cards, over window.aitherCanvas (canvas-preload.cjs). The board window and this page
   edit ONE document: its drawing (`items`) is drawn here read-only under the cards,
   and every card edit is an op main applies (canvas-model.applyPinOp) and saves.
   Cards are pin-item.cjs records. Text only (textContent); no markup from data. */
(function () {
  "use strict";
  const api = window.aitherCanvas;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const SVG = "http://www.w3.org/2000/svg";
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 2;
  /** pin-item LIVE_KINDS: the card body is a page main lays over it. */
  const LIVE = window.AitherPinCards.LIVE;

  let state = { boards: [], board: null, widgets: [], aitherone: false };
  let board = null;
  /** The live view: pan/zoom move faster than ops, so they are local until saved. */
  let view = { zoom: 1, pan: { x: 0, y: 0 } };
  let selected = null;
  const timers = new Map();
  let viewSaveTimer = null;

  function say(text) {
    $("err").textContent = text || "";
  }

  async function op(o) {
    const r = await api.op(o);
    if (!r || !r.ok) { say((r && r.error) || "refused"); return r; }
    say("");
    return r;
  }

  /**
   * What a re-render depends on. A saved pan/zoom or a note's text coming back must
   * NOT rebuild the board -- that would reset widget timers and steal the caret.
   */
  let renderedKey = "";
  const structureKey = (s) => JSON.stringify([s.boards, s.board && [s.board.id, s.board.title, s.board.grid, s.board.snap,
    s.board.link, s.board.items.length, s.board.items.map((i) => [i.id, i.x, i.y, i.w, i.h]),
    s.board.pins.map((p) => [p.id, p.kind, p.src.length > 200 ? p.src.length : (p.kind === "note" ? "" : p.src),
      p.bounds, p.locked, p.title, p.widget, p.z, p.opacity])]]);

  /** A state that arrived during a card drag waits for the drag to end (cards.busy). */
  let deferred = null;
  function setState(next) {
    if (!next || !next.ok) return;
    if (typeof cards !== "undefined" && cards.busy()) { deferred = next; return; }
    const switched = !board || !next.board || board.id !== next.board.id;
    state = next;
    board = next.board;
    if (switched && board) view = { zoom: board.view.scale || 1, pan: { x: board.view.x || 0, y: board.view.y || 0 } };
    const key = structureKey(state);
    if (key === renderedKey && !switched) return;
    renderedKey = key;
    render();
  }

  // ── the toolbar ────────────────────────────────────────────────────────────
  function renderBar() {
    const sel = $("board");
    sel.textContent = "";
    for (const b of state.boards) {
      const o = el("option", null, `${b.title} (${b.cards})${b.linked ? " ☁" : ""}`);
      o.value = b.id;
      o.selected = Boolean(board && b.id === board.id);
      sel.append(o);
    }
    $("board-delete").disabled = state.boards.length <= 1;
    $("zoom").textContent = `${Math.round(view.zoom * 100)}%`;
    $("snap").classList.toggle("on", Boolean(board && board.snap));
    $("snap").setAttribute("aria-pressed", String(Boolean(board && board.snap)));
    if (board) $("grid").value = String(board.grid);
    const wsel = $("widget");
    if (!wsel.options.length) {
      for (const w of state.widgets) {
        const o = el("option", null, w.label);
        o.value = w.id;
        o.title = w.hint || "";
        wsel.append(o);
      }
    }
    const linked = Boolean(board && board.link);
    $("ao-open").hidden = !linked;
    $("ao-sync").disabled = !state.aitherone;
    $("ao-sync").textContent = linked ? "Sync with AitherOne" : "Link to AitherOne";
    $("ao-sync").title = !state.aitherone ? "AitherOS Online is not available on this desk"
      : linked ? `Linked to AitherOne canvas ${board.link.docId}${board.link.kept ? ` (${board.link.kept} AitherOne-only items kept)` : ""}`
        : "Create an AitherOne canvas from this board and keep the two in sync";
  }

  $("board").onchange = (e) => op({ op: "board.select", id: e.target.value });
  $("board-new").onclick = () => op({ op: "board.create", name: "" });
  $("board-float").onclick = () => op({ op: "board.float" });
  $("board-rename").onclick = () => {
    const input = $("board-name");
    if (input.hidden) {
      input.hidden = false;
      input.value = board ? board.title : "";
      input.focus();
      input.select();
      $("board-rename").textContent = "Save";
      return;
    }
    void op({ op: "board.rename", name: input.value });
    input.hidden = true;
    $("board-rename").textContent = "Rename";
  };
  $("board-name").onkeydown = (e) => {
    if (e.key === "Enter") $("board-rename").click();
    if (e.key === "Escape") { $("board-name").hidden = true; $("board-rename").textContent = "Rename"; }
  };
  let deleteArmed = null;
  $("board-delete").onclick = () => {
    // Two clicks, no dialog: the first arms it and says what goes, the second does it.
    const b = $("board-delete");
    if (!deleteArmed) {
      b.textContent = `Remove "${board ? board.title : ""}" from the list?`;
      b.classList.add("danger");
      deleteArmed = setTimeout(() => { deleteArmed = null; b.textContent = "Delete"; b.classList.remove("danger"); }, 4000);
      return;
    }
    clearTimeout(deleteArmed);
    deleteArmed = null;
    b.textContent = "Delete";
    b.classList.remove("danger");
    void op({ op: "board.delete" });
  };
  const origin = () => ({ x: Math.round(-view.pan.x / view.zoom) + 32, y: Math.round(-view.pan.y / view.zoom) + 32 });
  async function pinTyped() {
    const raw = $("app-url").value.trim();
    if (!raw) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    const r = await op({ op: "pin.add", url, origin: origin() });
    if (r && r.ok) $("app-url").value = "";
  }
  $("app-add").onclick = pinTyped;
  $("app-url").onkeydown = (e) => { if (e.key === "Enter") void pinTyped(); };
  $("note-add").onclick = () => op({ op: "pin.add", kind: "note", text: "", origin: origin() });
  $("widget-add").onclick = () => {
    const w = state.widgets.find((x) => x.id === $("widget").value);
    if (!w) return;
    void op({ op: "pin.add", kind: "widget", widget: w.id, title: w.label, w: w.size.w, h: w.size.h, origin: origin() });
  };
  $("zoom-in").onclick = () => zoomBy(1.2);
  $("zoom-out").onclick = () => zoomBy(1 / 1.2);
  $("fit").onclick = fit;
  $("snap").onclick = () => board && op({ op: "grid", snap: !board.snap });
  $("grid").onchange = (e) => board && op({ op: "grid", grid: Number(e.target.value) });

  // ── AitherOne: link / sync / open; a conflict is the owner's call ─────────────
  function conflict(on) {
    $("ao-desk").hidden = !on;
    $("ao-remote").hidden = !on;
  }
  async function aoSync(prefer) {
    conflict(false);
    say("Syncing with AitherOne…");
    const r = await api.op({ op: "aitherone.sync", prefer });
    if (r && r.action === "conflict") {
      say(`Both changed since the last sync (desk ${r.local || "?"}, AitherOne ${r.remote || "?"}). Pick one; nothing was written.`);
      conflict(true);
      return;
    }
    if (!r || !r.ok) { say((r && r.error) || "the sync failed"); return; }
    const words = { linked: "Linked: an AitherOne canvas now mirrors this board", pushed: "Sent to AitherOne",
      pulled: `Updated from AitherOne${r.report ? ` (${r.report.cards} cards, ${r.report.drawing} drawn, ${r.report.kept} kept for AitherOne)` : ""}`,
      "in-sync": "Already in sync with AitherOne" };
    say(words[r.action] || r.action);
  }
  $("ao-sync").onclick = () => aoSync(null);
  $("ao-desk").onclick = () => aoSync("desk");
  $("ao-remote").onclick = () => aoSync("aitherone");
  $("ao-open").onclick = () => op({ op: "aitherone.open" });

  // ── pan & zoom ─────────────────────────────────────────────────────────────
  function applyView() {
    $("plane").style.transform = `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`;
    const g = (board ? board.grid : 16) * view.zoom;
    const vpEl = $("viewport");
    vpEl.style.backgroundSize = `${g}px ${g}px`;
    vpEl.style.backgroundPosition = `${view.pan.x}px ${view.pan.y}px`;
    $("zoom").textContent = `${Math.round(view.zoom * 100)}%`;
    reportViews();
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(() => { if (board) void api.op({ op: "view", zoom: view.zoom, pan: view.pan }); }, 400);
  }

  function zoomAt(factor, cx, cy) {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
    const bx = (cx - view.pan.x) / view.zoom;
    const by = (cy - view.pan.y) / view.zoom;
    view = { zoom: z, pan: { x: Math.round(cx - bx * z), y: Math.round(cy - by * z) } };
    applyView();
  }

  function zoomBy(factor) {
    const r = $("viewport").getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  }

  function fit() {
    const boxes = board ? [...board.pins.map((p) => p.bounds), ...board.items.map((i) => ({ x: i.x, y: i.y, width: i.w, height: i.h }))] : [];
    if (!boxes.length) { view = { zoom: 1, pan: { x: 0, y: 0 } }; applyView(); return; }
    const r = $("viewport").getBoundingClientRect();
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    const pad = 32;
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))));
    view = { zoom: z, pan: { x: Math.round(pad - minX * z), y: Math.round(pad - minY * z) } };
    applyView();
  }

  const vp = $("viewport");
  window.AitherMiddleDrag.suppressAutoscroll(vp);
  vp.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    else { view.pan = { x: Math.round(view.pan.x - e.deltaX), y: Math.round(view.pan.y - e.deltaY) }; applyView(); }
  }, { passive: false });
  vp.addEventListener("pointerdown", (e) => {
    // A card handles its own buttons (pin-cards.js); the background pans, by the
    // left button or the middle one (the owner's rule: middle on empty space pans).
    const onCard = e.target.closest && e.target.closest(".card");
    if (onCard) return;
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    vp.setPointerCapture(e.pointerId);
    vp.classList.add("panning");
    const start = { x: e.clientX, y: e.clientY, pan: { ...view.pan } };
    const move = (ev) => { view.pan = { x: start.pan.x + ev.clientX - start.x, y: start.pan.y + ev.clientY - start.y }; applyView(); };
    const up = () => {
      vp.classList.remove("panning");
      vp.removeEventListener("pointermove", move);
      vp.removeEventListener("pointerup", up);
      vp.removeEventListener("pointercancel", up);
    };
    vp.addEventListener("pointermove", move);
    vp.addEventListener("pointerup", up);
    vp.addEventListener("pointercancel", up);
    select(null);
  });
  document.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "+" || e.key === "=") { zoomBy(1.2); e.preventDefault(); return; }
    if (e.key === "-") { zoomBy(1 / 1.2); e.preventDefault(); return; }
    if (e.key === "0") { fit(); e.preventDefault(); return; }
    const pin = selected && board && board.pins.find((p) => p.id === selected);
    if (!pin) return;
    const g = board.snap ? board.grid : 8;
    const arrows = { ArrowLeft: [-g, 0], ArrowRight: [g, 0], ArrowUp: [0, -g], ArrowDown: [0, g] };
    if (arrows[e.key]) {
      e.preventDefault();
      const [dx, dy] = arrows[e.key];
      if (e.shiftKey) void op({ op: "pin.resize", id: pin.id, w: pin.bounds.width + dx, h: pin.bounds.height + dy });
      else void op({ op: "pin.move", id: pin.id, x: pin.bounds.x + dx, y: pin.bounds.y + dy });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void op({ op: "pin.remove", id: pin.id });
    } else if (e.key.toLowerCase() === "l") {
      void op({ op: "pin.lock", id: pin.id });
    } else if (e.key === "Enter" && LIVE.includes(pin.kind)) {
      void api.open(pin.id);
    }
  });

  // ── the board's drawing (read-only here; Float opens the window to draw) ────────
  function renderDrawing(plane) {
    const items = board ? board.items : [];
    if (!items.length) return;
    const svg = document.createElementNS(SVG, "svg");
    svg.id = "drawing";
    svg.setAttribute("width", "1");
    svg.setAttribute("height", "1");
    const attrs = (node, map) => { for (const [k, v] of Object.entries(map)) node.setAttribute(k, String(v)); return node; };
    for (const it of items) {
      if (it.type === "stroke" && Array.isArray(it.points)) {
        svg.append(attrs(document.createElementNS(SVG, "polyline"), { points: it.points.map((p) => `${p.x},${p.y}`).join(" "),
          fill: "none", stroke: it.color, "stroke-width": it.width, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      } else if (it.type === "shape") {
        const common = { fill: "none", stroke: it.color, "stroke-width": it.width };
        if (it.shape === "ellipse") {
          svg.append(attrs(document.createElementNS(SVG, "ellipse"), { ...common, cx: it.x + it.w / 2, cy: it.y + it.h / 2, rx: it.w / 2, ry: it.h / 2 }));
        } else if (it.shape === "line") {
          svg.append(attrs(document.createElementNS(SVG, "line"), { ...common, x1: it.x, y1: it.y, x2: it.x + it.w, y2: it.y + it.h }));
        } else {
          svg.append(attrs(document.createElementNS(SVG, "rect"), { ...common, x: it.x, y: it.y, width: it.w, height: it.h }));
        }
      }
    }
    plane.append(svg);
    for (const it of items) {
      if (it.type !== "text" && it.type !== "note" && it.type !== "image") continue;
      const d = el("div", `ditem ${it.type}`);
      Object.assign(d.style, { left: `${it.x}px`, top: `${it.y}px`, width: `${it.w}px`, height: `${it.h}px` });
      if (it.type === "image") {
        const img = el("img");
        img.src = it.dataUrl; // data:image only (boards-core normalizeItem); the CSP allows nothing else
        img.alt = it.name || "";
        Object.assign(img.style, { width: "100%", height: "100%", objectFit: "contain" });
        d.append(img);
      } else {
        d.textContent = it.text;
        if (it.type === "note") d.style.background = it.color;
        else Object.assign(d.style, { color: it.color, fontSize: `${it.size}px` });
      }
      plane.append(d);
    }
  }

  // ── cards ──────────────────────────────────────────────────────────────────
  function select(id) {
    selected = id;
    for (const node of document.querySelectorAll(".card")) node.classList.toggle("sel", node.dataset.id === id);
  }

  // ONE card renderer with the floating board window (pin-cards.js), and the owner's
  // middle-button rule (middle-drag.js) inside it.
  const cards = window.AitherPinCards.create({
    api, widgets: () => state.widgets, zoom: () => view.zoom, select, selected: () => selected,
    timers, onDrag: () => reportViews(), say,
    onSettle: () => { if (deferred) { const next = deferred; deferred = null; setState(next); } },
  });

  function render() {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
    renderBar();
    const plane = $("plane");
    plane.textContent = "";
    renderDrawing(plane);
    for (const pin of board ? board.pins : []) plane.append(cards.renderCard(pin));
    $("empty").hidden = Boolean(board && (board.pins.length || board.items.length));
    applyView();
    if (selected) {
      const node = document.querySelector(`.card[data-id="${selected}"]`);
      if (node && document.activeElement === document.body) node.focus({ preventScroll: true });
    }
  }

  // ── tell main where every live card's body is (it lays the page there) ────────
  let reportFrame = 0;
  function reportViews() {
    if (reportFrame) return;
    reportFrame = requestAnimationFrame(() => {
      reportFrame = 0;
      const v = vp.getBoundingClientRect();
      const cards = [];
      for (const node of document.querySelectorAll(".card.app")) {
        const r = node.querySelector(".body").getBoundingClientRect();
        cards.push({ id: node.dataset.id, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
      }
      // Whether the tab is on screen is MAIN's fact (active tab, pop-out, edit-layout
      // mode); document.visibilityState also flips on a merely occluded window.
      void api.views({ viewport: { x: v.left, y: v.top, width: v.width, height: v.height }, cards });
    });
  }
  window.addEventListener("resize", reportViews);

  api.onBoards((next) => setState(next));
  api.state().then((s) => {
    if (!s || !s.ok) { say((s && s.error) || "the canvas is not available"); return; }
    setState(s);
  });
})();
