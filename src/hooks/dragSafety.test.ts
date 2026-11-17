import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onDragAbort, releasedMidDrag } from './dragSafety';

/** A minimal event hub standing in for window and document (the vitest env is plain node). */
function hub() {
  const map = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener: (t: string, fn: (e: unknown) => void) => { (map.get(t) ?? map.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => { map.get(t)?.delete(fn); },
    fire: (t: string, e: unknown = {}) => { for (const fn of [...(map.get(t) ?? [])]) fn(e); },
    count: () => [...map.values()].reduce((n, s) => n + s.size, 0),
  };
}

let win: ReturnType<typeof hub>;
let doc: ReturnType<typeof hub> & { hidden: boolean };

beforeEach(() => {
  win = hub();
  doc = Object.assign(hub(), { hidden: false });
  (globalThis as unknown as { window: unknown }).window = win;
  (globalThis as unknown as { document: unknown }).document = doc;
});
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { document?: unknown }).document;
});

describe('a drag always ends', () => {
  it('a move with no button held means the release was lost', () => {
    expect(releasedMidDrag(0)).toBe(true);
    expect(releasedMidDrag(1)).toBe(false);
  });

  it.each([
    ['pointercancel', () => win.fire('pointercancel')],
    ['mouseup anywhere', () => win.fire('mouseup')],
    ['blur', () => win.fire('blur')],
    ['Escape', () => win.fire('keydown', { key: 'Escape' })],
    ['a buttonless move', () => win.fire('pointermove', { buttons: 0, pointerType: 'mouse' })],
    ['the window hiding', () => { doc.hidden = true; doc.fire('visibilitychange'); }],
  ])('%s ends it', (_name, fire) => {
    const end = vi.fn();
    const off = onDragAbort(end);
    fire();
    expect(end).toHaveBeenCalled();
    off();
  });

  it('a move with the button still down, or another key, does not', () => {
    const end = vi.fn();
    const off = onDragAbort(end);
    win.fire('pointermove', { buttons: 1, pointerType: 'mouse' });
    win.fire('keydown', { key: 'a' });
    expect(end).not.toHaveBeenCalled();
    off();
  });

  it('disarming removes every listener (a finished drag leaks nothing)', () => {
    const end = vi.fn();
    const off = onDragAbort(end);
    expect(win.count() + doc.count()).toBeGreaterThan(0);
    off();
    expect(win.count() + doc.count()).toBe(0);
    win.fire('blur');
    expect(end).not.toHaveBeenCalled();
  });
});
