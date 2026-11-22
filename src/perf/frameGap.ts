/**
 * Renderer frame-gap counter (plan 2027, slice S1).
 *
 * The desk had main-process lag (`mainLag`, main.cjs:101-120) and an external, manual
 * profile harness (scripts/perf-gate.cjs, needs DESK_CDP_PORT) — but NOTHING in the
 * renderer reported its own frame rate. So "the avatar is lagging" could not be
 * measured from /health, and no acceptance check could fail.
 *
 * This is the GL-free, unit-testable half: a rolling sampler over rendered-frame
 * timestamps that answers `{fps, p95GapMs}`. `Scene.tsx` `RenderStatsReporter` pushes
 * one timestamp per rendered frame and ships the stats to main, which publishes them
 * on GET /health as `stage.render`.
 */

export interface FrameGapStats {
  /** Frames rendered per second across the sampled window. */
  fps: number;
  /** 95th percentile of the gap between consecutive rendered frames, in ms. */
  p95GapMs: number;
  /** How many frames the window held (0 = not enough data yet). */
  samples: number;
}

export const EMPTY_FRAME_STATS: FrameGapStats = Object.freeze({ fps: 0, p95GapMs: 0, samples: 0 });

/** Pure: the p-th percentile (p in 0..100) of `values`, linear interpolation between
 *  neighbours. An empty list is 0 (never NaN — this is published as JSON). */
export function percentile(values: readonly number[], p: number): number {
  const n = values.length;
  if (!n) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Pure: fps and the p95 frame gap for a list of frame timestamps (ms, ascending). The
 *  window is the tail of the list that falls within `windowMs` of the LAST sample, so a
 *  stall at the head of the buffer cannot drag the number down forever. */
export function frameStats(times: readonly number[], windowMs = 2000): FrameGapStats {
  if (times.length < 2) return { ...EMPTY_FRAME_STATS, samples: times.length };
  const cutoff = times[times.length - 1] - Math.max(1, windowMs);
  const window: number[] = [];
  for (let i = times.length - 1; i >= 0 && times[i] >= cutoff; i -= 1) window.unshift(times[i]);
  if (window.length < 2) return { ...EMPTY_FRAME_STATS, samples: window.length };
  const gaps: number[] = [];
  for (let i = 1; i < window.length; i += 1) gaps.push(window[i] - window[i - 1]);
  const spanMs = window[window.length - 1] - window[0];
  const fps = spanMs > 0 ? ((window.length - 1) * 1000) / spanMs : 0;
  // One decimal each: the payload is a health number, not a measurement archive.
  return {
    fps: Math.round(fps * 10) / 10,
    p95GapMs: Math.round(percentile(gaps, 95) * 10) / 10,
    samples: window.length,
  };
}

export interface FrameGapSampler {
  push(at: number): void;
  stats(): FrameGapStats;
  clear(): void;
}

/** A bounded rolling buffer (capacity 1024 at ~95 Hz ≈ 10 s), so a long-lived window
 *  cannot grow it without bound. `windowMs` is what `stats()` looks back over. */
export function createFrameGap(windowMs = 2000, capacity = 1024): FrameGapSampler {
  const times: number[] = [];
  const cap = Math.max(2, Math.floor(capacity));
  return {
    push(at: number) {
      times.push(Number(at));
      if (times.length > cap) times.splice(0, times.length - cap);
    },
    stats() {
      return frameStats(times, windowMs);
    },
    clear() {
      times.length = 0;
    },
  };
}
