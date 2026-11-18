/**
 * Pixel-accurate avatar picking: WHICH body is under the pointer, decided by what is
 * actually drawn there.
 *
 * Owner, 2026-11-16: "the avatar click/selection hitbox extends far beyond the visible avatar.
 * With several avatars on screen, clicks land on the wrong one or on empty space."
 *
 * The old gate was a 1.8 x 2.1 box per body (cheap to raycast, much wider than a body) plus
 * an alpha probe that only said "something is painted here", never WHOSE it was: close
 * together, the box of the body in front covered the gap and the body behind it. So the
 * decision is now an ID-buffer pick (components/AvatarPicker.tsx): the scene is rendered
 * for ONE pixel with every body in a flat colour of its own, depth-tested, so
 *   - a click on a gap is nobody's (the window passes it to the desktop),
 *   - a click on a body is THAT body's, and
 *   - where two bodies overlap, the one in front wins (the depth buffer decides).
 *
 * This file is the GL-free half: the id colours, the selection / hover store the outline and
 * the main process read, and the silhouette edge detector. node/vitest-testable.
 */

export interface PickerApi {
  /** The slot under (clientX, clientY), or null over a gap. */
  pickAt(clientX: number, clientY: number): string | null;
  /** The slot painted within `radius` px of (clientX, clientY): the exact pixel first, else the nearest
   *  body pixel in the patch. One render of a (2r+1)^2 patch, not one per probe. */
  pickNear?(clientX: number, clientY: number, radius: number): string | null;
  /** A body's silhouette as a coverage mask (alpha > 0 = the body), at `scale` of the canvas size. */
  silhouette(slotId: string, scale?: number): { width: number; height: number; alpha: Uint8Array } | null;
  /** CHEAP: is the point within `slack` px of any body's projected screen box? Lets the
   *  click-through gate skip the expensive pick over empty pixels (clickThrough.ts). */
  near?(clientX: number, clientY: number, slack: number): boolean;
  /** CHEAP: did any body's projected screen box move since the last call? */
  moved?(): boolean;
}

/** Id colours: slot number n (1..255) is the red byte n; 0 is "nothing". */
export const MAX_IDS = 255;

export function encodeId(index: number): number {
  const n = Math.floor(Number(index));
  return Number.isFinite(n) && n >= 1 && n <= MAX_IDS ? n : 0;
}

/** The index a read-back RGBA pixel names (0 = background). Antialiasing is off in the id
 *  target, so the byte is exact; a value above `count` is a blend artefact and counts as nobody. */
export function decodeId(rgba: ArrayLike<number>, count: number): number {
  const a = Number(rgba[3]);
  if (!(a > 127)) return 0;
  const n = Number(rgba[0]);
  return n >= 1 && n <= count ? n : 0;
}

/**
 * The slack the WINDOW's click-through gets around a body (owner 2026-11-16, P0: a right-click on the
 * avatar's head and shoulders opened the Windows desktop menu). The exact one-pixel pick is right for
 * WHICH body a press belongs to, but as the window's on/off switch it flickers: the idle sways the head
 * and shoulders a few pixels every second, so a cursor resting on the body's edge was over a "gap" the
 * last time it moved and the press went through the window to the desktop. A few pixels of slack is
 * still the body, not the old box.
 */
export const PICK_SLOP_PX = 6;

/** Pure: the id in a square read-back patch (`size` x `size`, rows in any order) the click belongs to --
 *  the centre pixel's when it is a body, else the body pixel nearest the centre, else 0. */
export function nearestIdInPatch(rgba: ArrayLike<number>, size: number, count: number): number {
  const c = (size - 1) / 2;
  const at = (x: number, y: number) => {
    const i = (y * size + x) * 4;
    return decodeId([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]], count);
  };
  const centre = at(Math.round(c), Math.round(c));
  if (centre) return centre;
  let best = 0;
  let bestD = Infinity;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const id = at(x, y);
      if (!id) continue;
      const d = (x - c) * (x - c) + (y - c) * (y - c);
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  return best;
}

// -- the registry: which group is which slot ------------------------------------------

export interface PickGroup {
  traverse(visit: (object: unknown) => void): void;
}
const groups = new Map<string, PickGroup>();
let picker: PickerApi | null = null;

export function registerAvatarGroup(slotId: string, group: PickGroup | null): void {
  if (group) groups.set(slotId, group);
  else groups.delete(slotId);
}

/** Slots in a STABLE order (their id index is their position here). */
export function registeredSlots(): string[] {
  return [...groups.keys()].sort((a, b) => (a === 'slot0' ? -1 : b === 'slot0' ? 1 : a.localeCompare(b)));
}

