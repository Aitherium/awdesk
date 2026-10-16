/**
 * The REAL bead-space engine: @aitherium/bead-space's createBeadSpace (d3-force + d3-zoom
 * + the Kenney sprites), the one renderer Veil's universe and the tunnel pages use.
 *
 * The desk cannot import the monorepo package (it ships from the public awdesk fork and
 * has no d3), so vendor_bead_space.py copies the package's own browser build -- an IIFE
 * with d3 bundled that defines the global `BeadSpace` -- into src/vendor/bead-space/engine.
 * Vite emits it as an asset (`?url`) and this module loads it once with a script tag
 * (CSP script-src 'self'). The sprites are public/bead-space/kenney-simple-space (CC0).
 */
import engineUrl from '../vendor/bead-space/engine/bead-space.iife.js?url';
import '../vendor/bead-space/engine/bead-space.css';
import type { BeadData, BeadSpaceHandle, BeadSpaceOptions } from '../vendor/bead-space/types';

export interface BeadSpaceEngine {
  createBeadSpace(container: HTMLElement, data: BeadData, options?: BeadSpaceOptions): BeadSpaceHandle;
}

declare global {
  interface Window {
    BeadSpace?: BeadSpaceEngine;
  }
}

/** Relative to the document, so it works from file:// (the built desk) and the dev server. */
export const SPRITE_ROOT = './bead-space/kenney-simple-space';

let loading: Promise<BeadSpaceEngine> | null = null;

export function loadBeadSpace(): Promise<BeadSpaceEngine> {
  if (typeof window !== 'undefined' && window.BeadSpace) return Promise.resolve(window.BeadSpace);
  if (loading) return loading;
  loading = new Promise<BeadSpaceEngine>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = engineUrl;
    script.async = true;
    script.dataset.beadSpace = 'engine';
    script.onload = () => {
      if (window.BeadSpace && typeof window.BeadSpace.createBeadSpace === 'function') resolve(window.BeadSpace);
      else reject(new Error('the bead-space engine loaded but defined no BeadSpace'));
    };
    script.onerror = () => reject(new Error('the bead-space engine did not load'));
    document.head.appendChild(script);
  }).catch((err) => {
    loading = null; // a later mount may retry
    throw err;
  });
  return loading;
}
