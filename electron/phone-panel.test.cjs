"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describePhone, capabilitiesFor, VERBS } = require("./phone-panel.cjs");
const { createPhoneUsb } = require("./phone-usb.cjs");

const PHONE = { serial: "58281FDCG000BB", state: "device", model: "Pixel 10 Pro Fold" };

test("every state names the next step in words, and offers the right verbs", () => {
  const unplugged = describePhone({});
  assert.equal(unplugged.status, "unplugged");
  assert.deepEqual(unplugged.verbs, []);

  const unauth = describePhone({ phone: { ...PHONE, state: "unauthorized" } });
  assert.equal(unauth.status, "unauthorized");
  assert.match(unauth.next, /Allow on the USB debugging prompt/);

  const offline = describePhone({ phone: { ...PHONE, state: "offline" } });
  assert.equal(offline.status, "offline");

  const fresh = describePhone({ phone: PHONE });
  assert.equal(fresh.status, "not-linked");
  assert.deepEqual(fresh.verbs.map((v) => v.verb), ["link"]);
  assert.equal(fresh.verbs[0].primary, true);
  assert.equal(fresh.model, "Pixel 10 Pro Fold");

  const waiting = describePhone({ phone: PHONE, link: { serial: PHONE.serial, deviceId: "" } });
  assert.equal(waiting.status, "waiting-app");
  assert.match(waiting.next, /Open Aither on the phone/);
  assert.deepEqual(waiting.verbs.map((v) => v.verb), ["open-app", "unlink"]);

  const linked = describePhone({ phone: PHONE, link: { serial: PHONE.serial, deviceId: "fdev_x" } });
  assert.equal(linked.status, "linked");
  assert.deepEqual(linked.verbs.map((v) => v.verb), ["open-app", "unlink", "forget"]);
  for (const s of [fresh, waiting, linked]) for (const v of s.verbs) assert.ok(VERBS.includes(v.verb), v.verb);
});

test("the panel lists notifications, voice, camera and screen, honest about each one", () => {
  const linked = capabilitiesFor("linked");
  assert.deepEqual(linked.map((c) => c.id), ["control", "notifications", "voice", "camera", "screen"]);
  const by = Object.fromEntries(linked.map((c) => [c.id, c]));
  assert.equal(by.control.state, "ready");
  assert.equal(by.notifications.state, "in-app");
  assert.equal(by.voice.state, "in-app");
  assert.equal(by.camera.state, "in-app");
  assert.equal(by.screen.state, "ready");
  assert.equal(by.screen.action, "capture");
  assert.match(by.screen.detail, /Live screen sharing is not built yet/);
  assert.match(by.notifications.detail, /Reading the phone's own notifications is not built/);
  // before linking, driving the PC is not offered as working; with no cable, no capture
  assert.equal(capabilitiesFor("not-linked").find((c) => c.id === "control").state, "after-link");
  assert.equal(capabilitiesFor("unplugged").find((c) => c.id === "screen").state, "needs-cable");
});

test("an in-flight act and an error and the last capture reach the page state", () => {
  const s = describePhone({ phone: PHONE, busy: "link", error: "adb reverse failed", lastCapture: "C:\\x\\a.png" });
  assert.equal(s.busy, "link");
  assert.equal(s.error, "adb reverse failed");
  assert.equal(s.lastCapture, "C:\\x\\a.png");
});

test("screencap: PNG bytes are returned, anything else is a plain failure", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("data")]);
  const calls = [];
  const exec = (bin, argv, opts, cb) => { calls.push({ argv, opts }); cb(null, png, ""); };
  const usb = createPhoneUsb({ execFileImpl: exec, bin: "adb", env: {} });
  const r = await usb.screencap("58281FDCG000BB");
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].argv, ["-s", "58281FDCG000BB", "exec-out", "screencap", "-p"]);
  assert.equal(calls[0].opts.encoding, "buffer");
  assert.equal(calls[0].opts.windowsHide, true);

  const bad = createPhoneUsb({ execFileImpl: (b, a, o, cb) => cb(new Error("x"), Buffer.from("junk"), "device offline"), bin: "adb", env: {} });
  const f = await bad.screencap("58281FDCG000BB");
  assert.equal(f.ok, false);
  assert.match(f.error, /device offline/);
});

test("main.cjs: the Phone connected toast goes through the holder and opens the panel", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const at = src.indexOf("Phone connected: ${p.model}");
  assert.ok(at > 0, "toast not found");
  const near = src.slice(at - 400, at + 500);
  assert.match(near, /toaster\.show\(/, "the toast must be raised through the held toaster");
  assert.match(near, /openThisPhone\(/, "its click must open the This phone panel");
  assert.doesNotMatch(near, /new Notification\(/);
});
