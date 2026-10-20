/**
 * injury-view — a character's injuries, as ONE viewer may see them, right now.
 *
 * SHARED FILE. Byte-identical copies live at
 *   .DEPLOYMENT/awdesk/src/injuries/injury-view.ts              (the desk avatar)
 *   AitherOS/apps/AitherVeil/src/lib/avatar/injury-view.ts      (the Veil persona card + viewer)
 * and AitherOS/dev/tools/check_injury_view_parity.py (IVP001) fails when they drift. Edit both.
 *
 * INPUT: the awavatar character_spec `injuries` object (AitherOS/packages/awavatar schemas.py
 * `_injury_problems`), as Dark Matters exports it (engine/src/render/injuryExport.ts): the TRUE
 * kind / severity / region / bandaged / healed of every wound, the severed and broken parts, healed
 * scars, blood and grime, worded at the export's `tier`, plus `descriptors_by_tier` and the
 * timestamps `as_of` + per-wound `heal_days`.
 *
 * TWO CLAMPS, both only ever DOWN:
 *   1. the export's own tier (a pg export carries no blood to show), and
 *   2. the VIEWER's tier, from the platform adult-content gate (viewerInjuryTier). A closed gate,
 *      a missing gate, an unreadable gate are all pg. This module never opens anything.
 * At pg a wound is still SHOWN — bandages, bruise-dark marks sized by its true severity, scars, a
 * covered stump, a splint — just never red. Blood and open wounds need the blood tier; a raw stump
 * needs gore.
 *
 * TIME: the body heals while it is away from the game. From `as_of` to `now` each wound closes at
 * its exported `heal_days`; a closed wound of severity >= 2 (or a burn, fracture, stump) leaves a
 * scar; bleeding stops after BLEED_STOP_HOURS; loose blood and grime fade at the engine's rates.
 * An export with no `as_of` is shown exactly as exported (no invented clock).
 *
 * Pure: no DOM, no three.js, no network, no clock read unless `now` is omitted.
 */

export type InjuryTier = 'pg' | 'blood' | 'gore';
export type InjuryRegion = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';
export type WoundKind = 'cut' | 'stab' | 'bite' | 'lash' | 'bruise' | 'burn' | 'fracture' | 'stump';

export const INJURY_TIERS: readonly InjuryTier[] = ['pg', 'blood', 'gore'];
export const INJURY_REGIONS: readonly InjuryRegion[] = ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
const KINDS: readonly WoundKind[] = ['cut', 'stab', 'bite', 'lash', 'bruise', 'burn', 'fracture', 'stump'];

export interface InjuryWound {
  region: InjuryRegion;
  kind: WoundKind;
  severity: 1 | 2 | 3;
  bleeding: boolean;
  bandaged: boolean;
  healed: number;
  heal_days?: number;
}

export interface InjurySpec {
  tier: InjuryTier;
  wounds: InjuryWound[];
  severed: string[];
  broken: string[];
  scars: { region: InjuryRegion; kind: WoundKind }[];
  blood: number;
  grime: number;
  limp: string;
  signature: string;
  descriptors: string[];
  descriptors_by_tier: Partial<Record<InjuryTier, string[]>>;
  as_of: string | null;
}

export type Missing = '' | 'hand' | 'forearm' | 'arm' | 'foot' | 'calf' | 'leg';
export type StumpLook = '' | 'covered' | 'bandaged' | 'bloody' | 'raw' | 'healed';

export interface RegionView {
  bandage: boolean;
  /** 0..3 bruise-dark shading (any tier; at pg an unbound open wound shows as this, sized by severity). */
  bruise: number;
  /** 0..3 red staining (0 at pg). */
  blood: number;
  /** 0..3 open-wound depiction (0 at pg; capped at 2 below gore). */
  open: number;
  /** 0..3 burn marking. */
  burn: number;
  scar: number;
  broken: boolean;
  splinted: boolean;
  missing: Missing;
  stump: StumpLook;
}

