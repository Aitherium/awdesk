import { describe, expect, it } from 'vitest';
import { decideInteractive } from './clickThrough';

describe('avatar window click-through', () => {
  it('passes clicks through empty pixels (the "blocks my input" report)', () => {
    expect(decideInteractive({ buttons: 0, overAvatar: false, backdrop: true })).toBe(false);
  });
  it('keeps the beads, bubbles and the avatar body clickable', () => {
    expect(decideInteractive({ buttons: 0, overAvatar: false, backdrop: false })).toBe(true);
    expect(decideInteractive({ buttons: 0, overAvatar: true, backdrop: true })).toBe(true);
  });
  it('never drops the window mid-drag', () => {
    expect(decideInteractive({ buttons: 1, overAvatar: false, backdrop: true })).toBe(true);
  });
});
