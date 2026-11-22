import { describe, expect, it } from 'vitest';
import { anyBoxMoved, decideInteractive, nearAnyBox, shouldRePick } from './clickThrough';

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

// S1 (2026-11-18 lag audit): the resting re-check was a full skinned re-render plus a
// SYNCHRONOUS GPU readback, 8.3x/s forever. It now runs only when the cursor is near a
// body's projected screen box or a body moved — never over empty pixels.
describe('the re-pick gate', () => {
  const boxes = [
    { x: 40, y: 20, w: 60, h: 100 }, // slot0's projected box
    { x: 200, y: 0, w: 30, h: 40 },
  ];

  it('is inside a box, or within slack of one, and outside otherwise', () => {
    expect(nearAnyBox(50, 50, boxes)).toBe(true);
    expect(nearAnyBox(39, 50, boxes)).toBe(false);
    expect(nearAnyBox(39, 50, boxes, 2)).toBe(true);
    expect(nearAnyBox(500, 500, boxes)).toBe(false);
    expect(nearAnyBox(500, 500, [])).toBe(false);
  });

  it('a body that moved by more than the epsilon counts as a move; a sub-pixel jitter does not', () => {
    const moved = [{ x: 41, y: 20.4, w: 60, h: 100 }];
    expect(anyBoxMoved(boxes, moved)).toBe(true);
    expect(anyBoxMoved(boxes, [{ x: 40.4, y: 20, w: 60, h: 100 }, boxes[1]])).toBe(false);
    expect(anyBoxMoved([], boxes)).toBe(true);
  });

  it('decides to re-pick only when near a box or a body moved', () => {
    expect(shouldRePick(false, false)).toBe(false);
    expect(shouldRePick(true, false)).toBe(true);
    expect(shouldRePick(false, true)).toBe(true);
  });

  async function gatedRig(opts: { near: boolean; moved?: boolean }) {
    const { createClickThroughController } = await import('./clickThrough');
    const bodyAtCalls: Array<[number, number]> = [];
    const sent: boolean[] = [];
    const control = createClickThroughController({
      bodyAt: (x, y) => { bodyAtCalls.push([x, y]); return opts.near ? 'slot0' : null; },
      backdropAt: () => true,
      report: (v) => sent.push(v),
      nearBox: () => opts.near,
      bodyMoved: () => opts.moved ?? false,
    });
    return { control, bodyAtCalls, sent };
  }

  it('a resting cursor outside every box costs no pick at all', async () => {
    const { control, bodyAtCalls, sent } = await gatedRig({ near: false });
    control.move(500, 500, 0);
    expect(bodyAtCalls).toHaveLength(0); // the move itself is gated too
    control.tick();
    control.tick();
    expect(bodyAtCalls).toHaveLength(0);
    expect(sent.every((v) => v === false)).toBe(true);
  });

  it('a resting cursor near a body still re-picks (the swaying shoulder)', async () => {
    const { control, bodyAtCalls } = await gatedRig({ near: true });
    control.move(50, 50, 0);
    control.tick();
    expect(bodyAtCalls.length).toBe(2);
  });

  it('a body that moved under a cursor now outside every box is still re-picked', async () => {
    const { control, bodyAtCalls } = await gatedRig({ near: false, moved: true });
    control.move(50, 50, 0);
    bodyAtCalls.length = 0;
    control.tick();
    expect(bodyAtCalls.length).toBe(1);
  });
});
