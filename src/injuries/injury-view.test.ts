import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { injuryView, parseInjuries, viewerInjuryTier, type InjurySpec } from './injury-view';
import { RED_KINDS, applyInjuryOverlay, clearInjuryOverlay, hairCovers, type VrmLike } from './injury-overlay';

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

// ── the overlay, on a real three.js skinned body shaped like a VRM humanoid ────────────────────────
interface Rig { vrm: VrmLike; bones: Record<string, THREE.Bone> }

/** A skinned "VRM": a skeleton plus one skinned mesh of cylinders (limbs, torso) and a sphere (head), each vertex
 *  weighted to its segment's bone; optional hair over the char-left temple. */
function body(opts: { hair?: boolean } = {}): Rig {
  const scene = new THREE.Group();
  const bones: Record<string, THREE.Bone> = {};
  const add = (name: string, parent: THREE.Object3D, x: number, y: number, z = 0) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones[name] = b;
    return b;
  };
  const hips = add('hips', scene, 0, 0.9);
  const spine = add('spine', hips, 0, 0.1);
  const chest = add('chest', spine, 0, 0.15);
  const neck = add('neck', chest, 0, 0.2);
  add('head', neck, 0, 0.08);
  for (const [side, sx] of [['left', 1], ['right', -1]] as const) {
    // arms hang at the sides; legs straight
    add(`${side}Hand`, add(`${side}LowerArm`, add(`${side}UpperArm`, chest, sx * 0.18, 0.15), 0, -0.27), 0, -0.25);
    add(`${side}Foot`, add(`${side}LowerLeg`, add(`${side}UpperLeg`, hips, sx * 0.1, -0.05), 0, -0.42), 0, -0.4);
  }
  scene.updateMatrixWorld(true);
  const list = Object.values(bones);
  const wp = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3());
  const parts: Array<{ geo: THREE.BufferGeometry; bone: THREE.Bone }> = [];
  const limb = (from: string, to: string, r: number) => {
    const a = wp(bones[from]), b = wp(bones[to]);
    const g = new THREE.CylinderGeometry(r, r, a.distanceTo(b), 16, 8, true);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    parts.push({ geo: g, bone: bones[from] });
  };
  for (const side of ['left', 'right']) {
    limb(`${side}UpperArm`, `${side}LowerArm`, 0.045);
    limb(`${side}LowerArm`, `${side}Hand`, 0.04);
    limb(`${side}UpperLeg`, `${side}LowerLeg`, 0.07);
    limb(`${side}LowerLeg`, `${side}Foot`, 0.055);
  }
  limb('hips', 'chest', 0.14);
  limb('chest', 'neck', 0.15);
  const head = new THREE.SphereGeometry(0.11, 32, 24);
  head.translate(0, wp(bones.head).y + 0.06, 0);
  parts.push({ geo: head, bone: bones.head });
  const skinned = (geos: typeof parts, name: string) => {
    let n = 0;
    for (const p of geos) n += p.geo.attributes.position.count;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const index: number[] = [];
    let o = 0;
    for (const p of geos) {
      const g = p.geo;
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array as Float32Array, o * 3);
      nrm.set(g.attributes.normal.array as Float32Array, o * 3);
      for (let i = 0; i < c; i++) { si[(o + i) * 4] = list.indexOf(p.bone); sw[(o + i) * 4] = 1; }
      const idx = g.index as THREE.BufferAttribute;
      for (let i = 0; i < idx.count; i++) index.push(idx.getX(i) + o);
      o += c;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    geo.setIndex(index);
    const mat = new THREE.MeshStandardMaterial();
    mat.name = name;
    const mesh = new THREE.SkinnedMesh(geo, mat);
    scene.add(mesh);
    mesh.bind(new THREE.Skeleton(list));
    return mesh;
  };
  skinned(parts, 'Body_00_SKIN');
  if (opts.hair) {
    // a lock of hair hanging over the char-left temple
    const lock = new THREE.SphereGeometry(0.016, 12, 8);
    const H = wp(bones.head);
    lock.translate(0.071, H.y + 0.035, 0.117);
    skinned([{ geo: lock, bone: bones.head }], 'Hair_00_HAIR');
  }
  scene.updateMatrixWorld(true);
  return { vrm: { scene, humanoid: { getRawBoneNode: (n: string) => bones[n] ?? null } }, bones };
}
const count = (vrm: VrmLike, pred: (o: THREE.Object3D) => boolean) => {
  let n = 0;
  vrm.scene.traverse((o) => { if (pred(o)) n++; });
  return n;
};
const marks = (vrm: VrmLike) => count(vrm, (o) => Boolean(o.userData.aitherInjury));
const rings = (vrm: VrmLike) => count(vrm, (o) => (o as THREE.Mesh).geometry instanceof THREE.CylinderGeometry && Boolean(o.userData.aitherInjury));
const kindsOf = (drawn: Record<string, number>) => new Set(Object.keys(drawn).map((k) => k.split(':')[1]));

