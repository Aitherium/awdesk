/* global window, document, setTimeout, clearTimeout, setInterval, URL */
/* pin-cards.js -- ONE renderer for pinned cards (pin-item.cjs records), shared by
   aither://canvas (canvas-page.js) and the floating board window (board.html), so a
   card cannot look or behave differently in the two views of the same board.
   Text only (textContent); no markup from data, ever.

   window.AitherPinCards.create(opts) -> { renderCard(pin), labelFor(pin), LIVE }
     opts.api       { op(o) -> Promise<{ok,error}>, widget(id) -> Promise, open(id) }
     opts.widgets   () -> the widget registry's list (canvas-widgets.cjs)
     opts.zoom      () -> the surface's zoom (1 in the board window)
     opts.select    (id) -> mark a card selected
     opts.selected  () -> the selected card id
     opts.timers    Map card id -> interval (the caller clears them on re-render)
     opts.onDrag    () -> a card moved under the pointer (the live view must follow)
     opts.say       (text) -> show a status line
     opts.onSettle  () -> a drag ended (render what arrived meanwhile: see busy())
   Gestures: left-drag the header moves, the corner grip resizes, and the owner's
   middle-button rule (middle-drag.js): middle-drag moves, Shift resizes, Ctrl
   duplicates. */
(function (root) {
  "use strict";
  const LIVE = ["app", "url", "youtube", "gif", "image"];
  const KIND_LABEL = { youtube: "YouTube", gif: "GIF", image: "Image" };

  function create(opts) {
    const o = opts || {};
    const api = o.api;
    const zoom = () => (typeof o.zoom === "function" ? o.zoom() : 1) || 1;
    const timers = o.timers || new Map();
    const select = typeof o.select === "function" ? o.select : () => {};
    const onDrag = typeof o.onDrag === "function" ? o.onDrag : () => {};
    const say = typeof o.say === "function" ? o.say : () => {};
    const widgets = () => (typeof o.widgets === "function" ? o.widgets() : []) || [];
    /** Drags in flight: a re-render under one would detach the dragged node and lose its pointerup. */
    let active = 0;
    const onSettle = typeof o.onSettle === "function" ? o.onSettle : () => {};
    const op = async (x) => { const r = await api.op(x); if (!r || !r.ok) say((r && r.error) || "refused"); return r; };

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    };

    function hostOf(url) {
      try { const u = new URL(url); return u.protocol === "aither:" ? `aither://${u.hostname}` : u.hostname; } catch { return ""; }
    }

    function labelFor(pin) {
      if (pin.title) return pin.title;
      if (pin.kind === "widget") return (widgets().find((w) => w.id === pin.widget) || {}).label || pin.widget;
      if (pin.kind === "note") return "Note";
      const host = pin.src.startsWith("data:") ? "" : hostOf(pin.src);
      return KIND_LABEL[pin.kind] ? `${KIND_LABEL[pin.kind]}${host ? ` · ${host}` : ""}` : host;
    }

    /** Left-button drag of the header (move) or the corner grip (resize). */
    function dragCard(e, pin, node, mode) {
      if (pin.locked || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      select(pin.id);
      follow(e, e.currentTarget, pin, node, mode);
    }

    /** Track one drag and commit it as ONE op at the end. */
    function follow(e, target, pin, node, mode) {
      const b = pin.bounds;
      const MD = root.AitherMiddleDrag;
      let ghost = null;
      if (mode === "duplicate") {
        ghost = node.cloneNode(true);
        ghost.style.opacity = "0.6";
        ghost.style.pointerEvents = "none";
        node.parentNode.append(ghost);
      }
      active += 1;
      MD.track(e, target, {
        scale: zoom(),
        onMove: ({ dx, dy }) => {
          if (mode === "resize") {
            node.style.width = `${Math.max(120, b.width + dx)}px`;
            node.style.height = `${Math.max(80, b.height + dy)}px`;
          } else {
            const moving = ghost || node;
            moving.style.left = `${b.x + dx}px`;
            moving.style.top = `${b.y + dy}px`;
          }
          onDrag();
        },
        onEnd: ({ dx, dy, moved }) => {
          if (ghost) ghost.remove();
          active -= 1;
          if (!moved) { onSettle(); return; }
          if (mode === "move") void op({ op: "pin.move", id: pin.id, x: b.x + dx, y: b.y + dy });
          else if (mode === "resize") void op({ op: "pin.resize", id: pin.id, w: b.width + dx, h: b.height + dy });
          else void op({ op: "pin.duplicate", id: pin.id, x: b.x + dx, y: b.y + dy });
          onSettle();
        },
      });
    }

    function headButton(text, title, onclick, cls) {
      const b = el("button", cls || null, text);
      b.title = title;
      b.setAttribute("aria-label", title);
      b.onpointerdown = (e) => { if (e.button === 0) e.stopPropagation(); };
      b.onclick = (e) => { e.stopPropagation(); onclick(); };
      return b;
    }

    function renderNote(pin, body) {
      body.classList.add("note");
      const ta = el("textarea");
      ta.value = pin.src || "";
      ta.placeholder = "Write something…";
      ta.setAttribute("aria-label", "Note text");
      let t = null;
      ta.oninput = () => { clearTimeout(t); t = setTimeout(() => api.op({ op: "pin.update", id: pin.id, text: ta.value }), 500); };
      ta.onpointerdown = (e) => { if (e.button === 0) e.stopPropagation(); };
      body.append(ta);
    }

    function drawRead(body, w, r) {
      body.textContent = "";
      if (!r || !r.ok) { body.append(el("div", "err", (r && r.error) || "unavailable")); return; }
      if (w.view === "stat") {
        const box = el("div", "stat");
        box.append(el("div", `v tone-${r.tone || "muted"}`, r.value), el("div", "sub", r.sub));
        body.append(box);
      } else if (w.view === "list") {
        const box = el("div", "list");
        for (const row of r.rows || []) {
          const line = el("div", "row");
          line.append(el("span", null, row.label), el("span", `tone-${row.tone || "muted"}`, row.value));
          box.append(line);
        }
        if (r.more > 0) box.append(el("div", "sub", `+${r.more} more`));
        if (r.sub) box.append(el("div", "sub", r.sub));
        if (!(r.rows || []).length && !r.sub) box.append(el("div", "err", "nothing to show"));
        body.append(box);
      }
    }

    function renderWidget(pin, body) {
      const w = widgets().find((x) => x.id === pin.widget);
      if (!w) { body.append(el("div", "err", `No widget called ${pin.widget} on this desk.`)); return; }
      if (w.view === "clock") {
        const box = el("div", "clock");
        const t = el("div", "time");
        const d = el("div", "sub");
        box.append(t, d);
        body.append(box);
        const tick = () => {
          const now = new Date();
          t.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          d.textContent = now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
        };
        tick();
        timers.set(pin.id, setInterval(tick, 1000));
        return;
      }
      if (w.view === "note") { renderNote(pin, body); return; }
      body.append(el("div", "err", "Reading…"));
      const load = async () => drawRead(body, w, await api.widget(w.id));
      void load();
      if (w.refreshMs > 0) timers.set(pin.id, setInterval(load, w.refreshMs));
    }

    function renderCard(pin) {
      const live = LIVE.includes(pin.kind);
      const node = el("div", `card ${live ? "app" : pin.kind}${pin.locked ? " locked" : ""}${pin.id === (o.selected ? o.selected() : null) ? " sel" : ""}`);
      node.dataset.id = pin.id;
      node.tabIndex = 0;
      node.setAttribute("role", "group");
      const label = labelFor(pin);
      node.setAttribute("aria-label", `${label}${pin.locked ? " (locked)" : ""}`);
      const b = pin.bounds;
      Object.assign(node.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`,
        zIndex: String(10 + pin.z), opacity: String(pin.opacity) });
      node.onfocus = () => select(pin.id);
      // The owner's middle-button rule, anywhere on the card (body included).
      node.addEventListener("pointerdown", (e) => {
        if (e.button === 0) { select(pin.id); return; }
        const gesture = root.AitherMiddleDrag && root.AitherMiddleDrag.classify(e, true);
        if (!gesture) return;
        select(pin.id);
        if (pin.locked && gesture !== "duplicate") { e.preventDefault(); e.stopPropagation(); say("That card is locked (L unlocks it)."); return; }
        follow(e, node, pin, node, gesture);
      });
      if (root.AitherMiddleDrag) root.AitherMiddleDrag.suppressAutoscroll(node);
      const head = el("div", "head");
      head.append(el("span", "t", label));
      if (live) head.append(headButton("↗", "Open in a tab (Enter)", () => api.open(pin.id)));
      head.append(headButton(pin.locked ? "\u{1F512}" : "\u{1F513}", pin.locked ? "Unlock (L)" : "Lock in place (L)",
        () => op({ op: "pin.lock", id: pin.id }), "lock"));
      head.append(headButton("×", "Remove from the board (Delete)", () => op({ op: "pin.remove", id: pin.id })));
      head.onpointerdown = (e) => dragCard(e, pin, node, "move");
      const body = el("div", "body");
      if (live) body.textContent = "Loading…";
      else if (pin.kind === "note") renderNote(pin, body);
      else renderWidget(pin, body);
      const grip = el("div", "grip");
      grip.title = "Drag to resize (Shift+arrows, or Shift+middle-drag)";
      grip.onpointerdown = (e) => dragCard(e, pin, node, "resize");
      node.append(head, body, grip);
      return node;
    }

    return { renderCard, labelFor, LIVE, busy: () => active > 0 };
  }

  root.AitherPinCards = Object.freeze({ create, LIVE });
})(typeof window !== "undefined" ? window : globalThis);
