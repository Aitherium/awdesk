/**
 * injury-overlay — draw an InjuryView (./injury-view.ts) ON a loaded VRM's surface.
 *
 * SHARED FILE. Byte-identical copies live at
 *   .DEPLOYMENT/awdesk/src/injuries/injury-overlay.ts
 *   AitherOS/apps/AitherVeil/src/lib/avatar/injury-overlay.ts
 * (check_injury_view_parity.py IVP001). Edit both.
 *
 * PORTED from the game's renderer (Dark Matters engine/src/web/assets/ui/injury3d.mjs applyWoundsToVrm), after the
 * owner's verdict on the first version of this file, which drew translucent cylinders round the limbs: wounds as
 * bands "read as costume". Every mark now lies ON the body:
 *   DECALS  cuts / stabs / bites / lash welts, bruises, burns, scars, scrapes and tears, blood spatter, a taped head /
 *           torso dressing: each a SKINNED patch cut out of the OUTERMOST surface at the wound (the sleeve over the
 *           forearm, the skin of a bare one): that surface's triangles around the spot, re-skinned to the same
 *           skeleton (same bind, same weights, face morphs shared), pushed a hair off it, textured by planar
 *           projection with "down" toward the hand / foot on a limb and world-down on the head and torso.
 *   WRAPS   bandages and the wrap above a stump: the ring of the limb's outermost surface at the wound height,
 *           re-skinned and pushed out a few millimetres, gauze-textured, so the wrap follows the limb.
 *   SPLINT  two slats along the BROKEN bone, placed at the limb's measured surface on both sides, tied on with three
 *           skinned wraps (only for a break that was SET; an unset break is a bruise).
 *   STUMP   the severed raw bone collapses (scale ~0) after the marks were fitted; the closed end is a skinned patch
 *           of the triangles that collapse there: a dressing (pg covered / bandaged), a soaked dressing (blood tier),
 *           raw flesh with runs of blood (gore only); a healed stump keeps only its scar.
 *   HEAD    a pad or mark at the TEMPLE, never a band and never across the eyes; when hair would hide it (hair
 *           vertices in front of the spot) it moves down to the cheek, then forward, until it is clear.
 * The tier is the view's (already clamped by viewerInjuryTier and the export): at pg no texture this module draws
 * contains red. A model with no skinned surface (a test rig) falls back to small bone-hung patches, never rings.
 *
 * Idempotent per VRM: applying a new view first removes the old marks and restores every collapsed bone's scale.
 * `three` is passed in so one file serves two bundles with different three.js copies.
 */

import type * as THREENS from 'three';
import type { InjuryRegion, InjuryView, RegionView } from './injury-view';

type Three = typeof THREENS;
type V3 = THREENS.Vector3;
type Obj = THREENS.Object3D;

/** The subset of a three-vrm VRM this needs. */
export interface VrmLike {
  scene: Obj;
  humanoid?: {
    getRawBoneNode(name: string): Obj | null;
  } | null;
}

export interface InjuryOverlayHandle {
  key: string;
  /** What was drawn, as "meshName:textureKind" -> count (tests, smoke drivers). */
  drawn: Record<string, number>;
  dispose(): void;
}

const OVERLAY_TAG = '__aitherInjuryOverlay';
const SEG: Record<string, { up: string; low: string; end: string }> = {
  leftArm: { up: 'leftUpperArm', low: 'leftLowerArm', end: 'leftHand' },
  rightArm: { up: 'rightUpperArm', low: 'rightLowerArm', end: 'rightHand' },
  leftLeg: { up: 'leftUpperLeg', low: 'leftLowerLeg', end: 'leftFoot' },
  rightLeg: { up: 'rightUpperLeg', low: 'rightLowerLeg', end: 'rightFoot' },
};
const REGION_OF: Record<string, string> = {
  hips: 'torso', spine: 'torso', chest: 'torso', upperChest: 'torso', leftShoulder: 'torso', rightShoulder: 'torso',
  neck: 'head', head: 'head', leftEye: 'head', rightEye: 'head', jaw: 'head',
  leftUpperArm: 'leftArm', leftLowerArm: 'leftArm', leftHand: 'leftArm', rightUpperArm: 'rightArm', rightLowerArm: 'rightArm', rightHand: 'rightArm',
  leftUpperLeg: 'leftLeg', leftLowerLeg: 'leftLeg', leftFoot: 'leftLeg', leftToes: 'leftLeg',
  rightUpperLeg: 'rightLeg', rightLowerLeg: 'rightLeg', rightFoot: 'rightLeg', rightToes: 'rightLeg',
};
const RAD = { arm: 0.048, leg: 0.07 };
const NOT_SURFACE = /EYE|FaceMouth|FaceBrow|FaceEyelash|FaceEyeline|Highlight|HAIR|Outline/i;
const HAIR_RE = /HAIR/i;
const CLOTH_RE = /CLOTH|Tops|Bottoms|Shoes|Onepiece|Accessory|shirt|pants|skirt|dress|coat|jacket|boot|sock/i;

// ---------------------------------------------------------------------------------------------------- textures
type Ctx = CanvasRenderingContext2D;
type Rng = () => number;
interface TexOpts { tier?: string; variant?: string; cloth?: boolean; n?: number; blood?: number; state?: string; i?: number }
interface MatOpts { wet?: boolean; layer?: number }

function rng(seed: string): Rng {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function blobPath(x: Ctx, cx: number, cy: number, rx: number, ry: number, r: Rng, n = 10, j = 0.35) {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, k = 1 - j / 2 + r() * j; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); }
  x.beginPath();
  x.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; x.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2); }
  x.closePath();
}
function radial(x: Ctx, cx: number, cy: number, r0: number, stops: Array<[number, string]>) {
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, r0);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}
function trickle(x: Ctx, sx: number, sy: number, len: number, w0: number, col: string, r: Rng) {
  let cx = sx;
  const L: Array<[number, number]> = [], R: Array<[number, number]> = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8, y = sy + len * t, w = w0 * (1 - 0.55 * t); if (i) cx += (r() - 0.5) * w0 * 0.9; L.push([cx - w / 2, y]); R.push([cx + w / 2, y]); }
  x.fillStyle = col;
  x.beginPath(); x.moveTo(L[0][0], L[0][1]);
  for (const p of L) x.lineTo(p[0], p[1]);
  for (const p of R.reverse()) x.lineTo(p[0], p[1]);
  x.closePath(); x.fill();
  const e = L[L.length - 1];
  x.beginPath(); x.ellipse(e[0] + w0 * 0.2, e[1] + w0 * 0.25, w0 * 0.45, w0 * 0.6, 0, 0, 6.29); x.fill();
}
function lens(x: Ctx, cx: number, cy: number, hw: number, hh: number, rot: number) {
  x.save(); x.translate(cx, cy); x.rotate(rot);
  x.beginPath(); x.moveTo(-hw, 0); x.quadraticCurveTo(0, -hh, hw, 0); x.quadraticCurveTo(0, hh, -hw, 0); x.closePath();
  x.restore();
}

