/**
 * Ways a drag can end that are NOT a plain pointerup (owner 2026-11-16, P0: "after a click-drag the
 * avatar keeps following the cursor after the mouse is released").
 *
 * A pointerup is lost when the transparent overlay flips setIgnoreMouseEvents while the pointer is
 * still down, when the release happens outside the window, or when the window loses focus mid-drag.
 * A drag that never hears its release follows the cursor forever. So a drag also ends on:
 *   - pointercancel / mouseup anywhere on the window (a mouseup arrives when pointerup does not),
 *   - blur and visibilitychange (the window went away),
 *   - Escape,
 *   - and any pointermove that reports NO button held: the release already happened.
 */

/** Pure: does this pointermove say the button is no longer down? */
export function releasedMidDrag(buttons: number): boolean {
  return buttons === 0;
}

/**
 * Arm the extra endings for one drag. `end` is called at most once per drag by the caller's own
 * guard; `move` is the drag's pointermove listener, wrapped so a buttonless move ends the drag.
 * Returns the disarm function.
 */
export function onDragAbort(end: () => void, move?: (event: PointerEvent) => void): () => void {
  const abort = () => end();
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') end(); };
  const onVisibility = () => { if (document.hidden) end(); };
  const onBuffered = (e: PointerEvent) => { if (e.pointerType !== 'touch' && releasedMidDrag(e.buttons)) end(); };
  window.addEventListener('pointercancel', abort);
  window.addEventListener('mouseup', abort);
  window.addEventListener('blur', abort);
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  // Capture phase: runs before the drag's own move handler and ends the drag first.
  window.addEventListener('pointermove', onBuffered, true);
  void move;
  return () => {
    window.removeEventListener('pointercancel', abort);
    window.removeEventListener('mouseup', abort);
    window.removeEventListener('blur', abort);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pointermove', onBuffered, true);
  };
}
