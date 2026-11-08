"use strict";

// Owner 2026-11-07: "the whole-screen drawing must SEAMLESSLY transition from drawing
// to interacting with the desktop again". ink-window.cjs against a FAKE electron:
// what matters is what it asks the windows to do on every switch.

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./ink-core.cjs");
const ink = require("./ink-window.cjs");

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

function fakeElectron(cursor) {
  const log = { created: 0, ignore: [], sent: [] };
  class BrowserWindow {
    constructor() { log.created += 1; this.destroyed = false; this.focused = false;
      this.webContents = { send: (ch, p) => log.sent.push([ch, p]), setWindowOpenHandler() {}, on() {} }; }
    setAlwaysOnTop() {} setBounds() {} showInactive() {} focus() { this.focused = true; } blur() { this.focused = false; }
    isFocused() { return this.focused; } setFocusable() {} isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
    once() {} on() {} loadFile() { return Promise.resolve(); }
    setIgnoreMouseEvents(on, opts) { this.ignore = on ? (opts && opts.forward ? "forward" : "ignore") : "capture"; log.ignore.push(this.ignore); }
  }
  return {
    log,
    electron: {
      BrowserWindow,
      ipcMain: { handle() {}, on() {} },
      screen: {
        getAllDisplays: () => [DISPLAY], getCursorScreenPoint: () => cursor.p,
        getDisplayNearestPoint: () => DISPLAY, on() {},
      },
    },
  };
}

function setup() {
  const cursor = { p: { x: 900, y: 900 } };
  const fake = fakeElectron(cursor);
  ink.closeInk();
  ink.configureInk({ electron: fake.electron, cursor: () => cursor.p, onChange: null });
  return { fake, cursor, win: () => ink.__state() };
}

function stroke(id, y) {
  return core.normalizeItem({ id, type: "stroke", color: "#ff4d4d", width: 4,
    points: [{ x: 100, y }, { x: 300, y }, { x: 500, y }] });
}

test("20 draw/interact switches: one overlay, never recreated, and not one mark lost", () => {
  const { fake } = setup();
  ink.toggleDraw();
  let doc = core.normalizeState();
  doc = core.pushItem(doc, stroke("a", 100));
  doc = core.pushItem(doc, stroke("b", 200));
  ink.__setDoc(DISPLAY.id, doc);
  const created = fake.log.created;
  for (let i = 0; i < 20; i += 1) {
    const kind = ["toggle", "hold", "escape", "right-click", "pen"][i % 5];
    if (kind === "toggle") ink.toggleDraw();
    else if (kind === "hold") { ink.dispatch({ type: "hold-down" }); ink.dispatch({ type: "hold-up" }); }
    else if (kind === "pen") { ink.dispatch({ type: "pen-enter" }); ink.dispatch({ type: "mouse" }); }
    else ink.dispatch({ type: kind });
  }
  assert.equal(fake.log.created, created, "no window was recreated by a switch");
  assert.equal(ink.status().marks, 2, "every mark is still there");
  ink.dispatch({ type: "set", mode: "interact" });
  assert.equal(ink.__state().capture, "none", "back in interact, off every mark: fully click-through");
});

test("draw takes the pointer; interact gives it back with forwarding; the marks are untouched", () => {
  const { fake } = setup();
  ink.toggleDraw();
  assert.equal(fake.log.ignore.at(-1), "capture");
  assert.equal(ink.status().mode, "draw");
  ink.dispatch({ type: "escape" });
  assert.equal(fake.log.ignore.at(-1), "forward", "click-through, mouse moves still forwarded");
  ink.dispatch({ type: "hold-down" });
  assert.equal(ink.status().mode, "draw-held");
  assert.equal(fake.log.ignore.at(-1), "capture");
  ink.dispatch({ type: "hold-up" });
  assert.equal(fake.log.ignore.at(-1), "forward");
});

