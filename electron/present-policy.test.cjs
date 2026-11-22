"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const EXE = ["D:", "desk", "electron.exe"].join(String.fromCharCode(92));
const { GPU_PREFERENCE_KEY, applyPresentPolicy, gpuPreferenceCommand, presentPolicy } = require("./present-policy.cjs");

test("windows with no opinion presents on the GPU (S1: the software default was the lag)", () => {
  const p = presentPolicy({ env: {}, platform: "win32" });
  assert.deepEqual(p, { present: "gpu", gpu: "default", switches: [], gpuPreference: null });
});

test("DESK_PRESENT=software is the explicit override and keeps the integrated adapter", () => {
  const p = presentPolicy({ env: { DESK_PRESENT: "software" }, platform: "win32" });
  assert.deepEqual(p, { present: "software", gpu: "integrated", switches: ["disable-gpu-compositing"], gpuPreference: 1 });
});

test("a posture asking for software or gpu is honoured; auto falls through to the GPU", () => {
  assert.equal(presentPolicy({ env: {}, platform: "win32", posture: { present: "software", customer: false } }).present, "software");
  assert.equal(presentPolicy({ env: {}, platform: "win32", posture: { present: "gpu", customer: true } }).present, "gpu");
  assert.equal(presentPolicy({ env: {}, platform: "win32", posture: { present: "auto", customer: false } }).present, "gpu");
  // The env override outranks the posture in both directions.
  assert.equal(presentPolicy({ env: { DESK_PRESENT: "gpu" }, platform: "win32", posture: { present: "software" } }).present, "gpu");
  assert.equal(presentPolicy({ env: { DESK_PRESENT: "software" }, platform: "win32", posture: { present: "gpu" } }).present, "software");
});

test("other platforms keep Chromium's presentation and touch no registry", () => {
  for (const platform of ["linux", "darwin"]) {
    const p = presentPolicy({ env: {}, platform });
    assert.deepEqual(p, { present: "gpu", gpu: "default", switches: [], gpuPreference: null });
  }
});

test("DESK_PRESENT=gpu restores the hardware path and stops steering the adapter", () => {
  const p = presentPolicy({ env: { DESK_PRESENT: "gpu" }, platform: "win32" });
  assert.deepEqual(p.switches, []);
  assert.equal(p.gpu, "default");
  assert.equal(p.gpuPreference, null);
});

test("DESK_GPU overrides the adapter independently; junk falls back to auto", () => {
  assert.equal(presentPolicy({ env: { DESK_GPU: "discrete" }, platform: "win32" }).gpuPreference, 2);
  assert.equal(presentPolicy({ env: { DESK_GPU: "DEFAULT" }, platform: "win32" }).gpuPreference, null);
  assert.equal(presentPolicy({ env: { DESK_PRESENT: "fast", DESK_GPU: "9" }, platform: "win32" }).present, "gpu");
  assert.equal(presentPolicy({ env: { DESK_GPU: "integrated" }, platform: "win32", posture: { present: "software" } }).gpuPreference, 1);
});

test("the registry command names the exact executable and value", () => {
  const argv = gpuPreferenceCommand(EXE, 1);
  assert.equal(argv[1], GPU_PREFERENCE_KEY);
  assert.ok(GPU_PREFERENCE_KEY.endsWith(["DirectX", "UserGpuPreferences"].join(String.fromCharCode(92))));
  assert.equal(argv[3], EXE);
  assert.equal(argv[7], "GpuPreference=1;");
});

test("apply appends the switches and writes the preference only when it differs", () => {
  const appended = [];
  const app = { commandLine: { appendSwitch: (n) => appended.push(n) } };
  const calls = [];
  const execFile = (cmd, argv, _opts, cb) => {
    calls.push(argv[0]);
    cb(null, argv[0] === "query" ? `    ${EXE}    REG_SZ    GpuPreference=1;` : "");
  };
  // Explicit software present is the only mode that appends the switch (and steers the adapter).
  const out = applyPresentPolicy(app, { env: { DESK_PRESENT: "software" }, platform: "win32", execFile, exePath: EXE });
  assert.deepEqual(appended, ["disable-gpu-compositing"]);
  assert.equal(out.gpuPreferencePending, true);
  assert.deepEqual(calls, ["query"]); // already set: no write

  calls.length = 0;
  applyPresentPolicy(app, { env: { DESK_PRESENT: "software" }, platform: "win32", exePath: EXE, execFile: (c, a, o, cb) => { calls.push(a[0]); cb(a[0] === "query" ? new Error("absent") : null, ""); } });
  assert.deepEqual(calls, ["query", "add"]);
});

test("apply on linux runs nothing", () => {
  const app = { commandLine: { appendSwitch: () => assert.fail("no switch expected") } };
  const out = applyPresentPolicy(app, { env: {}, platform: "linux", execFile: () => assert.fail("no reg expected") });
  assert.equal(out.gpuPreferencePending, false);
});
