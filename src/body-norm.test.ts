import { describe, expect, it } from 'vitest';
import { MAX_BODY_SCALE, NORM_HEAD_HEIGHT, clampBodyScale, heightNormFactor, outsideView } from './body-norm';

describe('heightNormFactor (owner P0 2026-11-17: no giant models)', () => {
  it('pulls the 1.86 m kitsune down into the persona band', () => {
    const f = heightNormFactor(1.862);
    expect(1.862 * f).toBeCloseTo(NORM_HEAD_HEIGHT * 1.1, 5);
    expect(f).toBeLessThan(1);
  });
  it('leaves a body already in the band alone (aither-v2 1.51, charlie 1.57)', () => {
    expect(heightNormFactor(1.509)).toBe(1);
    expect(heightNormFactor(1.571)).toBe(1);
  });
  it('lifts a doll-sized body to the bottom of the band', () => {
    expect(0.6 * heightNormFactor(0.6)).toBeCloseTo(NORM_HEAD_HEIGHT * 0.8, 5);
  });
  it('a model with no measurable head is not touched', () => {
    expect(heightNormFactor(Number.NaN)).toBe(1);
    expect(heightNormFactor(0)).toBe(1);
  });
});

describe('clampBodyScale', () => {
  it('a stored 3x layout scale is drawn at the 1.25 ceiling', () => {
    expect(clampBodyScale(3)).toBe(MAX_BODY_SCALE);
  });
  it('a garbage scale is 1, never a giant', () => {
    expect(clampBodyScale(Number.NaN)).toBe(1);
    expect(clampBodyScale(-2)).toBe(1);
  });
  it('a normal scale passes through', () => {
    expect(clampBodyScale(0.8)).toBe(0.8);
  });
});

describe('outsideView (owner P0 2026-11-17: no body sliced at the window edge)', () => {
  it('a box sliced at the left edge is outside', () => {
    expect(outsideView([{ x: -1.4, y: 0, z: 0.5 }, { x: -0.6, y: 0.2, z: 0.5 }])).toBe(true);
  });
  it('a box inside the view is not', () => {
    expect(outsideView([{ x: -0.8, y: -0.9, z: 0.5 }, { x: 0.8, y: 0.9, z: 0.5 }])).toBe(false);
  });
  it('a corner behind the camera counts as outside', () => {
    expect(outsideView([{ x: 0, y: 0, z: 1.2 }])).toBe(true);
  });
  it('a negative margin is an allowance', () => {
    expect(outsideView([{ x: 1.01, y: 0, z: 0.5 }], -0.02)).toBe(false);
  });
});
