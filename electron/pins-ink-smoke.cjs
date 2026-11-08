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
 * are, against a temp userData. Exit 0 all pass, 1 a check failed, 2 broke or could not
 * judge (the host stalled main), 3 hung.
 *
 *   electron electron/pins-ink-smoke.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, desktopCapturer, screen } = require("electron");

// The desk's own renderer switches (main.cjs): occluded / click-through windows keep
// producing frames. Without them Chromium parks a click-through overlay's frames and a
// switch back to interact repaints seconds late (measured 2026-11-07: up to 4.3 s).
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-pins-ink-smoke-"));
app.setPath("userData", path.join(tmp, "userData"));
fs.mkdirSync(path.join(tmp, "userData"));
const SHOTS = process.env.AWDESK_SMOKE_SHOTS || path.join(os.tmpdir(), "awdesk-pins-ink-smoke");
try { fs.mkdirSync(SHOTS); } catch { /* exists */ }
process.on("unhandledRejection", (e) => { console.log(`REJECT ${(e && e.stack) || e}`); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 180_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const couldNotJudge = [];
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
  // AWDESK_SMOKE_INK_ONLY=1: ink alone, to time mode switches with nothing else painting.
  const inkOnly = process.env.AWDESK_SMOKE_INK_ONLY === "1";
  const gif = inkOnly ? { ok: true } : pins.addPin({ kind: "gif", src: "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif", title: "cat typing",
    bounds: { x: ox, y: oy, width: 300, height: 240 } });
  const yt = inkOnly ? { ok: true } : pins.addPin("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { title: "Big Buck Bunny",
    bounds: { x: ox + 320, y: oy, width: 480, height: 300 } });
  const page = inkOnly ? { ok: true } : pins.addPin({ kind: "url", src: "https://example.com/", title: "example.com",
    bounds: { x: ox + 820, y: oy, width: 420, height: 300 } });
  check(gif.ok && yt.ok && page.ok, "three pins (gif, youtube, page) were added");
  check(inkOnly || pins.__entries.size === 3, `three pin windows exist (${pins.__entries.size})`);
  const stored = inkOnly ? { pins: [] } : JSON.parse(fs.readFileSync(path.join(tmp, "userData", "desk-pins.json"), "utf8"));
  check(inkOnly || stored.pins.length === 3, "the pins were persisted");

  // Boards land in the temp dir, never the owner's ~/Aither Boards.
  const boardsDir = path.join(tmp, "boards");
  fs.mkdirSync(boardsDir);
  require("./boards-window.cjs").setBoardsDir(boardsDir);
  require("./boards-window.cjs").setEnqueue(() => ({ ok: false }));
  require("./boards-window.cjs").ensureIpc();

  // ── GIF picker ────────────────────────────────────────────────────────────
  const picker = require("./gif-picker-window.cjs");
  picker.openGifPicker("thumbs up");
  // Live, keyless: search "cat" through the desk's web path and pin the first GIF.
  if (!inkOnly) {
    const live = await picker.gifSearch().search("cat", { limit: 8 });
    if (!live.ok || !live.results.length) {
      console.log(`SKIP live GIF search: ${(live && live.reason) || "0 results"} (offline?)`);
    } else {
      const pinned = picker.pinGif(live.results[0].id);
      check(pinned.ok, `live GIF search (${live.provider}, ${live.results.length} results) pinned "${live.results[0].title}"`);
    }
  }

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
  const inkRegion = { x: ox - 10, y: oy + 300, width: Math.min(1000, work.width - 60), height: Math.min(420, work.height - 360) };
  const drawShot = await grab(region, "1-ink-draw-mode");
  check(Boolean(drawShot), `draw mode screenshot (edge glow + docked palette) ${drawShot || "(capture failed)"}`);
  const full = screen.getPrimaryDisplay().bounds;
  const edgeShot = await grab({ x: full.x, y: full.y + full.height - 220, width: full.width, height: 220 }, "1b-ink-palette-docked-and-glow");
  check(Boolean(edgeShot), `bottom edge: docked palette + glow ${edgeShot || "(capture failed)"}`);

  // ── seamless: 20 switches, one overlay, not one mark lost, latency per switch ──
  const sender0 = ink.__senderOf(displayId);
  const overlay = sender0;
  // Main-process event-loop lag during the switches: if a switch is slow while main
  // itself stalled, the stall is the host's, not the overlay's.
  let lagWorst = 0;
  let lagLast = Date.now();
  const lagTimer = setInterval(() => { const n = Date.now(); lagWorst = Math.max(lagWorst, n - lagLast - 10); lagLast = n; }, 10);
  const latencies = [];
  const recvs = [];
  const seq = ["toggle", "hold", "escape-from-draw", "pen", "right-click-from-draw"];
  for (let i = 0; i < 20; i += 1) {
    const kind = seq[i % seq.length];
    if (kind === "toggle") ink.toggleDraw();
    else if (kind === "hold") { ink.dispatch({ type: "hold-down" }); await sleep(30); ink.dispatch({ type: "hold-up" }); }
    else if (kind === "pen") { ink.dispatch({ type: "pen-enter" }); await sleep(30); ink.dispatch({ type: "mouse" }); }
    else { ink.dispatch({ type: "set", mode: "draw" }); await sleep(30); ink.dispatch({ type: kind.startsWith("escape") ? "escape" : "right-click" }); }
    await sleep(60);
    const probe = await overlay.executeJavaScript(
      "({ frame: document.body.dataset.switchMs || '-1', recv: document.body.dataset.switchRecvMs || '-1' })");
    if (Number(probe.frame) >= 0) latencies.push(Number(probe.frame));
    if (Number(probe.recv) >= 0) recvs.push(Number(probe.recv));
  }
  const raf = await overlay.executeJavaScript(
    "new Promise((r) => { requestAnimationFrame(() => r('raf ok')); setTimeout(() => r('raf did not fire in 500 ms'), 500); })");
  console.log(`  overlay ${raf}`);
  check(ink.__senderOf(displayId) === sender0, "20 switches: the same overlay window, never recreated");
  check(ink.status().marks === items.length, `20 switches: still ${items.length} marks`);
  clearInterval(lagTimer);
  console.log(`  main event-loop worst lag during the switches: ${lagWorst} ms`);
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -1;
  const worst = sorted.length ? sorted[sorted.length - 1] : -1;
  const recvWorst = recvs.length ? Math.max(...recvs) : -1;
  console.log(`  switch -> state in the overlay (ms): ${recvs.join(", ")}`);
  console.log(`  switch -> next painted frame (ms): ${latencies.join(", ")}`);
  if (lagWorst > 50) {
    // The host starved the desk's own main thread (measured on a 100% CPU box): a
    // latency verdict now would measure the host, not the overlay. Could-not-judge.
    console.log(`JUDGE-SKIP switch latency: main's event loop stalled ${lagWorst} ms -- rerun on an idle host`);
    couldNotJudge.push("switch latency");
  } else {
    check(recvs.length >= 15 && recvWorst <= 16, `every switch reached the overlay within one frame: worst ${recvWorst} ms`);
    check(median >= 0 && median <= 17, `median switch painted within one frame: ${median} ms (worst ${worst} ms)`);
  }

  // ── interact: ink stays, palette gone; capture only over a mark ──
  ink.dispatch({ type: "set", mode: "interact" });
  await sleep(400);
  const interactShot = await grab(region, "2-ink-interact-mode");
  check(Boolean(interactShot), `interact screenshot (ink stays, no palette, no glow) ${interactShot || "(capture failed)"}`);
  const strokePt = items[1].points[45];
  let cursorPt = { x: work.x + strokePt.x, y: work.y + strokePt.y + 2 };
  ink.configureInk({ cursor: () => cursorPt });
  ink.__pollHover();
  check(ink.__state().capture === "object", "cursor over a stroke: the overlay captures (so the middle button lands)");
  await sleep(300);
  const hoverShot = await grab(inkRegion, "3-ink-hover-outline");
  check(Boolean(hoverShot), `hover outline screenshot ${hoverShot || "(capture failed)"}`);
  cursorPt = { x: work.x + lx + 900, y: work.y + ly + 300 };
  ink.__pollHover();
  check(ink.__state().capture === "none", "cursor elsewhere: fully click-through");
  // Middle-drag the green stroke 120 px right while interacting (never entering draw).
  cursorPt = { x: work.x + strokePt.x, y: work.y + strokePt.y };
  ink.__pollHover();
  const h = ink.handlers();
  h["ink:mode"]({ sender: sender0 }, { type: "middle-down", id: "pen2" });
  const moved = h["ink:grab-end"]({ sender: sender0 }, { dx: 120, dy: 40 });
  check(moved.result && moved.result.ok && ink.status().mode === "interact", "middle-drag moved a stroke in interact mode");
  await sleep(400);
  const movedShot = await grab(inkRegion, "4-ink-after-middle-drag");
  check(Boolean(movedShot), `after middle-drag screenshot ${movedShot || "(capture failed)"}`);
  ink.configureInk({ cursor: null });

  const board = ink.saveToBoard();
  check(board.ok && board.items >= items.length, `Save to board made a board with ${board.items} items`);
  await sleep(2500);
  const boardShot = await grab({ x: work.x, y: work.y, width: Math.min(1600, work.width), height: Math.min(1000, work.height) }, "5-ink-to-board");
  check(Boolean(boardShot), `board screenshot ${boardShot || "(capture failed)"}`);

  console.log(`shots in ${SHOTS}`);
  ink.closeInk();
  pins.closeAll();
  picker.hide();
  app.exit(failures.length ? 1 : couldNotJudge.length ? 2 : 0);
}).catch((error) => { console.log(`BROKE ${(error && error.stack) || error}`); app.exit(2); });
