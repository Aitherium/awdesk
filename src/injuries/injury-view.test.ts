import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { injuryView, parseInjuries, viewerInjuryTier, type InjurySpec } from './injury-view';
import { applyInjuryOverlay, clearInjuryOverlay, type VrmLike } from './injury-overlay';

const AS_OF = '2026-10-19T12:00:00.000Z';
const T0 = Date.parse(AS_OF);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The Dark Matters showcase body (engine/src/render/injuryExport.ts, gore tier). */
function goreSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tier: 'gore',
    wounds: [
      { region: 'leftArm', kind: 'stump', severity: 3, bleeding: true, bandaged: false, healed: 0, heal_days: 21 },
      { region: 'rightLeg', kind: 'fracture', severity: 2, bleeding: false, bandaged: false, healed: 0, heal_days: 18 },
      { region: 'head', kind: 'cut', severity: 3, bleeding: true, bandaged: false, healed: 0, heal_days: 12 },
      { region: 'torso', kind: 'stab', severity: 3, bleeding: true, bandaged: false, healed: 0, heal_days: 12 },
      { region: 'rightArm', kind: 'cut', severity: 1, bleeding: false, bandaged: true, healed: 0.5, heal_days: 0.7 },
      { region: 'leftLeg', kind: 'burn', severity: 2, bleeding: false, bandaged: false, healed: 0, heal_days: 8 },
    ],
    severed: ['leftForearm', 'leftHand', 'leftFingers'],
    broken: ['rightCalf'],
    scars: [{ region: 'head', kind: 'cut' }],
    blood: 100,
    grime: 0,
    limp: 'both',
    signature: 'x',
    descriptors: ['missing left forearm — a raw, weeping stump of torn flesh and bone'],
    descriptors_by_tier: {
      pg: ['missing left forearm — the stump not yet dressed', 'a grievous stab wound on the torso, untended'],
      blood: ['missing left forearm — the stump unbound and still bleeding'],
      gore: ['missing left forearm — a raw, weeping stump of torn flesh and bone'],
    },
    as_of: AS_OF,
    ...over,
  };
}

function spec(over: Record<string, unknown> = {}): InjurySpec {
  const s = parseInjuries(goreSpec(over));
  if (!s) throw new Error('spec did not parse');
  return s;
}

describe('viewerInjuryTier — the platform adult gate decides, and only tightens', () => {
  it('closed, missing or non-boolean gate is pg', () => {
    expect(viewerInjuryTier({ adultContentVisible: false })).toBe('pg');
    expect(viewerInjuryTier({ adultContentVisible: 'true' as unknown as boolean })).toBe('pg');
    expect(viewerInjuryTier({ adultContentVisible: undefined as unknown as boolean, maxRating: 'r18' })).toBe('pg');
  });
  it('an open gate allows gore, tightened by the desk ceiling and the safety plane', () => {
    expect(viewerInjuryTier({ adultContentVisible: true })).toBe('gore');
    expect(viewerInjuryTier({ adultContentVisible: true, maxRating: 'r15' })).toBe('blood');
    expect(viewerInjuryTier({ adultContentVisible: true, maxRating: 'general' })).toBe('pg');
    expect(viewerInjuryTier({ adultContentVisible: true, explicitAllowed: false })).toBe('blood');
  });
});

describe('parseInjuries — structural, fail-closed', () => {
  it('rejects non-objects and unknown tiers', () => {
    expect(parseInjuries(null)).toBeNull();
    expect(parseInjuries('bleeding')).toBeNull();
    expect(parseInjuries({ tier: 'splatter', wounds: [] })).toBeNull();
  });
  it('a pg export cannot smuggle blood or bleeding in', () => {
    const s = parseInjuries(goreSpec({ tier: 'pg' }))!;
    expect(s.blood).toBe(0);
    expect(s.wounds.every((w) => !w.bleeding)).toBe(true);
    expect(Object.keys(s.descriptors_by_tier)).toEqual(['pg']);
  });
  it('drops unknown regions/kinds and keeps the true kinds', () => {
    const s = parseInjuries(goreSpec({ wounds: [{ region: 'tail', kind: 'cut', severity: 1 }, { region: 'torso', kind: 'stab', severity: 3, bandaged: true }] }))!;
    expect(s.wounds).toHaveLength(1);
    expect(s.wounds[0]).toMatchObject({ kind: 'stab', severity: 3, bandaged: true });
  });
});

