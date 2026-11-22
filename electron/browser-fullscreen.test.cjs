"use strict";

// A video's full-screen button: the tab's view takes the whole window while the page is
// full screen, and the layout from before comes back when it leaves.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fsMod = require("./browser-fullscreen.cjs");
const { EXIT_SCRIPT, createFullscreen, fullRect, fullscreenRects } = fsMod;
const { ALLOW_ARM_MS, armed } = require("./browser-permissions.cjs");

const RECTS = Object.freeze({
  page: { x: 240, y: 78, width: 700, height: 600 },
  panel: { x: 940, y: 78, width: 380, height: 600 },
  taskbar: { x: 240, y: 678, width: 1080, height: 44 },
  dock: { x: 240, y: 500, width: 700, height: 178 },
  avatar: { x: 0, y: 78, width: 240, height: 240 },
});
const CONTENT = { x: 0, y: 0, width: 2400, height: 1350 };

test("the page takes the whole window; panel, taskbar and dock collapse; the avatar slot goes", () => {
  const out = fullscreenRects(RECTS, CONTENT);
  assert.deepEqual(out.page, { x: 0, y: 0, width: 2400, height: 1350 });
  for (const pane of ["panel", "taskbar", "dock"]) assert.deepEqual(out[pane], { x: 0, y: 0, width: 0, height: 0 }, pane);
  assert.equal(out.avatar, null);
  assert.deepEqual(RECTS.page, { x: 240, y: 78, width: 700, height: 600 }, "the input is not changed");
});

test("fullRect ignores the window's screen position and bad input", () => {
  assert.deepEqual(fullRect({ x: 755, y: 358, width: 890.4, height: 647 }), { x: 0, y: 0, width: 890, height: 647 });
  assert.deepEqual(fullRect(null), { x: 0, y: 0, width: 0, height: 0 });
});

test("only the tab on screen is laid out full screen, and leaving restores the same rects object", () => {
  const fsState = createFullscreen();
  assert.equal(fsState.rects(RECTS, CONTENT, 3), RECTS, "nobody is full screen");
  assert.equal(fsState.enter(3), true);
  assert.equal(fsState.enter(3), false, "entering twice changes nothing");
  assert.equal(fsState.tab(), 3);
  assert.deepEqual(fsState.rects(RECTS, CONTENT, 3).page, { x: 0, y: 0, width: 2400, height: 1350 });
  assert.equal(fsState.rects(RECTS, CONTENT, 4), RECTS, "another tab on screen keeps the normal layout");
  assert.equal(fsState.stale(4), 3, "and the full-screen tab is told to exit");
  assert.equal(fsState.stale(3), null);
  assert.equal(fsState.leave(9), false, "another tab leaving is not ours");
  assert.equal(fsState.leave(3), true);
  assert.equal(fsState.rects(RECTS, CONTENT, 3), RECTS, "the exact layout from before");
  assert.equal(fsState.leave(3), false);
});

test("leave() with no id ends whatever is full screen (the window closed)", () => {
  const fsState = createFullscreen();
  fsState.enter(7);
  assert.equal(fsState.leave(null), true);
  assert.equal(fsState.tab(), null);
});

test("the exit script only touches a page that is full screen", () => {
  assert.match(EXIT_SCRIPT, /document\.fullscreenElement \? document\.exitFullscreen\(\)/);
});

test("browser-window lays out through the full-screen state and listens for both events", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  const layout = src.slice(src.indexOf("function layout() {"), src.indexOf("// ── Hidden tabs give their renderer back"));
  assert.match(layout, /htmlFullscreen\.rects\(currentRects\(\), win\.getContentBounds\(\), tabs\.active\)/);
  assert.match(src, /"enter-html-full-screen"/);
  assert.match(src, /"leave-html-full-screen"/);
});

// ---------------------------------------------------------------- review findings (M2, L1)

test("M2: the exit hint names the real site (the END of a long host) and how to leave", () => {
  assert.equal(fsMod.hintText("https://video.example.com/watch?v=1"), "video.example.com is full screen \u2014 press Esc to exit");
  const long = fsMod.hintText(`https://${"a".repeat(40)}.accounts.google.com.evil.example/x`);
  assert.ok(long.startsWith("\u2026") && long.includes("evil.example is full screen"), long);
  for (const url of ["about:blank", "data:text/html,x", "", null, "not a url"]) {
    assert.equal(fsMod.hintText(url), "This page is full screen \u2014 press Esc to exit", String(url));
  }
  assert.ok(fsMod.HINT_MS >= 2500 && fsMod.HINT_MS <= 5000, "about three seconds");
});