const DRAW: Record<string, (x: Ctx, N: number, o: TexOpts, r: Rng) => void> = {
  // open wounds (blood tiers only): a slash, a stab, a bite, lash welts; on cloth a slit and a soak
  wound(x, N, o, r) {
    const gore = o.tier === 'gore', c = N / 2, cy = N * 0.36;
    if (o.cloth) {
      x.fillStyle = radial(x, c, cy + N * 0.06, N * (gore ? 0.36 : 0.26), [[0, 'rgba(58,4,6,.92)'], [0.5, 'rgba(98,10,14,.7)'], [0.85, 'rgba(110,14,16,.35)'], [1, 'rgba(110,14,16,0)']]);
      blobPath(x, c, cy + N * 0.06, N * (gore ? 0.34 : 0.24), N * (gore ? 0.38 : 0.27), r, 12, 0.45); x.fill();
      for (let i = 0; i < (gore ? 4 : 2); i++) trickle(x, c + (r() - 0.5) * N * 0.2, cy + N * 0.12, N * (0.12 + r() * (gore ? 0.3 : 0.14)), N * 0.03, 'rgba(70,6,8,.85)', r);
      x.fillStyle = '#1c0304'; lens(x, c, cy, N * 0.15, N * (gore ? 0.05 : 0.025), -0.35); x.fill();
      return;
    }
    x.fillStyle = radial(x, c, cy, N * (gore ? 0.3 : 0.18), [[0, gore ? 'rgba(90,8,10,.75)' : 'rgba(140,30,30,.45)'], [1, 'rgba(140,30,30,0)']]);
    x.beginPath(); x.arc(c, cy, N * (gore ? 0.3 : 0.18), 0, 6.29); x.fill();
    const flows = gore ? 5 : 2;
    for (let i = 0; i < flows; i++) trickle(x, c + (i - (flows - 1) / 2) * N * 0.07 + (r() - 0.5) * N * 0.03, cy + N * 0.03, N * (gore ? 0.4 + r() * 0.2 : 0.18 + r() * 0.12), N * (gore ? 0.04 : 0.028), gore ? 'rgba(95,6,8,.95)' : 'rgba(120,12,14,.9)', r);
    const v = o.variant;
    if (v === 'stab') {
      const R = N * (gore ? 0.06 : 0.035);
      x.fillStyle = '#7d0c0c'; x.beginPath(); x.ellipse(c, cy, R * 1.6, R, -0.2, 0, 6.29); x.fill();
      x.fillStyle = '#170203'; x.beginPath(); x.ellipse(c, cy, R * 0.85, R * 0.45, -0.2, 0, 6.29); x.fill();
      if (gore) { x.fillStyle = '#b8343c'; lens(x, c, cy - R * 0.2, R * 1.3, R * 0.45, -0.2); x.fill(); }
    } else if (v === 'bite') {
      const R = N * 0.13;
      x.fillStyle = gore ? '#2a0204' : '#4a0606';
      for (const s of [-1, 1]) for (let i = 0; i < 6; i++) { const t = (i / 5 - 0.5) * 2.1; x.beginPath(); x.ellipse(c + Math.sin(t) * R, cy + s * (R * 0.5 - Math.cos(t) * R * 0.25), N * (gore ? 0.022 : 0.014), N * (gore ? 0.016 : 0.01), 0, 0, 6.29); x.fill(); }
      if (gore) { x.fillStyle = '#8e1c22'; blobPath(x, c, cy, R * 0.7, R * 0.35, r); x.fill(); }
    } else if (v === 'lash') {
      for (let i = -1; i <= 1; i++) { x.strokeStyle = gore ? '#6e0a0f' : '#a13a3a'; x.lineWidth = N * (gore ? 0.03 : 0.02); x.lineCap = 'round'; x.beginPath(); x.moveTo(c - N * 0.28, cy + i * N * 0.09); x.quadraticCurveTo(c, cy + i * N * 0.09 - N * 0.03, c + N * 0.28, cy + i * N * 0.09 + N * 0.02); x.stroke(); }
    } else {
      const hw = N * (gore ? 0.24 : 0.18), hh = N * (gore ? 0.07 : 0.028);
      x.fillStyle = '#3d0508'; lens(x, c, cy, hw, hh, -0.35); x.fill();
      x.fillStyle = gore ? '#8e1c22' : '#7d0c0c'; lens(x, c, cy, hw * 0.85, hh * 0.6, -0.35); x.fill();
      if (gore) { x.fillStyle = '#c4525a'; lens(x, c, cy + hh * 0.08, hw * 0.6, hh * 0.32, -0.35); x.fill(); }
    }
  },
  // pg: an abraded patch with fine dark lines, no red
  scrape(x, N, _o, r) {
    const c = N / 2;
    x.fillStyle = radial(x, c, c, N * 0.22, [[0, 'rgba(150,90,80,.45)'], [1, 'rgba(150,90,80,0)']]); x.beginPath(); x.arc(c, c, N * 0.22, 0, 6.29); x.fill();
    x.strokeStyle = 'rgba(110,60,52,.75)'; x.lineWidth = N * 0.008; x.lineCap = 'round';
    for (let i = 0; i < 7; i++) { const y = c + (i - 3) * N * 0.02; x.beginPath(); x.moveTo(c - N * 0.16 + r() * N * 0.04, y); x.lineTo(c + N * 0.12 + r() * N * 0.05, y - N * 0.06); x.stroke(); }
  },
  // pg on a garment: a tear, the linen under-layer showing (never skin, never red)
  tear(x, N, _o, r) {
    const c = N / 2;
    x.fillStyle = 'rgba(60,46,30,.35)'; blobPath(x, c, c, N * 0.24, N * 0.13, r, 12, 0.5); x.fill();
    x.fillStyle = '#ddd2ba'; x.strokeStyle = '#1d140e'; x.lineWidth = N * 0.01;
    x.beginPath();
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, k = 0.55 + r() * 0.6; const px = c + Math.cos(a) * N * 0.17 * k, py = c + Math.sin(a) * N * 0.06 * k; if (i) x.lineTo(px, py); else x.moveTo(px, py); }
    x.closePath(); x.fill(); x.stroke();
  },
  bruise(x, N, o, r) {
    const c = N / 2, k = 0.6 + 0.15 * (o.n || 1);
    x.fillStyle = radial(x, c, c, N * 0.45, [[0, `rgba(46,24,70,${0.7 * k})`], [0.45, `rgba(79,48,112,${0.5 * k})`], [0.75, `rgba(107,106,58,${0.25 * k})`], [1, 'rgba(107,106,58,0)']]);
    blobPath(x, c, c, N * 0.45, N * 0.36, r, 10, 0.3); x.fill();
  },
  burn(x, N, o, r) {
    const c = N / 2;
    if (o.tier === 'pg') {
      x.fillStyle = '#ece4cf'; x.strokeStyle = '#9a907a'; x.lineWidth = N * 0.01;
      x.fillRect(c - N * 0.24, c - N * 0.18, N * 0.48, N * 0.36); x.strokeRect(c - N * 0.24, c - N * 0.18, N * 0.48, N * 0.36);
      x.fillStyle = '#d6cbb0'; x.fillRect(c - N * 0.34, c - N * 0.12, N * 0.68, N * 0.05); x.fillRect(c - N * 0.34, c + N * 0.07, N * 0.68, N * 0.05);
      return;
    }
    if (o.cloth) { x.fillStyle = 'rgba(30,18,10,.7)'; blobPath(x, c, c, N * 0.36, N * 0.3, r, 12, 0.5); x.fill(); }
    if (o.tier === 'gore') {
      x.fillStyle = radial(x, c, c, N * 0.3, [[0, '#140a08'], [0.55, '#3a1a10'], [0.8, '#8a1c1c'], [1, 'rgba(184,72,74,0)']]); blobPath(x, c, c, N * 0.3, N * 0.24, r, 11, 0.45); x.fill();
    } else {
      x.fillStyle = radial(x, c, c, N * 0.28, [[0, 'rgba(192,69,60,.95)'], [0.6, 'rgba(213,106,90,.8)'], [0.85, 'rgba(138,42,34,.55)'], [1, 'rgba(138,42,34,0)']]); blobPath(x, c, c, N * 0.28, N * 0.22, r, 10, 0.4); x.fill();
    }
  },
  scar(x, N) {
    const c = N / 2;
    x.strokeStyle = 'rgba(233,201,184,.9)'; x.lineWidth = N * 0.016; x.lineCap = 'round';
    x.beginPath(); x.moveTo(c - N * 0.2, c + N * 0.06); x.lineTo(c + N * 0.2, c - N * 0.06); x.stroke();
    x.lineWidth = N * 0.008;
    for (let t = -0.15; t <= 0.16; t += 0.075) { x.beginPath(); x.moveTo(c + N * t - N * 0.015, c - N * t * 0.3 - N * 0.03); x.lineTo(c + N * t + N * 0.015, c - N * t * 0.3 + N * 0.03); x.stroke(); }
  },
  // a taped gauze pad (head / torso): never a band
  pad(x, N, o) {
    const c = N / 2;
    x.fillStyle = '#ece4cf'; x.strokeStyle = '#9a907a'; x.lineWidth = N * 0.012;
    x.beginPath(); x.rect(c - N * 0.2, c - N * 0.16, N * 0.4, N * 0.32); x.fill(); x.stroke();
    x.fillStyle = '#d8cdb0';
    x.save(); x.translate(c, c); x.rotate(0.6); x.fillRect(-N * 0.32, -N * 0.035, N * 0.64, N * 0.07); x.rotate(-1.2); x.fillRect(-N * 0.32, -N * 0.035, N * 0.64, N * 0.07); x.restore();
    if (o.blood && o.tier !== 'pg') { x.fillStyle = radial(x, c, c, N * 0.12, [[0, o.tier === 'gore' ? 'rgba(74,6,6,.9)' : 'rgba(125,12,12,.75)'], [1, 'rgba(125,12,12,0)']]); x.beginPath(); x.arc(c, c, N * 0.12, 0, 6.29); x.fill(); }
  },
  spatter(x, N, o, r) {
    const n = o.tier === 'gore' ? 26 : 10;
    for (let i = 0; i < n; i++) { const px = N * (0.1 + r() * 0.8), py = N * (0.1 + r() * 0.8), rr = N * (0.006 + r() * (o.tier === 'gore' ? 0.022 : 0.012)); x.fillStyle = `rgba(${(90 + r() * 40) | 0},8,10,${0.6 + r() * 0.35})`; x.beginPath(); x.ellipse(px, py, rr, rr * (0.7 + r() * 0.7), r() * 3, 0, 6.29); x.fill(); }
  },
  gauze(x, N, o, r) {
    x.fillStyle = '#ece4cf'; x.fillRect(0, N * 0.06, N, N * 0.88);
    x.strokeStyle = 'rgba(160,150,124,.75)'; x.lineWidth = N * 0.012;
    for (let i = -2; i < 6; i++) { x.beginPath(); x.moveTo(i * N * 0.25, N * 0.06); x.lineTo(i * N * 0.25 + N * 0.5, N * 0.94); x.stroke(); }
    x.fillStyle = 'rgba(120,110,90,.25)'; x.fillRect(0, N * 0.06, N, N * 0.05); x.fillRect(0, N * 0.89, N, N * 0.05);
    if (o.blood && o.tier !== 'pg') {
      const gore = o.tier === 'gore';
      x.fillStyle = radial(x, N * 0.3, N * 0.5, N * (gore ? 0.36 : 0.24), [[0, gore ? 'rgba(60,5,6,.92)' : 'rgba(125,12,12,.75)'], [0.7, 'rgba(125,12,12,.35)'], [1, 'rgba(125,12,12,0)']]);
      blobPath(x, N * 0.3, N * 0.5, N * (gore ? 0.34 : 0.22), N * (gore ? 0.34 : 0.26), r); x.fill();
    }
  },
  stump(x, N, o, r) {
    const c = N / 2;
    if (o.state === 'raw') {
      x.fillStyle = radial(x, c, c, N * 0.5, [[0, '#c4525a'], [0.5, '#9c1c22'], [1, '#5a0a0e']]); x.fillRect(0, 0, N, N);
      x.strokeStyle = 'rgba(232,197,154,.85)'; x.lineWidth = N * 0.03; x.beginPath(); x.arc(c, c, N * 0.4, 0, 6.29); x.stroke();
      x.fillStyle = '#efe3cf'; x.beginPath(); x.ellipse(c - N * 0.04, c + N * 0.02, N * 0.1, N * 0.08, 0.3, 0, 6.29); x.fill();
      return;
    }
    x.fillStyle = '#ece4cf'; x.fillRect(0, 0, N, N);
    x.strokeStyle = 'rgba(160,150,124,.7)'; x.lineWidth = N * 0.012;
    for (let i = 0; i < 5; i++) { x.beginPath(); x.arc(c, c, N * (0.1 + i * 0.09), 0.2 * i, 0.2 * i + 4.6); x.stroke(); }
    if (o.state === 'bloody' && o.tier !== 'pg') { x.fillStyle = radial(x, c, c, N * 0.5, [[0, 'rgba(74,6,6,.92)'], [0.45, 'rgba(125,12,12,.75)'], [0.8, 'rgba(125,12,12,.35)'], [1, 'rgba(125,12,12,0)']]); blobPath(x, c, c, N * 0.48, N * 0.46, r); x.fill(); }
  },
  drips(x, N, _o, r) {
    for (let i = 0; i < 5; i++) trickle(x, N * (0.25 + i * 0.12) + (r() - 0.5) * N * 0.05, N * 0.05, N * (0.4 + r() * 0.45), N * 0.045, 'rgba(98,8,10,.92)', r);
  },
  wood(x, N) {
    x.fillStyle = '#8a6a44'; x.fillRect(0, 0, N, N);
    x.strokeStyle = 'rgba(90,65,40,.6)'; x.lineWidth = 2;
    for (let i = 0; i < 10; i++) { x.beginPath(); x.moveTo(0, (i * N) / 10 + 3); x.bezierCurveTo(N * 0.3, (i * N) / 10 + 8, N * 0.6, (i * N) / 10 - 2, N, (i * N) / 10 + 4); x.stroke(); }
  },
};
/** Texture kinds that are red by construction: never drawn below the blood tier (asserted by the tests). */
export const RED_KINDS: ReadonlySet<string> = new Set(['wound', 'spatter', 'drips']);
/** A flat colour per kind, for a context with no canvas (node tests). */
const FLAT: Record<string, number> = {
  wound: 0x8e1c22, scrape: 0x96594f, tear: 0xddd2ba, bruise: 0x4f3070, burn: 0x8a2a14, scar: 0xe9c9b8, pad: 0xece4cf,
  spatter: 0x7a0a0c, gauze: 0xece4cf, stump: 0xece4cf, drips: 0x62080a, wood: 0x8a6a44,
};

