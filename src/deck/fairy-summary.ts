/**
 * The fairy's ONE plain sentence for a decision card (owner 2026-11-23).
 *
 * Built only from the card's own facts -- its title and each option's label and
 * consequence -- so nothing is invented. The whisper (electron/fairy-attention.cjs
 * `fairySummary`) carries the same rule for the desk's floating card; this is the
 * copy the Inbox (aither://cards) renders above its buttons.
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

export function fairySummary(card: FairyCard | null | undefined): string {
  if (!card || typeof card !== "object") return "";
  const kind = String(card.kind || "").toLowerCase();
  const head = String(card.title || "A decision")
    .replace(/^Claude Code needs you:\s*/i, "")
    .replace(/\s*\((?:G\d+|B[1-3])\)\s*$/i, "")
    .trim()
    .replace(/[.:;!?]+$/, "");
  if (!head) return "";
  if (kind === "credential") return `${head}. It needs a secret; open it to enter it.`;
  const options = Array.isArray(card.options) ? card.options.slice(0, 4) : [];
  if (options.length === 0) return `${head}.`;
  const parts = options
    .map((o) => {
      const label = String((o && (o.label || o.key)) || "").trim().slice(0, 60);
      // The consequence's FIRST clause only -- never a shorter, invented meaning.
      const consequence = String((o && o.consequence) || "")
        .trim()
        .split(/[.;]\s/)[0]
        .replace(/[.;:!?]+$/, "")
        .slice(0, 140);
      return consequence ? `${label} — ${consequence}` : label;
    })
    .filter(Boolean);
  return `${head}. ${parts.join("; ")}.`.slice(0, 480);
}