test("interact: the overlay captures ONLY while the cursor is on an ink object", () => {
  const { fake, cursor } = setup();
  ink.toggleDraw();
  ink.__setDoc(DISPLAY.id, core.pushItem(core.normalizeState(), stroke("s", 400)));
  ink.dispatch({ type: "set", mode: "interact" });
  cursor.p = { x: 300, y: 403 }; // 3 px from the stroke
  assert.equal(ink.objectAt(cursor.p).item.id, "s");
  ink.__pollHover();
  assert.equal(ink.__state().capture, "object");
  assert.equal(fake.log.ignore.at(-1), "capture", "over a stroke: captured");
  cursor.p = { x: 300, y: 600 };
  ink.__pollHover();
  assert.equal(ink.__state().capture, "none");
  assert.equal(fake.log.ignore.at(-1), "forward", "elsewhere: click-through");
  assert.equal(ink.status().mode, "interact", "never entered draw");
});

test("middle-drag in interact moves the stroke (one undo step); Ctrl duplicates; Shift resizes", () => {
  const { cursor } = setup();
  ink.toggleDraw();
  ink.__setDoc(DISPLAY.id, core.pushItem(core.normalizeState(), stroke("s", 400)));
  ink.dispatch({ type: "set", mode: "interact" });
  cursor.p = { x: 300, y: 400 };
  ink.__pollHover();
  const sender = { sender: ink.__senderOf(DISPLAY.id) };
  const h = ink.handlers();
  h["ink:mode"](sender, { type: "middle-down", id: "s" });
  assert.equal(ink.__state().grab.gesture, "move");
  h["ink:grab-end"](sender, { dx: 50, dy: -20 });
  const moved = ink.__doc(DISPLAY.id).items[0];
  assert.deepEqual([moved.points[0].x, moved.points[0].y], [150, 380]);
  assert.equal(ink.__state().grab, null);
  assert.equal(core.undo(ink.__doc(DISPLAY.id)).items[0].points[0].x, 100, "one undo puts it back");
  h["ink:mode"](sender, { type: "middle-down", id: "s", ctrl: true });
  h["ink:grab-end"](sender, { dx: 0, dy: 100 });
  assert.equal(ink.__doc(DISPLAY.id).items.length, 2, "Ctrl+middle-drag made a copy");
  h["ink:mode"](sender, { type: "middle-down", id: "s", shift: true });
  h["ink:grab-end"](sender, { dx: 400, dy: 0 });
  const b = core.itemBounds(ink.__doc(DISPLAY.id).items[0]);
  assert.ok(b.width > 500, `Shift+middle-drag widened it (${b.width})`);
  h["ink:mode"](sender, { type: "middle-down", id: "nope" });
  assert.equal(ink.__state().grab, null, "a middle press on nothing grabs nothing");
});

test("the renderer cannot dispatch the keys' own events (toggle / hold / set)", () => {
  setup();
  ink.toggleDraw();
  const sender = { sender: ink.__senderOf(DISPLAY.id) };
  for (const type of ["toggle", "hold-down", "set", "clear"]) {
    assert.equal(ink.handlers()["ink:mode"](sender, { type, mode: "pen" }), null, type);
  }
});

test("a mode switch sends the overlay no marks (no canvas redraw); a changed mark does", () => {
  const { fake } = setup();
  ink.toggleDraw();
  ink.__setDoc(DISPLAY.id, core.pushItem(core.normalizeState(), stroke("s", 400)));
  ink.dispatch({ type: "escape" }); // first state after the change: carries the marks
  const before = fake.log.sent.length;
  for (let i = 0; i < 6; i += 1) ink.toggleDraw();
  const switches = fake.log.sent.slice(before).filter(([ch]) => ch === "ink:state").map(([, p]) => p);
  assert.equal(switches.length, 6);
  assert.ok(switches.every((p) => !("items" in p)), "mode-only states carry no items");
  assert.ok(switches.every((p) => typeof p.rev === "number"));
  ink.__setDoc(DISPLAY.id, core.pushItem(ink.__doc(DISPLAY.id), stroke("t", 500)));
  ink.toggleDraw();
  const last = fake.log.sent.filter(([ch]) => ch === "ink:state").at(-1)[1];
  assert.equal(last.items.length, 2, "a new revision carries the marks");
});
