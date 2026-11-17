import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeId,
  encodeId,
  forgetSlot,
  getPickState,
  hexToRgb,
  maskBounds,
  nearestIdInPatch,
  outlineRing,
  outlineScale,
  registerAvatarGroup,
  ringRect,
  registeredSlots,
  resetPick,
  setHover,
  setSelected,
  setSlotLook,
  slotLook,
  subscribePick,
} from './avatarPick';

afterEach(() => resetPick());

/** A tiny software "renderer": paints each body as a filled rect with a depth, front-most wins.
 *  It is the same decision the GL id pass makes (flat id colour + depth test), so the overlap
 *  and gap rules are pinned here without a GPU. */
function raster(w: number, h: number, bodies: Array<{ id: number; x: number; y: number; w: number; h: number; z: number }>) {
  const id = new Uint8Array(w * h);
  const depth = new Float32Array(w * h).fill(Infinity);
  for (const b of bodies) {
    for (let y = b.y; y < b.y + b.h; y += 1) for (let x = b.x; x < b.x + b.w; x += 1) {
      if (b.z < depth[y * w + x]) { depth[y * w + x] = b.z; id[y * w + x] = encodeId(b.id); }
    }
  }
  return (x: number, y: number) => decodeId([id[y * w + x], 0, 0, id[y * w + x] ? 255 : 0], 3);
}

describe('avatar id colours', () => {
  it('round-trips slot numbers and treats background and blend artefacts as nobody', () => {
    expect(encodeId(1)).toBe(1);
    expect(encodeId(0)).toBe(0);
    expect(encodeId(256)).toBe(0);
    expect(decodeId([2, 0, 0, 255], 3)).toBe(2);
    expect(decodeId([0, 0, 0, 0], 3)).toBe(0);
    expect(decodeId([9, 0, 0, 255], 3)).toBe(0); // above the live count = a blend fringe
    expect(decodeId([2, 0, 0, 60], 3)).toBe(0); // a translucent edge is not a hit
  });
});

describe('three bodies close together', () => {
  // Three bodies 50 px wide, 10 px apart, the middle one standing in front and overlapping both.
  const pick = raster(200, 100, [
    { id: 1, x: 10, y: 10, w: 50, h: 80, z: 3 },
    { id: 3, x: 130, y: 10, w: 50, h: 80, z: 3 },
    { id: 2, x: 50, y: 10, w: 90, h: 80, z: 1 }, // front-most, overlaps both neighbours by 10 px
  ]);
  it('a click on each body selects that body', () => {
    expect(pick(20, 50)).toBe(1);
    expect(pick(95, 50)).toBe(2);
    expect(pick(170, 50)).toBe(3);
  });
  it('where two overlap the front-most wins', () => {
    expect(pick(55, 50)).toBe(2);
    expect(pick(135, 50)).toBe(2);
  });
  it('a gap, or the space above and below, is nobody: the click passes through', () => {
    expect(pick(5, 50)).toBe(0);
    expect(pick(185, 50)).toBe(0);
    expect(pick(95, 5)).toBe(0);
    expect(pick(95, 95)).toBe(0);
  });
});

describe('hover and selection state', () => {
  it('notifies once per real change and names who is hovered and selected', () => {
    const seen: Array<ReturnType<typeof getPickState>> = [];
    const off = subscribePick((s) => seen.push(s));
    expect(setHover('slot1')).toBe(true);
    expect(setHover('slot1')).toBe(false);
    expect(setSelected('slot1')).toBe(true);
    expect(setHover(null)).toBe(true);
    off();
    expect(seen.map((s) => [s.hover, s.selected])).toEqual([['slot1', null], ['slot1', 'slot1'], [null, 'slot1']]);
    expect(getPickState()).toEqual({ hover: null, selected: 'slot1' });
  });
  it('a removed body can be neither hovered nor selected; looks fall back to the slot name', () => {
    setHover('slot2');
    setSelected('slot2');
    setSlotLook('slot2', { label: 'Atlas', color: '#a3a3a3' });
    expect(slotLook('slot2').label).toBe('Atlas');
    forgetSlot('slot2');
    expect(getPickState()).toEqual({ hover: null, selected: null });
    expect(slotLook('slot2').label).toBe('slot2');
    expect(slotLook('slot0').label).toBe('Aither');
  });
  it('reports to the bridge so main can expose it', () => {
    const reportPick = vi.fn();
    (globalThis as unknown as { window: unknown }).window = { deskBridge: { reportPick } };
    setSelected('slot1');
    expect(reportPick).toHaveBeenCalledWith({ hover: null, selected: 'slot1' });
    delete (globalThis as unknown as { window?: unknown }).window;
  });
  it('orders slots with the resident first and a stable id index', () => {
    registerAvatarGroup('slot2', { traverse() {} });
    registerAvatarGroup('slot0', { traverse() {} });
    registerAvatarGroup('slot1', { traverse() {} });
    expect(registeredSlots()).toEqual(['slot0', 'slot1', 'slot2']);
  });
});

