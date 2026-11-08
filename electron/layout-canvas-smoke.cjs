"use strict";

/**
 * The browser's customizable layout and the pin canvas in a REAL window
 * (`npm run test:layout-canvas`): the real browser-window.cjs, the real chrome page,
 * the real aither://canvas page and real WebContentsViews. It drives the controls the
 * owner uses (the palette's layout verbs, the canvas page's own buttons) and then
 * READS what is on screen -- the DOM and the window list, not a bridge reply
 * (docs/UX-REIMPLEMENTATION.md: "a reply is not the UI").
 *
 * Own entry point, a throwaway userData, a loopback page server, no fleet. Set
 * LAYOUT_SMOKE_SHOTS=<dir> to save screenshots of edit-layout mode and the canvas.
 * Exit 0 all pass, 1 a check failed, 2 the run broke, 3 it hung.
 */
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

process.env.DESK_BROWSER_HOME = "http://127.0.0.1:1/";
process.env.DESK_BROWSER_CONTEXT_PUSH = "0";
process.env.DESK_GENESIS_BRIDGE_URL = "http://127.0.0.1:1";

const { app, BrowserWindow, webContents, desktopCapturer, protocol, ipcMain } = require("electron");
const bw = require("./browser-window.cjs");

// What main.cjs does before ready: aither:// is a standard, secure origin ('self' works).
require("./browser-internal.cjs").registerPrivilegedScheme(protocol);

app.setPath("userData", path.join(os.tmpdir(), `awdesk-layout-canvas-smoke-${process.pid}`));
// Boards go to a throwaway folder, never the owner's ~/Aither Boards.
const boardsDir = path.join(os.tmpdir(), `awdesk-layout-canvas-boards-${process.pid}`);
fs.mkdirSync(boardsDir, { recursive: true });
require("./boards-window.cjs").setBoardsDir(boardsDir);
process.on("unhandledRejection", (e) => { console.log("REJECT " + ((e && e.stack) || e)); app.exit(2); });
setTimeout(() => { console.log("TIMEOUT"); app.exit(3); }, 90000);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.LAYOUT_SMOKE_SHOTS || "";

/**
 * A REAL middle-button drag (sendInputEvent: Chromium makes the pointer events), the
 * owner's gesture: `mods` adds Shift / Control.
 */
async function middleDrag(wc, from, to, mods = []) {
  // The smoke runs on a real, shared desktop: a person's mouse crossing this window
  // mid-gesture sends real pointer events that end the synthetic drag. While the drag
  // runs the OS window ignores the real mouse; sendInputEvent goes to the page directly.
  const owner = BrowserWindow.fromWebContents(wc) || BrowserWindow.getAllWindows().find((w) => w.webContents === wc);
  if (owner) owner.setIgnoreMouseEvents(true);
  try { await middleDragRaw(wc, from, to, mods); } finally { if (owner && !owner.isDestroyed()) owner.setIgnoreMouseEvents(false); }
}
async function middleDragRaw(wc, from, to, mods) {
  wc.sendInputEvent({ type: "mouseMove", x: from.x, y: from.y, modifiers: mods });
  await wait(60);
  wc.sendInputEvent({ type: "mouseDown", x: from.x, y: from.y, button: "middle", clickCount: 1, modifiers: mods });
  await wait(120);
  for (let i = 1; i <= 6; i += 1) {
    wc.sendInputEvent({ type: "mouseMove", x: Math.round(from.x + ((to.x - from.x) * i) / 6),
      y: Math.round(from.y + ((to.y - from.y) * i) / 6), modifiers: [...mods, "middleButtonDown"] });
    await wait(80);
  }
  wc.sendInputEvent({ type: "mouseUp", x: to.x, y: to.y, button: "middle", clickCount: 1, modifiers: mods });
  await wait(600);
}
const centre = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await wait(100);
  }
}

/**
 * The window's real pixels -- page views included (a webContents capture would miss
 * every child view). On Windows: raise the window and copy that rectangle of the
 * screen; elsewhere the OS window capturer.
 */
