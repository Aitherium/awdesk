"use strict";

/**
 * goblin-core.cjs -- GargBot's goblin on the desk: where it stands, which frame it
 * wears, and the pure rules the window uses. The art is the frame set GargBot already
 * ships (.PRODUCTS/.GARGBOT/frontend/public/avatars/goblin: one Media Forge base still, an
 * i2v idle loop, inpainted talking/thinking faces), copied here as electron/goblin/<weapon>/.
 * It is a 2D body, not a VRM: the swarm grows a fairy into it the same way (avatar-grow.cjs
 * frames) and shrinks it back.
 *
 * PURE: no electron. node --test.
 */

const path = require("node:path");

const WEAPONS = Object.freeze(["sword", "noodle"]);
const MOODS = Object.freeze(["idle", "talking", "thinking", "happy"]);
const IDLE_FRAMES = 12;
const TALK_FRAMES = 4;
/** The window the goblin stands in (the art is 256 px; a little air for the glow). */
const SIZE = Object.freeze({ width: 232, height: 264 });

function weaponOf(value) {
  return value === "noodle" ? "noodle" : "sword";
}

function moodOf(value) {
  return MOODS.includes(value) ? value : "idle";
}

/** The frame file for (weapon, mood, tick), relative to electron/goblin/. */
function framePath(weapon, mood, tick = 0) {
  const w = weaponOf(weapon);
  const i = Math.max(0, Math.floor(Number(tick) || 0));
  const m = moodOf(mood);
  if (m === "idle") return `${w}/idle/frame_${String(i % IDLE_FRAMES).padStart(2, "0")}.png`;
  if (m === "talking") return `${w}/talking-${i % TALK_FRAMES}.png`;
  return `${w}/${m}.png`;
}

/** Absolute directory of the frame set (works unpacked and inside an asar). */
function frameRoot(dir = __dirname) {
  return path.join(dir, "goblin");
}

/** Every file a complete weapon set needs, so a test can prove the art shipped. */
function requiredFiles(weapon) {
  const files = ["face.png", "happy.png", "thinking.png"];
  for (let i = 0; i < TALK_FRAMES; i += 1) files.push(`talking-${i}.png`);
  for (let i = 0; i < IDLE_FRAMES; i += 1) files.push(`idle/frame_${String(i).padStart(2, "0")}.png`);
  return files.map((f) => `${weaponOf(weapon)}/${f}`);
}

/**
 * Where the goblin stands: beside the fairy's spot (to its left, feet on the fairy's
 * baseline) so the owner sees it come out of the swarm; with no fairy, the work area's
 * bottom-right corner above the taskbar. Never off the work area.
 */
function standBounds(fairy, area, { margin = 24 } = {}) {
  const a = {
    x: Number(area && area.x) || 0,
    y: Number(area && area.y) || 0,
    width: Math.max(SIZE.width, Number(area && area.width) || 1920),
    height: Math.max(SIZE.height, Number(area && area.height) || 1080),
  };
  let x;
  let y;
  if (fairy && Number.isFinite(Number(fairy.x)) && Number.isFinite(Number(fairy.y))) {
    x = Number(fairy.x) - SIZE.width - 8;
    y = Number(fairy.y) + (Number(fairy.height) || 72) - SIZE.height;
  } else {
    x = a.x + a.width - SIZE.width - margin;
    y = a.y + a.height - SIZE.height - margin;
  }
  x = Math.min(Math.max(a.x, x), a.x + a.width - SIZE.width);
  y = Math.min(Math.max(a.y, y), a.y + a.height - SIZE.height);
  return { x: Math.round(x), y: Math.round(y), width: SIZE.width, height: SIZE.height };
}

module.exports = { WEAPONS, MOODS, IDLE_FRAMES, TALK_FRAMES, SIZE, weaponOf, moodOf, framePath, frameRoot, requiredFiles, standBounds };
