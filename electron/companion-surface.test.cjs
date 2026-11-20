"use strict";

/**
 * The owner's bug (2026-11-20): the tray's "Show avatar" raised the body while the
 * fairy stayed floating -- TWO surfaces. The plan is the whole fix, so every
 * combination that can happen on a desk is asserted here: after applying a plan
 * at most ONE companion surface is visible (docking is the declared exception).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { plan } = require("./companion-surface.cjs");

const visibleAfter = (p) => p.visible.filter(Boolean);

test("the owner's case: fairy on screen + 'Show avatar' grows her in place, never a second body", () => {
  const p = plan({ want: "avatar", fairyVisible: true, fairyWanted: true, avatarVisible: false });
  assert.equal(p.avatar, "grow", "the existing fairy becomes the body");
  assert.equal(p.fairy, "hide", "and the fairy steps down on the same click");
  assert.equal(p.collapse, false);
  assert.deepEqual(visibleAfter(p), ["avatar"]);
});

test("'Show avatar' is the same verb when the fairy is off screen: one body, nothing beside it", () => {
  const p = plan({ want: "avatar", fairyVisible: false, fairyWanted: false, avatarVisible: false });
  assert.equal(p.avatar, "show");
  assert.equal(p.fairy, "hide");
  assert.deepEqual(visibleAfter(p), ["avatar"]);
});

test("already grown: a second 'Show avatar' is a no-op, not a second window", () => {
  const p = plan({ want: "avatar", expanded: true, fairyVisible: false, fairyWanted: true, avatarVisible: true });
  assert.equal(p.avatar, "keep");
  assert.equal(p.fairy, "hide");
  assert.deepEqual(visibleAfter(p), ["avatar"]);
});

test("'Back to the fairy' shrinks the body and brings the fairy back -- one surface", () => {
  const p = plan({ want: "fairy", expanded: true, fairyVisible: false, fairyWanted: true, avatarVisible: true });
  assert.equal(p.collapse, true);
  assert.equal(p.avatar, "hide");
  assert.equal(p.fairy, "show");
  assert.deepEqual(visibleAfter(p), ["fairy"]);
});

test("the tray toggle reads the surface: body up -> fairy, fairy up -> grow", () => {
  const up = plan({ want: "toggle", expanded: true, fairyWanted: true, avatarVisible: true });
  assert.equal(up.collapse, true);
  assert.deepEqual(visibleAfter(up), ["fairy"]);
  const down = plan({ want: "toggle", fairyVisible: true, fairyWanted: true });
  assert.equal(down.avatar, "grow");
  assert.deepEqual(visibleAfter(down), ["avatar"]);
});

test("a body shown WITHOUT the grow (the old path) still stands the fairy down", () => {
  const p = plan({ want: "avatar", expanded: false, fairyVisible: true, fairyWanted: true, avatarVisible: true });
  assert.equal(p.avatar, "keep");
  assert.equal(p.fairy, "hide", "the simultaneous pair in the owner's screenshot is impossible");
  assert.deepEqual(visibleAfter(p), ["avatar"]);
});

test("a fairy the owner never showed is not resurrected by hiding the body", () => {
  const p = plan({ want: "fairy", expanded: false, fairyVisible: false, fairyWanted: false, avatarVisible: true });
  assert.equal(p.avatar, "hide");
  assert.equal(p.fairy, "keep");
  assert.deepEqual(visibleAfter(p), []);
});

test("docked in the browser is the one declared separate surface: nothing is moved", () => {
  const p = plan({ want: "avatar", docked: true, fairyVisible: true, fairyWanted: true, avatarVisible: true });
  assert.equal(p.avatar, "keep");
  assert.equal(p.fairy, "keep");
  assert.equal(p.collapse, false);
  assert.equal(p.why, "the body is docked in the browser");
});

test("every non-docked plan leaves at most ONE surface visible", () => {
  const bools = [false, true];
  for (const want of ["avatar", "fairy", "toggle", "nonsense"]) {
    for (const expanded of bools) for (const fairyVisible of bools)
      for (const fairyWanted of bools) for (const avatarVisible of bools) {
        const facts = { expanded, fairyVisible, fairyWanted, avatarVisible };
        const p = plan({ want, ...facts });
        const shown = p.visible.filter(Boolean);
        assert.ok(shown.length <= 1, `${want} ${JSON.stringify(facts)} left ${shown.join("+")}`);
      }
  }
});

test("garbage in is a toggle-shaped plan, not a crash", () => {
  assert.doesNotThrow(() => plan());
  assert.doesNotThrow(() => plan({ want: 42, expanded: "yes" }));
});
