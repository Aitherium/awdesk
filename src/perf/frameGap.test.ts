import { describe, expect, it } from 'vitest';
import { createFrameGap, frameStats, percentile } from './frameGap';

describe('percentile', () => {
  it('interpolates between neighbours and never returns NaN for an empty list', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([0, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
  });
});

describe('frameStats', () => {
  it('reads a steady 60 fps capture as 60 fps with a ~16.7 ms p95 gap', () => {
    const times = Array.from({ length: 61 }, (_, i) => i * (1000 / 60));
    const s = frameStats(times, 2000);
    expect(s.fps).toBe(60);
    expect(s.p95GapMs).toBeCloseTo(16.7, 1);
    expect(s.samples).toBe(61);
  });

  it('a 15 fps idle window (66.7 ms frames) is reported as 15 fps', () => {
    const times = Array.from({ length: 31 }, (_, i) => i * (1000 / 15));
    const s = frameStats(times, 2000);
    expect(s.fps).toBe(15);
    expect(s.p95GapMs).toBeCloseTo(66.7, 1);
  });

  it('repeated long stalls show up in p95 while fps stays honest', () => {
    // 20 frames at 60 fps, 6 slow frames (~400 ms each = >5 % of the samples), 20 fast again.
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 20; i += 1) { times.push(t); t += 1000 / 60; }
    for (let i = 0; i < 6; i += 1) { times.push(t); t += 400; }
    for (let i = 0; i < 20; i += 1) { times.push(t); t += 1000 / 60; }
    const s = frameStats(times, 2000);
    expect(s.p95GapMs).toBe(400);
    expect(s.fps).toBeLessThan(20);
    expect(s.fps).toBeGreaterThan(3);
  });

  it('only counts the tail of the buffer inside the window', () => {
    const times = [0, 10_000, 10_016, 10_033, 10_050];
    const s = frameStats(times, 2000);
    expect(s.samples).toBe(4); // the ancient first sample is outside the window
    expect(s.p95GapMs).toBeLessThan(30);
  });

  it('reports nothing rather than NaN when there are fewer than two frames', () => {
    expect(frameStats([])).toEqual({ fps: 0, p95GapMs: 0, samples: 0 });
    expect(frameStats([5], 2000)).toEqual({ fps: 0, p95GapMs: 0, samples: 1 });
  });
});

describe('createFrameGap', () => {
  it('caps the buffer and answers over the requested window', () => {
    const sampler = createFrameGap(1000, 10);
    for (let i = 0; i < 100; i += 1) sampler.push(i * (1000 / 50));
    const s = sampler.stats();
    expect(s.samples).toBeLessThanOrEqual(10);
    expect(s.fps).toBeCloseTo(50, 0);
    sampler.clear();
    expect(sampler.stats().samples).toBe(0);
  });
});
