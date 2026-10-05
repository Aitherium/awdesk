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