interface Kit {
  THREE: Three;
  tex: Map<string, THREENS.Texture>;
  geoms: THREENS.BufferGeometry[];
  mats: THREENS.Material[];
  added: Obj[];
  drawn: Record<string, number>;
}

function texFor(K: Kit, kind: string, o: TexOpts = {}): THREENS.Texture {
  const { THREE } = K;
  const key = kind + '|' + JSON.stringify(o);
  const hit = K.tex.get(key);
  if (hit) return hit;
  let t: THREENS.Texture;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = ((): Ctx | null => {
    try {
      return canvas ? canvas.getContext('2d') : null;
    } catch {
      return null; // jsdom without the canvas package
    }
  })();
  if (canvas && ctx) {
    const N = kind === 'gauze' || kind === 'stump' || kind === 'wood' ? 128 : 256;
    canvas.width = N;
    canvas.height = N;
    DRAW[kind](ctx, N, o, rng(key));
    t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    if (kind === 'gauze') t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 4;
  } else {
    const c = new THREE.Color(FLAT[kind] ?? 0xffffff);
    t = new THREE.DataTexture(new Uint8Array([c.r * 255, c.g * 255, c.b * 255, 255]), 1, 1);
  }
  t.needsUpdate = true;
  t.userData = { injuryKind: kind, tier: o.tier ?? '' };
  K.tex.set(key, t);
  return t;
}
function decalMat(K: Kit, tex: THREENS.Texture, o: MatOpts = {}) {
  const { THREE } = K;
  const layer = o.layer || 0;
  const m = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, alphaTest: 0.02, roughness: o.wet ? 0.35 : 0.85, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2 - layer, polygonOffsetUnits: -4 - layer * 2, side: THREE.FrontSide,
  });
  m.userData = { aitherInjury: true, injuryKind: tex.userData.injuryKind };
  K.mats.push(m);
  return m;
}
function note(K: Kit, name: string, kind: string) {
  const k = `${name}:${kind}`;
  K.drawn[k] = (K.drawn[k] || 0) + 1;
}

