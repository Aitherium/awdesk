"use strict";

/**
 * Does the REAL fairy dock, stay off the controls and detach? `npm run test:fairy-dock`.
 * Owner, 2026-11-16: the fairy sat on CertTrack's "Review" tab. This opens a real desk
 * window showing a CertTrack-like page (tab strip, a "Review" tab placed exactly where the
 * fairy used to land, and a CROSS-ORIGIN iframe -- a second local server on another port --
 * with its own toolbar), docks the real orb window on it, and checks the fairy's real
 * bounds against the controls measured from the DOM (an oracle the probe does not share).
 *
 * Exit 0 pass, 1 a check failed, 3 it hung. Writes a screenshot to $SMOKE_OUT (default tmp).
 * Uses its own userData and its own fairy-owner file, so it never claims the owner's fairies.
 * NOTE: it shows a fairy on this machine's screen for a few seconds.
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, desktopCapturer, screen } = require("electron");

const tmp = path.join(os.tmpdir(), `awdesk-fairy-dock-smoke-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
app.setPath("userData", tmp);
process.env.DESK_FAIRY_OWNER_FILE = path.join(tmp, "fairy-owner.json");
app.on("window-all-closed", () => {});
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 120000);

const fails = [];
const expect = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overlap = (a, b) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

function serve(html) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const FRAME_HTML = `<!doctype html><body style="margin:0;font:14px sans-serif">
<div style="height:48px;background:#223;display:flex;gap:8px;align-items:center;padding:0 8px">
<button>Upload</button><button>Filter</button><button>Export</button></div><p>third-party app</p></body>`;

const pageHtml = (frameUrl, review) => `<!doctype html><body style="margin:0;font:14px sans-serif;height:100vh;position:relative">
<nav id="tabs" style="height:44px;display:flex;gap:6px;padding:6px;background:#eee">
<button>Overview</button><button>Reports</button><button>Settings</button></nav>
${review ? `<button id="review" style="position:absolute;left:${review.x}px;top:${review.y}px;width:${review.w}px;height:${review.h}px">Review</button>` : ""}
<iframe id="app" src="${frameUrl}" style="position:absolute;left:12px;top:60px;width:62%;height:55%;border:1px solid #888"></iframe>
</body>`;

app.whenReady().then(async () => {
  const orb = require("./orb-window.cjs");
  orb.startOrb({ hideByDefault: false });
  orb.showOrb();
  await sleep(800);
  const orbWin = () => BrowserWindow.getAllWindows().find((w) => {
    const b = w.getBounds();
    return Math.abs(b.width - orb.ORB_SIZE.width) <= 2 && Math.abs(b.height - orb.ORB_SIZE.height) <= 2 && w.isVisible(); // DPI rounding: 73 on a 2300 px screen
  });
  expect("the real fairy window is up", Boolean(orbWin()), null);

  const display = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: display.x + 80, y: display.y + 60, width: 1000, height: 680, show: true, title: "CertTrack stand-in",
    webPreferences: { contextIsolation: true },
  });
  const frameSrv = await serve(FRAME_HTML);
  const blankSrv = await serve("<!doctype html><body style=\"margin:0\"></body>");
  await win.loadURL(`http://127.0.0.1:${blankSrv.port}/`);
  win.show();
  win.focus();
  await sleep(600);

  const settle = async () => {
    let last = "";
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const b = orbWin() && orbWin().getBounds();
      const key = b ? `${b.x},${b.y}` : "";
      if (key && key === last && i > 4) return b;
      last = key;
    }
    return orbWin() && orbWin().getBounds();
  };

  // 1. CONTROL: with nothing on the page, where does the fairy dock (the old spot)?
  await orb.__refreshObstacles();
  const r1 = await orb.setDockWindow(win);
  const oldSpot = await settle();
  expect("control: it docks on the window", r1 && r1.docked === true && orb.__dock().attached, { r1, dock: orb.__dock() });
  await orb.setDockWindow(null);
  await sleep(1200);
  expect("control: it detaches (no longer attached to the window)", orb.__dock().attached === false, orb.__dock());

  // 2. The CertTrack-like page: its "Review" tab sits exactly where the fairy used to land.
  const content = win.getContentBounds();
  const review = {
    x: Math.max(0, oldSpot.x - content.x - 6), y: Math.max(0, oldSpot.y - content.y - 6),
    w: orb.ORB_SIZE.width + 12, h: orb.ORB_SIZE.height + 12,
  };
  const pageSrv = await serve(pageHtml(`http://127.0.0.1:${frameSrv.port}/`, review));
  await win.loadURL(`http://127.0.0.1:${pageSrv.port}/`);
  await sleep(1200);
  // The oracle: real control rects from the DOM (main page), plus the frame element's rect;
  // its toolbar is the top 48 px of that frame by construction.
  const dom = await win.webContents.executeJavaScript(`(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    return { buttons: [...document.querySelectorAll("button")].map(rect), frame: rect(document.getElementById("app")) };
  })()`);
  const cb = win.getContentBounds();
  const toScreen = ([x, y, w, h]) => ({ x: Math.round(cb.x + x), y: Math.round(cb.y + y), width: Math.round(w), height: Math.round(h) });
  const controls = dom.buttons.map(toScreen);
  const frameToolbar = toScreen([dom.frame[0], dom.frame[1], dom.frame[2], 48]);
  const everything = [...controls, frameToolbar];
  const orbBox = (b) => ({ x: b.x, y: b.y, width: b.width, height: b.height });
  const coveredBy = (b) => everything.reduce((n, o) => n + overlap(orbBox(b), o), 0);
  expect("negative control: the OLD spot really covers the Review tab (the check can fail)", coveredBy(oldSpot) > 0, { oldSpot, controls });

  // 3. Dock for real onto the page and check the fairy's real bounds.
  await orb.__refreshObstacles();
  await orb.setDockWindow(win);
  const docked = await settle();
  expect("it attaches to the window", orb.__dock().attached === true && orb.__dock().windowId === win.id, orb.__dock());
  expect("it moved off the old spot", docked && (docked.x !== oldSpot.x || docked.y !== oldSpot.y), { docked, oldSpot });
  expect("it covers no button and no part of the cross-origin frame's toolbar", coveredBy(docked) === 0, { docked, covered: coveredBy(docked) });
  const wb = win.getBounds();
  expect("it stands inside the window", docked.x >= wb.x && docked.y >= wb.y && docked.x + docked.width <= wb.x + wb.width && docked.y + docked.height <= wb.y + wb.height, { docked, wb });

  // 4. Screenshot as proof (the primary display), before detaching.
  try {
    const out = process.env.SMOKE_OUT || path.join(tmp, "fairy-dock.png");
    const size = screen.getPrimaryDisplay().size;
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    if (sources[0]) { fs.writeFileSync(out, sources[0].thumbnail.toPNG()); console.log("SHOT " + out); }
  } catch (error) { console.log("NOSHOT " + String((error && error.message) || error)); }

  // 5. Detach: the window goes away from under it.
  await orb.setDockWindow(null);
  await sleep(1200);
  expect("it detaches when asked", orb.__dock().attached === false, orb.__dock());
  win.destroy();
  for (const s of [frameSrv, blankSrv, pageSrv]) s.server.close();
  console.log(fails.length ? `FAILED ${fails.length}` : "ALL PASSED");
  app.exit(fails.length ? 1 : 0);
});