test("M2: the hint's document is main's own: no script, a locked-down CSP, and the host is escaped", () => {
  const url = fsMod.hintPage("https://video.example.com/watch");
  assert.ok(url.startsWith("data:text/html;charset=utf-8,"));
  const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<div id="hint">video\.example\.com is full screen \u2014 press Esc to exit<\/div>/);
  // Nothing of the page but its host reaches the document: not its path, query or title.
  const odd = decodeURIComponent(fsMod.hintPage("https://x.example/<img src=x onerror=alert(1)>?q=<b>").split(",").slice(1).join(","));
  assert.doesNotMatch(odd, /onerror|<img|<b>/);
});

test("M2: the hint sits at the top centre and never outside a small window", () => {
  assert.deepEqual(fsMod.hintRect({ x: 50, y: 60, width: 2400, height: 1350 }), { x: 970, y: 28, width: 460, height: 44 });
  const small = fsMod.hintRect({ width: 300, height: 200 });
  assert.ok(small.x >= 0 && small.x + small.width <= 300, JSON.stringify(small));
  assert.deepEqual(fsMod.hintRect(null), { x: 0, y: 28, width: 0, height: 44 });
});

test("L1: a permission or app question raised under full screen cannot arm until the page has left it", () => {
  assert.deepEqual([...fsMod.EYES_KINDS].sort(), ["external-app", "permission"]);
  for (const kind of ["permission", "external-app"]) {
    const raised = { kind, at: 1000, text: "q" };
    const held = fsMod.heldNotice(raised);
    assert.equal(fsMod.needsEyes(raised), true);
    assert.equal(raised.at, 1000, "the input is not changed");
    // However long the page stays full screen, Allow / Open stays dead.
    assert.equal(armed(held.at, 1000 + ALLOW_ARM_MS), false, kind);
    assert.equal(armed(held.at, 1000 + 60_000), false, kind);
    // Leaving full screen starts the half second.
    fsMod.restamp(held, 70_000);
    assert.equal(held.at, 70_000);
    assert.equal(armed(held.at, 70_000 + ALLOW_ARM_MS - 1), false, kind);
    assert.equal(armed(held.at, 70_000 + ALLOW_ARM_MS), true, kind);
  }
});

test("L1: a question that was already up when the page went full screen starts over on leave; other notices are left alone", () => {
  const prompt = { kind: "permission", at: 1000 };
  fsMod.restamp(prompt, 9000);
  assert.equal(armed(prompt.at, 9000 + ALLOW_ARM_MS - 1), false, "not armed the instant the toolbar reappears");
  const info = { kind: "info", at: 5, text: "Translating" };
  assert.equal(fsMod.needsEyes(info), false);
  assert.equal(fsMod.heldNotice(info), info);
  assert.equal(fsMod.restamp(info, 9000).at, 5);
  assert.equal(fsMod.restamp(undefined, 9000), undefined);
  assert.equal(fsMod.needsEyes(null), false);
});

test("M2 + L1: browser-window shows the hint on every enter, leaves full screen for a question, and restamps on leave", () => {
  const src = fs.readFileSync(path.join(__dirname, "browser-window.cjs"), "utf8");
  assert.match(src, /wc\.on\("enter-html-full-screen", \(\) => \{ htmlFullscreen\.enter\(id\); layout\(\); showFullscreenHint\(id\); \}\);/,
    "the hint is shown on EVERY enter, not only the first");
  assert.match(src, /wc\.on\("leave-html-full-screen", \(\) => \{ htmlFullscreen\.leave\(id\); afterPageFullscreen\(id\); \}\);/);
  const notice = src.slice(src.indexOf("function setNotice("), src.indexOf("/** The parity facts of the tab on screen"));
  assert.match(notice, /fullscreenMod\.needsEyes\(notice\) && htmlFullscreen\.tab\(\) === id/);
  assert.match(notice, /notice = fullscreenMod\.heldNotice\(notice\);\s*leavePageFullscreen\(id\);/);
  const after = src.slice(src.indexOf("function afterPageFullscreen("), src.indexOf("/** Another tab was put on screen while a page was full screen"));
  assert.match(after, /fullscreenMod\.restamp\(tabNotices\.get\(id\), now\);/);
  assert.match(after, /fullscreenMod\.restamp\(noticeBehind\.get\(id\), now\);/);
  const hint = src.slice(src.indexOf("function placeFullscreenHint("), src.indexOf("function hideFullscreenHint("));
  assert.match(hint, /win\.contentView\.addChildView\(hintView\);/, "the hint is (re)added last: the top child view");
  const layout = src.slice(src.indexOf("function layout() {"), src.indexOf("// ── Hidden tabs give their renderer back"));
  assert.match(layout, /placeFullscreenHint\(\);/);
});
