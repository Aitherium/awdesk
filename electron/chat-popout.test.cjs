"use strict";

// The Chat window popped out of the AitherOS desktop is an ordinary framed window; every
// other aitherium page a desktop window opens keeps the plain "allow".

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isChatPopoutUrl, openHandlerAnswer } = require("./chat-popout.cjs");

const BASE = { partition: "persist:living-desktop", preload: "/x/living-desktop-preload.cjs" };

test("recognises only the chat route, with or without a trailing slash or query", () => {
  assert.equal(isChatPopoutUrl("https://app.aitherium.com/embed/chat"), true);
  assert.equal(isChatPopoutUrl("https://app.aitherium.com/embed/chat/?x=1"), true);
  assert.equal(isChatPopoutUrl("/embed/chat"), false); // no origin: not a URL the handler is given
  assert.equal(isChatPopoutUrl("https://app.aitherium.com/embed/chatter"), false);
  assert.equal(isChatPopoutUrl("https://app.aitherium.com/embed/taskbar"), false);
  assert.equal(isChatPopoutUrl("not a url"), false);
});

test("the chat opens as a framed, opaque, movable window in the desktop's own session", () => {
  const a = openHandlerAnswer("https://app.aitherium.com/embed/chat", BASE);
  assert.equal(a.action, "allow");
  const o = a.overrideBrowserWindowOptions;
  assert.equal(o.frame, true);
  assert.equal(o.transparent, false);
  assert.equal(o.alwaysOnTop, false);
  assert.equal(o.skipTaskbar, false);
  assert.ok(o.width <= 1000 && o.height <= 800, "a chat window, not a work-area sheet");
  assert.equal(o.webPreferences.partition, BASE.partition);
  assert.equal(o.webPreferences.preload, BASE.preload);
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
});

test("every other aitherium page keeps the plain allow", () => {
  assert.deepEqual(openHandlerAnswer("https://app.aitherium.com/", BASE), { action: "allow" });
  assert.deepEqual(openHandlerAnswer("https://app.aitherium.com/embed/taskbar", BASE), { action: "allow" });
});

test("both desktop windows route their open handler through it", () => {
  const src = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  const uses = src.match(/chatPopout\.openHandlerAnswer\(url, popoutBase\(\)\)/g) || [];
  assert.equal(uses.length, 2, "the overlay window and the app window");
});
