"use strict";

/**
 * middle-drag-load.cjs -- main-process access to middle-drag.js, the ONE copy of the
 * middle-button rule. middle-drag.js is a page script (window.AitherMiddleDrag) and
 * this package is "type": "module", so it is not require()d: it is run once, with its
 * own `window` object, the way a page runs it. This file holds no rules.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let api = null;

/** window.AitherMiddleDrag, for main. */
function middleDrag() {
  if (!api) {
    // In THIS realm (not a new context), so the objects it returns are ordinary ones.
    const source = fs.readFileSync(path.join(__dirname, "middle-drag.js"), "utf8");
    const run = vm.runInThisContext(`(function (window) {
${source}
})`, { filename: "middle-drag.js" });
    const win = {};
    run(win);
    api = win.AitherMiddleDrag;
  }
  return api;
}

module.exports = { middleDrag };