// ------------------------------------------------------------------------------------------------------ surfaces
interface Surf { mesh: THREENS.SkinnedMesh; cloth: boolean; P: Float32Array; seg: string[]; n: number }
interface Body { root: Obj; get(n: string): Obj | null }
interface Hit { S: Surf; i: number }
interface Patch { mesh: THREENS.SkinnedMesh; parent: Obj | null }
interface Lat { dir: V3; lo: number; hi: number }

function wpos(THREE: Three, b: Obj | null): V3 { const v = new THREE.Vector3(); if (b) b.getWorldPosition(v); return v; }

function firstMaterial(o: THREENS.Mesh): THREENS.Material | null {
  const ms = ([] as THREENS.Material[]).concat(o.material as THREENS.Material | THREENS.Material[]);
  return ms.find((q) => q && !/Outline/i.test(q.name || '')) ?? null;
}

/** Posed world positions + the humanoid segment of every vertex of the skinned meshes `pick` accepts. */
function surfaces(THREE: Three, G: Body, pick: (name: string) => boolean): Surf[] {
  const out: Surf[] = [];
  const named = new Map<Obj, string>();
  for (const n of Object.keys(REGION_OF)) { const b = G.get(n); if (b && !named.has(b)) named.set(b, n); }
  const humanOf = new Map<Obj, string>();
  const resolve = (b: Obj | undefined): string => {
    if (!b) return '';
    const known = humanOf.get(b);
    if (known !== undefined) return known;
    let h = '';
    for (let p: Obj | null = b; p; p = p.parent) { const n = named.get(p); if (n) { h = n; break; } }
    humanOf.set(b, h);
    return h;
  };
  G.root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  G.root.traverse((o) => {
    const sm = o as THREENS.SkinnedMesh;
    if (!sm.isSkinnedMesh || sm.userData.aitherInjury || !sm.visible) return;
    const m = firstMaterial(sm);
    if (!m || m.visible === false || !pick(m.name || '')) return;
    const g = sm.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (!pos || !si || !sw || !g.attributes.normal) return;
    try { sm.skeleton.update(); } catch { /* bone matrices from the last frame */ }
    const n = pos.count, P = new Float32Array(n * 3), seg = new Array<string>(n);
    const bones = sm.skeleton.bones;
    for (let i = 0; i < n; i++) {
      sm.getVertexPosition(i, v);
      v.applyMatrix4(sm.matrixWorld);
      P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
      seg[i] = resolve(bones[best]);
    }
    out.push({ mesh: sm, cloth: CLOTH_RE.test(m.name || ''), P, seg, n });
  });
  return out;
}

function frameOf(THREE: Three, G: Body) {
  const L = wpos(THREE, G.get('leftUpperLeg')), R = wpos(THREE, G.get('rightUpperLeg'));
  const left = L.clone().sub(R);
  if (left.lengthSq() < 1e-8) left.set(1, 0, 0);
  left.normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
  return { left, fwd, up };
}

/** The outermost surface vertex at the wound spot (the shirt beats the skin under it). */
function spotOn(THREE: Three, surfs: Surf[], segs: Set<string>, anchor: V3, axis: V3, out: V3, slab: number, lat: Lat | null): Hit | null {
  let best: Hit | null = null, bd = -Infinity;
  const tmp = new THREE.Vector3();
  for (const S of surfs) for (let i = 0; i < S.n; i++) {
    if (!segs.has(S.seg[i])) continue;
    tmp.set(S.P[i * 3] - anchor.x, S.P[i * 3 + 1] - anchor.y, S.P[i * 3 + 2] - anchor.z);
    if (Math.abs(tmp.dot(axis)) > slab) continue;
    if (lat) { const l = tmp.dot(lat.dir); if (l < lat.lo || l > lat.hi) continue; }
    const d = tmp.dot(out);
    if (d > bd) { bd = d; best = { S, i }; }
  }
  return best;
}

/** Is the surface point C hidden by hair: a hair vertex within `r` of the ray C + t*out, 0 < t < reach. */
export function hairCovers(hair: ReadonlyArray<{ P: Float32Array; n: number }>, C: V3, out: V3, r = 0.022, reach = 0.09): boolean {
  for (const S of hair) for (let i = 0; i < S.n; i++) {
    const dx = S.P[i * 3] - C.x, dy = S.P[i * 3 + 1] - C.y, dz = S.P[i * 3 + 2] - C.z;
    const t = dx * out.x + dy * out.y + dz * out.z;
    if (t <= 0.002 || t > reach) continue;
    const px = dx - out.x * t, py = dy - out.y * t, pz = dz - out.z * t;
    if (px * px + py * py + pz * pz < r * r) return true;
  }
  return false;
}

