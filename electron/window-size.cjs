"use strict";

/**
 * window-size.cjs -- how big the avatar window is when the owner has not chosen.
 *
 * Owner P0, 2026-11-16: Aither "standing huge on top of his YouTube window". The window was a fixed
 * 600x950 DIP (or a size saved long ago) whatever the screen: on a 1350-DIP-high work area that is
 * two thirds of the screen, over whatever he is watching. The DEFAULT is now a share of the work
 * area; a size the owner set himself (saveSize writes `chosen: true`) is never touched.
 *
 * Pure: the work area is passed in (electron-free; window-size.test.cjs).
 */

const MIN_W = 320;
const MIN_H = 480;
const DEFAULT_W = 600;
const DEFAULT_H = 950;
/** Share of the work-area height the default window takes. */
const DEFAULT_SHARE = 0.42;
/** A size nobody marked as chosen (written by an old build) is capped at this share. */
const UNCHOSEN_CAP_SHARE = 0.5;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** The window size for a desk with nothing saved. */
function defaultSize(area) {
  const h = area && Number.isFinite(area.height) && area.height > 0 ? area.height : 0;
  if (!h) return { width: DEFAULT_W, height: DEFAULT_H };
  const height = clamp(Math.round(h * DEFAULT_SHARE), MIN_H, DEFAULT_H);
  const width = clamp(Math.round(height * (DEFAULT_W / DEFAULT_H)), MIN_W, DEFAULT_W);
  return { width, height };
}

/**
 * The size to open with: the saved size when the owner chose it, else the saved size capped to
 * half the work area (an old default), else the default. Never below the window minimum.
 */
function effectiveSize(saved, area) {
  const ok = saved && Number.isFinite(saved.width) && Number.isFinite(saved.height);
  if (!ok) return defaultSize(area);
  if (saved.chosen === true) return { width: saved.width, height: saved.height };
  const h = area && Number.isFinite(area.height) && area.height > 0 ? area.height : 0;
  if (!h) return { width: saved.width, height: saved.height };
  const maxH = Math.max(MIN_H, Math.round(h * UNCHOSEN_CAP_SHARE));
  if (saved.height <= maxH) return { width: saved.width, height: saved.height };
  const scale = maxH / saved.height;
  return { width: Math.max(MIN_W, Math.round(saved.width * scale)), height: maxH };
}

module.exports = { defaultSize, effectiveSize, MIN_W, MIN_H, DEFAULT_W, DEFAULT_H };
