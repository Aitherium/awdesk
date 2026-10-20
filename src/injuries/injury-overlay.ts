/**
 * injury-overlay — draw an InjuryView (./injury-view.ts) on a loaded VRM.
 *
 * SHARED FILE. Byte-identical copies live at
 *   .DEPLOYMENT/awdesk/src/injuries/injury-overlay.ts
 *   AitherOS/apps/AitherVeil/src/lib/avatar/injury-overlay.ts
 * (check_injury_view_parity.py IVP001). Edit both.
 *
 * What it draws, parented to the VRM's RAW humanoid bones (the skeleton the skin follows, so every
 * piece moves with the idle/talk animation):
 *   bandage   a cloth wrap around the limb segment / forehead / chest (any tier)
 *   bruise    a dark translucent band, sized by the wound's TRUE severity (any tier; at pg an
 *             unbound cut/stab/bite shows here, dark, never red)
 *   burn      a scorched band (brown at pg, angry red above it)
 *   scar      a thin pale line
 *   splint    two slats + ties on a broken limb that was set; an unset break is a bruise
 *   missing   the severed raw bone collapsed to its joint, capped: cloth (pg / bandaged), cloth with a
 *             red stain (blood tier), raw red (gore only), healed skin
 *   blood     red staining / an open-wound line — only when the view's tier is above pg, and the view
 *             tier is already clamped by the viewer's adult-content gate (viewerInjuryTier)
 *
 * The overlay is procedural (no textures, no assets), idempotent per VRM (applying a new view first
 * removes the old one and restores every collapsed bone's authored scale), and fails soft: a bone this
 * model does not author costs that one piece, never the load.
 *
 * `three` is passed in (as lib/avatar/vrm-load does in Veil) so one file serves two bundles with
 * different three.js copies.
 */

import type * as THREENS from 'three';
import type { InjuryRegion, InjuryView, RegionView } from './injury-view';

type Three = typeof THREENS;

/** The subset of a three-vrm VRM this needs. */
export interface VrmLike {
  scene: THREENS.Object3D;
  humanoid?: {
    getRawBoneNode(name: string): THREENS.Object3D | null;
  } | null;
}

export interface InjuryOverlayHandle {
  key: string;
  dispose(): void;
}

const OVERLAY_TAG = '__aitherInjuryOverlay';

const COLORS = {
  cloth: 0xe8e2d4,
  clothStain: 0x9b1c1c,
  bruise: 0x3d2340,
  burnPg: 0x5b3a29,
  burnRed: 0x8a2a14,
  blood: 0xa01010,
  open: 0x6a0a0a,
  openGore: 0x4a0000,
  raw: 0x6e0f0f,
  scar: 0xe2c3b5,
  splint: 0x7a5a3a,
  healed: 0xd9b8a0,
};

interface Segment {
  bone: THREENS.Object3D;
  /** Unit axis along the segment, in the bone's local frame. */
  axis: THREENS.Vector3;
  /** Segment centre, in the bone's local frame. */
  center: THREENS.Vector3;
  /** Segment length and limb radius, in the bone's LOCAL units. */
  length: number;
  radius: number;
}

// Which raw bones carry each region's marks, best first, and how thick that limb is relative to its length.
const LIMB: Record<string, { upper: string; lower: string; end: string; kUpper: number; kLower: number }> = {
  leftArm: { upper: 'leftUpperArm', lower: 'leftLowerArm', end: 'leftHand', kUpper: 0.15, kLower: 0.13 },
  rightArm: { upper: 'rightUpperArm', lower: 'rightLowerArm', end: 'rightHand', kUpper: 0.15, kLower: 0.13 },
  leftLeg: { upper: 'leftUpperLeg', lower: 'leftLowerLeg', end: 'leftFoot', kUpper: 0.16, kLower: 0.12 },
  rightLeg: { upper: 'rightUpperLeg', lower: 'rightLowerLeg', end: 'rightFoot', kUpper: 0.16, kLower: 0.12 },
};

function raw(vrm: VrmLike, name: string): THREENS.Object3D | null {
  try {
    return vrm.humanoid?.getRawBoneNode(name) ?? null;
  } catch {
    return null;
  }
}

/** A segment from `from` toward `to` (both raw bones), measured in `from`'s local frame. */
function segmentBetween(THREE: Three, from: THREENS.Object3D, to: THREENS.Object3D, k: number): Segment | null {
  from.updateWorldMatrix(true, false);
  to.updateWorldMatrix(true, false);
  const a = from.getWorldPosition(new THREE.Vector3());
  const b = to.getWorldPosition(new THREE.Vector3());
  const local = from.worldToLocal(b.clone());
  const length = local.length();
  if (!(length > 1e-6) || a.distanceTo(b) < 1e-6) return null;
  return { bone: from, axis: local.clone().normalize(), center: local.clone().multiplyScalar(0.5), length, radius: length * k };
}

