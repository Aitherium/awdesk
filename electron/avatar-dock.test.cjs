"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAvatarDock, DOCKED_MIN, FLOAT_MIN } = require("./avatar-dock.cjs");

function fakeWindow(bounds = { x: 1500, y: 300, width: 430, height: 680 }) {
  const w = {
    bounds: { ...bounds }, parent: undefined, onTop: true, allSpaces: true, visible: true, min: { ...FLOAT_MIN },
    destroyed: false, minimized: false,
    isDestroyed: () => w.destroyed,
    getBounds: () => ({ ...w.bounds }),
    setBounds: (b) => { w.bounds = { ...b }; },
    setParentWindow: (p) => { w.parent = p; },
    setAlwaysOnTop: (on) => { w.onTop = on; },
    setVisibleOnAllWorkspaces: (on) => { w.allSpaces = on; },
    setMinimumSize: (width, height) => { w.min = { width, height }; },
    isVisible: () => w.visible,
    showInactive: () => { w.visible = true; },
    isMinimized: () => w.minimized,
  };
  return w;
}

function setup({ wish = true, slot = { x: 10, y: 60, width: 248, height: 360 } } = {}) {
  const avatar = fakeWindow();
  const browser = fakeWindow({ x: 0, y: 0, width: 1320, height: 880 });
  let open = true;
  let rect = slot;
  const saved = [];
  const changes = [];
  const dock = createAvatarDock({
    avatar: () => avatar,
    browser: () => (open ? browser : null),
    slotRect: () => rect,
    load: () => wish,
    save: (d) => saved.push(d),
    onChange: (s) => changes.push(s),
  });
  return { avatar, browser, dock, saved, changes, close: () => { open = false; }, setRect: (r) => { rect = r; } };
}

test("docked: owned by the browser, on the slot, not on top, small minimum", () => {
  const { avatar, browser, dock } = setup();
  dock.sync();
  assert.equal(dock.isDocked(), true);
  assert.equal(avatar.parent, browser);
  assert.deepEqual(avatar.bounds, { x: 10, y: 60, width: 248, height: 360 });
  assert.equal(avatar.onTop, false);
  assert.equal(avatar.allSpaces, false);
  assert.deepEqual(avatar.min, DOCKED_MIN);
});

test("it follows the browser: a moved slot moves the avatar", () => {
  const { avatar, dock, setRect } = setup();
  dock.sync();
  setRect({ x: 400, y: 260, width: 248, height: 300 });
  dock.sync();
  assert.deepEqual(avatar.bounds, { x: 400, y: 260, width: 248, height: 300 });
});

test("floating restores exactly what it was before docking", () => {
  const { avatar, dock, saved } = setup();
  dock.sync();
  dock.undock();
  assert.equal(dock.isDocked(), false);
  assert.equal(avatar.parent, null);
  assert.equal(avatar.onTop, true);
  assert.equal(avatar.allSpaces, true);
  assert.deepEqual(avatar.min, FLOAT_MIN);
  assert.deepEqual(avatar.bounds, { x: 1500, y: 300, width: 430, height: 680 });
  assert.deepEqual(saved, [false]);
});

test("closing the browser floats the avatar but keeps the wish for the next open", () => {
  const { avatar, dock, close } = setup();
  dock.sync();
  close();
  dock.browserClosed();
  assert.equal(dock.isDocked(), false);
  assert.equal(avatar.parent, null);
  assert.equal(dock.wantsDock(), true);
});

test("no slot (rail collapsed, short window) floats it rather than parking it off-screen", () => {
  const { avatar, dock, setRect } = setup();
  dock.sync();
  setRect(null);
  dock.sync();
  assert.equal(dock.isDocked(), false);
  assert.equal(avatar.onTop, true);
});

test("a geometry sync never shows an avatar the owner hid; an explicit dock does", () => {
  const { avatar, dock } = setup({ wish: true });
  avatar.visible = false;
  dock.sync();
  assert.equal(avatar.visible, false);
  dock.undock();
  dock.dock();
  assert.equal(avatar.visible, true);
});

test("a floating wish never docks", () => {
  const { avatar, browser, dock } = setup({ wish: false });
  dock.sync();
  assert.equal(dock.isDocked(), false);
  assert.notEqual(avatar.parent, browser);
});

// Garg, 2026-10-16: every browser layout re-seated the docked avatar with setBounds even
// when nothing moved -- 64 % of the main process's CPU and the native memory growth sat
// under a.setBounds. An unchanged slot is now a no-op.
test("sync with an unchanged slot never calls setBounds again", () => {
  const { avatar, dock } = setup();
  let calls = 0;
  const real = avatar.setBounds;
  avatar.setBounds = (b) => { calls += 1; real(b); };
  dock.sync();
  const first = calls;
  for (let i = 0; i < 1000; i += 1) dock.sync();
  assert.equal(calls, first, "1000 syncs with the same slot: no extra setBounds");
});

test("sync still follows a slot that really moved", () => {
  const { avatar, dock, setRect } = setup();
  dock.sync();
  setRect({ x: 20, y: 70, width: 248, height: 360 });
  dock.sync();
  assert.deepEqual(avatar.bounds, { x: 20, y: 70, width: 248, height: 360 });
});

test("docked, the caption keeps clear of the body: the renderer reads the same flag main injects", () => {
  // Owner screenshot 2026-11-16: in the rail slot a long caption wrapped down over the whole
  // body and ran off the slot's edge. DOCKED_CSS now asks the renderer to keep the caption to
  // the room above the head (SpeechBubbleView reads --bubble-keep-clear); a renamed property on
  // either side would silently bring the old caption back, so both halves are pinned here.
  const fs = require("node:fs");
  const path = require("node:path");
  const { DOCKED_CSS } = require("./avatar-dock.cjs");
  assert.match(DOCKED_CSS, /\.speech-bubble \{[^}]*--bubble-keep-clear: 1/);
  assert.doesNotMatch(DOCKED_CSS, /max-height: 34vh/, "the old cap cut captions mid-line and hid the tail");
  const view = fs.readFileSync(path.join(__dirname, "..", "src", "components", "SpeechBubbleView.tsx"), "utf8");
  assert.match(view, /getPropertyValue\('--bubble-keep-clear'\)/);
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
  assert.match(css, /max-width: min\(260px, calc\(100vw - 16px\)\)/, "a caption is never wider than its window");
});

test("the gestures help fits its window or scrolls, and the beads keep their edge while it is open", () => {
  // Owner screenshot 2026-11-16: the help ran off under the Inbox, cut mid-word. The bead
  // column (beads + help) is capped to the window; the help is the part that gives way and
  // scrolls. Beads.tsx closes it on Esc / a press elsewhere / blur (src/components/Beads.test.tsx).
  const fs = require("node:fs");
  const path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");
  const rule = (sel) => {
    const at = css.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `${sel} rule missing`);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(".beads"), /max-height: calc\(100vh - 24px\)/);
  assert.match(rule(".beads"), /align-items: flex-end/);
  assert.match(rule(".bead-hint"), /overflow-y: auto/);
  assert.match(rule(".bead-hint"), /min-height: 0/);
});
