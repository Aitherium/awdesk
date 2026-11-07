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

describe('the body, not its box', () => {
  it('a fully transparent probe is not the body; one opaque pixel is', async () => {
    const { alphaHit } = await import('./clickThrough');
    expect(alphaHit(new Uint8Array(25 * 4))).toBe(false);
    const px = new Uint8Array(25 * 4);
    px[12 * 4 + 3] = 200;
    expect(alphaHit(px)).toBe(true);
    const faint = new Uint8Array(25 * 4);
    faint[3] = 10; // anti-aliased halo fringe
    expect(alphaHit(faint)).toBe(false);
  });
});
