/**
 * The agent fairy for the deck: which colours an agent's avatar mark wears.
 *
 * Owner, 2026-11-09: every agent is a fairy in its Order colour -- on Discord, on
 * the desk and on aitherium.com. The palette is ONE file
 * (electron/agent-fairies.json, byte-identical to AitherOS/config/agent-fairies.json);
 * electron/agent-fairy.cjs reads it for the desk fairy, this reads it for the deck.
 */
import palette from '../../electron/agent-fairies.json';

export interface AgentFairy {
  agent: string;
  label: string;
  color: string;
  core: string;
  glow: string;
  wings: 'petal' | 'swept';
  ring: boolean;
  sparkles: boolean;
  /** false = not an agent with its own fairy (the default Aither fairy is returned). */
  known: boolean;
}

interface PaletteEntry {
  label?: string;
  color?: string;
  core?: string;
  glow?: string;
  wings?: string;
  ring?: boolean;
  sparkles?: boolean;
}

const AGENTS = (palette as { agents?: Record<string, PaletteEntry> }).agents ?? {};
const ALIASES = (palette as { aliases?: Record<string, string> }).aliases ?? {};
const DEFAULT = (palette as { default?: string }).default ?? 'aither';
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Same rule as agent-fairy.cjs normalizeAgent: the name, an alias, else the first word naming an agent. */
export function normalizeAgent(name: string | null | undefined): string {
  const raw = String(name ?? '').trim().toLowerCase();
  if (!raw) return '';
  const direct = ALIASES[raw] ?? raw;
  if (AGENTS[direct]) return direct;
  for (const word of raw.split(/[^a-z0-9]+/).filter(Boolean)) {
    const key = ALIASES[word] ?? word;
    if (AGENTS[key]) return key;
  }
  return '';
}

function hex(value: string | undefined, fallback: string): string {
  return value && HEX_RE.test(value) ? value.toLowerCase() : fallback;
}

export function fairyFor(name: string | null | undefined): AgentFairy {
  const key = normalizeAgent(name);
  const entry = AGENTS[key || DEFAULT] ?? {};
  const color = hex(entry.color, '#38bdf8');
  return {
    agent: key || DEFAULT,
    label: entry.label ?? (key || DEFAULT),
    color,
    core: hex(entry.core, '#ffffff'),
    glow: hex(entry.glow, color),
    wings: entry.wings === 'swept' ? 'swept' : 'petal',
    ring: entry.ring === true,
    sparkles: entry.sparkles === true,
    known: Boolean(key),
  };
}

/** "#38bdf8" + 0.4 -> "rgba(56,189,248,0.4)". */
export function rgba(hexColor: string, alpha: number): string {
  const n = parseInt(hexColor.replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