/** A segment pointing world-up from `bone`, sized from a world measure (head, chest). */
function uprightSegment(THREE: Three, bone: THREENS.Object3D, worldLength: number, worldRadius: number, worldLift: number): Segment {
  bone.updateWorldMatrix(true, false);
  const s = bone.getWorldScale(new THREE.Vector3()).x || 1;
  const q = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
  return { bone, axis: up, center: up.clone().multiplyScalar(worldLift / s), length: worldLength / s, radius: worldRadius / s };
}

function bodyHeight(THREE: Three, vrm: VrmLike): number {
  const head = raw(vrm, 'head');
  const foot = raw(vrm, 'leftFoot') ?? raw(vrm, 'rightFoot');
  if (head && foot) {
    head.updateWorldMatrix(true, false);
    foot.updateWorldMatrix(true, false);
    const d = head.getWorldPosition(new THREE.Vector3()).distanceTo(foot.getWorldPosition(new THREE.Vector3()));
    if (d > 1e-3) return d / 0.85; // head joint sits ~85% of the way up
  }
  return 1.5;
}

/** Plan + draw. Returns a handle whose dispose() removes every piece and restores collapsed bones. */
export function applyInjuryOverlay(THREE: Three, vrm: VrmLike, view: InjuryView | null): InjuryOverlayHandle {
  clearInjuryOverlay(vrm);
  const added: THREENS.Object3D[] = [];
  const restored: Array<[THREENS.Object3D, THREENS.Vector3]> = [];
  const geoms: THREENS.BufferGeometry[] = [];
  const mats: THREENS.Material[] = [];
  const handle: InjuryOverlayHandle = {
    key: view?.key ?? '',
    dispose() {
      for (const o of added) o.parent?.remove(o);
      for (const [bone, scale] of restored) bone.scale.copy(scale);
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
      added.length = 0;
      restored.length = 0;
      const host = vrm.scene.userData as Record<string, unknown>;
      if (host[OVERLAY_TAG] === handle) delete host[OVERLAY_TAG];
    },
  };
  (vrm.scene.userData as Record<string, unknown>)[OVERLAY_TAG] = handle;
  if (!view || !vrm.humanoid) return handle;

  const material = (color: number, opacity = 1) => {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.95,
      metalness: 0,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    mats.push(m);
    return m;
  };
  const place = (seg: Segment, mesh: THREENS.Mesh, along: number) => {
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), seg.axis);
    mesh.position.copy(seg.center).addScaledVector(seg.axis, along * seg.length);
    mesh.name = 'aither-injury';
    mesh.renderOrder = 2;
    seg.bone.add(mesh);
    added.push(mesh);
  };
  /** A band around the segment: `height` and `along` in segment lengths, radius in limb radii. */
  const band = (seg: Segment, color: number, opacity: number, height: number, along = 0, radiusMul = 1.06) => {
    const r = seg.radius * radiusMul;
    const g = new THREE.CylinderGeometry(r, r, Math.max(seg.length * height, seg.radius * 0.08), 28, 1, true);
    geoms.push(g);
    place(seg, new THREE.Mesh(g, material(color, opacity)), along);
  };
  const splint = (seg: Segment) => {
    for (const side of [-1, 1]) {
      const g = new THREE.BoxGeometry(seg.radius * 0.28, seg.length * 0.7, seg.radius * 0.12);
      geoms.push(g);
      const mesh = new THREE.Mesh(g, material(COLORS.splint));
      place(seg, mesh, 0);
      // push the slat out to the limb's side, perpendicular to the axis
      const perp = new THREE.Vector3(1, 0, 0);
      if (Math.abs(perp.dot(seg.axis)) > 0.9) perp.set(0, 0, 1);
      perp.addScaledVector(seg.axis, -perp.dot(seg.axis)).normalize();
      mesh.position.addScaledVector(perp, side * seg.radius * 1.12);
    }
    band(seg, COLORS.cloth, 1, 0.08, -0.28, 1.2);
    band(seg, COLORS.cloth, 1, 0.08, 0.28, 1.2);
  };
  const cap = (parent: THREENS.Object3D, at: THREENS.Vector3, radius: number, look: RegionView['stump']) => {
    const color = look === 'raw' ? COLORS.raw : look === 'healed' ? COLORS.healed : COLORS.cloth;
    const g = new THREE.SphereGeometry(radius, 20, 14);
    geoms.push(g);
    const m = new THREE.Mesh(g, material(color));
    m.position.copy(at);
    m.name = 'aither-injury';
    parent.add(m);
    added.push(m);
    if (look === 'bloody') {
      const g2 = new THREE.SphereGeometry(radius * 1.02, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.45);
      geoms.push(g2);
      const stain = new THREE.Mesh(g2, material(COLORS.clothStain, 0.85));
      stain.position.copy(at);
      stain.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), at.clone().normalize());
      stain.name = 'aither-injury';
      parent.add(stain);
      added.push(stain);
    }
  };
  /** Marks for one region on one segment, in a fixed order so layering is stable. */
  const marks = (seg: Segment, R: RegionView, tier: InjuryView['tier']) => {
    if (R.bruise) band(seg, COLORS.bruise, 0.28 + 0.14 * R.bruise, 0.18 + 0.1 * R.bruise, 0.1, 1.03);
    if (R.burn) band(seg, tier === 'pg' ? COLORS.burnPg : COLORS.burnRed, 0.3 + 0.12 * R.burn, 0.2 + 0.08 * R.burn, -0.15, 1.035);
    for (let i = 0; i < Math.min(R.scar, 3); i++) band(seg, COLORS.scar, 0.9, 0.012, -0.3 + i * 0.12, 1.04);
    if (tier !== 'pg' && R.blood && !R.bandage) band(seg, COLORS.blood, 0.22 + 0.16 * R.blood, 0.16 + 0.08 * R.blood, 0.05, 1.045);
    if (tier !== 'pg' && R.open) band(seg, tier === 'gore' ? COLORS.openGore : COLORS.open, 0.95, 0.03 + 0.03 * R.open, 0.02, 1.05);
    if (R.bandage) {
      band(seg, COLORS.cloth, 1, 0.34, 0, 1.12);
      if (tier !== 'pg' && R.blood) band(seg, COLORS.clothStain, 0.55 + 0.12 * R.blood, 0.1 + 0.05 * R.blood, 0.02, 1.13);
    }
  };

  const H = bodyHeight(THREE, vrm);
  const regions = view.regions;

  // Head: a forehead wrap and marks above the brow.
  const head = raw(vrm, 'head');
  if (head) marks(uprightSegment(THREE, head, H * 0.06, H * 0.062, H * 0.065), regions.head, view.tier);

  // Torso: chest band (marks), falling back to the spine.
  const chest = raw(vrm, 'chest') ?? raw(vrm, 'spine');
  if (chest) {
    const seg = uprightSegment(THREE, chest, H * 0.12, H * 0.095, H * 0.02);
    marks(seg, regions.torso, view.tier);
    if (view.tier !== 'pg' && view.blood >= 40) band(seg, COLORS.blood, 0.18 + 0.002 * view.blood, 0.6, -0.4, 1.02);
  }

  // Limbs.
  for (const key of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as InjuryRegion[]) {
    const R = regions[key];
    const L = LIMB[key];
    const upper = raw(vrm, L.upper), lower = raw(vrm, L.lower), end = raw(vrm, L.end);
    const upperSeg = upper && lower ? segmentBetween(THREE, upper, lower, L.kUpper) : null;
    const lowerSeg = lower && end ? segmentBetween(THREE, lower, end, L.kLower) : null;

    // A lost limb: collapse the top severed raw bone onto its joint and cap the stump there.
    const lost = R.missing === 'arm' || R.missing === 'leg' ? L.upper
      : R.missing === 'forearm' || R.missing === 'calf' ? L.lower
      : R.missing === 'hand' || R.missing === 'foot' ? L.end
      : '';
    if (lost) {
      const bone = raw(vrm, lost);
      if (bone && bone.parent) {
        restored.push([bone, bone.scale.clone()]);
        bone.scale.setScalar(1e-4);
        const near = lost === L.end ? lowerSeg : upperSeg;
        const r = (near?.radius ?? H * 0.03) * 1.1;
        cap(bone.parent, bone.position.clone(), r, R.stump || 'covered');
      }
    }
    // Where the marks go: the lowest segment that still exists.
    const seg = R.missing === 'arm' || R.missing === 'leg' ? null
      : R.missing === 'forearm' || R.missing === 'calf' ? upperSeg
      : lowerSeg ?? upperSeg;
    if (!seg) continue;
    if (R.broken) {
      if (R.splinted) splint(seg);
      else band(seg, COLORS.bruise, 0.45, 0.3, 0, 1.03);
    }
    marks(seg, { ...R, broken: false }, view.tier);
  }

  return handle;
}

/** Remove whatever overlay this VRM carries (no-op when none). */
export function clearInjuryOverlay(vrm: VrmLike): void {
  const prev = (vrm.scene.userData as Record<string, unknown>)[OVERLAY_TAG] as InjuryOverlayHandle | undefined;
  prev?.dispose();
}
