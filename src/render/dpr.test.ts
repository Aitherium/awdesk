import { describe, expect, it } from 'vitest';
import { chooseDpr } from './dpr';

describe('chooseDpr', () => {
  it('is 1 while anything is moving, speaking or was just touched', () => {
    expect(chooseDpr({ active: true, sinceInputMs: 99999, devicePixelRatio: 2 })).toBe(1);
    expect(chooseDpr({ active: false, sinceInputMs: 100, devicePixelRatio: 2 })).toBe(1);
  });
  it('rises to the display ratio, at most 2, once the scene is idle', () => {
    expect(chooseDpr({ active: false, sinceInputMs: 5000, devicePixelRatio: 1.6 })).toBe(1.6);
    expect(chooseDpr({ active: false, sinceInputMs: 5000, devicePixelRatio: 3 })).toBe(2);
    expect(chooseDpr({ active: false, sinceInputMs: 5000, devicePixelRatio: 1 })).toBe(1);
  });
  it('a hidden window and a junk ratio stay at 1', () => {
    expect(chooseDpr({ active: false, sinceInputMs: 9e9, devicePixelRatio: 2, hidden: true })).toBe(1);
    expect(chooseDpr({ active: false, sinceInputMs: 9e9, devicePixelRatio: NaN })).toBe(1);
  });
});