export function registeredGroup(slotId: string): PickGroup | undefined {
  return groups.get(slotId);
}

export function setPicker(next: PickerApi | null): void {
  picker = next;
}

export function pickAt(clientX: number, clientY: number): string | null {
  return picker ? picker.pickAt(clientX, clientY) : null;
}

/** The body within `radius` px of the point (the exact pixel wins); falls back to the exact pick. */
export function pickNear(clientX: number, clientY: number, radius = PICK_SLOP_PX): string | null {
  if (!picker) return null;
  if (picker.pickNear && radius > 0) return picker.pickNear(clientX, clientY, radius);
  return picker.pickAt(clientX, clientY);
}

/**
 * Cheap proximity test used by the click-through gate (clickThrough.ts): is the point within
 * `slack` px of a body's projected screen box? No picker (or a picker without box knowledge)
 * answers TRUE, so an unknown picker costs a pick rather than losing a clickable body.
 */
export function nearBody(clientX: number, clientY: number, slack = 0): boolean {
  if (!picker?.near) return true;
  return picker.near(clientX, clientY, slack);
}

/** Cheap: did any body's projected screen box move since the last check? Unknown = true. */
export function bodiesMoved(): boolean {
  if (!picker?.moved) return true;
  return picker.moved();
}

export function hasPicker(): boolean {
  return picker !== null;
}

export function silhouetteOf(slotId: string, scale?: number) {
  return picker ? picker.silhouette(slotId, scale) : null;
}

// -- hover + selection ---------------------------------------------------------------------

export interface SlotLook {
  label: string;
  color: string;
}

export interface PickState {
  hover: string | null;
  selected: string | null;
}

const state: PickState = { hover: null, selected: null };
const looks = new Map<string, SlotLook>();
const listeners = new Set<(s: PickState) => void>();

function emit() {
  const snapshot = { ...state };
  for (const fn of listeners) fn(snapshot);
  try { (window as unknown as { deskBridge?: { reportPick?: (s: PickState) => void } }).deskBridge?.reportPick?.(snapshot); } catch { /* no bridge in tests */ }
}

export function getPickState(): PickState {
  return { ...state };
}

