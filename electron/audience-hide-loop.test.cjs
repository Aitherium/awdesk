"use strict";

// The 2026-11-20 "keeps losing itself" second half: when the audience hides the resident
// body and there is no stand-in, enforceActiveCharacterRating() hid it and return.
// hideOverlay() calls refreshTrayMenu(), and refreshTrayMenu() calls
// enforceActiveCharacterRating() -- so every hide scheduled another hide, forever:
// measured 17 "hiding the body" lines a second, main +60 MB/min, the desk gone within
// minutes with no crash report. The hide must only happen while a body is on screen.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("the audience hide only fires for a body that is on screen", () => {
  // The guard reads the WINDOW, not a stored flag: a hidden window cannot re-enter.
  assert.match(main,
    /if \(avatarWindow && !avatarWindow\.isDestroyed\(\) && avatarWindow\.isVisible\(\)\) \{\s*\n\s*debugLog\("audience: the resident body is not for this audience and no stand-in is chosen; hiding the body"\);\s*\n\s*void hideOverlay\(\{ byOwner: false \}\);/);
  // Exactly one automatic hide in that branch: a second call anywhere is the loop back.
  const fn = main.slice(main.indexOf("function enforceActiveCharacterRating"), main.indexOf("// -- the rogues gallery"));
  assert.equal((fn.match(/hideOverlay\(\{/g) || []).length, 1, "one hideOverlay call in enforceActiveCharacterRating");
});

test("the cycle that made the loop possible is still real (they call each other)", () => {
  // Pin both ends: if a future change removes either side the guard could be dropped
  // without anyone noticing. This test is the reminder of why the guard exists.
  assert.match(main, /function refreshTrayMenu\(\) \{[\s\S]*?enforceActiveCharacterRating\(\);/);
  assert.match(main, /async function hideOverlay\(\{ byOwner = true \} = \{\}\) \{[\s\S]*?refreshTrayMenu\(\);/);
});