/** Copy the chosen triangles of S into a new SkinnedMesh on the same skeleton, UVs from `uvOf`. */
function patchMesh(K: Kit, S: Surf, tri: number[], uvOf: (i: number, out: [number, number]) => void, push: number, tex: THREENS.Texture, matOpts: MatOpts, wrapFix = false): Patch | null {
  const { THREE } = K;
  const src = S.mesh, g = src.geometry, A = g.attributes;
  const remap = new Map<number, number>(), list: number[] = [];
  for (const i of tri) if (!remap.has(i)) { remap.set(i, list.length); list.push(i); }
  const n = list.length;
  let pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const u2: [number, number] = [0, 0];
  for (let k = 0; k < n; k++) {
    const i = list[k];
    const nx = A.normal.getX(i), ny = A.normal.getY(i), nz = A.normal.getZ(i);
    pos[k * 3] = A.position.getX(i) + nx * push; pos[k * 3 + 1] = A.position.getY(i) + ny * push; pos[k * 3 + 2] = A.position.getZ(i) + nz * push;
    nrm[k * 3] = nx; nrm[k * 3 + 1] = ny; nrm[k * 3 + 2] = nz;
    for (let c = 0; c < 4; c++) { si[k * 4 + c] = A.skinIndex.getComponent(i, c); sw[k * 4 + c] = A.skinWeight.getComponent(i, c); }
    uvOf(i, u2);
    uv[k * 2] = u2[0]; uv[k * 2 + 1] = u2[1];
  }
  let index = tri.map((i) => remap.get(i) as number);
  if (wrapFix) {
    // a triangle straddling the wrap's u seam: duplicate its low-u vertices a full turn on
    const extra: Array<{ j: number; u: number }> = [];
    const idx2: number[] = [];
    for (let t = 0; t < index.length; t += 3) {
      const ids = [index[t], index[t + 1], index[t + 2]], us = ids.map((j) => uv[j * 2]);
      if (Math.max(...us) - Math.min(...us) > 1.5) {
        idx2.push(...ids.map((j) => { if (uv[j * 2] < 1.5) { extra.push({ j, u: uv[j * 2] + 3 }); return n + extra.length - 1; } return j; }));
      } else idx2.push(...ids);
    }
    if (extra.length) {
      const m = n + extra.length;
      const p2 = new Float32Array(m * 3), n2 = new Float32Array(m * 3), uv2 = new Float32Array(m * 2), si2 = new Uint16Array(m * 4), sw2 = new Float32Array(m * 4);
      p2.set(pos); n2.set(nrm); uv2.set(uv); si2.set(si); sw2.set(sw);
      extra.forEach((x, e) => {
        const d = n + e;
        for (let c = 0; c < 3; c++) { p2[d * 3 + c] = pos[x.j * 3 + c]; n2[d * 3 + c] = nrm[x.j * 3 + c]; }
        for (let c = 0; c < 4; c++) { si2[d * 4 + c] = si[x.j * 4 + c]; sw2[d * 4 + c] = sw[x.j * 4 + c]; }
        uv2[d * 2] = x.u; uv2[d * 2 + 1] = uv[x.j * 2 + 1];
        list.push(list[x.j]);
      });
      pos = p2; nrm = n2; uv = uv2; si = si2; sw = sw2;
    }
    index = idx2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setIndex(index);
  const mp = g.morphAttributes && g.morphAttributes.position;
  if (mp && mp.length && src.morphTargetInfluences) {
    // the face's expressions move the mark with it
    geo.morphAttributes.position = mp.map((attr) => {
      const a = new Float32Array(list.length * 3);
      list.forEach((i, k) => { a[k * 3] = attr.getX(i); a[k * 3 + 1] = attr.getY(i); a[k * 3 + 2] = attr.getZ(i); });
      return new THREE.BufferAttribute(a, 3);
    });
    geo.morphTargetsRelative = g.morphTargetsRelative;
  }
  K.geoms.push(geo);
  const mesh = new THREE.SkinnedMesh(geo, decalMat(K, tex, matOpts));
  if (geo.morphAttributes.position) { mesh.morphTargetInfluences = src.morphTargetInfluences; mesh.morphTargetDictionary = src.morphTargetDictionary; }
  mesh.name = 'aitherWound';
  mesh.frustumCulled = false;
  mesh.renderOrder = (src.renderOrder || 0) + 2 + (matOpts.layer || 0);
  mesh.userData.aitherInjury = true;
  mesh.raycast = () => {};
  mesh.bind(src.skeleton, src.bindMatrix);
  mesh.bindMode = src.bindMode;
  // a SIBLING of the source surface, same local transform
  mesh.position.copy(src.position); mesh.quaternion.copy(src.quaternion); mesh.scale.copy(src.scale);
  return { mesh, parent: src.parent };
}

/** A skinned patch of S's triangles around C (world), planar-projected (U across, V = `down`). */
function buildDecal(K: Kit, S: Surf, C: V3, N: V3, down: V3, R: number, tex: THREENS.Texture, matOpts: MatOpts, segs: Set<string>): Patch | null {
  const { THREE } = K;
  const g = S.mesh.geometry, idx = g.index, P = S.P;
  const triCount = idx ? idx.count / 3 : S.n / 3;
  const Vd = down.clone().sub(N.clone().multiplyScalar(down.dot(N)));
  if (Vd.lengthSq() < 1e-6) Vd.set(0, -1, 0);
  Vd.normalize();
  const U = new THREE.Vector3().crossVectors(N, Vd).normalize();
  const R2 = R * R * 1.3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  const keep: number[] = [];
  const at = (i: number, v: V3) => v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    if (!(segs.has(S.seg[i0]) || segs.has(S.seg[i1]) || segs.has(S.seg[i2]))) continue;
    at(i0, a); at(i1, b); at(i2, c);
    if (a.distanceToSquared(C) > R2 && b.distanceToSquared(C) > R2 && c.distanceToSquared(C) > R2) continue;
    if (a.distanceToSquared(C) > R2 * 2.2 || b.distanceToSquared(C) > R2 * 2.2 || c.distanceToSquared(C) > R2 * 2.2) continue;
    fn.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    if (fn.lengthSq() < 1e-14) continue;
    if (fn.normalize().dot(N) < 0.15) continue;
    keep.push(i0, i1, i2);
  }
  if (!keep.length) return null;
  return patchMesh(K, S, keep, (i, out) => {
    at(i, a).sub(C);
    out[0] = 0.5 + a.dot(U) / (2 * R);
    out[1] = 0.5 - a.dot(Vd) / (2 * R);
  }, 0.0014, tex, matOpts);
}

/** The outermost layers in a slab of `segs` around C (the sleeve over the arm, not the skin under it). */
function outerLayers(THREE: Three, surfs: Surf[], segs: Set<string>, C: V3, axis: V3, lo: number, hi: number): Surf[] {
  const tmp = new THREE.Vector3();
  const layers: Array<{ S: Surf; r: number }> = [];
  for (const S of surfs) {
    let cnt = 0, rs = 0;
    for (let i = 0; i < S.n; i++) {
      if (!segs.has(S.seg[i])) continue;
      tmp.set(S.P[i * 3] - C.x, S.P[i * 3 + 1] - C.y, S.P[i * 3 + 2] - C.z);
      const ax = tmp.dot(axis);
      if (ax < lo || ax > hi) continue;
      rs += tmp.sub(axis.clone().multiplyScalar(ax)).length();
      cnt++;
    }
    if (cnt >= 6) layers.push({ S, r: rs / cnt });
  }
  if (!layers.length) return [];
  const rMax = Math.max(...layers.map((L) => L.r));
  return layers.filter((L) => L.r >= rMax - 0.006).map((L) => L.S);
}