export interface InjuryView {
  tier: InjuryTier;
  regions: Record<InjuryRegion, RegionView>;
  /** 0..100 loose blood on the body (0 at pg). */
  blood: number;
  grime: number;
  limp: '' | 'left' | 'right' | 'both';
  /** VRM humanoid bones to collapse: the top severed bone of each lost limb. */
  severedBones: string[];
  descriptors: string[];
  /** Wounds still open now / closed since the export. */
  open: number;
  closed: number;
  any: boolean;
  /** Stable key for memoisation (changes when anything drawn changes). */
  key: string;
}

/** Hours after export a still-bleeding wound is assumed to have clotted or been bound. */
export const BLEED_STOP_HOURS = 12;
const MAX_BYTES = 16 * 1024;
const TIER_RANK: Record<InjuryTier, number> = { pg: 0, blood: 1, gore: 2 };

export function minTier(a: InjuryTier, b: InjuryTier): InjuryTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * The tier a viewer may see. `adultContentVisible` is the PLATFORM gate (opt-in AND age-verified,
 * as the server judged it, or the desk's ~/.aither/adult_content.json mirror) — closed = pg.
 * `maxRating` (the desk's own ceiling) and `explicitAllowed` (the live safety plane) only tighten.
 */
export function viewerInjuryTier(o: {
  adultContentVisible: boolean;
  maxRating?: string | null;
  explicitAllowed?: boolean | null;
}): InjuryTier {
  if (o.adultContentVisible !== true) return 'pg';
  const max = String(o.maxRating ?? 'r18').toLowerCase();
  if (max === 'general' || max === 'g' || max === 'pg') return 'pg';
  if (max === 'r15' || o.explicitAllowed === false) return 'blood';
  return 'gore';
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const strs = (v: unknown, cap = 32): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 300).slice(0, cap) : [];

/**
 * Structural read, fail-closed: anything that is not an injuries object is null, an unknown tier is
 * null, unknown regions/kinds are dropped, and a pg export cannot smuggle blood or bleeding in.
 */
export function parseInjuries(raw: unknown): InjurySpec | null {
  if (!isObj(raw)) return null;
  try {
    if (JSON.stringify(raw).length > MAX_BYTES) return null;
  } catch {
    return null;
  }
  const tier = raw.tier as InjuryTier;
  if (!INJURY_TIERS.includes(tier)) return null;
  const wounds: InjuryWound[] = [];
  for (const w of Array.isArray(raw.wounds) ? raw.wounds.slice(0, 32) : []) {
    if (!isObj(w)) continue;
    const region = w.region as InjuryRegion;
    const kind = w.kind as WoundKind;
    const severity = w.severity;
    if (!INJURY_REGIONS.includes(region) || !KINDS.includes(kind)) continue;
    if (severity !== 1 && severity !== 2 && severity !== 3) continue;
    const hd = num(w.heal_days, -1);
    wounds.push({
      region,
      kind,
      severity,
      bleeding: tier !== 'pg' && w.bleeding === true,
      bandaged: w.bandaged === true,
      healed: clamp(num(w.healed), 0, 1),
      ...(hd >= 0 ? { heal_days: Math.min(hd, 365) } : {}),
    });
  }
  const scars = (Array.isArray(raw.scars) ? raw.scars.slice(0, 32) : [])
    .filter((m): m is { region: InjuryRegion; kind: WoundKind } =>
      isObj(m) && INJURY_REGIONS.includes(m.region as InjuryRegion) && KINDS.includes(m.kind as WoundKind))
    .map((m) => ({ region: m.region, kind: m.kind }));
  const byTier: Partial<Record<InjuryTier, string[]>> = {};
  if (isObj(raw.descriptors_by_tier)) {
    for (const t of INJURY_TIERS) {
      if (TIER_RANK[t] > TIER_RANK[tier]) continue; // never above the export's own tier
      const list = strs(raw.descriptors_by_tier[t]);
      if (list.length) byTier[t] = list;
    }
  }
  const asOf = typeof raw.as_of === 'string' && !Number.isNaN(Date.parse(raw.as_of)) ? raw.as_of : null;
  return {
    tier,
    wounds,
    severed: strs(raw.severed),
    broken: strs(raw.broken),
    scars,
    blood: tier === 'pg' ? 0 : clamp(num(raw.blood), 0, 100),
    grime: clamp(num(raw.grime), 0, 100),
    limp: typeof raw.limp === 'string' ? raw.limp : '',
    signature: typeof raw.signature === 'string' ? raw.signature : '',
    descriptors: strs(raw.descriptors),
    descriptors_by_tier: byTier,
    as_of: asOf,
  };
}

function blankRegion(): RegionView {
  return { bandage: false, bruise: 0, blood: 0, open: 0, burn: 0, scar: 0, broken: false, splinted: false, missing: '', stump: '' };
}

// Dark Matters BodyPart -> depth of loss, and the VRM humanoid bone that goes with it.
const ARM_DEPTH: Array<[string, Missing, string]> = [['UpperArm', 'arm', 'UpperArm'], ['Forearm', 'forearm', 'LowerArm'], ['Hand', 'hand', 'Hand']];
const LEG_DEPTH: Array<[string, Missing, string]> = [['Thigh', 'leg', 'UpperLeg'], ['Calf', 'calf', 'LowerLeg'], ['Foot', 'foot', 'Foot']];

const SEV = ['', 'shallow', 'deep', 'grievous'];
const KIND_WORD: Record<WoundKind, string> = { cut: 'cut', stab: 'stab wound', bite: 'bite wound', lash: 'lash welts', bruise: 'bruising', burn: 'burn', fracture: 'fracture', stump: 'stump' };
const REGION_WORD: Record<InjuryRegion, string> = { head: 'head', torso: 'torso', leftArm: 'left arm', rightArm: 'right arm', leftLeg: 'left leg', rightLeg: 'right leg' };
const MISSING_WORD: Record<string, string> = { hand: 'hand', forearm: 'forearm', arm: 'arm', foot: 'foot', calf: 'lower leg', leg: 'leg' };
const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an ' : 'a ') + s;

interface LiveWound extends InjuryWound {
  closedNow: boolean;
  healedNow: number;
  bleedingNow: boolean;
}

/**
 * The view of `spec` for a viewer at `viewerTier`, advanced to `now` (ms epoch; default Date.now()).
 * null when there is nothing to draw (no spec, or everything has healed without a trace).
 */
export function injuryView(spec: InjurySpec | null, viewerTier: InjuryTier, now: number = Date.now()): InjuryView | null {
  if (!spec) return null;
  const T = minTier(spec.tier, viewerTier);
  const red = T !== 'pg';
  const asOf = spec.as_of ? Date.parse(spec.as_of) : NaN;
  const hours = Number.isFinite(asOf) ? Math.max(0, (now - asOf) / 3_600_000) : 0;
  const days = hours / 24;

  const live: LiveWound[] = spec.wounds.map((w) => {
    let progress = 0;
    if (hours > 0 && typeof w.heal_days === 'number') progress = w.heal_days <= 0 ? 1 : clamp(days / w.heal_days, 0, 1);
    const healedNow = clamp(w.healed + (1 - w.healed) * progress, 0, 1);
    return { ...w, healedNow, closedNow: progress >= 1, bleedingNow: red && w.bleeding && !w.bandaged && hours < BLEED_STOP_HOURS };
  });

  const regions = Object.fromEntries(INJURY_REGIONS.map((r) => [r, blankRegion()])) as Record<InjuryRegion, RegionView>;
  for (const m of spec.scars) regions[m.region].scar++;
  let closed = 0;
  for (const w of live) {
    const R = regions[w.region];
    if (w.closedNow) {
      closed++;
      if (w.kind !== 'bruise' && (w.severity >= 2 || w.kind === 'burn' || w.kind === 'fracture' || w.kind === 'stump')) R.scar++;
      continue;
    }
    const fresh = 1 - w.healedNow;
    const depth = Math.max(1, Math.ceil(w.severity * fresh));
    if (w.bandaged) R.bandage = true;
    if (w.kind === 'bruise') { R.bruise = Math.max(R.bruise, Math.ceil(w.severity * fresh)); continue; }
    if (w.kind === 'fracture') { R.broken = true; R.splinted = R.splinted || w.bandaged; R.bruise = Math.max(R.bruise, 1); continue; }
    if (w.kind === 'stump') continue; // drawn through `severed`
    if (w.kind === 'burn') { R.burn = Math.max(R.burn, depth); if (!red) continue; }
    if (red) {
      R.blood = Math.max(R.blood, w.bandaged ? 1 : w.bleedingNow ? w.severity : Math.max(1, Math.round(w.severity * fresh * 0.6)));
      if (!w.bandaged && w.kind !== 'burn') R.open = Math.max(R.open, depth);
    } else if (!w.bandaged && w.kind !== 'burn') {
      R.bruise = Math.max(R.bruise, depth); // pg: the wound is shown, dark not red, at its true size
    }
  }

  // Lost limbs (authoritative list) and broken parts.
  const severed = new Set(spec.severed);
  const severedBones: string[] = [];
  for (const side of ['left', 'right'] as const) {
    for (const [regionKey, chain] of [[`${side}Arm`, ARM_DEPTH], [`${side}Leg`, LEG_DEPTH]] as const) {
      const R = regions[regionKey as InjuryRegion];
      const hit = chain.find(([part]) => severed.has(side + part));
      if (!hit) continue;
      R.missing = hit[1];
      severedBones.push(side + hit[2]);
      const sw = live.find((w) => w.kind === 'stump' && w.region === regionKey);
      R.stump = !sw || sw.closedNow ? 'healed'
        : T === 'gore' && !sw.bandaged ? 'raw'
        : T === 'pg' ? (sw.bandaged ? 'bandaged' : 'covered')
        : sw.bandaged && sw.healedNow >= 0.5 ? 'bandaged'
        : 'bloody';
      if (sw && !sw.closedNow && sw.bandaged) R.bandage = true;
    }
  }
  for (const part of spec.broken) {
    const side = part.startsWith('left') ? 'left' : part.startsWith('right') ? 'right' : '';
    if (!side) continue;
    const region = (/Arm|Forearm|Hand|Fingers/.test(part) ? `${side}Arm` : `${side}Leg`) as InjuryRegion;
    const fx = live.find((w) => w.kind === 'fracture' && w.region === region);
    if (fx && fx.closedNow) continue; // the bone has knit since the export
    regions[region].broken = true;
  }
  for (const r of INJURY_REGIONS) {
    if (T === 'pg') { regions[r].blood = 0; regions[r].open = 0; }
    if (T !== 'gore') regions[r].open = Math.min(regions[r].open, 2);
  }

  const blood = red ? Math.round(clamp(spec.blood - hours * 1.5, 0, 100)) : 0;
  const grime = Math.round(clamp(spec.grime - hours * 0.25, 0, 100));
  const legHurt = (side: 'left' | 'right') => {
    const R = regions[`${side}Leg`];
    return !!R.missing || R.broken || live.some((w) => w.region === `${side}Leg` && !w.closedNow && w.severity >= 2 && w.healedNow < 0.7);
  };
  const L = legHurt('left'), Rr = legHurt('right');
  const limp = L && Rr ? 'both' : L ? 'left' : Rr ? 'right' : '';
  const open = live.filter((w) => !w.closedNow).length;
  const anyRegion = INJURY_REGIONS.some((r) => {
    const R = regions[r];
    return R.bandage || R.bruise || R.blood || R.open || R.burn || R.scar || R.broken || R.missing;
  });
  const any = anyRegion || blood >= 10 || grime >= 25;
  if (!any) return null;

  // Text: the export's own words for this tier while nothing has changed since `as_of`; once time has
  // healed something, describe the body as it is NOW (same honest wording rules as the engine export).
  const changed = closed > 0 || live.some((w) => red && w.bleeding && !w.bleedingNow) || (red ? Math.round(spec.blood) : 0) !== blood;
  const exported = spec.descriptors_by_tier[T] ?? (spec.tier === T ? spec.descriptors : null);
  const descriptors = !changed && exported && exported.length ? exported : describe(T, regions, live, blood, grime, limp);

  const key = [T, blood >> 3, grime >> 3, limp, ...INJURY_REGIONS.map((r) => {
    const R = regions[r];
    return `${R.bandage ? 'b' : ''}${R.bruise}${R.blood}${R.open}${R.burn}${Math.min(R.scar, 3)}${R.broken ? (R.splinted ? 'S' : 'k') : ''}${R.missing}${R.stump}`;
  })].join('|');
  return { tier: T, regions, blood, grime, limp, severedBones, descriptors, open, closed, any, key };
}

function describe(T: InjuryTier, regions: Record<InjuryRegion, RegionView>, live: LiveWound[], blood: number, grime: number, limp: string): string[] {
  const out: string[] = [];
  for (const r of INJURY_REGIONS) {
    const R = regions[r];
    if (R.missing) {
      const lost = `missing ${r.startsWith('left') ? 'left' : 'right'} ${MISSING_WORD[R.missing]}`;
      out.push(R.stump === 'healed' ? `${lost} — a long-healed stump`
        : R.stump === 'raw' ? `${lost} — a raw, unbound stump`
        : R.stump === 'bloody' ? `${lost} — the stump bound in blood-soaked wrappings`
        : R.stump === 'bandaged' ? `${lost} — the stump bandaged`
        : `${lost} — the stump not yet dressed`);
    }
    const setOrNot = R.splinted ? ', splinted' : live.some((w) => w.kind === 'fracture' && w.region === r && !w.closedNow) ? ', not yet set' : '';
    if (R.broken) out.push(`broken ${REGION_WORD[r]}${setOrNot}`);
  }
  for (const w of live) {
    if (w.closedNow || w.kind === 'stump' || w.kind === 'fracture') continue;
    const where = REGION_WORD[w.region];
    const healing = w.healedNow >= 0.6 ? 'healing ' : '';
    if (w.kind === 'bruise') { out.push(`${w.healedNow >= 0.6 ? 'fading ' : ''}${w.severity >= 2 ? 'heavy ' : ''}bruising on the ${where}`); continue; }
    const base = `${healing}${SEV[w.severity]} ${KIND_WORD[w.kind]} on the ${where}`;
    if (T === 'pg') out.push(`${article(base)}, ${w.bandaged ? 'bound' : 'untended'}`);
    else out.push(`${base}, ${w.bandaged ? 'bandaged' : w.bleedingNow ? 'still bleeding' : 'untended'}`);
  }
  const scarred = INJURY_REGIONS.filter((r) => regions[r].scar > 0);
  if (scarred.length) out.push(`scars on the ${scarred.map((r) => REGION_WORD[r]).join(', ')}`);
  if (blood >= 50) out.push(T === 'gore' ? 'drenched in blood' : 'spattered with blood');
  else if (blood >= 15) out.push('flecked with dried blood');
  if (grime >= 50) out.push('filthy, caked in dirt');
  else if (grime >= 25) out.push('grimy and dishevelled');
  if (limp) out.push(`favouring the ${limp === 'both' ? 'legs' : `${limp} leg`} — a pained limp`);
  return Array.from(new Set(out));
}
