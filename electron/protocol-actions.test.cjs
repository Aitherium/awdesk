"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseProtocolUrl } = require("./protocol-actions.cjs");

test("maps Desk URLs to lifecycle and clamped level events", () => {
  const commands = parseProtocolUrl("desk://speaking?level=3");
  assert.equal(commands[0].event.state.activity, "speaking");
  assert.deepEqual(commands[1].event, { type: "audio-level", level: 1 });
  assert.equal(parseProtocolUrl("desk://inactive")[0].event.state.phase, "inactive");
  assert.deepEqual(parseProtocolUrl("desk://fleet"), [{ type: "fleet" }]);
  assert.deepEqual(parseProtocolUrl("desk:///fleet"), [{ type: "fleet" }]);
});

test("maps window and animation URLs without accepting another scheme", () => {
  assert.deepEqual(parseProtocolUrl("desk://toggle"), [{ type: "toggle" }]);
  assert.deepEqual(parseProtocolUrl("desk://dance"), [
    { type: "event", event: { type: "animation", animation: "DANCE" } },
  ]);
  assert.deepEqual(parseProtocolUrl("desk://finger-gun"), [
    { type: "event", event: { type: "animation", animation: "FINGER_GUN" } },
  ]);
  assert.deepEqual(parseProtocolUrl("desk://happy"), [
    { type: "event", event: { type: "animation", animation: "HAPPY" } },
  ]);
  assert.equal(parseProtocolUrl("desk://celebrate"), null);
  assert.equal(parseProtocolUrl("another-product://show"), null);
  assert.equal(parseProtocolUrl("not a URL"), null);
});

test("maps desk://command to command window protocol action", () => {
  assert.deepEqual(parseProtocolUrl("desk://command"), [{ type: "command" }]);
  assert.deepEqual(parseProtocolUrl("desk:///command"), [{ type: "command" }]);
});

test("desk://overlay and desk://desktop map to the two desktop surfaces", () => {
  assert.deepEqual(parseProtocolUrl("desk://overlay"), [{ type: "overlay" }]);
  assert.deepEqual(parseProtocolUrl("desk://living-desktop"), [{ type: "overlay" }]);
  assert.deepEqual(parseProtocolUrl("desk://desktop"), [{ type: "desktop" }]);
  assert.deepEqual(parseProtocolUrl("desk:///aither-desktop"), [{ type: "desktop" }]);
});

test("desk://setup opens Set up Aither (the awnix [oobe] terminal's hand-off)", () => {
  assert.deepEqual(parseProtocolUrl("desk://setup"), [{ type: "setup" }]);
  assert.equal(parseProtocolUrl("other://setup"), null);
});

test("desk://enroll hands the whole link to the enroller", () => {
  const url = "desk://enroll?c=AB3K9Q2Z&d=fdev_1&i=https://idp.aitherium.com";
  assert.deepEqual(parseProtocolUrl(url), [{ type: "enroll", url }]);
});

test("desk://browse carries one http(s) page to the desk's Aither Browser, nothing else", () => {
  const target = "https://github.com/a?b=1&c=2";
  assert.deepEqual(parseProtocolUrl(`desk://browse?url=${encodeURIComponent(target)}`), [
    { type: "browse", url: target },
  ]);
  assert.deepEqual(parseProtocolUrl("desk:///browse?url=http%3A%2F%2Fexample.com"), [
    { type: "browse", url: "http://example.com" },
  ]);
  assert.equal(parseProtocolUrl("desk://browse"), null);
  assert.equal(parseProtocolUrl(`desk://browse?url=${encodeURIComponent("javascript:alert(1)")}`), null);
  assert.equal(parseProtocolUrl(`desk://browse?url=${encodeURIComponent("file:///C:/Windows")}`), null);
  assert.equal(parseProtocolUrl("other://browse?url=https%3A%2F%2Fx.test"), null);
});
