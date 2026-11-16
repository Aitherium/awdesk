/**
 * Per-body viseme overrides, OUTSIDE React (same reasoning as voiceLevels.ts: a mouth
 * shape is a per-frame signal, not UI state).
 *
 * The swarm API's `visemes(agentId, weights)` -- driven by whoever owns real-time voice
 * and lip sync -- lands here. While a body has a FRESH override (set within `ttlMs`), its
 * mouth is those five VRM shapes exactly; when it lapses (or the driver sends `null`) the
 * body falls back to the amplitude lip sync, so a driver that dies mid-word leaves a body
 * that talks from the audio level, never one frozen with its mouth open.
 */

export const VISEME_NAMES = ['aa', 'ee', 'ih', 'oh', 'ou'] as const;
export type VisemeName = (typeof VISEME_NAMES)[number];
export type VisemeWeights = Record<VisemeName, number>;

/** A driver that streams frames refreshes the override every ~30 ms; 250 ms is a lapse. */
export const DEFAULT_TTL_MS = 250;
const MAX_TTL_MS = 5000;

interface Entry {
  weights: VisemeWeights;
  until: number;
}

const entries = new Map<string, Entry>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clamp01(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** Sanitise an arbitrary payload into the five weights (anything missing is 0). */
export function sanitizeVisemes(raw: unknown): VisemeWeights {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { aa: clamp01(src.aa), ee: clamp01(src.ee), ih: clamp01(src.ih), oh: clamp01(src.oh), ou: clamp01(src.ou) };
}

/** Set (or, with null, release) a body's mouth shape. */
export function setVisemes(slotId: string, weights: unknown | null, ttlMs: number = DEFAULT_TTL_MS): void {
  if (weights === null || weights === undefined) {
    entries.delete(slotId);
    return;
  }
  const ttl = Math.max(16, Math.min(MAX_TTL_MS, Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : DEFAULT_TTL_MS));
  entries.set(slotId, { weights: sanitizeVisemes(weights), until: now() + ttl });
}

/** The live override for a body, or null when there is none or it has lapsed. */
export function getVisemes(slotId: string): VisemeWeights | null {
  const entry = entries.get(slotId);
  if (!entry) return null;
  if (now() > entry.until) {
    entries.delete(slotId);
    return null;
  }
  return entry.weights;
}

export function clearVisemes(slotId: string): void {
  entries.delete(slotId);
}

/** Test seam. */
export function resetVisemes(): void {
  entries.clear();
}