describe('the outline', () => {
  // Owner screenshots 2026-11-16: a hard, stair-stepped white band. The ring was binary (0 or 255
  // alpha) from a half-resolution mask; these pin the replacement: thin, antialiased, outside.
  const W = 24;
  const H = 24;
  const FULL = { x: 0, y: 0, w: W, h: H };
  /** A 6x6 body at (8..13, 8..13); its left column only half covered (an MSAA edge). */
  function body() {
    const alpha = new Uint8Array(W * H);
    for (let y = 8; y < 14; y += 1) for (let x = 8; x < 14; x += 1) alpha[y * W + x] = x === 8 ? 128 : 255;
    return alpha;
  }
  const at = (px: Uint8ClampedArray, x: number, y: number, rect = FULL) => px[((y - rect.y) * rect.w + (x - rect.x)) * 4 + 3];

  it('is drawn just OUTSIDE the silhouette, never over the body, and is empty for an empty mask', () => {
    const px = outlineRing(body(), W, H, FULL, [255, 0, 0], 1.5);
    expect(at(px, 10, 10)).toBe(0); // inside the body
    expect(at(px, 14, 10)).toBe(255); // one pixel outside, full strength
    expect(px[(10 * W + 14) * 4]).toBe(255); // in the given colour
    expect(at(px, 19, 10)).toBe(0); // far away
    expect(outlineRing(new Uint8Array(W * H), W, H, FULL, [1, 2, 3], 2).every((v) => v === 0)).toBe(true);
  });

  it('is antialiased: a soft outer edge, and a half-covered edge pixel is half ring', () => {
    const px = outlineRing(body(), W, H, FULL, [255, 255, 255], 1.5);
    expect(at(px, 16, 10)).toBe(0); // 3 px out of a 1.5 px ring: past even the soft edge
    const soft = at(px, 14, 7); // 1.41 px off the body's corner: inside the soft outer edge
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(255);
    expect(at(px, 8, 10)).toBe(127); // coverage 128/255: the ring fills the uncovered half
    // Not a binary mask any more: real intermediate alpha values exist.
    const alphas = new Set<number>();
    for (let i = 3; i < px.length; i += 4) alphas.add(px[i]);
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true);
  });

  it('thin: a wider ring reaches further, and only the requested rectangle is computed', () => {
    const thin = outlineRing(body(), W, H, FULL, [255, 255, 255], 1);
    const wide = outlineRing(body(), W, H, FULL, [255, 255, 255], 2.5);
    expect(at(thin, 15, 10)).toBe(0); // 2 px out: beyond a 1 px ring
    expect(at(wide, 15, 10)).toBe(255); // and well inside a 2.5 px one
    const rect = ringRect({ x: 8, y: 8, w: 6, h: 6 }, W, H, 2);
    expect(rect).toEqual({ x: 4, y: 4, w: 14, h: 14 });
    const cut = outlineRing(body(), W, H, rect, [255, 255, 255], 2);
    expect(cut.length).toBe(rect.w * rect.h * 4);
    expect(at(cut, 15, 7, rect)).toBe(at(outlineRing(body(), W, H, FULL, [255, 255, 255], 2), 15, 7));
    expect(ringRect({ x: 0, y: 0, w: 3, h: 3 }, 4, 4, 2)).toEqual({ x: 0, y: 0, w: 4, h: 4 }); // clamped
  });

  it('reads the mask at the window resolution, capped for a very large window', () => {
    expect(outlineScale(600, 950)).toBe(1);
    expect(outlineScale(248, 470)).toBe(1);
    const big = outlineScale(2560, 1440);
    expect(big).toBeLessThan(1);
    expect(2560 * big * 1440 * big).toBeLessThanOrEqual(1_000_000);
    expect(outlineScale(0, 0)).toBe(1);
  });
  it('bounds the covered pixels for the name tag; hexToRgb falls back to white', () => {
    const alpha = new Uint8Array(100);
    alpha[2 * 10 + 3] = 255;
    alpha[5 * 10 + 6] = 255;
    expect(maskBounds(alpha, 10, 10)).toEqual({ x: 3, y: 2, w: 4, h: 4 });
    expect(maskBounds(new Uint8Array(100), 10, 10)).toBeNull();
    expect(hexToRgb('#38bdf8')).toEqual([0x38, 0xbd, 0xf8]);
    expect(hexToRgb('nope')).toEqual([255, 255, 255]);
  });
});

describe('the click-through slack round a body', () => {
  const patch = (size: number, ids: Record<string, number>) => {
    const px = new Uint8Array(size * size * 4);
    for (const [k, id] of Object.entries(ids)) {
      const [x, y] = k.split(',').map(Number);
      const i = (y * size + x) * 4;
      px[i] = id;
      px[i + 3] = 255;
    }
    return px;
  };
  it('the exact pixel wins; else the body pixel nearest the pointer; else nobody', () => {
    expect(nearestIdInPatch(patch(5, { '2,2': 1, '2,1': 2 }), 5, 3)).toBe(1);
    expect(nearestIdInPatch(patch(5, { '4,4': 1, '2,1': 2 }), 5, 3)).toBe(2);
    expect(nearestIdInPatch(patch(5, {}), 5, 3)).toBe(0);
    // A blend artefact above the slot count is nobody, here as in the exact pick.
    expect(nearestIdInPatch(patch(5, { '2,2': 9 }), 5, 3)).toBe(0);
  });
});
