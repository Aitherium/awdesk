/**
 * The fairy's ONE plain sentence for a decision card (owner 2026-11-23).
 *
 * Says what each answer DOES, from the card's own option consequences only --
 * never the title (it is already above), and never a consequence that merely
 * repeats its label. If no option adds anything, the sentence is empty and the
 * card shows no fairy block. The whisper's copy lives in
 * electron/fairy-attention.cjs (`fairySummary`); both are tested against the
 * same repeated-label card so they cannot drift.
 */

export interface FairyCardOption {
  key?: string;
  label?: string;
  consequence?: string;
}

export interface FairyCard {
  title?: string;
  kind?: string;
  options?: FairyCardOption[] | null;
}

/** Normalised words, for "is this consequence just the label again?". */
function plainWords(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .replace(/^(done|ok|okay|yes)\s*[-:]\s*/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function fairySummary(card: FairyCard | null | undefined): string {
  if (!card || typeof card !== 'object') return '';
  const kind = String(card.kind || '').toLowerCase();
  if (kind === 'credential') return 'It needs a secret; open it to enter it.';
  const options = Array.isArray(card.options) ? card.options.slice(0, 4) : [];
  const parts = options
    .map((o) => {
      const label = String((o && (o.label || o.key)) || '').trim().slice(0, 60);
      // The consequence's FIRST clause -- never a shorter, invented meaning.
      const clause = String((o && o.consequence) || '')
        .trim()
        .split(/[.;]\s/)[0]
        .replace(/[.;:!?]+$/, '')
        .slice(0, 140);
      const l = plainWords(label);
      const c = plainWords(clause);
      if (!c || !l) return '';
      // Same words either way (or one wholly contains the other): says nothing
      // about what the answer DOES. Drop it, never print it twice.
      if (c === l || l.includes(c) || c.startsWith(l) || l.startsWith(c)) return '';
      return `${label} — ${clause}`;
    })
    .filter(Boolean);
  return parts.length ? `${parts.join('; ')}.`.slice(0, 480) : '';
}
