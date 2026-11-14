"use strict";

// A video's full-screen button and a page's Copy button were both denied. They are now
// allowed for the owner's own web tab without a prompt, and for nobody else.

const test = require("node:test");
const assert = require("node:assert/strict");
const { GESTURE_SCRIPT, QUIET, decide } = require("./browser-quiet-grants.cjs");

const owner = { by: "you", kind: "web" };
const agent = { by: "agent", kind: "web" };

test("only fullscreen and clipboard write are judged here; everything else is the caller's", () => {
  assert.deepEqual(Object.keys(QUIET).sort(), ["clipboard-sanitized-write", "fullscreen"]);
  for (const other of ["clipboard-read", "media", "notifications", "geolocation", "openExternal", "automatic-fullscreen", "pointerLock", "", null]) {
    assert.equal(decide({ permission: other, tab: owner }), null, String(other));
  }
});

test("the owner's web tab gets full screen with no prompt, from an embedded player's frame too", () => {
  assert.deepEqual(decide({ permission: "fullscreen", details: { isMainFrame: true }, tab: owner }), { allow: true, gesture: false });
  assert.deepEqual(decide({ permission: "fullscreen", details: { isMainFrame: false }, tab: owner }), { allow: true, gesture: false });
  assert.deepEqual(decide({ permission: "fullscreen", tab: { by: "you", kind: "web", private: true } }), { allow: true, gesture: false }, "InPrivate too");
});

test("the owner's web tab may write the clipboard from its top frame, and main must see a click", () => {
  assert.deepEqual(decide({ permission: "clipboard-sanitized-write", details: { isMainFrame: true }, tab: owner }), { allow: true, gesture: true });
  assert.deepEqual(decide({ permission: "clipboard-sanitized-write", details: { isMainFrame: false }, tab: owner }), { allow: false, gesture: false },
    "an embedded frame (an ad) cannot write the clipboard");
  assert.match(GESTURE_SCRIPT, /navigator\.userActivation\.isActive/);
});

test("an agent's tab gets neither, also when an agent drives the tab", () => {
  for (const permission of Object.keys(QUIET)) {
    assert.deepEqual(decide({ permission, details: { isMainFrame: true }, tab: agent }), { allow: false, gesture: false }, permission);
    assert.deepEqual(decide({ permission, details: { isMainFrame: true }, tab: owner, agentDriving: true }), { allow: false, gesture: false }, permission);
  }
});

test("console pages, hosted pages, extension pages and an unknown sender get neither", () => {
  for (const tab of [{ by: "you", kind: "internal" }, { by: "you", kind: "hosted" }, { by: "you", kind: "extension" }, null, undefined, {}]) {
    for (const permission of Object.keys(QUIET)) {
      assert.deepEqual(decide({ permission, tab }), { allow: false, gesture: false }, `${permission} ${JSON.stringify(tab)}`);
    }
  }
});
