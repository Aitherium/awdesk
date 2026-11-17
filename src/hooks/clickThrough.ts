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

import { hasPicker, PICK_SLOP_PX, pickNear, setHover } from './avatarPick';

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

/**
 * The window's click-through switch, GL-free and unit-tested (clickThrough.test.ts).
 *
 * Owner 2026-11-16, P0: a right-click on the avatar's head and shoulders opened the plain Windows
 * desktop menu. The window only re-decided on a MOUSE MOVE, but the body moves on its own: the idle
 * sways the head and shoulders under a cursor that is standing still. A cursor that last moved over
 * a gap stayed "click-through" while the shoulder swayed under it, and the press went to the desktop.
 * And a mouseleave dropped the window to click-through outright, though the OS sends one whenever the
 * window flips its own hit-testing while the cursor rests on the body. So now:
 *   - a resting cursor is re-decided on a short clock (`tick`), not only when it moves;
 *   - the decision has a few pixels of slack round the body (pickNear, PICK_SLOP_PX);
 *   - a leave clears the hover but never makes the window click-through by itself (a window that
 *     stays clickable after the cursor really left covers nothing: the next move into it re-decides);
 *   - a held button always keeps the window (a drag or a press in flight).
 */
export interface ClickThroughDeps {
  /** The body under (or within the slack of) a point, or null. */
  bodyAt(x: number, y: number): string | null;
  /** Is the element under the point only a backdrop (canvas, body, wrappers)? */
  backdropAt(x: number, y: number): boolean;
  report(interactive: boolean): void;
  hover?(slot: string | null): void;
}

export function createClickThroughController(deps: ClickThroughDeps) {
  let last: { x: number; y: number } | null = null;
  let held = false;
  const decide = () => {
    if (!last) return;
    if (held) { deps.report(true); return; }
    const slot = deps.bodyAt(last.x, last.y);
    deps.hover?.(slot);
    deps.report(decideInteractive({ buttons: 0, overAvatar: slot !== null, backdrop: deps.backdropAt(last.x, last.y) }));
  };
  return {
    /** A pointer move (forwarded while the window ignores the mouse, real otherwise). */
    move(x: number, y: number, buttons: number) {
      last = { x, y };
      held = buttons !== 0;
      decide();
    },
    /** A button went down / every button came up. */
    press(down: boolean) {
      held = down;
      if (down) deps.report(true);
    },
    /** The clock: the body may have moved under a cursor that did not. */
    tick() {
      if (!held) decide();
    },
    /** The pointer left the window (or the OS says so while the window flips): hover only. */
    leave() {
      deps.hover?.(null);
    },
  };
}

/** How often a resting cursor is re-decided (the idle sways a shoulder ~10 px a second). */
export const RESTING_RECHECK_MS = 120;

/** Install once per avatar window. Returns the cleanup. */
export function installClickThrough(): () => void {
  if (!bridge()?.setInteractive) return () => {};
  const control = createClickThroughController({
    bodyAt: (x, y) => {
      if (hasPicker()) return pickNear(x, y, PICK_SLOP_PX);
      // No GL picker (a solo window, a failed context): the old proxy box + alpha probe.
      return overAvatar > 0 && paintedAt(x, y) !== false ? 'body' : null;
    },
    backdropAt: (x, y) => isBackdrop(document.elementFromPoint(x, y)),
    report,
    hover: (slot) => {
      if (!hasPicker()) return;
      setHover(slot);
      document.body.style.cursor = slot ? 'grab' : '';
    },
  });
  let pending: { x: number; y: number; buttons: number } | null = null;
  let frame = 0;
  // One pick per animation frame at most: the id render is cheap but not free.
  const evaluate = () => {
    frame = 0;
    const m = pending;
    pending = null;
    if (m) control.move(m.x, m.y, m.buttons);
  };
  const onMove = (e: PointerEvent | MouseEvent) => {
    pending = { x: e.clientX, y: e.clientY, buttons: e.buttons };
    if (!frame) frame = window.requestAnimationFrame(evaluate);
  };
  const onDown = () => control.press(true);
  const onUp = (e: MouseEvent) => { if (e.buttons === 0) control.press(false); };
  const onLeave = () => { overAvatar = 0; control.leave(); };
  const clock = window.setInterval(() => {
    if (!document.hidden && !pending) control.tick();
  }, RESTING_RECHECK_MS);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('mouseup', onUp, true);
  document.documentElement.addEventListener('mouseleave', onLeave);
  return () => {
    window.clearInterval(clock);
    if (frame) window.cancelAnimationFrame(frame);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('mouseup', onUp, true);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    lastSent = null;
    try { bridge()?.setInteractive?.(true); } catch { /* closing */ }
  };
}
