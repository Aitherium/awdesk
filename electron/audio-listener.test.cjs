"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAudioListener } = require("./audio-listener.cjs");
const { LinuxPipeWireListener } = require("./linux-pipewire-listener.cjs");
const { NativeProcessAudioListener } = require("./native-process-audio-listener.cjs");

test("selects the native listener implementation for each supported platform", () => {
  assert.ok(createAudioListener({ platform: "linux" }) instanceof LinuxPipeWireListener);
  assert.ok(createAudioListener({ platform: "darwin" }) instanceof NativeProcessAudioListener);
  assert.ok(createAudioListener({ platform: "win32" }) instanceof NativeProcessAudioListener);
  assert.equal(createAudioListener({ platform: "freebsd" }), null);
});
