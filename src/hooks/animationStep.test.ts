import { describe, expect, it } from 'vitest';
import { advanceSubStepped, MAX_CATCHUP_S, MAX_STEP_S, subSteps } from './animationStep';

describe('subSteps', () => {
  it('advances a 200 ms gap as 200 ms of animation in <= 1/30 s steps', () => {
    const steps = subSteps(0.2);
    expect(steps.length).toBeGreaterThan(1);
    for (const s of steps) expect(s).toBeLessThanOrEqual(MAX_STEP_S + 1e-9);
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(0.2, 9);
  });

  it('a 15 fps idle frame (66.7 ms) is two steps, not a clamped 33 ms', () => {
    const delta = 1 / 15;
    const steps = subSteps(delta);
    expect(steps.length).toBe(2);
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(delta, 9);
  });

  it('never integrates more than the catch-up cap on a real stall', () => {
    const steps = subSteps(5);
    const total = steps.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(MAX_CATCHUP_S, 9);
    expect(steps.length).toBeLessThanOrEqual(Math.ceil(MAX_CATCHUP_S / MAX_STEP_S));
  });

  it('ignores junk and non-positive deltas instead of looping', () => {
    expect(subSteps(0)).toEqual([]);
    expect(subSteps(-1)).toEqual([]);
    expect(subSteps(Number.NaN)).toEqual([]);
    const capped = subSteps(Number.POSITIVE_INFINITY);
    expect(capped.reduce((a, b) => a + b, 0)).toBeCloseTo(MAX_CATCHUP_S, 9);
  });
});

describe('advanceSubStepped', () => {
  it('sums to the elapsed time and calls the update once per step', () => {
    let calls = 0;
    const advanced = advanceSubStepped(0.2, () => { calls += 1; });
    expect(calls).toBe(subSteps(0.2).length);
    expect(advanced).toBeCloseTo(0.2, 9);
  });

  it('reports 0 for an unusable delta', () => {
    let called = false;
    expect(advanceSubStepped(Number.NaN, () => { called = true; })).toBe(0);
    expect(called).toBe(false);
  });
});
