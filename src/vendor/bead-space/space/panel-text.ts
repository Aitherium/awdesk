// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/** The selection panel's words and timings, kept apart so the panel file exports only components. */
import type { UniverseNode } from '../types';

/** Destructive verbs arm on the first click and run on a second within this window. */
export const CONFIRM_WINDOW_MS = 6000;

/** One plain sentence about how the node is doing. */
export function stateSentence(node: UniverseNode): string {
  if (node.virtual) return 'Known only from an open card.';
  const h = node.health;
  const reason = h?.reason ? `: ${h.reason}` : '';
  const r = h?.rollup;
  if (r) {
    const total = r.ok + r.degraded + r.down + r.starting + r.unknown;
    if (total > 0) {
      const bad = [
        r.down ? `${r.down} down` : '',
        r.degraded ? `${r.degraded} degraded` : '',
        r.starting ? `${r.starting} starting` : '',
        r.unknown ? `${r.unknown} not reporting` : '',
      ].filter(Boolean);
      return `${r.ok} of ${total} healthy${bad.length ? `, ${bad.join(', ')}` : ''}.`;
    }
  }
  switch (h?.state) {
    case 'ok':
      return `Healthy${reason}.`;
    case 'degraded':
      return `Degraded${reason}.`;
    case 'down':
      return `Down${reason}.`;
    case 'starting':
      return `Starting up${reason}.`;
    case 'parked':
      return `Parked on purpose${reason}.`;
    default:
      return 'No source has reported on this yet.';
  }
}