describe('applyInjuryOverlay — marks ON the surface, not bands round it', () => {
  it('pg: skinned decals on the body, a dressed stump, nothing red, no rings; dispose restores', () => {
    const { vrm, bones } = body();
    const h = applyInjuryOverlay(THREE, vrm, injuryView(spec(), 'pg', T0));
    const kinds = kindsOf(h.drawn);
    expect(h.drawn['aitherWound:bruise']).toBeGreaterThan(0);
    expect(kinds.has('scrape')).toBe(true); // the unbound stab at pg: a scrape, dark not red
    expect(h.drawn['aitherWoundStump:stump']).toBeGreaterThan(0);
    for (const red of RED_KINDS) expect(kinds.has(red)).toBe(false);
    expect(rings(vrm)).toBe(0);
    let skinnedMarks = 0;
    vrm.scene.traverse((o) => { if (o.userData.aitherInjury && (o as THREE.SkinnedMesh).isSkinnedMesh) skinnedMarks++; });
    expect(skinnedMarks).toBe(marks(vrm)); // every mark rides the skeleton
    expect(bones.leftLowerArm.scale.x).toBeLessThan(0.01);
    h.dispose();
    expect(marks(vrm)).toBe(0);
    expect(bones.leftLowerArm.scale.x).toBe(1);
  });

  it('gore: open wounds, a raw stump with runs of blood, spatter; re-apply replaces, clear restores', () => {
    const { vrm, bones } = body();
    const h = applyInjuryOverlay(THREE, vrm, injuryView(spec(), 'gore', T0));
    const kinds = kindsOf(h.drawn);
    expect(kinds.has('wound')).toBe(true);
    expect(kinds.has('drips')).toBe(true);
    expect(kinds.has('spatter')).toBe(true);
    const first = marks(vrm);
    applyInjuryOverlay(THREE, vrm, injuryView(spec(), 'gore', T0));
    expect(marks(vrm)).toBe(first);
    clearInjuryOverlay(vrm);
    expect(marks(vrm)).toBe(0);
    expect(bones.leftLowerArm.scale.x).toBe(1);
  });

  it('bandaged: limb wraps follow the limb; the head gets a pad, never a band; a SET break gets slats', () => {
    const { vrm } = body();
    const bandaged = parseInjuries(goreSpec({
      wounds: [
        { region: 'head', kind: 'cut', severity: 2, bleeding: false, bandaged: true, healed: 0.1, heal_days: 5 },
        { region: 'rightArm', kind: 'cut', severity: 2, bleeding: false, bandaged: true, healed: 0.1, heal_days: 5 },
        { region: 'rightLeg', kind: 'fracture', severity: 2, bleeding: false, bandaged: true, healed: 0.1, heal_days: 16 },
      ],
      severed: [],
      broken: ['rightCalf'],
    }));
    const h = applyInjuryOverlay(THREE, vrm, injuryView(bandaged, 'pg', T0));
    expect(h.drawn['aitherWoundWrap:gauze']).toBeGreaterThan(0);
    expect(h.drawn['aitherWound:pad']).toBe(1);
    expect(h.drawn['aitherWoundSplint:wood']).toBe(2);
    expect(rings(vrm)).toBe(0);
    // an UNSET break gets no splint
    const unset = parseInjuries(goreSpec({ wounds: [{ region: 'rightLeg', kind: 'fracture', severity: 2, bandaged: false, healed: 0, heal_days: 18 }], severed: [], broken: ['rightCalf'] }));
    expect(applyInjuryOverlay(THREE, vrm, injuryView(unset, 'pg', T0)).drawn['aitherWoundSplint:wood']).toBeUndefined();
  });

  it('head marks move clear of hair (temple -> cheek)', () => {
    const headOnly = parseInjuries(goreSpec({
      wounds: [{ region: 'head', kind: 'cut', severity: 2, bleeding: false, bandaged: true, healed: 0.1, heal_days: 5 }],
      severed: [], broken: [], scars: [], blood: 0,
    }));
    const centreY = (vrm: VrmLike) => {
      const box = new THREE.Box3();
      vrm.scene.traverse((o) => {
        if (!o.userData.aitherInjury) return;
        const p = (o as THREE.Mesh).geometry.attributes.position;
        for (let i = 0; i < p.count; i++) box.expandByPoint(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      });
      return box.getCenter(new THREE.Vector3()).y;
    };
    const bare = body();
    applyInjuryOverlay(THREE, bare.vrm, injuryView(headOnly, 'pg', T0));
    const haired = body({ hair: true });
    const h = applyInjuryOverlay(THREE, haired.vrm, injuryView(headOnly, 'pg', T0));
    expect(h.drawn['aitherWound:pad']).toBe(1);
    expect(centreY(haired.vrm)).toBeLessThan(centreY(bare.vrm) - 0.03);
  });

  it('hairCovers: a hair vertex on the ray in front of the spot covers it; one behind does not', () => {
    const C = new THREE.Vector3(0, 0, 0), out = new THREE.Vector3(0, 0, 1);
    expect(hairCovers([{ P: new Float32Array([0, 0.005, 0.03]), n: 1 }], C, out)).toBe(true);
    expect(hairCovers([{ P: new Float32Array([0, 0, -0.03]), n: 1 }], C, out)).toBe(false);
    expect(hairCovers([{ P: new Float32Array([0.05, 0, 0.03]), n: 1 }], C, out)).toBe(false);
  });

  it('a null view or a model without a humanoid draws nothing and never throws', () => {
    const { vrm } = body();
    applyInjuryOverlay(THREE, vrm, null);
    expect(marks(vrm)).toBe(0);
    expect(() => applyInjuryOverlay(THREE, { scene: new THREE.Group(), humanoid: null }, injuryView(spec(), 'gore', T0))).not.toThrow();
  });

  it('a bones-only rig falls back to small patches, still never rings', () => {
    const { vrm } = body();
    vrm.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.visible = false; });
    const h = applyInjuryOverlay(THREE, vrm, injuryView(spec(), 'pg', T0));
    expect(Object.keys(h.drawn).length).toBeGreaterThan(0);
    expect(Object.keys(h.drawn).every((k) => k.startsWith('aitherWoundPatch:'))).toBe(true);
    expect(rings(vrm)).toBe(0);
  });
});
