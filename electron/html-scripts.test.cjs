"use strict";

// A syntax error in a page's inline script kills the page silently (measured
// 2026-11-07: a duplicate `let drag` left the ink overlay blank). Parse every inline
// script of the pages this slice owns.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const page of ["ink.html", "pin.html", "gif-picker.html", "board.html"]) {
  test(`${page}: every inline script parses`, () => {
    const html = fs.readFileSync(path.join(__dirname, page), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, `${page} has an inline script`);
    for (const code of scripts) assert.doesNotThrow(() => new Function(code), `${page} inline script`);
  });
}
