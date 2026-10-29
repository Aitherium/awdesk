"use strict";

// MOCKED adb throughout: execFile is injected, no phone and no adb.exe are needed.

const test = require("node:test");
const assert = require("node:assert/strict");

const { adbArgv, createPhoneUsb, isUsbSerial, parseDevices, resolveAdb, PHONE_PORT } = require("./phone-usb.cjs");

const LISTING = [
  "List of devices attached",
  "R5CT1234ABC            device product:o1q model:SM_G991U device:o1q transport_id:4",
  "8AXY0012              unauthorized usb:1-2 transport_id:5",
  "192.168.1.122:49665    offline transport_id:2202",
  "adb-R5CT1234ABC-x1._adb-tls-connect._tcp device product:o1q model:SM_G991U transport_id:6",
  "emulator-5554          device product:sdk_gphone64 model:sdk_gphone64_x86_64 transport_id:7",
  "",
].join("\r\n");

test("USB phones only: Wi-Fi debugging and emulators are not a cable", () => {
  const phones = parseDevices(LISTING);
  assert.deepEqual(phones.map((p) => [p.serial, p.state, p.model]), [
    ["R5CT1234ABC", "device", "SM G991U"],
    ["8AXY0012", "unauthorized", "Android phone"],
  ]);
  assert.equal(isUsbSerial("emulator-5554"), false);
  assert.equal(isUsbSerial("emulator-5554", { allowEmulator: true }), true);
  assert.equal(isUsbSerial("10.0.0.2:5555"), false);
});

test("adbArgv builds exactly four shapes and refuses everything else", () => {
  assert.deepEqual(adbArgv("devices"), ["devices", "-l"]);
  assert.deepEqual(adbArgv("reverse", { serial: "R5CT", pcPort: 50123 }),
    ["-s", "R5CT", "reverse", `tcp:${PHONE_PORT}`, "tcp:50123"]);
  assert.deepEqual(adbArgv("unreverse", { serial: "R5CT" }), ["-s", "R5CT", "reverse", "--remove", `tcp:${PHONE_PORT}`]);
  const launch = adbArgv("launch", { serial: "R5CT" });
  assert.equal(launch[2], "shell");
  assert.equal(launch.at(-1), "'https://app.aitherium.com/?app=control&tab=pc'");
  assert.throws(() => adbArgv("shell", { serial: "R5CT" }), /not allowed/);
  assert.throws(() => adbArgv("install", { serial: "R5CT" }), /not allowed/);
  assert.throws(() => adbArgv("reverse", { serial: "R5CT; rm -rf /", pcPort: 50123 }), /bad serial/);
  assert.throws(() => adbArgv("reverse", { serial: "R5CT", pcPort: 80 }), /bad port/);
  assert.throws(() => adbArgv("launch", { serial: "R5CT", url: "https://evil.example/" }), /bad url/);
  assert.throws(() => adbArgv("launch", { serial: "R5CT", url: "https://app.aitherium.com/'; reboot; '" }), /bad url/);
});

function fakeAdb(outputs) {
  const calls = [];
  const impl = (bin, argv, opts, cb) => {
    calls.push({ argv, opts });
    const next = typeof outputs === "function" ? outputs(argv) : outputs.shift();
    setImmediate(() => cb(next.error || null, next.stdout || "", ""));
  };
  return { calls, impl };
}

test("a pulled cable reports the phone removed; every spawn is windowsHide", async () => {
  const listings = [{ stdout: LISTING }, { stdout: "List of devices attached\r\n\r\n" }];
  const adb = fakeAdb(listings);
  const events = [];
  const usb = createPhoneUsb({ execFileImpl: adb.impl, bin: "adb", onChange: (e) => events.push(e), env: {} });
  await usb.pollOnce();
  assert.deepEqual(events[0].added.map((p) => p.serial), ["R5CT1234ABC", "8AXY0012"]);
  await usb.pollOnce();
  assert.deepEqual(events[1].removed.map((p) => p.serial), ["R5CT1234ABC", "8AXY0012"]);
  assert.equal(usb.phones().length, 0);
  assert.ok(adb.calls.every((c) => c.opts.windowsHide === true));
});

test("an unauthorized phone becoming authorized is a change", async () => {
  const adb = fakeAdb([
    { stdout: "8AXY0012 unauthorized usb:1-2\n" },
    { stdout: "8AXY0012 device usb:1-2 model:Pixel_8\n" },
  ]);
  const events = [];
  const usb = createPhoneUsb({ execFileImpl: adb.impl, bin: "adb", onChange: (e) => events.push(e), env: {} });
  await usb.pollOnce();
  await usb.pollOnce();
  assert.equal(events.length, 2);
  assert.equal(events[1].added[0].state, "device");
  assert.equal(events[1].added[0].model, "Pixel 8");
});

test("resolveAdb: env first, then the WinGet platform-tools package", () => {
  assert.equal(resolveAdb({ AWDESK_ADB_BIN: "X:/adb.exe" }), "X:/adb.exe");
  const found = resolveAdb({ LOCALAPPDATA: "L:" }, (p) => p.includes("Google.PlatformTools_x"),
    () => ["Other.Pkg", "Google.PlatformTools_x"]);
  assert.match(found, /Google\.PlatformTools_x[\\/]platform-tools[\\/]adb/);
  assert.equal(resolveAdb({}, () => false, () => []), "adb");
});
