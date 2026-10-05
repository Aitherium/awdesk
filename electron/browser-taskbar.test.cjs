"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const tb = require("./browser-taskbar.cjs");

test("the taskbar page lives on the Online host, https only", () => {
  assert.equal(tb.taskbarUrl("https://app.aitherium.com/"), "https://app.aitherium.com/embed/taskbar");
  assert.equal(tb.taskbarUrl("https://app.aitherium.com/workspace"), "https://app.aitherium.com/embed/taskbar");
  assert.equal(tb.taskbarUrl("http://app.aitherium.com/"), null);
  assert.equal(tb.taskbarUrl("not a url"), null);
});

test("navigation out of the taskbar: Online for aitherium pages, web tab otherwise, never local schemes", () => {
  assert.equal(tb.routeFor("https://app.aitherium.com/embed/taskbar"), "stay");
  assert.equal(tb.routeFor("https://app.aitherium.com/embed/taskbar/"), "stay");
  assert.equal(tb.routeFor("https://app.aitherium.com/?spawn=learn"), "online");
  assert.equal(tb.routeFor("https://aitherium.com/"), "online");
  assert.equal(tb.routeFor("https://evil.example/aitherium.com"), "web");
  assert.equal(tb.routeFor("https://aitherium.com.evil.example/"), "web");
  assert.equal(tb.routeFor("file:///C:/x"), "deny");
  assert.equal(tb.routeFor("aither://settings/"), "deny");
  assert.equal(tb.routeFor("javascript:alert(1)"), "deny");
  assert.equal(tb.routeFor("http://app.aitherium.com/embed/taskbar"), "web", "http is never the taskbar itself");
});

test("only the exact title opens the view; a 404 means unavailable", () => {
  assert.equal(tb.isOpenTitle(tb.OPEN_TITLE), true);
  assert.equal(tb.isOpenTitle("Aither taskbar"), false);
  assert.equal(tb.isOpenTitle("Aither taskbar · open — injected"), false);
  assert.equal(tb.isUnavailable(404), true);
  assert.equal(tb.isUnavailable(200), false);
  assert.equal(tb.isUnavailable(undefined), false);
});

test("expanded, the view runs from under the toolbar to the bottom, full width", () => {
  const rects = { page: { x: 254, y: 118, width: 700, height: 650 }, taskbar: { x: 0, y: 768, width: 1320, height: 56 } };
  assert.deepEqual(tb.expandedRect(rects), { x: 0, y: 118, width: 1320, height: 706 });
});
