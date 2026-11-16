import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearVisemes, getVisemes, resetVisemes, sanitizeVisemes, setVisemes } from './voiceVisemes';

afterEach(() => {
  resetVisemes();
  vi.useRealTimers();
});

describe('voiceVisemes', () => {
  it('sanitises: clamps to 0..1, drops junk, missing is 0', () => {
    expect(sanitizeVisemes({ aa: 2, ee: -1, ih: 'x', oh: 0.4 })).toEqual({ aa: 1, ee: 0, ih: 0, oh: 0.4, ou: 0 });
    expect(sanitizeVisemes(null)).toEqual({ aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 });
  });

  it('holds a fresh override and lets it lapse so the body falls back to the amplitude lip sync', () => {
    vi.useFakeTimers();
    setVisemes('slot1', { aa: 0.8 }, 100);
    expect(getVisemes('slot1')?.aa).toBe(0.8);
    expect(getVisemes('slot2')).toBeNull();
    vi.advanceTimersByTime(500);
    expect(getVisemes('slot1')).toBeNull();
  });

  it('null releases at once; a body keeps its own mouth', () => {
    setVisemes('slot1', { oh: 1 });
    setVisemes('slot2', { ee: 1 });
    setVisemes('slot1', null);
    expect(getVisemes('slot1')).toBeNull();
    expect(getVisemes('slot2')?.ee).toBe(1);
    clearVisemes('slot2');
    expect(getVisemes('slot2')).toBeNull();
  });
});
