"use strict";
/* global window, PointerEvent, requestAnimationFrame -- pageBenchmark() runs inside
   the derived overlay page, not in this process; it is serialised with toString(). */

/**
 * ink-draw-perf.cjs -- measure the cost of the screen-ink STROKE path on the REAL
 * overlay (ink-window.cjs -> ink.html), not a stand-in.
 *
 *   node node_modules/electron/cli.js electron/ink-draw-perf.cjs \
 *        [--marks=40] [--points=120] [--moves=100]
 *
 * It seeds a heavy committed scene (marks x points), then drives synthetic pen
 * strokes through the page:
 *
 *   idle   rAF cadence with nothing drawing (the host's ceiling);
 *   sync   every pointermove dispatched back-to-back, timing the handler alone.
 *          This is the per-sample work the OLD path did: a full-canvas clear, a
 *          redraw of every committed mark, and a fresh outline of the whole
 *          in-flight stroke -- on every sample;
 *   paced  one pointermove per animation frame for `moves` frames, recording the
 *          rAF interval (a proxy for visible lag; host/GPU sensitive).
 *
 * Prints one JSON object and exits 0. Exit 2 = it could not judge. The `sync`
 * per-move figure is the stable one: the stroke path must not touch the committed
 * scene per sample. Run before and after a change and compare.
 *
 * main.cjs is NOT started (it would take the running desk's instance lock).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, screen } = require("electron");

// The desk's own renderer switches, so a click-through overlay keeps producing frames.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awdesk-ink-draw-perf-"));
app.setPath("userData", path.join(tmp, "userData"));
fs.mkdirSync(path.join(tmp, "userData"));

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const MARKS = Math.max(0, Math.min(200, arg("marks", 40)));
const POINTS = Math.max(2, Math.min(2000, arg("points", 120)));
const MOVES = Math.max(10, Math.min(1000, arg("moves", 100)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(() => { console.log(JSON.stringify({ error: "timeout" })); app.exit(2); }, 150_000);

function failed(reason) {
  console.log(JSON.stringify({ error: reason }));
  app.exit(2);
}

async function waitFor(predicate, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(step);
  }
  return null;
}

function seedDoc(width, height) {
  const core = require("./ink-core.cjs");
  let doc = core.normalizeState();
  for (let m = 0; m < MARKS; m += 1) {
    const y = 40 + ((height - 80) * (m + 0.5)) / Math.max(1, MARKS);
    const points = [];
    for (let i = 0; i < POINTS; i += 1) {
      const t = i / (POINTS - 1);
      points.push({
        x: 40 + t * (width - 80),
        y: y + Math.sin(t * Math.PI * (2 + (m % 3))) * 10,
        p: 0.5,
      });
    }
    doc = core.pushItem(doc, core.normalizeItem({
      id: `seed-${m}`, type: "stroke", tool: m % 4 === 0 ? "highlighter" : "pen",
      color: "#7aa2ff", width: 4, points,
    }));
  }
  return doc;
}

// Runs in the page: idle cadence, then the stroke handler cost, then paced frames.
function pageBenchmark({ moves }) {
  const fire = (type, x, y) => {
    window.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, pointerId: 1, pointerType: "pen", isPrimary: true,
      button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: 0.5,
    }));
  };
  const W = window.innerWidth;
  const H = window.innerHeight;
  const at = (i, n) => ({ x: 60 + ((W - 120) * i) / n, y: H / 2 + Math.sin(i / 12) * Math.min(140, H / 4) });
  const stats = (list) => {
    const s = [...list].sort((a, b) => a - b);
    const q = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0).toFixed(2);
    const avg = list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
    return { n: s.length, avgMs: +avg.toFixed(2), p50Ms: q(0.5), p95Ms: q(0.95), worstMs: q(1) };
  };

  // 1) idle: rAF cadence with nothing drawing (the host's ceiling).
  const idleRaf = new Promise((resolve) => {
    const intervals = [];
    let last = performance.now();
    let n = 0;
    const tick = () => {
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      n += 1;
      if (n >= 40) resolve(intervals);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  return idleRaf.then((idle) => {
    // 2) sync: handler cost alone, no frame in between.
    const syncStart = performance.now();
    const first = at(0, moves);
    fire("pointerdown", first.x, first.y);
    const perMove = [];
    for (let i = 1; i <= moves; i += 1) {
      const { x, y } = at(i, moves);
      const s = performance.now();
      fire("pointermove", x, y);
      perMove.push(performance.now() - s);
    }
    const syncTotal = performance.now() - syncStart;
    fire("pointerup", W - 60, H / 2);
    const sync = {
      totalMs: +syncTotal.toFixed(1),
      perMoveMs: { avg: +(syncTotal / moves).toFixed(3), ...stats(perMove) },
    };

    // 3) paced: one move per rAF; cap the wall clock so a throttled host cannot hang.
    return new Promise((resolve) => {
      const intervals = [];
      let i = 0;
      let last = performance.now();
      const cap = setTimeout(() => {
        fire("pointerup", W - 60, H / 2);
        done(true);
      }, 20_000);
      const start = at(0, moves);
      fire("pointerdown", start.x, start.y);
      const done = (capped) => {
        clearTimeout(cap);
        const frames = { ...stats(intervals), fps: +(1000 / (intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length))).toFixed(1),
          overBudget: intervals.filter((v) => v > 20).length, capped };
        resolve({ viewport: [W, H], dpr: window.devicePixelRatio, idle: stats(idle), sync, frames });
      };
      const step = () => {
        const now = performance.now();
        intervals.push(now - last);
        last = now;
        if (i >= moves) { fire("pointerup", W - 60, H / 2); done(false); return; }
        const { x, y } = at(i, moves);
        fire("pointermove", x, y);
        i += 1;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  });
}

app.whenReady().then(async () => {
  const ink = require("./ink-window.cjs");
  ink.enterDraw();
  const display = screen.getPrimaryDisplay();

  const overlay = await waitFor(() => ink.__senderOf(display.id));
  if (!overlay) return failed("overlay window never appeared");

  const ready = await waitFor(async () => {
    const ok = await overlay.executeJavaScript(
      "document.readyState === 'complete' && Boolean(window.aitherInk) && document.body.classList.contains('active')",
      true).catch(() => false);
    return ok || null;
  });
  if (!ready) return failed("overlay page never became active");

  const { width, height } = display.bounds;
  ink.__setDoc(display.id, seedDoc(width, height));
  ink.setTool("pen");
  await sleep(400);

  const count = await overlay.executeJavaScript(
    "document.getElementById('count') ? document.getElementById('count').textContent : ''", true);
  if (!/\d+\s+marks/.test(count || "")) return failed(`overlay did not receive the seeded scene (count="${count}")`);

  const result = await overlay.executeJavaScript(`(${pageBenchmark.toString()})(${JSON.stringify({ moves: MOVES })})`, true);
  if (!result || !result.frames) return failed("benchmark returned nothing");

  console.log(JSON.stringify({ scene: { marks: MARKS, pointsPerMark: POINTS }, ...result }));
  app.exit(0);
}).catch((error) => failed(String((error && error.stack) || error).slice(0, 400)));