/** A ring of the limb's OUTERMOST surface around C along `axis` (half-height h): a wrap that follows the limb. */
function buildWrap(K: Kit, surfs: Surf[], segs: Set<string>, C: V3, axis: V3, h: number, push: number, tex: THREENS.Texture, matOpts: MatOpts, ref: V3): Patch[] {
  const { THREE } = K;
  const tmp = new THREE.Vector3();
  const refV = ref.clone().sub(axis.clone().multiplyScalar(ref.dot(axis))).normalize();
  const side = new THREE.Vector3().crossVectors(axis, refV);
  const meshes: Patch[] = [];
  for (const S of outerLayers(THREE, surfs, segs, C, axis, -h, h)) {
    const g = S.mesh.geometry, idx = g.index, P = S.P, keep: number[] = [];
    const triCount = idx ? idx.count / 3 : S.n / 3;
    const axOf = (i: number) => (P[i * 3] - C.x) * axis.x + (P[i * 3 + 1] - C.y) * axis.y + (P[i * 3 + 2] - C.z) * axis.z;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      if (!(segs.has(S.seg[i0]) && segs.has(S.seg[i1]) && segs.has(S.seg[i2]))) continue;
      if (Math.abs((axOf(i0) + axOf(i1) + axOf(i2)) / 3) > h) continue;
      keep.push(i0, i1, i2);
    }
    if (!keep.length) continue;
    const angOf = (i: number) => {
      tmp.set(P[i * 3] - C.x, P[i * 3 + 1] - C.y, P[i * 3 + 2] - C.z);
      tmp.sub(axis.clone().multiplyScalar(tmp.dot(axis)));
      return Math.atan2(tmp.dot(side), tmp.dot(refV));
    };
    const m = patchMesh(K, S, keep, (i, out) => { out[0] = (angOf(i) / (Math.PI * 2) + 0.5) * 3; out[1] = 0.5 + axOf(i) / (2 * h); }, push, tex, matOpts, true);
    if (m) { m.mesh.name = 'aitherWoundWrap'; meshes.push(m); }
  }
  return meshes;
}

/** The closed end of a severed limb: the outermost layer's triangles in the last `h` of the parent segment plus every
 *  triangle of the severed segment(s), which collapse onto the joint; textured end-on. */
function buildEnd(K: Kit, surfs: Surf[], psegs: Set<string>, endSegs: Set<string>, J: V3, axis: V3, h: number, tex: THREENS.Texture, matOpts: MatOpts, ref: V3): Patch[] {
  const { THREE } = K;
  const tmp = new THREE.Vector3();
  const refV = ref.clone().sub(axis.clone().multiplyScalar(ref.dot(axis))).normalize();
  const side = new THREE.Vector3().crossVectors(axis, refV);
  const out: Patch[] = [];
  for (const S of outerLayers(THREE, surfs, psegs, J, axis, -h, 0.02)) {
    const g = S.mesh.geometry, idx = g.index, P = S.P, keep: number[] = [];
    const ok = (i: number) => {
      if (endSegs.has(S.seg[i])) return true;
      if (!psegs.has(S.seg[i])) return false;
      return (P[i * 3] - J.x) * axis.x + (P[i * 3 + 1] - J.y) * axis.y + (P[i * 3 + 2] - J.z) * axis.z >= -h;
    };
    const triCount = idx ? idx.count / 3 : S.n / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      if (ok(i0) && ok(i1) && ok(i2)) keep.push(i0, i1, i2);
    }
    if (!keep.length) continue;
    const m = patchMesh(K, S, keep, (i, o) => {
      tmp.set(P[i * 3] - J.x, P[i * 3 + 1] - J.y, P[i * 3 + 2] - J.z);
      const a = tmp.dot(axis), rr = (Math.max(0, -a) / h) * 0.45 + 0.05;
      const tx = tmp.dot(side), tz = tmp.dot(refV), l = Math.hypot(tx, tz) || 1;
      o[0] = 0.5 + (tx / l) * rr;
      o[1] = 0.5 + (tz / l) * rr;
    }, 0.0015, tex, matOpts);
    if (m) { m.mesh.name = 'aitherWoundStump'; out.push(m); }
  }
  return out;
}

function lostBone(seg: { up: string; low: string; end: string }, missing: string) {
  return missing === 'hand' || missing === 'foot' ? seg.end : missing === 'forearm' || missing === 'calf' ? seg.low : seg.up;
}

