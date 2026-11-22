import { describe, expect, it } from 'vitest';
import { POSITION_BOUND } from '../hooks/useAvatarLayout';
import { cleanRect, lookYaw, rectTargetX, walkSteps, walkTargetX, walkYaw } from './entity-motion';

describe('walkTo(screenRect): where on the stage a body must stand', () => {
  it('the target is the rect\'s horizontal centre', () => {
    expect(rectTargetX({ x: 100, y: 0, width: 200, height: 50 })).toBe(200);
  });
  it('moves by the pixel gap at the body\'s own scale', () => {
    expect(walkTargetX(0, 500, 700, 0.005)).toBe(1);
    expect(walkTargetX(1, 500, 300, 0.005)).toBe(0);
  });
  it('stops at the stage edge when the target is far off the window', () => {
    expect(walkTargetX(0, 500, 90000, 0.005)).toBe(POSITION_BOUND);
    expect(walkTargetX(0, 500, -90000, 0.005)).toBe(-POSITION_BOUND);
  });
  it('a dead scale (no camera yet) leaves the body where it is', () => {
    expect(walkTargetX(0.4, 500, 700, 0)).toBe(0.4);
    expect(walkTargetX(0.4, 500, 700, NaN)).toBe(0.4);
  });
});

describe('the walk itself', () => {
  it('eases in and out and ends exactly on the target', () => {
    const steps = walkSteps(0, 1, 10);
    expect(steps).toHaveLength(10);
    expect(steps[9]).toBe(1);
    expect(steps[0]).toBeLessThan(0.1);
    expect(steps[4]).toBeLessThanOrEqual(0.5);
    expect(steps.every((v, i) => i === 0 || v >= steps[i - 1])).toBe(true);
  });
  it('faces the way it goes, and not at all for a tiny step', () => {
    expect(walkYaw(0, 1)).toBeGreaterThan(0);
    expect(walkYaw(1, 0)).toBeLessThan(0);
    expect(walkYaw(0, 0.01)).toBe(0);
    expect(Math.abs(walkYaw(0, 40))).toBeLessThanOrEqual(0.6);
  });
});

describe('lookAt(screenPoint)', () => {
  it('turns toward the point, in proportion, never past the clamp', () => {
    expect(lookYaw(500, 500, 1000)).toBe(0);
    expect(lookYaw(500, 750, 1000)).toBeCloseTo(0.45, 3);
    expect(lookYaw(500, -90000, 1000)).toBe(-0.9);
    expect(lookYaw(500, 90000, 1000)).toBe(0.9);
  });
});

describe('what the bridge may send', () => {
  it('keeps finite rects and refuses the rest', () => {
    expect(cleanRect({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(cleanRect({ x: 'a', y: 2, width: 3, height: 4 })).toBeNull();
    expect(cleanRect(null)).toBeNull();
    expect(cleanRect({ x: 1, y: 2 })).toEqual({ x: 1, y: 2, width: 0, height: 0 });
  });
});
