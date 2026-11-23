"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const right = require("./desktop-right.cjs");

test("a fresh right-press on the desktop background is ours", () => {
  for (const cls of right.DESKTOP_CLASSES) {
    assert.equal(right.shouldOpen({ down: true, className: cls }), true, cls);
  }
});

test("apps, files, icons and Shift+right-click keep their own menu", () => {
  assert.equal(right.shouldOpen({ down: true, className: "Chrome_WidgetWin_1" }), false);
  assert.equal(right.shouldOpen({ down: true, className: "CabinetWClass" }), false); // Explorer window
  assert.equal(right.shouldOpen({ down: true, className: "Progman", shift: true }), false);
  assert.equal(right.shouldOpen({ down: true, className: "" }), false);
});

test("only the transition opens: held and released samples do not", () => {
  assert.equal(right.shouldOpen({ down: true, className: "WorkerW", wasDown: true }), false);
  assert.equal(right.shouldOpen({ down: false, className: "WorkerW" }), false);
});

test("the icon list view (SysListView32) is still the desktop", () => {
  assert.equal(right.isDesktopClass("SysListView32"), true);
  assert.equal(right.isDesktopClass("progman"), false); // class names are exact
});
