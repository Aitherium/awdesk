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

// Regression, owner 2026-11-16 (P0): a right-click on the avatar's head and shoulders opened the plain
// Windows desktop menu. The body sways under a cursor that is standing still, and a mouseleave the OS
// sends while the window flips its hit-testing dropped the window to click-through outright.
describe('a right-click on a body that moves under a resting cursor', () => {
  async function rig() {
    const { createClickThroughController } = await import('./clickThrough');
    let shoulderX = 100; // the body covers x < shoulderX; it sways
    const sent: boolean[] = [];
    const control = createClickThroughController({
      bodyAt: (x) => (x < shoulderX ? 'slot0' : null),
      backdropAt: () => true,
      report: (v) => sent.push(v),
    });
    return { control, sent, sway: (x: number) => { shoulderX = x; } };
  }

  it('a shoulder that sways under a still cursor makes the window clickable without a mouse move', async () => {
    const { control, sent, sway } = await rig();
    control.move(105, 50, 0); // last move: just off the shoulder
    expect(sent.at(-1)).toBe(false);
    sway(110); // the idle swings the shoulder under the cursor; nothing moved
    control.tick();
    expect(sent.at(-1)).toBe(true); // the right press lands on the window, not the desktop
  });

  it('a mouseleave while the cursor rests on the body never makes the window click-through', async () => {
    const { control, sent } = await rig();
    control.move(50, 50, 0);
    expect(sent.at(-1)).toBe(true);
    control.leave();
    control.tick();
    expect(sent.at(-1)).toBe(true);
  });

  it('a press holds the window until every button is up, even if the body sways off the cursor', async () => {
    const { control, sent, sway } = await rig();
    control.move(95, 50, 0);
    control.press(true);
    sway(80);
    control.tick();
    expect(sent.at(-1)).toBe(true); // the release still reaches the window: the menu, never the desktop's
    control.press(false);
    control.tick();
    expect(sent.at(-1)).toBe(false); // empty transparent space passes through again
  });

  it('empty transparent space still passes clicks through', async () => {
    const { control, sent } = await rig();
    control.move(300, 50, 0);
    control.tick();
    expect(sent.every((v) => v === false)).toBe(true);
  });
});
