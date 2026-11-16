"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { defaultSize, effectiveSize } = require("./window-size.cjs");

test("the default window is a share of the work area, never the old fixed 600x950 on a big screen", () => {
  const big = defaultSize({ height: 1350 }); // a 4K panel at 160 %
  assert.ok(big.height <= 1350 * 0.45, `${big.height} must not cover the screen`);
  assert.ok(big.height >= 480 && big.width >= 320);
  assert.deepEqual(defaultSize({ height: 4000 }), { width: 600, height: 950 }, "never above the old default");
  assert.deepEqual(defaultSize(null), { width: 600, height: 950 });
});

test("a size the owner chose is never touched", () => {
  assert.deepEqual(effectiveSize({ width: 900, height: 1200, chosen: true }, { height: 1350 }), { width: 900, height: 1200 });
});

test("a size an old build saved (not marked chosen) is capped at half the work area, keeping its shape", () => {
  const out = effectiveSize({ width: 681, height: 844 }, { height: 1350 });
  assert.equal(out.height, 675);
  assert.ok(out.width < 681 && out.width >= 320);
  assert.deepEqual(effectiveSize({ width: 400, height: 500 }, { height: 1350 }), { width: 400, height: 500 }, "already small");
});

test("main.cjs opens with effectiveSize and only marks a size chosen when the owner sets one", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/window-size\.cjs"\)/);
  assert.match(main, /effectiveSize\(/);
  assert.match(main, /JSON\.stringify\(\{ width, height, chosen: true \}\)/);
});
