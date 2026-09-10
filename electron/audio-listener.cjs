"use strict";

const { LinuxPipeWireListener } = require("./linux-pipewire-listener.cjs");
const { NativeProcessAudioListener } = require("./native-process-audio-listener.cjs");

function createAudioListener({ platform = process.platform, ...options } = {}) {
  if (platform === "linux") return new LinuxPipeWireListener(options);
  if (platform === "darwin" || platform === "win32") {
    return new NativeProcessAudioListener({ platform, ...options });
  }
  return null;
}

module.exports = { createAudioListener };
