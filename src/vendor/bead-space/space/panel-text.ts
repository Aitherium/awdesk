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
  /** Things in the tier, and how many of them had a RAM reading. */
  count: number;
  measured: number;
  /**
   * 'containers' when the figures are galaxy:fleet `tier_ram` -- every container the
   * tier's sidecar keeps, the same set `llm-quiesce-distro.py profile` keeps (Postgres,
   * the tunnel, DNS, the Genesis pair included). 'services' when only the beads' own
   * readings were available, which leaves out every unit no services.yaml bead carries.
   */
  noun: 'containers' | 'services';
}

interface TierRam {
  mb: number;
  measured: number;
  containers: number;
}

/** galaxy:fleet meta.tier_ram[tier] + meta.fleet_ram_mb, when universe.py measured them. */
function applySetRam(data: UniverseData, tier: ProfileTier): (TierRam & { fleetMb: number }) | null {
  const fleet = data.nodes.find((n) => n.id === 'galaxy:fleet');
  const all = fleet?.meta?.tier_ram;
  const row = all && typeof all === 'object' ? (all as Record<string, unknown>)[tier] : null;
  const fleetMb = num(fleet?.meta?.fleet_ram_mb);
  if (!row || typeof row !== 'object' || fleetMb === null) return null;
  const r = row as Record<string, unknown>;
  const mb = num(r.mb);
  const measured = num(r.measured);
  const containers = num(r.containers);
  if (mb === null || measured === null || containers === null) return null;
  return { mb, measured, containers, fleetMb };
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
  const apply = applySetRam(data, tier);
  if (apply) {
    return { tier, dimIds, ramMb: apply.mb, fleetMb: apply.fleetMb, count: apply.containers,
      measured: apply.measured, noun: 'containers' };
  }
  return { tier, dimIds, ramMb, fleetMb, count, measured, noun: 'services' };
}

/** "business 16.4 GB of 22.4 GB · 43 containers (40 measured)". */
export function lensSentence(s: LensSummary): string {
  const ram = s.fleetMb > 0 ? `${formatMb(s.ramMb)} of ${formatMb(s.fleetMb)}` : 'RAM not measured';
  const noun = s.count === 1 ? s.noun.slice(0, -1) : s.noun;
  return `${s.tier} ${ram} · ${s.count} ${noun}`
    + (s.measured < s.count ? ` (${s.measured} measured)` : '');
}

/**
 * The fleet audit's verdicts (AitherOS/dev/tools/fleet_audit.py via universe.py), worst
 * first: a parent planet shows the worst verdict under it.
 */
export const AUDIT_VERDICTS = [
  'breaking', 'crashed', 'dead', 'waste', 'trim-candidate', 'parked', 'business', 'core',
] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

/** One colour per verdict -- none of them the ask gold. */
export const VERDICT_COLORS: Record<AuditVerdict, string> = {
  breaking: '#FF4D4F',
  crashed: '#FF922B',
  dead: '#ADB5BD',
  waste: '#DA77F2',
  'trim-candidate': '#FFE066',
  parked: '#495057',
  business: '#4DABF7',
  core: '#69DB7C',
};

/** The verdict as the owner reads it. */
export const VERDICT_WORDS: Record<AuditVerdict, string> = {
  breaking: 'Breaking: something running misses it',
  crashed: 'Crashed',
  dead: 'Dead: a leftover nothing runs',
  waste: 'Waste: serves nothing',
  'trim-candidate': 'Trim candidate',
  parked: 'Parked',
  business: 'Kept by business',
  core: 'Core: never stopped',
};

export function verdictOf(node: UniverseNode | null | undefined): AuditVerdict | null {
  const v = node?.meta?.verdict;
  return typeof v === 'string' && (AUDIT_VERDICTS as readonly string[]).includes(v)
    ? (v as AuditVerdict) : null;
}

/** "Trim candidate · frees 99 MB · 6 requests in 13 h" -- what was not measured is left out. */
export function auditLine(node: UniverseNode): string {
  const v = verdictOf(node);
  if (!v) return '';
  const m = node.meta ?? {};
  const parts: string[] = [VERDICT_WORDS[v]];
  const frees = num(m.frees_mb);
  if (frees !== null && frees > 0) parts.push(`frees ${formatMb(frees)}`);
  const req = num(m.requests);
  const hours = num(m.log_hours);
  if (req !== null) {
    const window = hours === null ? '' : hours >= 1 ? ` in ${Math.round(hours)} h` : ' in <1 h';
    parts.push(`${req} request${req === 1 ? '' : 's'}${window}`);
  }
  const mem = num(m.mem_mb);
  if (mem !== null && frees === null) parts.push(`RAM ${formatMb(mem)}`);
  return parts.join(' · ');
}

export interface AuditSummary {
  headline: string;
  running: number | null;
  ramMb: number | null;
  freesMb: number | null;
  byVerdict: Partial<Record<AuditVerdict, number>>;
  generatedAt: string;
  logsScanned: boolean;
}

/** galaxy:fleet meta.audit, or null when the universe carries no audit. */
export function auditSummaryOf(data: UniverseData | null): AuditSummary | null {
  const fleet = data?.nodes.find((n) => n.id === 'galaxy:fleet');
  const raw = fleet?.meta?.audit;
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const by: Partial<Record<AuditVerdict, number>> = {};
  const rawBy = a.by_verdict && typeof a.by_verdict === 'object' ? (a.by_verdict as Record<string, unknown>) : {};
  for (const v of AUDIT_VERDICTS) {
    const n = num(rawBy[v]);
    if (n) by[v] = n;
  }
  return {
    headline: text(a.headline),
    running: num(a.running),
    ramMb: num(a.ram_mb),
    freesMb: num(a.frees_mb),
    byVerdict: by,
    generatedAt: text(a.generated_at),
    logsScanned: a.logs_scanned === true,
  };
}

/** "56 running · 19.9 GB · trim frees 3.2 GB · measured 12 min ago". */
export function auditSentence(s: AuditSummary, nowMs: number = Date.now()): string {
  const head = s.running !== null && s.ramMb !== null
    ? `${s.running} running · ${formatMb(s.ramMb)} · trim frees ${formatMb(s.freesMb ?? 0)}`
    : s.headline || 'audit not measured';
  const at = Date.parse(s.generatedAt);
  if (!Number.isFinite(at)) return head;
  const mins = Math.max(0, Math.round((nowMs - at) / 60000));
  const age = mins < 1 ? 'just now' : mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return `${head} · measured ${age}`;
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