export function subscribePick(fn: (s: PickState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setHover(slotId: string | null): boolean {
  if (state.hover === slotId) return false;
  state.hover = slotId;
  emit();
  return true;
}

export function setSelected(slotId: string | null): boolean {
  if (state.selected === slotId) return false;
  state.selected = slotId;
  emit();
  return true;
}

export function setSlotLook(slotId: string, look: SlotLook | null): void {
  if (look) looks.set(slotId, look);
  else looks.delete(slotId);
  emit();
}

export function slotLook(slotId: string): SlotLook {
  return looks.get(slotId) ?? { label: slotId === 'slot0' ? 'Aither' : slotId, color: '#ffffff' };
}

/** A removed body can be neither hovered nor selected. */
export function forgetSlot(slotId: string): void {
  groups.delete(slotId);
  looks.delete(slotId);
  let changed = false;
  if (state.hover === slotId) { state.hover = null; changed = true; }
  if (state.selected === slotId) { state.selected = null; changed = true; }
  if (changed) emit();
}

export function resetPick(): void {
  groups.clear();
  looks.clear();
  state.hover = null;
  state.selected = null;
  picker = null;
}

/**
 * A read-only probe for tests and the swarm API (`window.__deskPick`, reached through main's
 * executeJavaScript): who is under a point, each body's silhouette bounds, the pick state.
 * It reads what the pick reads; it changes nothing.
 */
export function installProbe(): () => void {
  const w = window as unknown as { __deskPick?: unknown };
  w.__deskPick = {
    pickAt: (x: number, y: number) => pickAt(x, y),
    pickNear: (x: number, y: number, r?: number) => pickNear(x, y, r),
    state: () => getPickState(),
    slots: () => registeredSlots(),
    bounds: () => {
      const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
      for (const slot of registeredSlots()) {
        const sil = silhouetteOf(slot, 0.5);
        const b = sil ? maskBounds(sil.alpha, sil.width, sil.height) : null;
        out[slot] = b ? { x: b.x * 2, y: b.y * 2, w: b.w * 2, h: b.h * 2 } : null;
      }
      return out;
    },
    // Sample a grid and report which slot each cell belongs to (for choosing click points).
    grid: (step = 24) => {
      const rows: Array<{ x: number; y: number; slot: string | null }> = [];
      for (let y = step / 2; y < window.innerHeight; y += step) for (let x = step / 2; x < window.innerWidth; x += step) rows.push({ x, y, slot: pickAt(x, y) });
      return rows;
    },
    size: () => ({ w: window.innerWidth, h: window.innerHeight }),
    // What each registered group holds (diagnostic): meshes, visible meshes, skinned meshes.
    info: () => {
      const out: Record<string, { meshes: number; visible: number; skinned: number; pos: number[] | null }> = {};
      for (const slot of registeredSlots()) {
        const g = registeredGroup(slot);
        let meshes = 0; let visible = 0; let skinned = 0; let pos: number[] | null = null;
        g?.traverse((o) => {
          const m = o as { isMesh?: boolean; isSkinnedMesh?: boolean; visible?: boolean; userData?: { pickProxy?: boolean }; position?: { x: number; y: number; z: number } };
          if (m.isMesh && !m.userData?.pickProxy) { meshes += 1; if (m.visible !== false) visible += 1; if (m.isSkinnedMesh) skinned += 1; }
          if (!pos && m.position && (o as { isGroup?: boolean }).isGroup) pos = [m.position.x, m.position.y, m.position.z];
        });
        out[slot] = { meshes, visible, skinned, pos };
      }
      return out;
    },
  };
  return () => { delete w.__deskPick; };
}

// -- the outline -----------------------------------------------------------------------------
//
// Owner screenshots 2026-11-16: the outline read as a hard, stair-stepped WHITE band around
// the body, on the desktop and in the browser rail. It was a binary ring (alpha 0 or 255) cut
// from a binary mask read at HALF the window's resolution, then stretched 2x and again by the
// display scale, so every step was 3-4 device pixels. Now: the mask is read at the window's
// own resolution with MSAA (fractional coverage at the edge, components/AvatarPicker.tsx), the
// ring is computed antialiased on both sides, only around the body, and painted at device
// resolution with smoothing (components/AvatarOutline.tsx).

export interface MaskRect { x: number; y: number; w: number; h: number }

/** The scale a silhouette is read at for the outline: the window's own CSS pixels, capped so a
 *  very large window does not read back megabytes ten times a second. */
export function outlineScale(cssWidth: number, cssHeight: number, maxPixels = 1_000_000): number {
  const area = Math.max(1, Number(cssWidth) || 0) * Math.max(1, Number(cssHeight) || 0);
  return area <= maxPixels ? 1 : Math.max(0.25, Math.floor(Math.sqrt(maxPixels / area) * 100) / 100);
}

/** The part of the mask a ring `ring` px wide needs: the body's bounds grown by the ring and
 *  its soft edge, clamped to the mask. */
export function ringRect(bounds: MaskRect, width: number, height: number, ring: number): MaskRect {
  const pad = Math.ceil(Math.max(0, ring)) + 2;
  const x = Math.max(0, bounds.x - pad);
  const y = Math.max(0, bounds.y - pad);
  const x2 = Math.min(width, bounds.x + bounds.w + pad);
  const y2 = Math.min(height, bounds.y + bounds.h + pad);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

/**
 * An antialiased outline ring `ring` px wide, just OUTSIDE a body's coverage mask (alpha 0..255,
 * fractional at the edge). The outer edge falls off with distance; the inner edge is
 * (1 - coverage), so the ring meets the body's own antialiased edge with no seam and never
 * paints over the body. RGBA (straight alpha) for `rect` only, row-major, rect.w x rect.h.
 */
export function outlineRing(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  rect: MaskRect,
  rgb: [number, number, number],
  ring = 1.5,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(Math.max(0, rect.w * rect.h * 4)));
  const r = Math.max(0.5, Number(ring) || 0);
  const reach = Math.ceil(r + 0.5);
  // The disk's taps, each weighted by how much of it lies inside the ring: the soft outer edge.
  const taps: Array<[number, number, number]> = [];
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const weight = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(dx, dy)));
      if (weight > 0) taps.push([dx, dy, weight]);
    }
  }
  taps.sort((a, b) => b[2] - a[2]); // the nearest taps first: most pixels reach full strength early
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const cover = (Number(alpha[y * width + x]) || 0) / 255;
      if (cover >= 1) continue; // the body itself: never painted over
      let reachHere = 0;
      for (const [dx, dy, weight] of taps) {
        const qx = x + dx;
        const qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const v = ((Number(alpha[qy * width + qx]) || 0) / 255) * weight;
        if (v > reachHere) {
          reachHere = v;
          if (reachHere >= 1) break;
        }
      }
      const a = reachHere * (1 - cover);
      if (a <= 0) continue;
      const i = ((y - rect.y) * rect.w + (x - rect.x)) * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/** "#rrggbb" -> [r, g, b]; anything else is white. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Bounds of the covered pixels (for the name tag), or null for an empty mask. */
export function maskBounds(alpha: ArrayLike<number>, width: number, height: number): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
