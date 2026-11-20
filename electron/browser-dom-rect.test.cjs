"use strict";

/**
 * browser_snapshot must emit the awscreen DomSnapshot shape, so
 * `awscreen state --dom` joins this page's controls onto the pixels with NO
 * external converter: each element carries `rect` in CSS viewport px and the
 * top level carries {dpr, vw, vh, sx, sy}.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { scriptFor } = require("./browser-window.cjs");

test("browser_snapshot reports rect + viewport for awscreen --dom", () => {
  const js = scriptFor("snapshot", {});
  assert.match(js, /rect:\s*\[r\.left,\s*r\.top,\s*r\.width,\s*r\.height\]/);
  assert.match(js, /viewport:\s*\{/);
  assert.match(js, /dpr:\s*window\.devicePixelRatio/);
  assert.match(js, /sx:\s*scrollX/);
  assert.match(js, /origin_px:\s*\[0,\s*0\]/);
  assert.match(js, /image_scale:\s*"fit"/);
});
