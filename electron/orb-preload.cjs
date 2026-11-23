"use strict";

/* global window, document */

/**
 * Bridge for the spirit (orb.html, all three views: orb, bubble, veil).
 * Owned by orb-window.cjs.
 *
 * The page can say WHERE the pointer is, that a press began/ended, which verb
 * it asks, what was dropped on it, and whether it is typing — nothing else.
 * Capture, the vision ladder, the queue, the probe and the clipboard all live
 * in main; the page never names a path, a model or a file (a dropped file's
 * PATH is read here with webUtils and handed to main, which applies the
 * credential refusal before anything opens it).
 */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function on(channel, fn) {
  const listener = (_event, payload) => {
    try { fn(payload); } catch { /* a page bug stays in the page */ }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** Turn a drop into what main can act on: real paths plus typed text. */
function droppedPayload(event) {
  const paths = [];
  const files = event && event.dataTransfer ? event.dataTransfer.files : null;
  for (const file of files || []) {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) paths.push(String(p));
    } catch { /* a drag that is not a real file (a browser image) has no path */ }
  }
  let text;
  try { text = String(event.dataTransfer.getData("text/plain") || ""); } catch { text = ""; }
  if (text.length > 4000) text = text.slice(0, 4000);
  return { paths, text };
}

// Drop targets: the orb disc and the bubble card. A hover cue is CSS-only.
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    try { document.documentElement.classList.add("drop-hover"); } catch { /* no DOM */ }
  });
  window.addEventListener("dragleave", () => {
    try { document.documentElement.classList.remove("drop-hover"); } catch { /* no DOM */ }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    try { document.documentElement.classList.remove("drop-hover"); } catch { /* no DOM */ }
    const payload = droppedPayload(event);
    if (!payload.paths.length && !payload.text.trim()) return;
    void ipcRenderer.invoke("desk:spirit-drop", payload);
  });
}

