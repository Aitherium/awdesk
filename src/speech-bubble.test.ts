import { describe, expect, it } from 'vitest';
import { BUBBLE_MAX_CHARS, bubbleDurationMs, bubbleText, captionLines, clampIntoViewport, stackOffset } from './speech-bubble';

describe('bubbleText', () => {
  it('collapses whitespace and leaves a short line alone', () => {
    expect(bubbleText('  build   is\ngreen  ')).toBe('build is green');
  });

  it('cuts a long line at a word boundary, inside the limit, with an ellipsis', () => {
    const long = 'the quick brown fox jumps over the lazy dog '.repeat(20);
    const out = bubbleText(long);
    expect(out.length).toBeLessThanOrEqual(BUBBLE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    // A word boundary: the character before the ellipsis is a whole word's end.
    expect(long.replace(/\s+/g, ' ').startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('never throws on a non-string from across the IPC boundary', () => {
    expect(bubbleText(undefined)).toBe('');
    expect(bubbleText(42)).toBe('');
    expect(bubbleText(null)).toBe('');
  });
});

describe('bubbleDurationMs', () => {
  it('with NO audio, paces by reading speed -- longer text stays longer', () => {
    const short = bubbleDurationMs('ok', 0);
    const long = bubbleDurationMs('x'.repeat(120), 0);
    expect(short).toBe(2500); // the floor: long enough to find the bubble at all
    expect(long).toBeGreaterThan(short);
    expect(long).toBe(1200 + 120 * 60);
  });

  it('with audio, outlives the clip slightly instead of vanishing with it', () => {
    expect(bubbleDurationMs('hello there', 4000)).toBe(4900);
  });

  it('is bounded, and a garbage duration reads as "no audio"', () => {
    expect(bubbleDurationMs('x'.repeat(5000), 0)).toBe(14000);
    expect(bubbleDurationMs('hi', 999999)).toBe(14000);
    expect(bubbleDurationMs('hi', Number.NaN)).toBe(2500);
    expect(bubbleDurationMs('hi', -5)).toBe(2500);
  });
});

describe('clampIntoViewport', () => {
  const viewport = { width: 430, height: 680 };

  it('pulls the MEASURED off-screen bubble back inside the window', () => {
    // The real rectangle from the live desk, 2026-09-19: drawn above the window.
    const nudge = clampIntoViewport({ left: 85, top: -277, right: 345, bottom: -227 }, viewport);
    expect(nudge).toEqual({ dx: 0, dy: 285 });
    expect(-277 + nudge.dy).toBe(8);
  });

  it('leaves a bubble that already fits exactly where it is', () => {
    expect(clampIntoViewport({ left: 60, top: 40, right: 320, bottom: 90 }, viewport)).toEqual({ dx: 0, dy: 0 });
  });

  it('pulls in from the right and bottom edges too', () => {
    expect(clampIntoViewport({ left: 300, top: 650, right: 560, bottom: 700 }, viewport)).toEqual({ dx: -138, dy: -28 });
  });

  it('pins an over-wide bubble to the LEADING edge so the start of the text survives', () => {
    expect(clampIntoViewport({ left: -50, top: 100, right: 600, bottom: 150 }, viewport).dx).toBe(58);
  });

  it('a non-finite rect is no nudge, never NaN into a style', () => {
    expect(clampIntoViewport({ left: Number.NaN, top: 100, right: 10, bottom: 150 }, viewport)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('stackOffset: a newer bubble stacks over an older one instead of covering it', () => {
  const box = (left: number, top: number, w = 100, h = 30) => ({ left, top, right: left + w, bottom: top + h });
  it('needs no move when nothing overlaps', () => {
    expect(stackOffset(box(0, 100), [box(200, 100)])).toBe(0);
    expect(stackOffset(box(0, 100), [box(0, 40)])).toBe(0);
  });
  it('lifts a bubble that overlaps an older one to just above it', () => {
    expect(stackOffset(box(10, 110), [box(0, 100)])).toBe(100 - 6 - 30 - 110);
  });
  it('clears several stacked bubbles in one pass', () => {
    const dy = stackOffset(box(0, 100), [box(0, 100), box(0, 64)]);
    const top = 100 + dy;
    expect(top + 30).toBeLessThanOrEqual(64);
  });
});

describe('captionLines (docked: keep clear of the body)', () => {
  // Owner screenshot 2026-11-16: in the 230 px rail slot a long caption wrapped down over the
  // whole avatar. Docked, the caption gets only the lines that fit above the head.
  it('fits the room between the top margin and the anchor above the head', () => {
    // anchor 70 px down, 8 px margin, 16 px padding+border, 15 px lines -> (70 - 8 - 16) / 15 = 3
    expect(captionLines(70, 15, 16)).toBe(3);
    expect(captionLines(40, 15, 16)).toBe(1);
  });
  it('is at least one line (a caption nobody can see is worse) and bounded', () => {
    expect(captionLines(5, 15, 16)).toBe(1);
    expect(captionLines(-100, 15, 16)).toBe(1);
    expect(captionLines(5000, 15, 16)).toBe(12);
  });
  it('never throws on garbage measurements', () => {
    expect(captionLines(Number.NaN, 15)).toBe(1);
    expect(captionLines(100, 0)).toBe(1);
  });
});
