"use strict";

// The window half of the audio surface: the OSD must be transparent to the
// mouse, the IPC handlers must reject any renderer that is not one of the two
// audio windows, and main must tear the module down on quit.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

/** A fake Electron with a real BrowserWindow class so fromWebContents works. */
function makeElectron() {
  const created = [];
  const handled = {};
  class BrowserWindow {
    constructor(options) {
      this.options = options || {};
      this.calls = [];
      this.sent = [];
      this.destroyed = false;
      this.onceHandlers = {};
      this.onHandlers = {};
      this.webContents = {
        send: (channel, value) => this.sent.push([channel, value]),
        setWindowOpenHandler() {},
        on() {},
      };
      created.push(this);
    }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(ignore, options) { this.calls.push(["setIgnoreMouseEvents", ignore, options]); }
    setContentProtection() {}
    setMenuBarVisibility() {}
    setBounds() {}
    loadFile() { return Promise.resolve(); }
    once(name, fn) { this.onceHandlers[name] = fn; }
    on(name, fn) { this.onHandlers[name] = fn; }
    showInactive() { this.visible = true; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    static fromWebContents(contents) { return created.find((win) => win.webContents === contents) || null; }
  }
  const electron = {
    BrowserWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    ipcMain: { handle: (channel, fn) => { handled[channel] = fn; } },
  };
  return { electron, created, handled };
}

/** Load a fresh audio-control module (its `electron()` is lazy, per call). */
function loadAudio() {
  const file = require.resolve("./audio-control.cjs");
  delete require.cache[file];
  return require(file);
}

/** Hold a fake `require("electron")` for the whole (possibly async) test body. */
async function withElectron(electron, fn) {
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return electron;
    return original.call(this, request, ...rest);
  };
  try {
    return await fn();
  } finally {
    Module._load = original;
  }
}

test("the OSD swallows no clicks: click-through on create, every show, and ready-to-show", async () => {
  const { electron, created } = makeElectron();
  const audio = loadAudio();
  const info = { kind: "speaker", title: "Speakers", value: "45%", percent: 45, muted: false, note: "Speakers", icon: "volume" };
  await withElectron(electron, async () => {
    audio.showOsd(info);
    const osd = created[0];
    assert.deepEqual(osd.calls[0], ["setIgnoreMouseEvents", true, { forward: true }]);
    osd.onceHandlers["ready-to-show"]();
    assert.equal(osd.calls.length, 2, "ready-to-show re-asserts click-through before showing");
    assert.equal(osd.visible, true);

    // A second volume change re-shows the SAME window: click-through again.
    audio.showOsd(info);
    assert.equal(osd.calls.length, 3);
    audio.teardown();
  });
});

test("only the Audio flyout and the OSD may change machine-wide audio", async () => {
  const { electron, created, handled } = makeElectron();
  const audio = loadAudio();
  await withElectron(electron, async () => {
    audio.openSettings();
    audio.ensureAudioIpc();
    const settings = created[0];
    const foreign = { sender: { id: 999 } };
    for (const channel of Object.keys(handled)) {
      const verdict = await handled[channel](foreign);
      assert.deepEqual(verdict, { ok: false, reason: "not the audio window" }, `${channel} accepted a foreign sender`);
    }
    const allowed = await handled["audio:osd-info"]({ sender: settings.webContents });
    assert.equal(allowed.reason, undefined, "the flyout's own webContents is accepted");
    assert.equal(typeof allowed.title, "string");
    audio.teardown();
  });
});

test("main quits through audio.teardown(), and the flyout queues its actions", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const quit = mainSrc.slice(mainSrc.lastIndexOf('app.on("before-quit"'));
  assert.match(quit, /audio\.teardown\(\)/, "before-quit must stop the poll/OSD/helper");

  const html = fs.readFileSync(path.join(__dirname, "audio.html"), "utf8");
  assert.ok(!html.includes("if (busy) return;"), "a slider move during the slow first read is no longer dropped");
  assert.match(html, /function enqueue\(work\)/);
  assert.match(html, /captureId !== lastCaptureId\) rebindMeter\(\)/);
  assert.match(html, /addEventListener\("devicechange", rebindMeter\)/);
});