contextBridge.exposeInMainWorld("aitherOrb", {
  // existing ask-orb surface
  init: () => ipcRenderer.invoke("desk:orb-init"),
  hit: (inside) => ipcRenderer.invoke("desk:orb-hit", Boolean(inside)),
  dragStart: () => ipcRenderer.invoke("desk:orb-drag-start"),
  dragEnd: () => ipcRenderer.invoke("desk:orb-drag-end"),
  click: () => ipcRenderer.invoke("desk:orb-click"),
  // The BADGE is the needs-you door: one click opens the Inbox list (never
  // answers anything). Kept separate from `click` so the orb body keeps its
  // open/close meaning.
  needsYou: () => ipcRenderer.invoke("desk:orb-needs-you"),
  ask: (verb, text) => ipcRenderer.invoke("desk:orb-ask", String(verb || ""), String(text || "")),
  copy: (id) => ipcRenderer.invoke("desk:orb-copy", String(id || "")),
  pin: (id, pinned) => ipcRenderer.invoke("desk:orb-pin", String(id || ""), Boolean(pinned)),
  close: () => ipcRenderer.invoke("desk:orb-close"),
  hide: () => ipcRenderer.invoke("desk:orb-toggle"),
  state: (next) => ipcRenderer.invoke("desk:orb-state", { drafting: Boolean(next && next.drafting) }),
  onLine: (fn) => on("orb:line", fn),
  onBadge: (fn) => on("orb:badge", fn),
  onBusy: (fn) => on("orb:busy", fn),
  onQueue: (fn) => on("orb:queue", fn),
  onFocus: (fn) => on("orb:focus", fn),

  // spirit: attach, trips, holds, results, right-click, drag-out
  menu: () => ipcRenderer.invoke("desk:spirit-menu"),
  pick: (index, action) => ipcRenderer.invoke("desk:spirit-pick", Number(index) || 0, String(action || "hold")),
  holdAction: (action) => ipcRenderer.invoke("desk:spirit-hold", String(action || "")),
  dragHold: () => ipcRenderer.invoke("desk:spirit-drag-hold"),
  cancelTrip: () => ipcRenderer.invoke("desk:spirit-cancel"),
  home: () => ipcRenderer.invoke("desk:spirit-home"),
  attach: () => ipcRenderer.invoke("desk:spirit-attach"),
  mode: (mode) => ipcRenderer.invoke("desk:spirit-mode", mode ? String(mode) : ""),
  onHold: (fn) => on("orb:hold", fn),
  onResults: (fn) => on("orb:results", fn),
  onTrips: (fn) => on("orb:trips", fn),
  onTint: (fn) => on("orb:tint", fn),
  onDepth: (fn) => on("orb:depth", fn),
  onAttach: (fn) => on("orb:attach", fn),
  onMode: (fn) => on("orb:mode", fn),
  onVeil: (fn) => on("orb:veil", fn),
  // Visual neurons (neurons-model.cjs): each agent's recent steps, batched by main
  // at <= 10 Hz. {on, agents:[{agent, nodes, edges}], ttlMs, pulseMs}
  onNeurons: (fn) => on("orb:neurons", fn),
  // the owner's AitherSprite the fairy wears ({name, stage, mood, line, tooltip, tint} | null)
  onSprite: (fn) => on("orb:sprite", fn),
  // attention (fairy-attention.cjs): the whisper's buttons and the fairy's nudge level.
  nudgeAct: (action, key) => ipcRenderer.invoke("desk:nudge-act", String(action || ""),
    typeof key === "boolean" ? key : String(key == null ? "" : key)),
  onNudge: (fn) => on("orb:nudge", fn),
  onNudgeView: (fn) => on("orb:nudge-view", fn),
  onNudgeFlash: (fn) => on("orb:nudge-flash", fn),
  // The agent fairy (agent-fairy.cjs): whose colours the fairy wears, the
  // companions orbiting it. `peek` is refused since 2026-11-12: a hover never opens a card.
  onFairy: (fn) => on("orb:fairy", fn),
  onCompanions: (fn) => on("orb:companions", fn),
  peek: (id) => ipcRenderer.invoke("desk:orb-peek", String(id || "")),
  swarmHit: (inside) => ipcRenderer.invoke("desk:swarm-hit", Boolean(inside)),
  // A CLICK on an agent's fairy opens that agent's newest card (never the empty chat).
  openCard: (id, agent) => ipcRenderer.invoke("desk:orb-open-card", String(id || ""), String(agent || "")),
  // A card or panel is open over the fairy: hover tooltips stand down ({open}).
  onPanel: (fn) => on("orb:panel", fn),
  // Click a companion fairy: a chat with that agent.
  chatAgent: (agent) => ipcRenderer.invoke("desk:orb-chat-agent", String(agent || "")),
  // Hover = a one-line tooltip after a dwell, never a card (owner 2026-11-12).
  // text "" hides it; point is the pointer in screen DIPs.
  tip: (text, point) => ipcRenderer.invoke("desk:fairy-tip", String(text || ""),
    point && Number.isFinite(Number(point.x)) ? { x: Number(point.x), y: Number(point.y) } : null),
  onTip: (fn) => on("orb:tip", fn),
  // Main gave this window back to click-through (the pointer left it without a
  // mouseleave reaching the page): drop the hover so the next move re-arms it.
  onHitReset: (fn) => on("orb:hit-reset", fn),
  // The panel (fairy-panel.cjs): the session switcher, a card answered in place, and
  // the page's own content height so the window fits it.
  panelSession: (id) => ipcRenderer.invoke("desk:panel-session", String(id || "")),
  panelAnswer: (id, key) => ipcRenderer.invoke("desk:panel-answer", String(id || ""), String(key || "")),
  panelSize: (px) => ipcRenderer.invoke("desk:panel-size", Number(px) || 0),
  onPanelView: (fn) => on("orb:panel-view", fn),
  // The asking card's own pin (card-stay.cjs, owner 2026-11-22): stays open and
  // draggable; main docks it to the nearest screen corner. Activity restarts the
  // opt-in idle timeout, which is OFF unless the owner sets one in Settings.
  pinCard: (pinned) => ipcRenderer.invoke("desk:orb-pin-card", Boolean(pinned)),
  activity: () => ipcRenderer.invoke("desk:orb-activity"),
  // Right click: a companion's menu (its card) or the orb's; a pick names an item id.
  fairyMenu: (id, agent) => ipcRenderer.invoke("desk:fairy-menu", String(id || ""), String(agent || "")),
  orbMenu: () => ipcRenderer.invoke("desk:orb-menu"),
  menuPick: (id) => ipcRenderer.invoke("desk:menu-pick", String(id || "")),
  menuHover: (inside) => ipcRenderer.invoke("desk:menu-hover", inside === "key" ? "key" : Boolean(inside)),
  onMenu: (fn) => on("orb:menu", fn),
  // Fine control over the fairies (fairy-control.cjs): a click selects one, the wheel
  // changes the swarm's radius, a drag takes one out of the ring (pin) or back in (rejoin);
  // main reads the real cursor on every phase. `onSwarmView` carries the layout, the
  // focused window to keep off and the counts; `onPinMate` is a pinned fairy's own row.
  select: (agent) => ipcRenderer.invoke("desk:swarm-select", String(agent || "")),
  swarmWheel: (deltaY) => ipcRenderer.invoke("desk:swarm-wheel", Number(deltaY) || 0),
  swarmDrag: (phase, agent, from) => ipcRenderer.invoke("desk:swarm-drag", String(phase || ""), String(agent || ""), from === "pin" ? "pin" : "swarm"),
  onSwarmView: (fn) => on("orb:swarm-view", fn),
  onPinMate: (fn) => on("orb:pin-mate", fn),
});
