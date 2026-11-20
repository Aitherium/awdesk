"use strict";

/**
 * companion-surface.cjs -- ONE companion surface on the desktop.
 *
 * Owner, 2026-11-20: "WHY DOES CLICKING DESKTOP TRAY OPEN A SEPARATE AVATAR WHEN
 * THE FAIRY IS SUPPOSED TO TURN INTO THAT AVATAR".
 *
 * The desk has two renderers -- the fairy (orb-window.cjs) and Aither's body
 * (main.cjs's one avatar window) -- but a person has ONE companion. Measured
 * live: the tray's "Show avatar" called showOverlay(), which raised the body
 * while the fairy kept floating beside it (two surfaces, two places to look).
 * The grow path ("Show Aither", a fairy click, expandToAvatar) was already
 * right: it stands the fairy down and the body grows out of her spot.
 *
 * So every visit to the companion resolves HERE, to a plan:
 *   avatar target: grow in place when the fairy is on screen; otherwise the
 *                  body shows where it stands. The fairy steps down either way.
 *   fairy target:  the body leaves and the fairy comes back to her spot.
 *
 * Docked in the browser rail is the ONE declared exception (owner: docking is
 * the way to a separate surface), so a docked plan keeps both.
 *
 * PURE: no electron, no windows, no clocks. node --test.
 */

/** What a person is asking for. `toggle` is the tray's "Show avatar" / "Hide avatar". */
const WANTS = Object.freeze(["avatar", "fairy", "toggle"]);

/**
 * Decide what moves.
 *
 * Args:
 *   want: "avatar" | "fairy" | "toggle".
 *   expanded: the fairy has grown into the body (orb-window `expanded`).
 *   fairyVisible: the fairy orb is on screen right now.
 *   fairyWanted: the fairy's own saved switch says shown (orb.json `visible`) --
 *     still true while she is stood down for the body.
 *   avatarVisible: the body window is on screen.
 *   docked: the body lives in the browser rail (a separate surface by design).
 *
 * Returns:
 *   {fairy: "show"|"hide"|"keep",
 *    avatar: "grow"|"show"|"hide"|"keep",
 *    collapse: bool,           // the grown body must shrink back into the fairy
 *    visible: [...],           // surfaces visible after the plan
 *    why}
 */
function plan({
  want = "toggle",
  expanded = false,
  fairyVisible = false,
  fairyWanted = false,
  avatarVisible = false,
  docked = false,
} = {}) {
  const ask = WANTS.includes(want) ? want : "toggle";
  if (docked) {
    // The body is the browser's surface; it moves with the browser, not with this
    // switch. Docking is the one declared way to have both.
    return {
      fairy: "keep",
      avatar: "keep",
      collapse: false,
      visible: [fairyVisible && "fairy", avatarVisible && "avatar"].filter(Boolean),
      why: "the body is docked in the browser",
    };
  }

  const bodyUp = expanded || avatarVisible;
  const target = ask === "toggle" ? (bodyUp ? "fairy" : "avatar") : ask;
  const fairyAfter = (fairyWanted || fairyVisible) ? "show" : "keep";

  if (target === "avatar") {
    if (bodyUp) {
      return {
        fairy: "hide",
        avatar: "keep",
        collapse: false,
        visible: ["avatar"],
        why: "the body is already up",
      };
    }
    if (fairyVisible) {
      // The whole point: same window, same spot, the fairy becomes the body.
      return {
        fairy: "hide",
        avatar: "grow",
        collapse: false,
        visible: ["avatar"],
        why: "the fairy grows into the body in place",
      };
    }
    return {
      fairy: "hide",
      avatar: "show",
      collapse: false,
      visible: ["avatar"],
      why: "no fairy on screen: the body shows alone",
    };
  }

  // fairy
  return {
    fairy: fairyAfter,
    avatar: avatarVisible || expanded ? "hide" : "keep",
    collapse: expanded,
    visible: fairyAfter === "show" ? ["fairy"] : [],
    why: expanded ? "the body shrinks back into the fairy" : "the fairy is the companion",
  };
}

module.exports = { WANTS, plan };