describe('injuryView — the clamp only ever goes down', () => {
  it('pg viewer: bandage/bruise/scar/covered stump, never red, true severity kept', () => {
    const v = injuryView(spec(), 'pg', T0)!;
    expect(v.tier).toBe('pg');
    expect(v.blood).toBe(0);
    for (const r of Object.values(v.regions)) {
      expect(r.blood).toBe(0);
      expect(r.open).toBe(0);
    }
    expect(v.regions.torso.bruise).toBe(3); // the grievous stab shows at its true size, dark not red
    expect(v.regions.leftArm.missing).toBe('forearm');
    expect(v.regions.leftArm.stump).toBe('covered'); // unbound: covered at pg, never "bandaged"
    expect(v.regions.rightArm.bandage).toBe(true);
    expect(v.regions.rightLeg.broken).toBe(true);
    expect(v.regions.rightLeg.splinted).toBe(false); // the break was not set: no splint is invented
    expect(v.regions.head.scar).toBe(1);
    expect(v.severedBones).toEqual(['leftLowerArm']);
    expect(v.descriptors.join(' ')).not.toMatch(/blood|raw|gaping|weeping/i);
    expect(v.descriptors).toContain('a grievous stab wound on the torso, untended');
  });
  it('gore viewer on a gore export: raw stump and open wounds; blood viewer: bloody stump, open capped at 2', () => {
    const g = injuryView(spec(), 'gore', T0)!;
    expect(g.regions.leftArm.stump).toBe('raw');
    expect(g.regions.torso.open).toBe(3);
    expect(g.blood).toBe(100);
    expect(g.descriptors[0]).toMatch(/raw, weeping stump/);
    const b = injuryView(spec(), 'blood', T0)!;
    expect(b.tier).toBe('blood');
    expect(b.regions.leftArm.stump).toBe('bloody');
    expect(b.regions.torso.open).toBe(2);
    expect(b.descriptors[0]).toMatch(/still bleeding/);
  });
  it('a gore viewer of a pg export still sees pg (the export tier is a ceiling too)', () => {
    const v = injuryView(parseInjuries(goreSpec({ tier: 'pg' })), 'gore', T0)!;
    expect(v.tier).toBe('pg');
    expect(v.blood).toBe(0);
    expect(v.regions.leftArm.stump).toBe('covered');
  });
});

describe('injuryView — heals and fades with the spec timestamps', () => {
  it('bleeding stops after BLEED_STOP_HOURS; blood fades', () => {
    const later = injuryView(spec(), 'gore', T0 + 13 * HOUR)!;
    expect(later.regions.torso.blood).toBeLessThan(3);
    expect(later.blood).toBeLessThan(100);
    expect(later.descriptors.join(' ')).not.toMatch(/still bleeding/);
  });
  it('a wound past its heal_days closes; a deep one leaves a scar; a shallow one leaves nothing', () => {
    const v = injuryView(spec(), 'pg', T0 + 1 * DAY)!;
    expect(v.closed).toBe(1); // the shallow bandaged arm cut (0.7 days)
    expect(v.regions.rightArm.bandage).toBe(false);
    expect(v.regions.rightArm.scar).toBe(0);
    const w = injuryView(spec(), 'pg', T0 + 13 * DAY)!;
    expect(w.regions.torso.bruise).toBe(0);
    expect(w.regions.torso.scar).toBe(1); // the grievous stab scarred
    expect(w.regions.head.scar).toBe(2);
  });
  it('a stump heals to a healed cap; a fracture knits and the limp eases', () => {
    const v = injuryView(spec(), 'gore', T0 + 30 * DAY)!;
    expect(v.regions.leftArm.missing).toBe('forearm'); // the limb never grows back by itself
    expect(v.regions.leftArm.stump).toBe('healed');
    expect(v.regions.rightLeg.broken).toBe(false);
    expect(v.descriptors.join(' ')).toMatch(/long-healed stump/);
  });
  it('no as_of: shown exactly as exported (no invented clock)', () => {
    const a = injuryView(spec({ as_of: undefined }), 'pg', T0 + 365 * DAY)!;
    const b = injuryView(spec(), 'pg', T0)!;
    expect(a.key).toBe(b.key);
  });
  it('nothing left to draw is null', () => {
    const s = parseInjuries({ tier: 'pg', wounds: [{ region: 'torso', kind: 'bruise', severity: 1, healed: 0, heal_days: 1 }], as_of: AS_OF })!;
    expect(injuryView(s, 'pg', T0)).not.toBeNull();
    expect(injuryView(s, 'pg', T0 + 2 * DAY)).toBeNull();
  });
});

