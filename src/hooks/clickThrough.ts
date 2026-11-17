/**
 * Click-through for the avatar window (customer report, 2026-10-20: "the side bar with the alert
 * thing really does just block my input to my applications").
 *
 * The avatar window is a 600x950 transparent, always-on-top rectangle. Before this it
 * caught EVERY click inside that rectangle, painted or not, so the apps under its empty
 * pixels were unreachable and the beads rail read as a wall. Now the window passes
 * clicks through (main: setIgnoreMouseEvents(true, {forward:true})) except where
 * something is drawn: a DOM control (beads, bubbles, hint, drag strip) or an avatar
 * body (Scene's onPointerOver/Out raycast). Forwarded mouse moves keep both checks live
 * while the window is ignoring.
 *
 * Fail-interactive: the window starts clickable and stays that way until this module
 * has reported once, so a renderer that never loads cannot leave a ghost window.
 */

import { hasPicker, pickAt, setHover } from './avatarPick';

let overAvatar = 0;
let lastSent: boolean | null = null;

type Bridge = { setInteractive?: (interactive: boolean) => void };

function bridge(): Bridge | undefined {
  return (window as unknown as { deskBridge?: Bridge }).deskBridge;
}

/** Elements that are only a backdrop: a pointer over them is over nothing drawn. */
export function isBackdrop(el: Element | null): boolean {
  if (!el) return true;
  const tag = el.tagName;
  if (tag === 'HTML' || tag === 'BODY' || tag === 'CANVAS' || tag === 'MAIN') return true;
  // R3F wraps the canvas in two plain divs; they are as empty as the canvas.
  return !!el.querySelector?.(':scope > canvas') || !!el.querySelector?.(':scope > div > canvas');
}

/**
 * Owner 2026-11-02: "their hit boxes extend way beyond their bodies instead of just
 * being their bodies". The grab proxy (Scene.tsx) is a 1.8 x 2.1 box -- cheap to
 * raycast, much wider than a body. So "over an avatar" now also needs the pixel
 * under the pointer to be PAINTED: a 5x5 alpha probe of the last frame. null means
 * the probe could not run (no GL) and the box alone decides, as before.
 */
export function paintedAt(clientX: number, clientY: number): boolean | null {
  const canvas = document.querySelector('canvas');
  if (!canvas) return null;
  const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
  if (!gl) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const r = 2;
  const x = Math.round((clientX - rect.left) * sx) - r;
  const y = Math.round(canvas.height - (clientY - rect.top) * sy) - r;
  if (x + r < 0 || y + r < 0 || x - r >= canvas.width || y - r >= canvas.height) return false;
  const size = r * 2 + 1;
  const px = new Uint8Array(size * size * 4);
  try {
    gl.readPixels(Math.max(0, x), Math.max(0, y), size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  } catch {
    return null;
  }
  return alphaHit(px);
}

/** Pure, unit-tested: any probed pixel opaque enough to be the body. */
export function alphaHit(rgba: ArrayLike<number>, threshold = 24): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > threshold) return true;
  return false;
}

/** Pure decision, unit-tested: interactive while a button is held (a drag in flight
 *  must never lose its window), over an avatar, or over a non-backdrop element. */
export function decideInteractive(opts: { buttons: number; overAvatar: boolean; backdrop: boolean }): boolean {
  return opts.buttons !== 0 || opts.overAvatar || !opts.backdrop;
}

/** Pure decision, unit-tested: which events close the open gestures help (components/Beads.tsx).
 *  It is a popover, one at a time (owner screenshot 2026-11-16: it stayed open under the Inbox,
 *  its text cut mid-word). Esc; a press anywhere outside it -- a bead, a body, the canvas --
 *  except on the "?" bead, which toggles it; and the window losing focus (another popup, or any
 *  app, took it). */
export function hintClosesOn(e: { type: string; key?: string; insideHint?: boolean; onToggle?: boolean }): boolean {
  if (e.type === 'keydown') return e.key === 'Escape';
  if (e.type === 'pointerdown') return !e.insideHint && !e.onToggle;
  return e.type === 'blur';
}

function report(interactive: boolean) {
  if (interactive === lastSent) return;
  lastSent = interactive;
  try { bridge()?.setInteractive?.(interactive); } catch { /* window closing */ }
}

/** Kept for callers that still announce a body under the pointer; the pick decides now. */
export function avatarPointerOver() { overAvatar += 1; report(true); }
export function avatarPointerOut() { overAvatar = Math.max(0, overAvatar - 1); }

/** Install once per avatar window. Returns the cleanup. */
export function installClickThrough(): () => void {
  if (!bridge()?.setInteractive) return () => {};
  let pending: { x: number; y: number; buttons: number } | null = null;
  let frame = 0;
  // One pick per animation frame at most: the id render is cheap but not free.
  const evaluate = () => {
    frame = 0;
    const m = pending;
    pending = null;
    if (!m) return;
    const backdrop = isBackdrop(document.elementFromPoint(m.x, m.y));
    if (m.buttons !== 0) {
      // A drag in flight must never lose its window.
      report(true);
      return;
    }
    let onBody: boolean;
    if (hasPicker()) {
      // The pixel under the pointer, and WHOSE it is: a gap between bodies is nobody's.
      const slot = pickAt(m.x, m.y);
      setHover(slot);
      document.body.style.cursor = slot ? 'grab' : '';
      onBody = slot !== null;
    } else {
      // No GL picker (a solo window, a failed context): the old proxy box + alpha probe.
      onBody = overAvatar > 0 && paintedAt(m.x, m.y) !== false;
    }
    report(decideInteractive({ buttons: 0, overAvatar: onBody, backdrop }));
  };
  const onMove = (e: PointerEvent | MouseEvent) => {
    pending = { x: e.clientX, y: e.clientY, buttons: e.buttons };
    if (!frame) frame = window.requestAnimationFrame(evaluate);
  };
  // Leaving the window entirely: nothing of ours is under the cursor.
  const onLeave = () => { overAvatar = 0; setHover(null); document.body.style.cursor = ''; report(false); };
  window.addEventListener('mousemove', onMove, true);
  document.documentElement.addEventListener('mouseleave', onLeave);
  return () => {
    window.removeEventListener('mousemove', onMove, true);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    lastSent = null;
    try { bridge()?.setInteractive?.(true); } catch { /* closing */ }
  };
}