function buildSurfaceMarks(K: Kit, G: Body, view: InjuryView, surfs: Surf[], hair: Surf[]) {
  const { THREE } = K;
  const F = frameOf(THREE, G);
  const tier = view.tier, red = tier !== 'pg', gore = tier === 'gore';
  const add = (r: Patch | null) => {
    if (!r) return;
    (r.parent || G.root).add(r.mesh);
    K.added.push(r.mesh);
    note(K, r.mesh.name, String((r.mesh.material as THREENS.Material).userData.injuryKind));
  };
  const addAll = (arr: Patch[]) => { for (const r of arr) add(r); };
  const pt = (h: Hit) => new THREE.Vector3(h.S.P[h.i * 3], h.S.P[h.i * 3 + 1], h.S.P[h.i * 3 + 2]);
  // hidden = hair in front of the spot along its own normal OR toward the viewer facing the body
  // (the tube is as wide as the mark: a strand anywhere over the decal hides part of it)
  const hidden = (h: Hit, out: V3, r: number) => hairCovers(hair, pt(h), out, r) || hairCovers(hair, pt(h), F.fwd, r);
  let lat: Lat | null = null;
  let avoidHair = false;
  /** On the head every mark is small (a temple / cheek mark, never a mask over the face). */
  let capR = Infinity;
  const decalAt = (segs: Set<string>, anchor: V3, axis: V3, out0: V3, down: V3, R0: number, tex: THREENS.Texture | ((cloth: boolean) => THREENS.Texture), matOpts: MatOpts, slab = 0.03) => {
    let out = out0;
    const R = Math.min(R0, capR);
    let hit = spotOn(THREE, surfs, segs, anchor, axis, out, slab, lat);
    if (hit && avoidHair && hair.length && hidden(hit, out, 0.025)) {
      // HEAD: hair would hide the mark: walk forward onto the cheek until a spot is clear (never the eyes)
      const toward = (l: number) => F.left.clone().multiplyScalar(l).add(F.fwd).normalize();
      const tries: Array<{ a: V3; o: V3; l: Lat | null }> = [
        { a: anchor.clone().add(F.up.clone().multiplyScalar(-0.03)), o: toward(0.45), l: lat ? { dir: lat.dir, lo: 0.04, hi: 0.075 } : null },
        { a: anchor.clone().add(F.up.clone().multiplyScalar(-0.045)), o: toward(0.25), l: lat ? { dir: lat.dir, lo: 0.025, hi: 0.06 } : null },
        { a: anchor.clone().add(F.up.clone().multiplyScalar(-0.06)), o: toward(0.1), l: lat ? { dir: lat.dir, lo: 0.015, hi: 0.045 } : null },
      ];
      for (const t of tries) {
        const next = spotOn(THREE, surfs, segs, t.a, axis, t.o, slab, t.l);
        if (!next) continue;
        hit = next;
        out = t.o;
        if (!hidden(next, out, 0.025)) break;
      }
    }
    if (!hit) return null;
    const C = pt(hit);
    add(buildDecal(K, hit.S, C, out, down, R, typeof tex === 'function' ? tex(hit.S.cloth) : tex, matOpts, segs));
    return hit;
  };
  for (const region of Object.keys(view.regions) as InjuryRegion[]) {
    const R: RegionView = view.regions[region];
    const seg = SEG[region];
    let segs: Set<string> | null = null, anchor: V3 | null = null;
    let axis = F.up.clone(), out = F.fwd.clone(), down = new THREE.Vector3(0, -1, 0), boneLen = 0.25;
    lat = null;
    avoidHair = false;
    capR = region === 'head' ? 0.045 : Infinity;
    if (seg) {
      const lost = R.missing ? lostBone(seg, R.missing) : '';
      const useUpper = lost === seg.low || R.missing === 'arm' || R.missing === 'leg';
      const upB = R.missing === 'arm' || R.missing === 'leg' ? null : G.get(useUpper ? seg.up : seg.low);
      const lowB = G.get(useUpper ? seg.low : seg.end);
      if (upB && lowB) {
        const a = wpos(THREE, upB), b = wpos(THREE, lowB);
        axis = b.clone().sub(a);
        boneLen = axis.length() || 0.25;
        axis.normalize();
        anchor = a.clone().lerp(b, 0.5);
        segs = new Set([useUpper ? seg.up : seg.low]);
        out = F.fwd.clone().sub(axis.clone().multiplyScalar(F.fwd.dot(axis))).normalize();
        down = axis.clone(); // toward the hand / foot: a hanging limb's "down"
      }
    } else if (region === 'torso') {
      const a = wpos(THREE, G.get('chest') || G.get('spine')), b = wpos(THREE, G.get('hips') || G.get('spine'));
      anchor = a.clone().lerp(b, 0.35).add(F.left.clone().multiplyScalar(0.06));
      boneLen = Math.max(0.2, a.distanceTo(b));
      segs = new Set(['spine', 'chest', 'hips', 'upperChest']);
      out = F.fwd.clone().add(F.left.clone().multiplyScalar(0.35)).normalize();
    } else if (region === 'head') {
      // the char-left temple, OUTSIDE the eye: never across the eyes, never a band
      anchor = wpos(THREE, G.get('head')).add(F.up.clone().multiplyScalar(0.035));
      lat = { dir: F.left.clone(), lo: 0.055, hi: 0.09 };
      segs = new Set(['head']);
      out = F.left.clone().multiplyScalar(0.55).add(F.fwd.clone().multiplyScalar(0.85)).normalize();
      avoidHair = true;
    }
    // ---- stump: the flush end patch, a wrap above it, runs of blood at gore ----
    if (seg && R.missing && R.stump !== 'healed') {
      const lostName = lostBone(seg, R.missing);
      const cut = G.get(lostName), par = cut && cut.parent;
      const parName = R.missing === 'hand' || R.missing === 'foot' ? seg.low : R.missing === 'forearm' || R.missing === 'calf' ? seg.up : '';
      const pb = parName ? G.get(parName) : null;
      if (cut && par) {
        const J = wpos(THREE, cut);
        const ax = J.clone().sub(pb ? wpos(THREE, pb) : wpos(THREE, par));
        const len = ax.length() || 0.2;
        ax.normalize();
        const psegs = new Set(parName ? [parName] : ['hips', 'spine', 'chest', 'upperChest']);
        const stState = R.stump === 'raw' && gore ? 'raw' : R.stump === 'bloody' && red ? 'bloody' : 'bandaged';
        const endSegs = new Set([lostName, ...(lostName === seg.low ? [seg.end] : [])]);
        addAll(buildEnd(K, surfs, psegs, endSegs, J, ax, len * 0.14, texFor(K, 'stump', { state: stState, tier }), { layer: 2, wet: stState !== 'bandaged' }, F.fwd));
        if (stState !== 'raw' && R.stump !== 'covered' && pb) {
          addAll(buildWrap(K, surfs, psegs, J.clone().add(ax.clone().multiplyScalar(-len * 0.22)), ax, len * 0.06, 0.004, texFor(K, 'gauze', { blood: stState === 'bloody' ? 1 : 0, tier }), { layer: 1 }, F.fwd));
        }
        if (stState === 'raw' && pb) {
          decalAt(psegs, J.clone().add(ax.clone().multiplyScalar(-len * 0.18)), ax, F.fwd.clone().sub(ax.clone().multiplyScalar(F.fwd.dot(ax))).normalize(), ax, 0.09, texFor(K, 'drips', { tier }), { wet: true, layer: 1 }, len * 0.08);
        }
      }
    }
    if (!segs || !anchor) continue;
    // ---- the marks on the surviving surface ----
    for (let k = 0; k < Math.min(R.scar, 3); k++) {
      decalAt(segs, anchor.clone().add(axis.clone().multiplyScalar(-boneLen * (0.22 - 0.16 * k))), axis, out, down, 0.03, texFor(K, 'scar', { i: k }), { layer: 0 });
    }
    if (R.bruise) decalAt(segs, anchor.clone().add(axis.clone().multiplyScalar(boneLen * 0.12)), axis, out, down, (0.035 + 0.012 * R.bruise) * (region === 'head' ? 0.5 : 1), texFor(K, 'bruise', { n: R.bruise }), { layer: 0 });
    if (R.burn) {
      decalAt(segs, anchor.clone().add(axis.clone().multiplyScalar(seg ? -boneLen * 0.12 : -0.05)), axis, out, down, (tier === 'pg' ? 0.035 : 0.04) + 0.012 * R.burn, (cloth) => texFor(K, 'burn', { tier, cloth: tier === 'pg' ? false : cloth }), { layer: 1, wet: gore });
    }
    const woundAt = region === 'head' ? anchor : anchor.clone().add(axis.clone().multiplyScalar(seg ? -boneLen * 0.05 : 0));
    if (red && (R.open || R.blood) && !R.bandage) {
      const Rr = (region === 'head' ? 0.035 : 0.06) * (gore ? 1.4 : 1) * (1 + 0.12 * (R.open || 1));
      decalAt(segs, woundAt, axis, out, down, Rr, (cloth) => texFor(K, 'wound', { tier, variant: R.wound || 'cut', cloth }), { layer: 2, wet: true });
    } else if (R.torn && !R.bandage) {
      decalAt(segs, woundAt, axis, out, down, 0.04, (cloth) => texFor(K, cloth ? 'tear' : 'scrape', {}), { layer: 2 });
    }
    if (R.bandage && !R.missing) {
      if (region === 'head' || region === 'torso') {
        // a taped dressing over the wound, flush on the surface (a wrap round the torso read as a sash)
        decalAt(segs, woundAt, axis, out, down, region === 'head' ? 0.05 : 0.08, texFor(K, 'pad', { blood: red ? R.blood : 0, tier }), { layer: 3 });
      } else {
        addAll(buildWrap(K, surfs, segs, woundAt, axis, 0.035, 0.004, texFor(K, 'gauze', { blood: red ? R.blood : 0, tier }), { layer: 3 }, F.fwd));
      }
    }
    // ---- splint: only on a break that was SET; two slats at the measured surface, three ties ----
    if (R.broken && R.splinted && !R.missing && seg) {
      const upper = R.brokenAt === 'upper';
      const b0 = G.get(upper ? seg.up : seg.low), b1 = G.get(upper ? seg.low : seg.end);
      if (b0 && b1) {
        const A = wpos(THREE, b0), ax = wpos(THREE, b1).sub(A);
        const len = ax.length() || 0.3;
        ax.normalize();
        const bsegs = new Set([upper ? seg.up : seg.low]);
        const latV = new THREE.Vector3().crossVectors(ax, F.fwd);
        if (latV.lengthSq() < 1e-6) latV.copy(F.left);
        latV.normalize();
        const tmp = new THREE.Vector3();
        const radAt = (t: number, dir: V3) => {
          const C0 = A.clone().add(ax.clone().multiplyScalar(len * t));
          let m = 0;
          for (const Sf of surfs) for (let i = 0; i < Sf.n; i++) {
            if (!bsegs.has(Sf.seg[i])) continue;
            tmp.set(Sf.P[i * 3] - C0.x, Sf.P[i * 3 + 1] - C0.y, Sf.P[i * 3 + 2] - C0.z);
            if (Math.abs(tmp.dot(ax)) > len * 0.06) continue;
            const d = tmp.dot(dir);
            if (d > m) m = d;
          }
          return m || (/Arm/.test(region) ? RAD.arm : RAD.leg);
        };
        const woodTex = texFor(K, 'wood', {});
        for (const sd of [1, -1]) {
          const dir = latV.clone().multiplyScalar(sd);
          const t0 = 0.14, t1 = 0.86, th = 0.007;
          const p0 = A.clone().add(ax.clone().multiplyScalar(len * t0)).add(dir.clone().multiplyScalar(radAt(t0, dir) + th));
          const p1 = A.clone().add(ax.clone().multiplyScalar(len * t1)).add(dir.clone().multiplyScalar(radAt(t1, dir) + th));
          const geo = new THREE.BoxGeometry(0.012, p1.distanceTo(p0), 0.03);
          K.geoms.push(geo);
          const m = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.8 });
          m.userData = { aitherInjury: true, injuryKind: 'wood' };
          K.mats.push(m);
          const slat = new THREE.Mesh(geo, m);
          slat.position.copy(p0).lerp(p1, 0.5);
          const yAx = p1.clone().sub(p0).normalize();
          const xAx = dir.clone().sub(yAx.clone().multiplyScalar(dir.dot(yAx))).normalize();
          const zAx = new THREE.Vector3().crossVectors(xAx, yAx);
          slat.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAx, yAx, zAx));
          slat.name = 'aitherWoundSplint';
          slat.userData.aitherInjury = true;
          slat.updateMatrixWorld(true);
          b0.attach(slat);
          K.added.push(slat);
          note(K, slat.name, 'wood');
        }
        for (const t of [0.22, 0.5, 0.78]) addAll(buildWrap(K, surfs, bsegs, A.clone().add(ax.clone().multiplyScalar(len * t)), ax, 0.014, 0.02, texFor(K, 'gauze', {}), { layer: 3 }, F.fwd));
      }
    }
  }
  // ---- body-wide blood spatter on the torso front (blood tiers only; dense at gore) ----
  if (red && view.blood >= 30) {
    const a = wpos(THREE, G.get('chest') || G.get('spine'));
    const segs = new Set(['spine', 'chest', 'hips', 'upperChest']);
    lat = null;
    avoidHair = false;
    capR = Infinity;
    const n = gore ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const anc = a.clone().add(F.left.clone().multiplyScalar((i - (n - 1) / 2) * 0.09)).add(F.up.clone().multiplyScalar(-0.04 * i));
      decalAt(segs, anc, F.up, F.fwd, new THREE.Vector3(0, -1, 0), gore ? 0.11 : 0.08, texFor(K, 'spatter', { tier, i }), { layer: 1, wet: true }, 0.04);
    }
  }
}

