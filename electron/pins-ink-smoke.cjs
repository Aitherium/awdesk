"use strict";

/**
 * pins-ink-smoke.cjs -- a REAL Electron run of the 2026-11-07 ink / pins / GIF
 * slice, for screenshots and a live check that the windows open:
 *
 *   1. ink: draw mode on the primary display, three smoothed strokes (one with a
 *      pen's varying pressure, one mouse-flat, one highlighter) plus an arrow;
 *   2. pins: a GIF, a YouTube video and a web page pinned to the desktop;
 *   3. the GIF picker, opened with a query (no key = its "add a GIF key" state).
 *
 * Then it grabs the region holding all of it (desktopCapturer) and writes PNGs to
 * AWDESK_SMOKE_SHOTS (default %TEMP%/awdesk-pins-ink-smoke). main.cjs is not
 * started (it would take the running desk's instance lock); the modules it wires
 * are, against a temp userData. Exit 0 all pass, 1 a check failed, 2 broke, 3 hung.
 *
 *   electron electron/pins-ink-smoke.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, desktopCapturer, screen } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-pins-ink-smoke-"));
app.setPath("userData", path.join(tmp, "userData"));
fs.mkdirSync(path.join(tmp, "userData"));
const SHOTS = process.env.AWDESK_SMOKE_SHOTS || path.join(os.tmpdir(), "awdesk-pins-ink-smoke");
try { fs.mkdirSync(SHOTS); } catch { /* exists */ }
process.on("unhandledRejection", (e) => { console.log(`REJECT ${(e && e.stack) || e}`); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 90_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };

function wave(x0, y0, len, amp, { pressure = null } = {}) {
  const pts = [];
  for (let i = 0; i <= 90; i += 1) {
    const t = i / 90;
    pts.push({
      x: x0 + t * len,
      y: y0 + Math.sin(t * Math.PI * 2.2) * amp + (Math.random() - 0.5) * 3,
      p: pressure ? pressure(t) : 0.5,
    });
  }
  return pts;
}

async function grab(region, name) {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  const crop = source.thumbnail.crop({
    x: Math.round((region.x - display.bounds.x) * scale), y: Math.round((region.y - display.bounds.y) * scale),
    width: Math.round(region.width * scale), height: Math.round(region.height * scale),
  });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, crop.toPNG());
  return file;
}

