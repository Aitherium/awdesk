"use strict";

// The overlay is a full-screen transparent window. Everywhere it is not drawing UI the
// click must reach Windows. Measured on Garg's install 2026-10-16: the tenant page sent no
// hit-areas at all and Desk made the WHOLE window clickable ("fail-interactive"), so his
// real desktop could not be clicked or hovered.

const test = require("node:test");
const assert = require("node:assert/strict");
const hit = require("./overlay-hit.cjs");

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1040 };
const NOW = 100_000;
const DOCK = { edge: "bottom", thickness: 56 };

function verdict(over) {
  return hit.hitVerdict({ now: NOW, bounds: BOUNDS, cursor: { x: 900, y: 400 }, hit: { regions: [], dock: null, reportedAt: 0 },
    point: null, ...over });
}

test("fresh hit-areas decide: a window is interactive, the bare desktop passes through", () => {
  const h = { regions: [{ x: 100, y: 100, w: 400, h: 300 }], dock: DOCK, reportedAt: NOW - 500 };
  assert.equal(verdict({ hit: h, cursor: { x: 200, y: 200 } }).interactive, true);
  assert.equal(verdict({ hit: h, cursor: { x: 1200, y: 500 } }).interactive, false);
  assert.equal(verdict({ hit: h, cursor: { x: 1200, y: 1030 } }).interactive, true, "the dock strip");
  assert.equal(verdict({ hit: h }).source, "regions");
});

test("NO hit-areas ever (the tenant page): only a bottom dock band is clickable, never the whole desktop", () => {
  const v = verdict({ cursor: { x: 900, y: 400 } });
  assert.equal(v.interactive, false, "the middle of the desktop passes through");
  assert.equal(v.source, "fallback");
  assert.equal(verdict({ cursor: { x: 900, y: 1035 } }).interactive, true, "a bottom band stays reachable");
});

test("stale hit-areas (a still screen, an old page that only posts on change) keep the LAST known layout", () => {
  const h = { regions: [{ x: 100, y: 100, w: 400, h: 300 }], dock: DOCK, reportedAt: NOW - 30_000 };
  assert.equal(verdict({ hit: h, cursor: { x: 200, y: 200 } }).interactive, true);
  assert.equal(verdict({ hit: h, cursor: { x: 1200, y: 500 } }).interactive, false, "30 s later the desktop still passes through");
  assert.equal(verdict({ hit: h }).source, "last-known");
});

test("a fresh point probe from the page answers where hit-areas are missing or stale", () => {
  const painted = { x: 900, y: 400, at: NOW - 100, chain: [{ tag: "div", bgAlpha: 0.9, area: 0.1 }] };
  const bare = { x: 900, y: 400, at: NOW - 100, chain: [{ tag: "div", bgAlpha: 0, area: 1 }] };
  assert.equal(verdict({ point: painted }).interactive, true);
  assert.equal(verdict({ point: painted }).source, "point");
  assert.equal(verdict({ point: bare }).interactive, false);
  const old = { ...painted, at: NOW - 5_000 };
  assert.equal(verdict({ point: old }).source, "fallback", "an old probe is not trusted");
  const far = { ...painted, x: 100, y: 100 };
  assert.equal(verdict({ point: far }).source, "fallback", "a probe for another spot is not trusted");
  const h = { regions: [], dock: DOCK, reportedAt: NOW - 200 };
  assert.equal(verdict({ hit: h, point: painted }).source, "regions", "fresh hit-areas outrank a probe");
});

test("outside the window is never interactive", () => {
  assert.equal(verdict({ cursor: { x: -5, y: 400 } }).interactive, false);
});

test("painted: a background, an image, a border or a control counts; a full-screen wrapper never does", () => {
  assert.equal(hit.isPainted([{ tag: "div", bgAlpha: 0, area: 0.2 }]), false);
  assert.equal(hit.isPainted([{ tag: "span", bgAlpha: 0, area: 0.01 }, { tag: "div", bgAlpha: 0.6, area: 0.2 }]), true, "an ancestor panel");
  assert.equal(hit.isPainted([{ tag: "div", bgImage: true, area: 0.1 }]), true);
  assert.equal(hit.isPainted([{ tag: "div", borderAlpha: 1, borderWidth: 1, area: 0.1 }]), true);
  assert.equal(hit.isPainted([{ tag: "button", area: 0.001 }]), true);
  assert.equal(hit.isPainted([{ tag: "canvas", area: 1 }]), false, "a full-screen canvas is the backdrop");
  assert.equal(hit.isPainted([{ tag: "div", bgAlpha: 1, area: 0.99 }]), false, "a full-screen tinted wrapper is the backdrop");
  assert.equal(hit.isPainted([{ tag: "div", bgAlpha: 1, area: 0.2, opacity: 0 }]), false, "invisible");
  assert.equal(hit.isPainted([{ tag: "div", bgAlpha: 1, area: 0.2, pointerEvents: "none" }]), false);
  assert.equal(hit.isPainted("junk"), false);
});

test("the overlay window decides with hitVerdict and its preload sends point probes", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const win = fs.readFileSync(path.join(__dirname, "living-desktop-window.cjs"), "utf8");
  assert.match(win, /require\("\.\/overlay-hit\.cjs"\)/);
  assert.doesNotMatch(win, /return true; \/\/ fail-interactive/, "stale hit-areas must never make the whole desktop clickable");
  assert.match(win, /"living-desktop:point"/);
  const pre = fs.readFileSync(path.join(__dirname, "living-desktop-preload.cjs"), "utf8");
  assert.match(pre, /elementFromPoint/);
  assert.match(pre, /"living-desktop:point"/);
});

test("the stale threshold is 3 s", () => {
  assert.equal(hit.REGIONS_FRESH_MS, 3000);
  const h = { regions: [{ x: 100, y: 100, w: 400, h: 300 }], dock: DOCK, reportedAt: NOW - 3500 };
  assert.equal(verdict({ hit: h }).source, "last-known");
});
