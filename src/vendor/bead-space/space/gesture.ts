// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * The 2D engine's zoom rule, restated here so `./space` does not pull the d3 engine in:
 * a plain wheel scrolls the page, Ctrl/Cmd+wheel (and a trackpad pinch, which arrives
 * as a ctrlKey wheel) zooms; a drag rotates unless it is a right/middle button or Ctrl.
 * test/space-scene.ts pins it equal to `zoomGestureAllowed` in core/bead-space.ts.
 */
export function spaceGestureAllowed(event: {
  type: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  button?: number;
}): boolean {
  if (event.type === 'wheel') return Boolean(event.ctrlKey || event.metaKey);
  return !event.ctrlKey && !event.button;
}

/** 600 ms ease-out (cubic). */
export const FLY_MS = 600;

export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

/** WebGL is available here (the probe context is released at once). */
export function hasWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
    // Hand the probe context straight back: browsers cap live contexts per page.
    ctx?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(ctx);
  } catch {
    return false;
  }
}