async function shoot(win, name) {
  if (!shots) return null;
  fs.mkdirSync(shots, { recursive: true });
  const file = path.join(shots, name);
  const { screen } = require("electron");
  win.setAlwaysOnTop(true, "screen-saver");
  win.show();
  win.focus();
  await wait(700);
  const b = win.getContentBounds();
  try {
    if (process.platform !== "win32") throw new Error("not windows");
    const scale = screen.getDisplayMatching(b).scaleFactor || 1;
    const px = (v) => Math.round(v * scale);
    const ps = "Add-Type -AssemblyName System.Drawing;"
      + `$bmp = New-Object System.Drawing.Bitmap ${px(b.width)}, ${px(b.height)};`
      + "$g = [System.Drawing.Graphics]::FromImage($bmp);"
      + `$g.CopyFromScreen(${px(b.x)}, ${px(b.y)}, 0, 0, $bmp.Size);`
      + `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
    require("node:child_process").execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 });
  } catch {
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: b.width, height: b.height } });
    const own = sources.find((x) => x.id === win.getMediaSourceId());
    const image = own && !own.thumbnail.isEmpty() ? own.thumbnail : await win.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
  } finally {
    win.setAlwaysOnTop(false);
  }
  console.log(`SHOT ${file}`);
  return file;
}

app.whenReady().then(async () => {
  const fails = [];
  const expect = (name, cond, detail) => {
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " :: " + JSON.stringify(detail)));
    if (!cond) fails.push(name);
  };
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const name = decodeURIComponent(req.url.slice(1)) || "Root";
    res.end(`<!doctype html><title>${name}</title><body style="margin:0;font:16px sans-serif;background:#13202b;color:#cfe">`
      + `<h2 style="margin:16px">${name}</h2><p style="margin:16px">A live page on the canvas.</p></body>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // main.cjs answers the theme for every aither:// page; the smoke has no theme.
  ipcMain.handle("desk:appearance-get", () => ({ theme: "dark-glass", uiScale: 1 }));
  require("./boards-window.cjs").ensureIpc();
  const win = bw.createBrowserWindow({ url: `${base}/Home` });
  win.setBounds({ width: 1400, height: 900 });
  await until(() => win.isVisible());
  await wait(800);
  const chrome = win.webContents;
  const dom = (js) => chrome.executeJavaScript(js);
  const rail = () => bw.getState().rail;

  // ── presets ────────────────────────────────────────────────────────────────
  await bw.layoutCommand("preset:Focus");
  await wait(300);
  expect("Focus collapses the rail and hides the panel (read from the DOM)",
    await dom("document.body.classList.contains('collapsed') && document.getElementById('grip-panel').hidden"), rail().layout);
  await bw.layoutCommand("preset:Default");
  await wait(300);
  expect("Default brings both back", !(await dom("document.body.classList.contains('collapsed')")) && rail().rects.panel.width > 0);
  const saved = await bw.layoutCommand("save", "Smoke");
  await wait(300);
  expect("save-as names a preset the picker lists", saved.ok
    && (await dom("[...document.querySelectorAll('#opt-preset option')].some((o) => o.value === 'Smoke')")), saved);

  // ── sides ──────────────────────────────────────────────────────────────────
  await bw.layoutCommand("side", "panel left");
  await bw.layoutCommand("side", "rail right");
  await wait(300);
  let R = rail().rects;
  expect("panel left + rail right: panel | page | rail", R.panel.x === 0 && R.page.x > R.panel.x && R.rail.x > R.page.x, R);
  expect("the chrome page moved its rail to the right edge", await dom("document.body.classList.contains('rail-right')"));
  await bw.layoutCommand("side", "panel right");
  await bw.layoutCommand("side", "rail left");
  await wait(200);

  // ── detach / reattach (surface-state is the owner; the window is the oracle) ──
  const before = BrowserWindow.getAllWindows().length;
  const det = await bw.layoutCommand("detach", "panel");
  await wait(300);
  expect("detach: the panel is in its own window", det.ok && rail().layout.detached.panel === "detached"
    && BrowserWindow.getAllWindows().length === before + 1, { det, layout: rail().layout });
  expect("detach: the page took the panel's room", rail().rects.panel.width === 0);
  const paneWin = BrowserWindow.getAllWindows().find((w) => /Assistant panel/.test(w.getTitle()));
  paneWin.setBounds({ x: 120, y: 140, width: 430, height: 640 });
  await wait(600);
  paneWin.close(); // from OUTSIDE, as the owner's title-bar X would
  await wait(400);
  expect("closing the pane's window reattaches it (no hole left behind)", rail().layout.detached.panel === "embedded"
    && rail().rects.panel.width > 0, rail().layout);
  await bw.layoutCommand("detach", "panel");
  await wait(300);
  const again = BrowserWindow.getAllWindows().find((w) => /Assistant panel/.test(w.getTitle()));
  const b = again.getBounds();
  expect("a detached pane reopens where it was", Math.abs(b.x - 120) < 4 && Math.abs(b.width - 430) < 4, b);
  await bw.layoutCommand("attach", "panel");
  await wait(300);

  // ── the rail's arrangement ─────────────────────────────────────────────────
  const pin = await bw.layoutCommand("rail.pin", "Files");
  await wait(300);
  expect("Pin to rail: a Pinned section leads the rail", pin.ok && rail().sections[0].name === "Pinned"
    && (await dom("document.querySelector('#nav .sec').textContent === 'Pinned'")), pin);

  // ── edit-layout mode ───────────────────────────────────────────────────────
  await bw.layoutCommand("edit");
  await wait(500);
  const boxes = await dom("document.querySelectorAll('#editor .box').length");
  expect("edit mode draws the panes as boxes (page, panel, dock, taskbar)", boxes >= 3, boxes);
  expect("edit mode offers drop zones for panel, dock and rail", (await dom("document.querySelectorAll('#editor .zone').length")) === 6);
  expect("edit mode shows the rail's own edit strip", await dom("!document.getElementById('railedit').hidden"));
  expect("edit mode makes rail rows draggable", await dom("[...document.querySelectorAll('#nav .row')].some((r) => r.draggable)"));
  await shoot(win, "edit-layout-mode.png");
  // Middle-drag the panel's box onto the LEFT drop zone (the owner's middle-button rule).
  win.focus();
  await wait(500);
  const panelBox = await dom("(() => { const r = document.querySelector('#editor .box.panel').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
  const leftZone = await dom("(() => { const r = document.querySelector('#editor .zone[data-pane=\"panel\"][data-side=\"left\"]'); const z = r.style; return { x: parseFloat(z.left), y: parseFloat(z.top), width: parseFloat(z.width), height: parseFloat(z.height) }; })()");
  await middleDrag(chrome, centre(panelBox), centre(leftZone));
  let panelMoved = await until(() => rail().layout.sides.panel === "left", 3000);
  if (!panelMoved) {
    // Measured ~1 in 5 on a busy shared desktop: the synthetic press can land while the
    // chrome is still repainting after the screenshot's focus change. One retry, said aloud.
    console.log("RETRY edit-mode middle-drag (first synthetic drag did not land)");
    await wait(800);
    await middleDrag(chrome, centre(panelBox), centre(leftZone));
    panelMoved = await until(() => rail().layout.sides.panel === "left", 3000);
  }
  expect("edit mode: middle-drag a pane onto a lit edge moves it", panelMoved, rail().layout.sides);
  await bw.layoutCommand("side", "panel right");
  await wait(300);
  await bw.layoutCommand("edit");
  await wait(300);
  expect("Done leaves edit mode", await dom("document.getElementById('editor').hidden"));

  // ── the canvas ─────────────────────────────────────────────────────────────
  const open = await bw.layoutCommand("canvas.open");
  expect("aither://canvas opens", open.ok, open);
  const canvasWc = await until(() => webContents.getAllWebContents().find((w) => /^aither:\/\/canvas\//.test(w.getURL()) && !w.isLoading()));
  expect("the canvas page loaded", Boolean(canvasWc));
  await wait(600);
  const page = (js) => canvasWc.executeJavaScript(js);
  await page("document.getElementById('widget').value = 'clock'; document.getElementById('widget-add').click();");
  await wait(300);
  await page("document.getElementById('note-add').click();");
  await wait(300);
  await page("document.getElementById('widget').value = 'system'; document.getElementById('widget-add').click();");
  await wait(300);
  await page(`document.getElementById('app-url').value = '${base}/Pinned%20page'; document.getElementById('app-add').click();`);
  await wait(400);
  // A .gif address pins as a GIF card (pin-item kind detection), still a live view.
  await page(`document.getElementById('app-url').value = '${base}/party.gif'; document.getElementById('app-add').click();`);
  await wait(400);
  const pinnedTab = await bw.layoutCommand("canvas.pin-url", `${base}/Second`);
  expect("Pin to canvas from the palette lands on the board", pinnedTab.ok, pinnedTab);
  await wait(800);
  const cards = await page("document.querySelectorAll('.card').length");
  expect("the board shows every pinned card", cards === 6, cards); // +1 below: the Ctrl+middle copy
  await page("document.getElementById('fit').click()");
  await wait(600);
  const live = await until(() => webContents.getAllWebContents().filter((w) => w.getURL().startsWith(`${base}/`)
    && /Pinned|Second|party/.test(decodeURIComponent(w.getURL()))).length === 3, 15000);
  expect("each app card is a live page view (not a frame)", live);
  expect("the canvas page holds no iframe", (await page("document.querySelectorAll('iframe, webview').length")) === 0);
  // Lock one, try to move it with the keyboard: it stays.
  const first = await page("document.querySelector('.card').dataset.id");
  await page(`document.querySelector('.card[data-id="${first}"]').focus()`);
  await page(`document.querySelector('.card[data-id="${first}"] .lock').click()`);
  await wait(300);
  const locked = await page(`document.querySelector('.card[data-id="${first}"]').classList.contains('locked')`);
  expect("lock: the card says so", locked);
  // The owner's middle-button rule on a card: middle-drag moves it, Ctrl+middle copies it.
  const noteId = await page("document.querySelector('.card.note').dataset.id");
  const noteRect = await page(`(() => { const r = document.querySelector('.card[data-id="${noteId}"] .body').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const beforeLeft = await page(`parseFloat(document.querySelector('.card[data-id="${noteId}"]').style.left)`);
  await middleDrag(canvasWc, centre(noteRect), { x: centre(noteRect).x + 120, y: centre(noteRect).y + 60 });
  const leftNow = () => page(`parseFloat(document.querySelector('.card[data-id="${noteId}"]').style.left)`);
  expect("canvas: middle-drag on a card moves it (saved, re-rendered)", await until(async () => (await leftNow()) > beforeLeft, 4000),
    { beforeLeft, afterLeft: await leftNow() });
  const countBefore = await page("document.querySelectorAll('.card').length");
  const moved = await page(`(() => { const r = document.querySelector('.card[data-id="${noteId}"] .body').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await middleDrag(canvasWc, centre(moved), { x: centre(moved).x + 40, y: centre(moved).y + 160 }, ["control"]);
  expect("canvas: Ctrl+middle-drag duplicates the card (saved)", await until(async () => {
    const st = await page("window.aitherCanvas.state()");
    return st.board.pins.length === countBefore + 1;
  }, 4000));
  await page("document.getElementById('fit').click()");
  await wait(800);
  await shoot(win, "canvas-pinned-cards.png");
  // A navigation the card's kind forbids is refused (a web card cannot reach aither://).
  const card = webContents.getAllWebContents().find((w) => /Pinned/.test(decodeURIComponent(w.getURL())));
  await card.executeJavaScript("location.href = 'aither://settings/'").catch(() => {});
  await wait(500);
  expect("a web card cannot navigate to aither://", !card.getURL().startsWith("aither:"), card.getURL());

  // ── persisted: the canvas IS a whiteboard file; the layout holds only the pointer ──
  await wait(600);
  const layoutFile = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "browser-layout.json"), "utf8"));
  const boardId = layoutFile.desk && layoutFile.desk.canvasBoard;
  const boardFile = path.join(boardsDir, `${boardId}.json`);
  const boardDoc = fs.existsSync(boardFile) ? JSON.parse(fs.readFileSync(boardFile, "utf8")) : null;
  expect("the cards live in the boards store (~/Aither Boards/<id>.json, version 2)",
    boardDoc && boardDoc.version === 2 && boardDoc.pins.length === 7 && boardDoc.pins.some((p) => p.kind === "gif"), boardDoc && boardDoc.pins.map((p) => p.kind));
  expect("the layout file holds presets and the board pointer, never the boards",
    !("boards" in layoutFile.desk) && layoutFile.desk.presets.some((p) => p.name === "Smoke"), Object.keys(layoutFile.desk));
  // The floating board window opens the SAME board.
  const floated = await page("window.aitherCanvas.op({ op: 'board.float' })");
  await wait(800);
  const boardWin = await until(() => BrowserWindow.getAllWindows().find((w) => decodeURIComponent(w.webContents.getURL()).includes(`id=${boardId}`)));
  expect("Float opens this board in its own (existing) board window", floated.ok && Boolean(boardWin), floated);
  if (boardWin) {
    // The floating board draws the SAME cards (pin-cards.js), and the same gesture works there.
    const bwc = boardWin.webContents;
    await until(() => !bwc.isLoading());
    await wait(800);
    const bdom = (js) => bwc.executeJavaScript(js);
    const boardCards = await until(async () => (await bdom("document.querySelectorAll('#pins .card').length")) === 7);
    expect("the floating board window shows the board's pinned cards", boardCards, await bdom("document.querySelectorAll('#pins .card').length"));
    expect("...with the canvas's own card renderer", await bdom("Boolean(window.AitherPinCards && window.AitherMiddleDrag)"));
    const clockId = await bdom("document.querySelector('#pins .card.widget:not(.locked)').dataset.id");
    const r0 = await bdom(`(() => { const r = document.querySelector('#pins .card[data-id="${clockId}"] .body').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const b0 = JSON.parse(fs.readFileSync(boardFile, "utf8")).pins.find((x) => x.id === clockId).bounds;
    await middleDrag(bwc, centre(r0), { x: centre(r0).x + 96, y: centre(r0).y + 48 });
    const b1 = () => JSON.parse(fs.readFileSync(boardFile, "utf8")).pins.find((x) => x.id === clockId).bounds;
    expect("board window: middle-drag a card moves it in the ONE board file",
      await until(() => b1().x > b0.x && b1().y > b0.y, 4000), { b0, b1: b1() });
    // Middle-drag on EMPTY board space pans the board window (drawing and cards together).
    const stage = await bdom("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");
    const emptyAt = { x: Math.round(stage.x + 30), y: Math.round(stage.y + stage.height - 30) };
    const cardX = () => bdom(`document.querySelector('#pins .card[data-id="${clockId}"]').getBoundingClientRect().x`);
    const x0 = await cardX();
    await middleDrag(bwc, emptyAt, { x: emptyAt.x + 150, y: emptyAt.y - 20 });
    expect("board window: middle-drag on empty space pans (the cards move with the board)",
      await until(async () => (await cardX()) > x0 + 100, 3000), { x0, x1: await cardX() });
    const unchanged = JSON.parse(fs.readFileSync(boardFile, "utf8")).pins.find((x) => x.id === clockId).bounds;
    expect("...and a pan changes no card's board position", unchanged.x === b1().x && unchanged.y === b1().y, unchanged);
    await shoot(boardWin, "board-window-pins.png");
    boardWin.destroy();
  }

  server.close();
  console.log(fails.length ? `FAILED ${fails.length}: ${fails.join(", ")}` : "ALL PASS");
  app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.log("BROKE " + ((e && e.stack) || e)); app.exit(2); });
