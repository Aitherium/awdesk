"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const audio = require("./audio-control.cjs");

test("the OSD sits bottom-centre of the work area (the Windows volume-flyout spot)", () => {
  const at4k = audio.osdBounds({ x: 0, y: 0, width: 3840, height: 2112 });
  assert.equal(at4k.width, audio.OSD_WIDTH);
  assert.equal(at4k.height, audio.OSD_HEIGHT);
  assert.equal(at4k.x, Math.round((3840 - audio.OSD_WIDTH) / 2));
  assert.equal(at4k.y, 2112 - audio.OSD_HEIGHT - 72);

  // A second monitor to the right: the OSD follows that display's work area.
  const second = audio.osdBounds({ x: 1920, y: 2160, width: 1920, height: 1040 });
  assert.equal(second.x, 1920 + Math.round((1920 - audio.OSD_WIDTH) / 2));
  assert.equal(second.y, 2160 + 1040 - audio.OSD_HEIGHT - 72);

  // No display answer at all must still produce a sane rectangle.
  const fallback = audio.osdBounds(null);
  assert.ok(Number.isFinite(fallback.x) && Number.isFinite(fallback.y));
});

test("cached mute flags drive the tray labels", () => {
  audio.__setStateForTest({ state: null });
  assert.equal(audio.speakerMuted(), false);
  assert.equal(audio.micMuted(), false);

  audio.__setStateForTest({
    state: {
      ok: true,
      render: { id: "s", name: "Speakers", volume: 20, muted: true },
      capture: { id: "m", name: "Microphone", volume: 60, muted: false },
    },
  });
  assert.equal(audio.speakerMuted(), true);
  assert.equal(audio.micMuted(), false);
  assert.equal(audio.cachedState().render.volume, 20);
});

test("the OSD page gets a complete model even before the first change", () => {
  audio.__setStateForTest({ osdInfo: null });
  const info = audio.publicOsd();
  assert.equal(info.title, "Speakers");
  assert.equal(typeof info.value, "string");
  assert.equal(typeof info.percent, "number");
});

test("the flyout's IPC surface is the one audio-preload.cjs calls", () => {
  const channels = Object.keys(audio.handlers());
  for (const channel of ["audio:state", "audio:list", "audio:set-volume", "audio:set-muted", "audio:set-default", "audio:close", "audio:osd-info"]) {
    assert.ok(channels.includes(channel), `${channel} is missing from audio-control handlers()`);
  }
});

test("volume step and OSD timing are the owner-facing constants", () => {
  assert.equal(audio.OSD_MS, 1200);
  assert.equal(require("./system-audio.cjs").VOLUME_STEP, 5);
  assert.equal(audio.STATE_POLL_MS, 30000);
});

test("the 30 s poll re-renders the tray when Windows itself flips a mute flag", async () => {
  const systemAudio = require("./system-audio.cjs");
  const original = systemAudio.getState;
  const seen = [];
  const snap = (renderMuted, captureMuted) => ({
    ok: true,
    render: { id: "s", name: "Speakers", volume: 40, muted: renderMuted },
    capture: { id: "m", name: "Microphone", volume: 60, muted: captureMuted },
  });
  audio.configureAudio({ onChange: (state) => seen.push(state) });
  try {
    audio.__setStateForTest({ state: snap(false, false) });
    systemAudio.getState = async () => snap(false, false);
    await audio.refreshState({ announce: false });
    assert.equal(seen.length, 0, "an unchanged state does not re-render the tray");

    systemAudio.getState = async () => snap(true, false);
    await audio.refreshState({ announce: false });
    assert.equal(seen.length, 1, "a mute made in the Windows flyout re-renders the tray");

    await audio.refreshState({ announce: false });
    assert.equal(seen.length, 1, "the poll stays quiet when nothing changed");

    await audio.refreshState({ announce: true });
    assert.equal(seen.length, 2, "a Desk change still announces unconditionally");
  } finally {
    systemAudio.getState = original;
    audio.configureAudio({ onChange: null });
    audio.teardown();
  }
});
