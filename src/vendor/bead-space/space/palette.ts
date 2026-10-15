// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/**
 * The space palette. BINDING: both renderers and the HUD read colours from here only.
 */
import type { BeadHealthState } from '../types';

export const PALETTE = {
  void: '#000103',
  surface: '#02060D',
  raised: '#040C15',
  hairline: '#162330',
  /** Selection, links, the Aither ship, Explore. */
  aitherium: '#2AD7D7',
  healthy: '#70DDB1',
  /** Needs you. */
  gold: '#EAB532',
  /** Urgent. */
  forge: '#FF8950',
  /** Down, destructive. */
  danger: '#FF9189',
  quiet: '#69737D',
  haze: '#1A83DB',
  ink: '#E6EEF5',
  galaxyTints: ['#9FD8FF', '#D8C8FF', '#FFB3E6', '#C8FFD4', '#FFE9A8', '#A8ECFF'],
} as const;

export const FONTS = {
  name: '"Inter", system-ui, sans-serif',
  nameWeight: 300,
  metric: '"JetBrains Mono", ui-monospace, monospace',
} as const;

/** Body colour for a health state. `unknown` is drawn hollow in quiet grey, never green. */
export function healthColor(state: BeadHealthState | undefined): string {
  switch (state) {
    case 'ok':
      return PALETTE.healthy;
    case 'degraded':
      return PALETTE.forge;
    case 'down':
      return PALETTE.danger;
    case 'starting':
      return PALETTE.galaxyTints[5];
    case 'parked':
      return PALETTE.quiet;
    default:
      return PALETTE.quiet;
  }
}

/** Drawn as a wireframe instead of a solid body. */
export function isHollow(state: BeadHealthState | undefined): boolean {
  return state == null || state === 'unknown';
}

/** Drawn dim. */
export function isQuiet(state: BeadHealthState | undefined): boolean {
  return state === 'parked';
}

/** Stable tint for a galaxy by its position among the root's children. */
export function galaxyTint(index: number): string {
  const tints = PALETTE.galaxyTints;
  return tints[((index % tints.length) + tints.length) % tints.length];
}

/** `#RRGGBB` → [r, g, b] in 0..1 (sRGB, not linearised). */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