// ── the overlay, on a real three.js skeleton shaped like a VRM humanoid ─────────────────────────────
function skeleton(): VrmLike {
  const scene = new THREE.Group();
  const bones: Record<string, THREE.Bone> = {};
  const add = (name: string, parent: THREE.Object3D, x: number, y: number) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, 0);
    parent.add(b);
    bones[name] = b;
    return b;
  };
  const hips = add('hips', scene, 0, 0.9);
  const spine = add('spine', hips, 0, 0.1);
  const chest = add('chest', spine, 0, 0.15);
  add('head', add('neck', chest, 0, 0.2), 0, 0.08);
  for (const [side, sx] of [['left', 1], ['right', -1]] as const) {
    add(`${side}Hand`, add(`${side}LowerArm`, add(`${side}UpperArm`, chest, sx * 0.18, 0.15), sx * 0.27, 0), sx * 0.25, 0);
    add(`${side}Foot`, add(`${side}LowerLeg`, add(`${side}UpperLeg`, hips, sx * 0.1, -0.05), 0, -0.42), 0, -0.4);
  }
  scene.updateMatrixWorld(true);
  return { scene, humanoid: { getRawBoneNode: (n: string) => bones[n] ?? null } };
}
const pieces = (vrm: VrmLike) => {
  let n = 0;
  vrm.scene.traverse((o) => { if (o.name === 'aither-injury') n++; });
  return n;
};
const reds = (vrm: VrmLike) => {
  const out: number[] = [];
  vrm.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (o.name === 'aither-injury' && m?.color) {
      const c = m.color;
      if (c.r > 0.3 && c.g < 0.15 && c.b < 0.15) out.push(c.getHex());
    }
  });
  return out;
};

describe('applyInjuryOverlay', () => {
  it('pg: draws marks, collapses the severed forearm, and nothing is red', () => {
    const vrm = skeleton();
    const forearm = vrm.humanoid!.getRawBoneNode('leftLowerArm')!;
    const h = applyInjuryOverlay(THREE, vrm, injuryView(spec(), 'pg', T0));
    expect(pieces(vrm)).toBeGreaterThan(5);
    expect(forearm.scale.x).toBeLessThan(0.01);
    expect(reds(vrm)).toEqual([]);
    h.dispose();
    expect(pieces(vrm)).toBe(0);
    expect(forearm.scale.x).toBe(1);
  });
  it('gore: red appears; re-applying replaces (never stacks); clear restores', () => {
    const vrm = skeleton();
    applyInjuryOverlay(THREE, vrm, injuryView(spec(), 'gore', T0));
    const first = pieces(vrm);
    expect(reds(vrm).length).toBeGreaterThan(0);
    applyInjuryOverlay(THREE, vrm, injuryView(spec(), 'gore', T0));
    expect(pieces(vrm)).toBe(first);
    clearInjuryOverlay(vrm);
    expect(pieces(vrm)).toBe(0);
    expect(vrm.humanoid!.getRawBoneNode('leftLowerArm')!.scale.x).toBe(1);
  });
  it('a null view or a model without a humanoid draws nothing and never throws', () => {
    const vrm = skeleton();
    applyInjuryOverlay(THREE, vrm, null);
    expect(pieces(vrm)).toBe(0);
    expect(() => applyInjuryOverlay(THREE, { scene: new THREE.Group(), humanoid: null }, injuryView(spec(), 'gore', T0))).not.toThrow();
  });
});