/** A body with no skinned surface (a test rig, a procedural figure): small bone-hung patches, never rings. */
function buildPrimitiveMarks(K: Kit, G: Body, view: InjuryView) {
  const { THREE } = K;
  for (const region of Object.keys(view.regions) as InjuryRegion[]) {
    const R = view.regions[region];
    const seg = SEG[region];
    const bone = seg ? G.get(R.missing === 'forearm' || R.missing === 'calf' ? seg.up : seg.low) : G.get(region === 'torso' ? 'chest' : 'head') ?? G.get('spine');
    if (!bone) continue;
    const kinds: string[] = [];
    if (R.bandage && !R.missing) kinds.push(region === 'head' || region === 'torso' ? 'pad' : 'gauze');
    if (R.bruise) kinds.push('bruise');
    if (R.scar) kinds.push('scar');
    if (R.burn) kinds.push('burn');
    if (view.tier !== 'pg' && (R.open || R.blood) && !R.bandage) kinds.push('wound');
    else if (R.torn && !R.bandage) kinds.push('scrape');
    kinds.forEach((kind, k) => {
      const geo = new THREE.PlaneGeometry(0.05, 0.05);
      K.geoms.push(geo);
      const mesh = new THREE.Mesh(geo, decalMat(K, texFor(K, kind, { tier: view.tier }), { layer: k }));
      mesh.position.set(0, 0.04 + 0.02 * k, 0.05);
      mesh.name = 'aitherWoundPatch';
      mesh.userData.aitherInjury = true;
      bone.add(mesh);
      K.added.push(mesh);
      note(K, mesh.name, kind);
    });
  }
}

/** Draw `view` on `vrm`. Returns a handle whose dispose() removes every mark and restores collapsed bones. */
export function applyInjuryOverlay(THREE: Three, vrm: VrmLike, view: InjuryView | null): InjuryOverlayHandle {
  clearInjuryOverlay(vrm);
  const K: Kit = { THREE, tex: new Map(), geoms: [], mats: [], added: [], drawn: {} };
  const restored: Array<[Obj, V3]> = [];
  const host = vrm.scene.userData as Record<string, unknown>;
  const handle: InjuryOverlayHandle = {
    key: view?.key ?? '',
    drawn: K.drawn,
    dispose() {
      for (const o of K.added) o.parent?.remove(o);
      for (const [bone, scale] of restored) bone.scale.copy(scale);
      for (const g of K.geoms) g.dispose();
      for (const m of K.mats) m.dispose();
      for (const t of K.tex.values()) t.dispose();
      K.added.length = 0;
      restored.length = 0;
      if (host[OVERLAY_TAG] === handle) delete host[OVERLAY_TAG];
    },
  };
  host[OVERLAY_TAG] = handle;
  if (!view || !vrm.humanoid) return handle;
  const humanoid = vrm.humanoid;
  const G: Body = {
    root: vrm.scene,
    get: (n) => {
      try {
        return humanoid.getRawBoneNode(n);
      } catch {
        return null;
      }
    },
  };
  try {
    const surfs = surfaces(THREE, G, (name) => !NOT_SURFACE.test(name));
    if (surfs.length) buildSurfaceMarks(K, G, view, surfs, surfaces(THREE, G, (name) => HAIR_RE.test(name)));
    else buildPrimitiveMarks(K, G, view);
  } catch (error) {
    console.warn('[injury-overlay] marks failed', error);
  }
  // severed chains collapse AFTER every mark was fitted to the whole limb
  for (const region of Object.keys(view.regions) as InjuryRegion[]) {
    const R = view.regions[region], seg = SEG[region];
    if (!seg || !R.missing) continue;
    const cut = G.get(lostBone(seg, R.missing));
    if (cut) { restored.push([cut, cut.scale.clone()]); cut.scale.setScalar(1e-3); }
  }
  return handle;
}

/** Remove whatever overlay this VRM carries (no-op when none). */
export function clearInjuryOverlay(vrm: VrmLike): void {
  const prev = (vrm.scene.userData as Record<string, unknown>)[OVERLAY_TAG] as InjuryOverlayHandle | undefined;
  prev?.dispose();
}