app.whenReady().then(async () => {
  const work = screen.getPrimaryDisplay().workArea;
  const ox = work.x + 40;
  const oy = work.y + 40;

  // ── pins ──────────────────────────────────────────────────────────────────
  const pins = require("./pins-window.cjs");
  pins.configurePins({
    storeFile: path.join(tmp, "userData", "desk-pins.json"),
    openInBrowser: (url) => { console.log(`(would open in the Aither browser: ${url})`); return { ok: true }; },
    launchApp: (src) => { console.log(`(would launch ${src})`); return { ok: true }; },
  });
  const gif = pins.addPin({ kind: "gif", src: "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif", title: "cat typing",
    bounds: { x: ox, y: oy, width: 300, height: 240 } });
  const yt = pins.addPin("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { title: "Big Buck Bunny",
    bounds: { x: ox + 320, y: oy, width: 480, height: 300 } });
  const page = pins.addPin({ kind: "url", src: "https://example.com/", title: "example.com",
    bounds: { x: ox + 820, y: oy, width: 420, height: 300 } });
  check(gif.ok && yt.ok && page.ok, "three pins (gif, youtube, page) were added");
  check(pins.__entries.size === 3, `three pin windows exist (${pins.__entries.size})`);
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, "userData", "desk-pins.json"), "utf8"));
  check(stored.pins.length === 3, "the pins were persisted");

  // Boards land in the temp dir, never the owner's ~/Aither Boards.
  const boardsDir = path.join(tmp, "boards");
  fs.mkdirSync(boardsDir);
  require("./boards-window.cjs").setBoardsDir(boardsDir);
  require("./boards-window.cjs").setEnqueue(() => ({ ok: false }));
  require("./boards-window.cjs").ensureIpc();

  // ── GIF picker ────────────────────────────────────────────────────────────
  const picker = require("./gif-picker-window.cjs");
  picker.openGifPicker("thumbs up");

  // Pins + picker alone first: the full-screen ink overlay changes what the
  // compositor hands desktopCapturer, so each gets its own shot.
  await sleep(9000); // pages, the embed and the GIF load
  const pinsRegion = { x: ox - 10, y: oy - 10, width: Math.min(1280, work.width - 60), height: Math.min(720, work.height - 60) };
  for (const [id, e] of pins.__entries) console.log(`  pin ${id.slice(0, 18)} ${JSON.stringify(e.win.getBounds())}`);
  const pinsShot = await grab(pinsRegion, "pins-and-gif-picker");
  check(Boolean(pinsShot), `pins screenshot ${pinsShot || "(capture failed)"}`);

  // ── ink ───────────────────────────────────────────────────────────────────
  const ink = require("./ink-window.cjs");
  const core = require("./ink-core.cjs");
  ink.enterDraw();
  await sleep(1500);
  const displayId = screen.getPrimaryDisplay().id;
  let doc = core.normalizeState();
  const lx = ox - work.x;
  const ly = oy - work.y + 360;
  const items = [
    { id: "pen1", type: "stroke", tool: "pen", color: "#ff4d4d", width: 5,
      points: wave(lx + 20, ly + 30, 520, 26, { pressure: (t) => 0.15 + 0.85 * Math.sin(t * Math.PI) }) },
    { id: "pen2", type: "stroke", tool: "pen", color: "#4ade80", width: 5, points: wave(lx + 20, ly + 110, 520, 18) },
    { id: "hl", type: "stroke", tool: "highlighter", color: "#ffd166", width: 5, points: wave(lx + 20, ly + 170, 520, 4) },
    { id: "arr", type: "shape", tool: "arrow", color: "#7aa2ff", width: 4, a: { x: lx + 620, y: ly + 150 }, b: { x: lx + 760, y: ly - 40 } },
    { id: "txt", type: "text", tool: "text", color: "#ffffff", text: "smooth ink, pinned GIF, YouTube, page", at: { x: lx + 20, y: ly + 240 } },
  ];
  for (const raw of items) doc = core.pushItem(doc, core.normalizeItem(raw));
  ink.__setDoc(displayId, doc);
  ink.setTool("pen"); // broadcasts the doc
  check(ink.status().marks === items.length, `ink holds ${items.length} marks`);
  check(core.strokeOutline(items[0].points, { size: 7 }).length > 100, "the pen stroke has a smooth outline");

  await sleep(2000);
  const region = { x: ox - 10, y: oy - 10, width: Math.min(1280, work.width - 60), height: Math.min(720, work.height - 60) };
  const all = await grab(region, "ink-over-screen");
  check(Boolean(all), `overview screenshot ${all || "(capture failed)"}`);

  // Click-through on: the overlays stop taking the mouse, the marks stay.
  const through = ink.setPassThrough(true);
  check(through.active && through.passThrough, "click-through ink is on and drawing stays active");
  const board = ink.saveToBoard();
  check(board.ok && board.items >= items.length, `Save to board made a board with ${board.items} items`);
  await sleep(2500);
  const boardShot = await grab({ x: work.x, y: work.y, width: Math.min(1600, work.width), height: Math.min(1000, work.height) }, "ink-to-board");
  check(Boolean(boardShot), `board screenshot ${boardShot || "(capture failed)"}`);

  console.log(`shots in ${SHOTS}`);
  ink.closeInk();
  pins.closeAll();
  picker.hide();
  app.exit(failures.length ? 1 : 0);
}).catch((error) => { console.log(`BROKE ${(error && error.stack) || error}`); app.exit(2); });
