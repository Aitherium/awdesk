/**
 * Click-through for the avatar window (garg, 2026-10-20: "the side bar with the alert
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

/** Pure decision, unit-tested: interactive while a button is held (a drag in flight
 *  must never lose its window), over an avatar, or over a non-backdrop element. */
export function decideInteractive(opts: { buttons: number; overAvatar: boolean; backdrop: boolean }): boolean {
  return opts.buttons !== 0 || opts.overAvatar || !opts.backdrop;
}

function report(interactive: boolean) {
  if (interactive === lastSent) return;
  lastSent = interactive;
  try { bridge()?.setInteractive?.(interactive); } catch { /* window closing */ }
}

/** Scene calls these from each avatar's onPointerOver / onPointerOut. */
export function avatarPointerOver() { overAvatar += 1; report(true); }
export function avatarPointerOut() { overAvatar = Math.max(0, overAvatar - 1); }

/** Install once per avatar window. Returns the cleanup. */
export function installClickThrough(): () => void {
  if (!bridge()?.setInteractive) return () => {};
  const onMove = (e: PointerEvent | MouseEvent) => {
    const backdrop = isBackdrop(document.elementFromPoint(e.clientX, e.clientY));
    report(decideInteractive({ buttons: e.buttons, overAvatar: overAvatar > 0, backdrop }));
  };
  // Leaving the window entirely: nothing of ours is under the cursor.
  const onLeave = () => { overAvatar = 0; report(false); };
  window.addEventListener('mousemove', onMove, true);
  document.documentElement.addEventListener('mouseleave', onLeave);
  return () => {
    window.removeEventListener('mousemove', onMove, true);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    lastSent = null;
    try { bridge()?.setInteractive?.(true); } catch { /* closing */ }
  };
}
