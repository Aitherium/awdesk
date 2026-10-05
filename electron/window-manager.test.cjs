"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWindowManager, displayFor, placeOnDisplay } = require("./window-manager.cjs");
const { windowsHandlers, fromWindowsPage } = require("./windows-window.cjs");

const LEFT = { id: 1, label: "Left", bounds: {}, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 };
const RIGHT = { id: 2, label: "Right", bounds: {}, workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, size: { width: 2560, height: 1440 }, scaleFactor: 1 };

function fakeWin(title, b) {
  const w = { title, b: { ...b }, visible: true, top: false, destroyed: false,
    isDestroyed: () => w.destroyed, getTitle: () => w.title, getBounds: () => ({ ...w.b }), setBounds: (n) => { w.b = { ...n }; },
    isVisible: () => w.visible, isMinimized: () => false, isMaximized: () => false, unmaximize() {}, restore() {},
    show: () => { w.visible = true; }, showInactive: () => { w.visible = true; }, hide: () => { w.visible = false; }, focus() {},
    isAlwaysOnTop: () => w.top, setAlwaysOnTop: (on) => { w.top = on; } };
  return w;
}

function setup() {
  const browser = fakeWin("Aither Browser", { x: 100, y: 100, width: 1200, height: 800 });
  const card = fakeWin("Decision", { x: 300, y: 200, width: 400, height: 300 });
  const helper = fakeWin("", { x: 0, y: 0, width: 1, height: 1 });
  const electron = () => ({
    screen: { getPrimaryDisplay: () => LEFT, getAllDisplays: () => [LEFT, RIGHT] },
    BrowserWindow: { getAllWindows: () => [browser, card, helper] },
    app: { getPath: () => os.tmpdir() },
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wm-")), "layouts.json");
  const m = createWindowManager({ electron, file, registered: () => ({ browser: () => browser }) });
  return { m, browser, card };
}

test("placement keeps the relative spot and stays inside the target work area", () => {
  const b = placeOnDisplay({ x: 960, y: 520, width: 800, height: 600 }, LEFT.workArea, RIGHT.workArea);
  assert.deepEqual(b, { x: 1920 + 1280, y: 700, width: 800, height: 600 });
  const big = placeOnDisplay({ x: 0, y: 0, width: 5000, height: 5000 }, LEFT.workArea, RIGHT.workArea);
  assert.deepEqual([big.width, big.height], [2560, 1400]);
  assert.equal(displayFor({ x: 2000, y: 10, width: 100, height: 100 }, [LEFT, RIGHT]).id, 2);
});

test("list: named windows by key, others by title, untitled helpers left out", () => {
  const { m } = setup();
  assert.deepEqual(m.list().map((w) => w.key), ["browser", "title:Decision"]);
});

test("move to a monitor, hide, show, pin", () => {
  const { m, browser, card } = setup();
  assert.equal(m.moveTo("browser", 2).ok, true);
  assert.ok(browser.b.x >= 1920, "now on the right monitor");
  m.hide("title:Decision");
  assert.equal(card.visible, false);
  m.show("title:Decision");
  assert.equal(card.visible, true);
  m.setOnTop("browser", true);
  assert.equal(browser.top, true);
  assert.equal(m.moveTo("browser", 99).ok, false);
});

test("save and restore an arrangement; a missing window is skipped, not opened", () => {
  const { m, browser, card } = setup();
  m.moveTo("browser", 2);
  card.visible = false;
  assert.equal(m.save("Two monitors").ok, true);
  m.moveTo("browser", 1);
  card.visible = true;
  const r = m.restore("Two monitors");
  assert.deepEqual([r.ok, r.placed, r.skipped], [true, 2, 0]);
  assert.ok(browser.b.x >= 1920);
  assert.equal(card.visible, false);
  assert.deepEqual(m.layouts().map((l) => l.name), ["Two monitors"]);
  assert.equal(m.save("../etc").ok, false, "names are plain");
});

test("only aither://windows reaches these channels", async () => {
  assert.equal(fromWindowsPage({ getURL: () => "aither://windows/" }), true);
  let touched = 0;
  const m = new Proxy({}, { get: () => () => { touched++; return { ok: true }; } });
  for (const h of Object.values(windowsHandlers(m))) assert.equal((await h({ sender: { getURL: () => "https://x.test/" } }, "browser", 1)).ok, false);
  assert.equal(touched, 0);
});
