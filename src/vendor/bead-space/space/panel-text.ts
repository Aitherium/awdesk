// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/** The selection panel's words and timings, kept apart so the panel file exports only components. */
import type { BeadVerb, UniverseData, UniverseNode } from '../types';

/** Profile tiers, smallest first (stack_map.yaml profiles; each extends the one before). */
export const LENS_TIERS = ['business', 'platform', 'critical', 'full'] as const;
export type ProfileTier = (typeof LENS_TIERS)[number];
export type LensTier = ProfileTier | 'none';
/** universe.py ADDED_PREFIX / CORE_LABEL. */
export const ADDED_PREFIX = 'added: ';
export const CORE_LABEL = 'core: never stopped';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 812 -> "812 MB"; 3000 -> "2.9 GB". */
export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function profilesOf(node: UniverseNode): ProfileTier[] {
  const raw = node.meta?.profiles;
  const list = Array.isArray(raw) ? raw.map(String) : [];
  return LENS_TIERS.filter((t) => list.includes(t));
}

export function isCore(node: UniverseNode): boolean {
  return node.meta?.criticality === 'core';
}

/** The verbs that live in the "What it is doing" block, not the verb row. */
export function isProfileVerb(verb: BeadVerb): boolean {
  return verb.transport === 'profile';
}

/** True when the node carries anything the "What it is doing" block can say. */
export function hasDoing(node: UniverseNode): boolean {
  const m = node.meta ?? {};
  return ['role', 'criticality', 'profiles', 'kept_because', 'mem_mb', 'cpu_pct', 'disk_mb', 'dependents']
    .some((k) => m[k] !== undefined && m[k] !== null && m[k] !== '');
}

/**
 * "Tiered storage · Healthy · CPU 3% · RAM 812 MB · disk 40 MB · 35 dependents". A
 * metric that was not measured is left out -- never printed as 0.
 */
export function doingLine(node: UniverseNode): string {
  const m = node.meta ?? {};
  const parts: string[] = [];
  if (text(m.role)) parts.push(text(m.role));
  parts.push(stateSentence(node).split(' · ')[0]);
  const cpu = num(m.cpu_pct);
  if (cpu !== null) parts.push(`CPU ${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`);
  const mem = num(m.mem_mb);
  if (mem !== null) parts.push(`RAM ${formatMb(mem)}`);
  const disk = num(m.disk_mb);
  if (disk !== null) parts.push(`disk ${formatMb(disk)}`);
  const deps = num(m.dependents);
  if (deps) parts.push(`${deps} dependent${deps === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** "kept because ..." -- or the core label; '' when nothing keeps it. */
export function keptBecause(node: UniverseNode): string {
  const why = text(node.meta?.kept_because);
  if (isCore(node)) return CORE_LABEL;
  return why;
}

export interface LensSummary {
  tier: ProfileTier;
  /** svc nodes outside the tier: drawn dim, their status untouched. */
  dimIds: Set<string>;
  /** Summed measured RAM of the tier's services, and of every measured service. */
  ramMb: number;
  fleetMb: number;
  /** Services in the tier, and how many of them had a RAM reading. */
  count: number;
  measured: number;
}

/** The decision view: which services a tier keeps and what they cost. Pure. */
export function lensOf(data: UniverseData | null, tier: LensTier): LensSummary | null {
  if (!data || tier === 'none') return null;
  const dimIds = new Set<string>();
  let ramMb = 0;
  let fleetMb = 0;
  let count = 0;
  let measured = 0;
  for (const node of data.nodes) {
    if (!node.id.startsWith('svc:')) continue;
    const mem = num(node.meta?.mem_mb);
    if (mem !== null) fleetMb += mem;
    if (!profilesOf(node).includes(tier)) {
      dimIds.add(node.id);
      continue;
    }
    count += 1;
    if (mem !== null) {
      ramMb += mem;
      measured += 1;
    }
  }
  return { tier, dimIds, ramMb, fleetMb, count, measured };
}

/** "business 16.4 GB of 22.4 GB · 37 services (31 measured)". */
export function lensSentence(s: LensSummary): string {
  const ram = s.fleetMb > 0 ? `${formatMb(s.ramMb)} of ${formatMb(s.fleetMb)}` : 'RAM not measured';
  return `${s.tier} ${ram} · ${s.count} service${s.count === 1 ? '' : 's'}`
    + (s.measured < s.count ? ` (${s.measured} measured)` : '');
}

export interface LaneRow {
  lane: string;
  verdict: string;
  servedBy: string;
  latencyMs: number | null;
}

/** An inference verdict's per-lane table (fleet_verbs `inference status --json`), or []. */
export function laneRowsOf(result: unknown): LaneRow[] {
  const lanes = result && typeof result === 'object' ? (result as { lanes?: unknown }).lanes : null;
  if (!Array.isArray(lanes)) return [];
  return lanes.filter((l) => l && typeof l === 'object').slice(0, 12).map((l) => {
    const r = l as Record<string, unknown>;
    return {
      lane: text(r.lane) || text(r.model) || '?',
      verdict: text(r.verdict) || '?',
      servedBy: text(r.served_by),
      latencyMs: num(r.latency_ms),
    };
  });
}

/** Destructive verbs arm on the first click and run on a second within this window. */
export const CONFIRM_WINDOW_MS = 6000;

/**
 * A health source's reason as a phrase: "Watch: online" -> "Watch online". Sources
 * write `<who>: <what>`; behind a state word that read as "Healthy: Watch: online."
 */
export function reasonPhrase(reason: string | undefined): string {
  const text = (reason ?? '').trim().replace(/\.$/, '');
  if (!text) return '';
  // Case kept: the first word is often a service name ("ArcPlayground: Watch: offline").
  return text.replace(/:\s+/g, ' ');
}

/** One plain line about how the node is doing: "Healthy · Watch online". */
export function stateSentence(node: UniverseNode): string {
  if (node.virtual) return 'Known only from an open card';
  const h = node.health;
  const phrase = reasonPhrase(h?.reason);
  const reason = phrase ? ` · ${phrase}` : '';
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
      return `${r.ok} of ${total} healthy${bad.length ? ` · ${bad.join(', ')}` : ''}`;
    }
  }
  switch (h?.state) {
    case 'ok':
      return `Healthy${reason}`;
    case 'degraded':
      return `Degraded${reason}`;
    case 'down':
      return `Down${reason}`;
    case 'starting':
      return `Starting up${reason}`;
    case 'parked':
      return `Parked on purpose${reason}`;
    default:
      return 'Not reporting yet';
  }
}
