// GENERATED from @aitherium/bead-space 0.2.0 by vendor_bead_space.py -- edit the package and re-run.
/* eslint-disable react-hooks/immutability -- an imperative scene: buffers, uniforms and
   label/panel element styles are written in frame callbacks and effects, never during
   render, which is the point (a setState per frame is the stutter this avoids). */
/**
 * The universe in 3D: react-three-fiber, rendered ON DEMAND.
 *
 * Budget: one instanced icosahedron mesh for every solid body (plus one wireframe
 * instanced mesh for bodies whose health is unknown), one line set per link style, and
 * additive point sprites for atmospheres, beacons, matches, comets and the ship. The
 * scene renders only when something changed; a 30 fps timer runs ONLY while a beacon,
 * a comet or the ship is moving. With prefers-reduced-motion nothing pulses or flies
 * and camera moves are cuts.
 *
 * Gestures follow the 2D engine's rule (see gesture.ts): drag rotates, Ctrl/Cmd+wheel
 * or a pinch dollies. Dollying in past a threshold descends into the body under the
 * cursor; dollying out ascends. If WebGL is missing, or frames fall under 30 fps for
 * 3 s, `onFallback` fires and the host shows the 2D view.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import * as THREE from 'three';

import type { UniverseData, UniverseNode } from '../types';
import { childrenOf, indexUniverse, parentOf } from '../universe/levels';
import type { VisibleSet } from '../universe/levels';
import { hashFrac, ringRadius } from '../universe/layout';
import type { SelectionAction, SelectionState } from '../universe/selection';
import { FLY_MS, easeOutCubic, hasWebGL, spaceGestureAllowed } from './gesture';
import { FONTS, PALETTE, galaxyTint, hexToRgb } from './palette';
import { bodyRadius, buildInstances, positionOf } from './scene';
import type { AskGlow, Positions, SceneInstances } from './scene';

export type FallbackReason = 'no WebGL' | 'slow';

export interface Space3DProps {
  data: UniverseData;
  visible: VisibleSet;
  positions: Positions;
  glow: AskGlow;
  state: SelectionState;
  dispatch: (action: SelectionAction) => void;
  matchIds?: ReadonlySet<string>;
  reducedMotion?: boolean;
  /** A node an "Explore with Aither" turn is running on: the ship orbits it. */
  exploringId?: string | null;
  /** The selection panel's wrapper; positioned beside the selected node. */
  anchorRef?: RefObject<HTMLDivElement | null>;
  onFallback?: (reason: FallbackReason) => void;
}

const LABEL_CHILD_CAP = 24;
const TIMER_FPS = 30;
/** The timer asks for 30 fps; holding less than 80% of that for 3 s is "under 30". */
const SLOW_FPS = 24;
const SLOW_FOR_MS = 3000;
const STARS = 2000;
const DESCEND_AT = 0.45;
const ASCEND_AT = 2.2;

/** How far the camera sits to frame a level. */
function viewDistance(data: UniverseData, node: UniverseNode): number {
  const kids = childrenOf(data, node.id).length;
  const ring = kids ? ringRadius(node.level, kids) : 0;
  return Math.max(ring * 2.6, bodyRadius(node.level, kids) * 7, 4);
}

// ── textures & materials ────────────────────────────────────────────────────

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function glowTexture(): THREE.Texture {
  return canvasTexture((ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.22, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

function ringTexture(): THREE.Texture {
  return canvasTexture((ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.68, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(255,255,255,1)');
    g.addColorStop(0.9, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

const RIM_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vColor;
void main() {
  mat4 im = mat4(1.0);
  #ifdef USE_INSTANCING
  im = instanceMatrix;
  #endif
  vec4 mv = modelViewMatrix * im * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * mat3(im) * normal);
  vView = normalize(-mv.xyz);
  #ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
  #else
  vColor = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * mv;
}
`;

const RIM_FRAGMENT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vColor;
void main() {
  vec3 n = normalize(vNormal);
  float facing = max(dot(n, normalize(vView)), 0.0);
  float rim = pow(1.0 - facing, 2.4);
  float lit = max(dot(n, normalize(vec3(0.4, 0.7, 0.6))), 0.0);
  vec3 col = vColor * (0.10 + 0.22 * lit) + vColor * rim * 1.35;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const POINT_VERTEX = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uScale;
uniform float uTime;
uniform float uPulse;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float pulse = 1.0 + uPulse * 0.18 * sin(uTime * 3.0 + position.x * 0.01);
  gl_PointSize = aSize * pulse * uScale / max(-mv.z, 0.001);
  gl_Position = projectionMatrix * mv;
}
`;

const POINT_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec3 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * uOpacity;
  gl_FragColor = vec4(vColor * a, a);
}
`;

const PILLAR_VERTEX = /* glsl */ `
varying float vY;
void main() {
  vY = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PILLAR_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vY;
void main() {
  float a = pow(1.0 - vY, 1.6) * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
}
`;

function pointMaterial(map: THREE.Texture, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uOpacity: { value: opacity },
      uScale: { value: 400 },
      uTime: { value: 0 },
      uPulse: { value: 0 },
    },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Points with per-point size (world units) and colour, one draw call. */
function glowPoints(xyz: number[], sizes: number[], colors: number[], material: THREE.ShaderMaterial): THREE.Points {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  const pts = new THREE.Points(geo, material);
  pts.frustumCulled = false;
  return pts;
}

function linear(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// ── scene pieces ────────────────────────────────────────────────────────────

interface Shared {
  glowTex: THREE.Texture;
  ringTex: THREE.Texture;
}

function useShared(): Shared {
  const shared = useMemo(() => ({ glowTex: glowTexture(), ringTex: ringTexture() }), []);
  useEffect(() => () => {
    shared.glowTex.dispose();
    shared.ringTex.dispose();
  }, [shared]);
  return shared;
}

function Bodies({ inst, onPick, dragged }: {
  inst: SceneInstances;
  onPick: (kind: 'click' | 'double' | 'context' | 'hover' | 'leave', id: string | null) => void;
  dragged: MutableRefObject<boolean>;
}) {
  const meshes = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const solidMat = new THREE.ShaderMaterial({ vertexShader: RIM_VERTEX, fragmentShader: RIM_FRAGMENT });
    const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.75 });
    const n = Math.max(1, inst.count);
    const solid = new THREE.InstancedMesh(geo, solidMat, n);
    const wire = new THREE.InstancedMesh(geo, wireMat, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    const quiet = linear(PALETTE.quiet);
    for (let i = 0; i < n; i += 1) {
      const live = i < inst.count;
      const s = live ? inst.scales[i] : 0;
      const pos = new THREE.Vector3(inst.centers[i * 3] ?? 0, inst.centers[i * 3 + 1] ?? 0, inst.centers[i * 3 + 2] ?? 0);
      const hollow = live && inst.hollow[i] === 1;
      m.compose(pos, q, new THREE.Vector3().setScalar(live && !hollow ? s : 0));
      solid.setMatrixAt(i, m);
      m.compose(pos, q, new THREE.Vector3().setScalar(hollow ? s : 0));
      wire.setMatrixAt(i, m);
      color.setRGB(inst.colors[i * 3] ?? 0, inst.colors[i * 3 + 1] ?? 0, inst.colors[i * 3 + 2] ?? 0, THREE.SRGBColorSpace);
      solid.setColorAt(i, color);
      const dim = live && inst.ghost[i] ? 0.3 : 1;
      color.setRGB(quiet[0] * dim, quiet[1] * dim, quiet[2] * dim);
      wire.setColorAt(i, color);
    }
    solid.instanceMatrix.needsUpdate = true;
    wire.instanceMatrix.needsUpdate = true;
    solid.computeBoundingSphere();
    wire.computeBoundingSphere();
    return { solid, wire, geo, solidMat, wireMat };
  }, [inst]);
  useEffect(() => () => {
    meshes.geo.dispose();
    meshes.solidMat.dispose();
    meshes.wireMat.dispose();
    meshes.solid.dispose();
    meshes.wire.dispose();
  }, [meshes]);

  const idOf = (instanceId: number | undefined) =>
    instanceId != null && instanceId < inst.count ? inst.ids[instanceId] : null;
  const handlers = {
    onClick: (e: { instanceId?: number; delta: number; stopPropagation: () => void }) => {
      e.stopPropagation();
      if (e.delta > 5 || dragged.current) return;
      onPick('click', idOf(e.instanceId));
    },
    onDoubleClick: (e: { instanceId?: number; stopPropagation: () => void }) => {
      e.stopPropagation();
      onPick('double', idOf(e.instanceId));
    },
    onContextMenu: (e: { instanceId?: number; stopPropagation: () => void; nativeEvent: Event }) => {
      e.stopPropagation();
      e.nativeEvent.preventDefault();
      onPick('context', idOf(e.instanceId));
    },
    onPointerMove: (e: { instanceId?: number; stopPropagation: () => void }) => {
      e.stopPropagation();
      onPick('hover', idOf(e.instanceId));
    },
    onPointerOut: () => onPick('leave', null),
  };
  return (
    <>
      <primitive object={meshes.solid} {...handlers} />
      <primitive object={meshes.wire} {...handlers} />
    </>
  );
}

function Links({ inst }: { inst: SceneInstances }) {
  const objs = useMemo(() => {
    const solidGeo = new THREE.BufferGeometry();
    solidGeo.setAttribute('position', new THREE.BufferAttribute(inst.linkPositions, 3));
    const solidMat = new THREE.LineBasicMaterial({ color: PALETTE.aitherium, transparent: true, opacity: 0.32, depthWrite: false });
    const solid = new THREE.LineSegments(solidGeo, solidMat);
    const dashGeo = new THREE.BufferGeometry();
    dashGeo.setAttribute('position', new THREE.BufferAttribute(inst.dashedLinkPositions, 3));
    const dashMat = new THREE.LineDashedMaterial({
      color: PALETTE.aitherium,
      transparent: true,
      opacity: 0.32,
      dashSize: 3,
      gapSize: 3,
      depthWrite: false,
    });
    const dashed = new THREE.LineSegments(dashGeo, dashMat);
    dashed.computeLineDistances();
    solid.frustumCulled = false;
    dashed.frustumCulled = false;
    return { solid, dashed, solidGeo, solidMat, dashGeo, dashMat };
  }, [inst]);
  useEffect(() => () => {
    objs.solidGeo.dispose();
    objs.solidMat.dispose();
    objs.dashGeo.dispose();
    objs.dashMat.dispose();
  }, [objs]);
  return (
    <>
      <primitive object={objs.solid} />
      <primitive object={objs.dashed} />
    </>
  );
}

function Starfield({ shared, data, positions }: { shared: Shared; data: UniverseData; positions: Positions }) {
  const field = useMemo(() => {
    const xyz: number[] = [];
    for (let i = 0; i < STARS; i += 1) {
      const u = hashFrac(`star${i}u`) * 2 - 1;
      const t = hashFrac(`star${i}t`) * Math.PI * 2;
      const r = 9000 + hashFrac(`star${i}r`) * 5000;
      const s = Math.sqrt(1 - u * u);
      xyz.push(Math.cos(t) * s * r, u * r, Math.sin(t) * s * r);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
    const mat = new THREE.PointsMaterial({
      color: '#8FA3B8',
      size: 1.3,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const stars = new THREE.Points(geo, mat);
    stars.frustumCulled = false;
    stars.raycast = () => undefined;
    return { stars, geo, mat };
  }, []);
  useEffect(() => () => {
    field.geo.dispose();
    field.mat.dispose();
  }, [field]);
  const objs = useMemo(() => {
    // Tinted nebulae, one per galaxy (the root's children), behind everything else.
    const root = indexUniverse(data).root;
    const galaxies = root ? childrenOf(data, root.id) : [];
    const sprites = galaxies.map((g, i) => {
      const smat = new THREE.SpriteMaterial({
        map: shared.glowTex,
        color: galaxyTint(i),
        transparent: true,
        opacity: 0.11,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(smat);
      const p = positionOf(positions, g.id) ?? [0, 0, 0];
      sprite.position.set(p[0], p[1], p[2]);
      sprite.scale.setScalar(900);
      sprite.raycast = () => undefined;
      return sprite;
    });
    return { sprites };
  }, [shared, data, positions]);
  useEffect(() => () => {
    for (const s of objs.sprites) s.material.dispose();
  }, [objs]);
  return (
    <>
      <primitive object={field.stars} />
      {objs.sprites.map((s, i) => (
        <primitive key={i} object={s} />
      ))}
    </>
  );
}

function Glows({ shared, inst, matchIds, selectedId, reducedMotion }: {
  shared: Shared;
  inst: SceneInstances;
  matchIds?: ReadonlySet<string>;
  selectedId: string | null;
  reducedMotion: boolean;
}) {
  const { size, camera } = useThree();
  const objs = useMemo(() => {
    // Atmospheres: every instance, health-tinted, ghosts faint.
    const aXyz: number[] = [];
    const aSize: number[] = [];
    const aCol: number[] = [];
    for (let i = 0; i < inst.count; i += 1) {
      aXyz.push(inst.centers[i * 3], inst.centers[i * 3 + 1], inst.centers[i * 3 + 2]);
      aSize.push(inst.scales[i] * 4.2);
      const k = inst.ghost[i] ? 0.25 : 0.55;
      aCol.push(inst.colors[i * 3] * k, inst.colors[i * 3 + 1] * k, inst.colors[i * 3 + 2] * k);
    }
    const atmoMat = pointMaterial(shared.glowTex, 1);
    const atmo = glowPoints(aXyz, aSize, aCol, atmoMat);

    // Beacons: a halo ring per ask-bearing body, gold or forge.
    const hXyz: number[] = [];
    const hSize: number[] = [];
    const hCol: number[] = [];
    const gold = hexToRgb(PALETTE.gold);
    const forge = hexToRgb(PALETTE.forge);
    for (const b of inst.beacons) {
      const i = b.index;
      hXyz.push(inst.centers[i * 3], inst.centers[i * 3 + 1], inst.centers[i * 3 + 2]);
      hSize.push(inst.scales[i] * 5.5);
      hCol.push(...(b.urgent ? forge : gold));
    }
    const haloMat = pointMaterial(shared.ringTex, 1);
    const halo = glowPoints(hXyz, hSize, hCol, haloMat);

    // Search matches and the selection: cyan rings.
    const mXyz: number[] = [];
    const mSize: number[] = [];
    const mCol: number[] = [];
    const cyan = hexToRgb(PALETTE.aitherium);
    inst.ids.forEach((id, i) => {
      if (inst.ghost[i]) return;
      const sel = id === selectedId;
      if (!sel && !(matchIds?.has(id))) return;
      mXyz.push(inst.centers[i * 3], inst.centers[i * 3 + 1], inst.centers[i * 3 + 2]);
      mSize.push(inst.scales[i] * (sel ? 3.6 : 3.1));
      const k = sel ? 1 : 0.6;
      mCol.push(cyan[0] * k, cyan[1] * k, cyan[2] * k);
    });
    const ringMat = pointMaterial(shared.ringTex, 1);
    const rings = glowPoints(mXyz, mSize, mCol, ringMat);

    // Pillars: a vertical additive beam above every beacon.
    const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    pillarGeo.translate(0, 0.5, 0);
    const pillars = inst.beacons.map((b) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(b.urgent ? PALETTE.forge : PALETTE.gold) },
          uOpacity: { value: 0.55 },
        },
        vertexShader: PILLAR_VERTEX,
        fragmentShader: PILLAR_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(pillarGeo, mat);
      const s = inst.scales[b.index];
      mesh.position.set(inst.centers[b.index * 3], inst.centers[b.index * 3 + 1], inst.centers[b.index * 3 + 2]);
      mesh.scale.set(s * 0.09, s * 16, s * 0.09);
      mesh.raycast = () => undefined;
      return mesh;
    });
    for (const p of [atmo, halo, rings]) p.raycast = () => undefined;
    return { atmo, halo, rings, pillars, pillarGeo, mats: [atmoMat, haloMat, ringMat] };
  }, [shared, inst, matchIds, selectedId]);

  useEffect(() => () => {
    for (const p of [objs.atmo, objs.halo, objs.rings]) p.geometry.dispose();
    for (const m of objs.mats) m.dispose();
    objs.pillarGeo.dispose();
    for (const p of objs.pillars) (p.material as THREE.Material).dispose();
  }, [objs]);

  useFrame((state) => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    const scale = (size.height * state.viewport.dpr) / (2 * Math.tan((fov * Math.PI) / 360));
    for (const m of objs.mats) {
      m.uniforms.uScale.value = scale;
      m.uniforms.uTime.value = state.clock.elapsedTime;
    }
    objs.mats[1].uniforms.uPulse.value = reducedMotion ? 0 : 1;
  });

  return (
    <>
      <primitive object={objs.atmo} />
      <primitive object={objs.halo} />
      <primitive object={objs.rings} />
      {objs.pillars.map((p, i) => (
        <primitive key={i} object={p} />
      ))}
    </>
  );
}

/** Comets along traffic links and the Aither ship around an explored node. */
function Movers({ shared, inst, exploring, reducedMotion }: {
  shared: Shared;
  inst: SceneInstances;
  exploring: { center: [number, number, number]; radius: number } | null;
  reducedMotion: boolean;
}) {
  const { size, camera } = useThree();
  const objs = useMemo(() => {
    const n = reducedMotion ? 0 : inst.trafficPositions.length / 6;
    const xyz = new Array(Math.max(1, n) * 3).fill(0);
    const sizes = new Array(Math.max(1, n)).fill(0);
    const seg = inst.trafficPositions;
    for (let i = 0; i < n; i += 1) {
      const o = i * 6;
      const len = Math.hypot(seg[o + 3] - seg[o], seg[o + 4] - seg[o + 1], seg[o + 5] - seg[o + 2]);
      sizes[i] = Math.max(0.4, len * 0.035);
    }
    const cyan = linear(PALETTE.aitherium);
    const cols = new Array(Math.max(1, n)).fill(0).flatMap(() => cyan);
    const cometMat = pointMaterial(shared.glowTex, 1);
    const comets = glowPoints(xyz, sizes, cols, cometMat);
    const shipMat = pointMaterial(shared.glowTex, 1);
    const ship = glowPoints([0, 0, 0], [exploring ? exploring.radius * 0.5 : 0], [...linear(PALETTE.aitherium)], shipMat);
    comets.raycast = () => undefined;
    ship.raycast = () => undefined;
    return { comets, ship, cometMat, shipMat, n };
  }, [shared, inst, exploring, reducedMotion]);
  useEffect(() => () => {
    objs.comets.geometry.dispose();
    objs.ship.geometry.dispose();
    objs.cometMat.dispose();
    objs.shipMat.dispose();
  }, [objs]);

  useFrame((state) => {
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    const scale = (size.height * state.viewport.dpr) / (2 * Math.tan((fov * Math.PI) / 360));
    objs.cometMat.uniforms.uScale.value = scale;
    objs.shipMat.uniforms.uScale.value = scale;
    const t = state.clock.elapsedTime;
    if (objs.n) {
      const attr = objs.comets.geometry.getAttribute('position') as THREE.BufferAttribute;
      const seg = inst.trafficPositions;
      for (let i = 0; i < objs.n; i += 1) {
        const f = (t * 0.22 + hashFrac(`comet${i}`)) % 1;
        const o = i * 6;
        attr.setXYZ(
          i,
          seg[o] + (seg[o + 3] - seg[o]) * f,
          seg[o + 1] + (seg[o + 4] - seg[o + 1]) * f,
          seg[o + 2] + (seg[o + 5] - seg[o + 2]) * f,
        );
      }
      attr.needsUpdate = true;
    }
    if (exploring) {
      const attr = objs.ship.geometry.getAttribute('position') as THREE.BufferAttribute;
      const a = reducedMotion ? 0.8 : t * 1.6;
      const [cx, cy, cz] = exploring.center;
      attr.setXYZ(0, cx + Math.cos(a) * exploring.radius, cy + Math.sin(a * 0.7) * exploring.radius * 0.25, cz + Math.sin(a) * exploring.radius);
      attr.needsUpdate = true;
    }
  });
  return (
    <>
      <primitive object={objs.comets} />
      <primitive object={objs.ship} />
    </>
  );
}

// ── camera, labels, timers ──────────────────────────────────────────────────

interface Orbit {
  target: THREE.Vector3;
  radius: number;
  theta: number;
  phi: number;
}

interface Tween {
  from: Orbit;
  to: Orbit;
  start: number;
}

function applyOrbit(camera: THREE.Camera, o: Orbit): void {
  const s = new THREE.Spherical(o.radius, o.phi, o.theta);
  const offset = new THREE.Vector3().setFromSpherical(s);
  camera.position.copy(o.target).add(offset);
  camera.lookAt(o.target);
  const cam = camera as THREE.PerspectiveCamera;
  cam.near = Math.max(0.01, o.radius / 200);
  cam.far = 60000;
  cam.updateProjectionMatrix();
}

function lerpOrbit(a: Orbit, b: Orbit, t: number): Orbit {
  let dTheta = b.theta - a.theta;
  while (dTheta > Math.PI) dTheta -= Math.PI * 2;
  while (dTheta < -Math.PI) dTheta += Math.PI * 2;
  return {
    target: a.target.clone().lerp(b.target, t),
    radius: a.radius + (b.radius - a.radius) * t,
    theta: a.theta + dTheta * t,
    phi: a.phi + (b.phi - a.phi) * t,
  };
}

function Rig({ data, visible, positions, state, dispatch, reducedMotion, dragged, labelEls, anchorRef, labelIds, askIds, animate, onSlow }: {
  data: UniverseData;
  visible: VisibleSet;
  positions: Positions;
  state: SelectionState;
  dispatch: (a: SelectionAction) => void;
  reducedMotion: boolean;
  dragged: MutableRefObject<boolean>;
  labelEls: MutableRefObject<Map<string, HTMLDivElement>>;
  anchorRef?: RefObject<HTMLDivElement | null>;
  labelIds: string[];
  askIds: ReadonlySet<string>;
  animate: boolean;
  onSlow: () => void;
}) {
  const { camera, gl, invalidate, size } = useThree();
  const orbit = useRef<Orbit | null>(null);
  const tween = useRef<Tween | null>(null);
  const latest = useRef({ state, visible, data, dispatch, positions });
  latest.current = { state, visible, data, dispatch, positions };
  const base = viewDistance(data, visible.focus);
  const baseRef = useRef(base);
  baseRef.current = base;

  // Fly to the level whenever the focus changes: the parent ends up BEHIND the focus,
  // so the ghost ancestors stay in view beyond the current level.
  // Keyed on the focus ID only: a data refresh every few seconds must not yank the
  // camera back while someone is looking around.
  const focusId = visible.focus.id;
  useEffect(() => {
    const { data, positions, visible } = latest.current;
    const focus = visible.focus;
    const p = positionOf(positions, focus.id) ?? [0, 0, 0];
    const target = new THREE.Vector3(p[0], p[1], p[2]);
    const up = parentOf(data, focus.id);
    const pp = up ? positionOf(positions, up) : null;
    const dir = pp ? target.clone().sub(new THREE.Vector3(pp[0], pp[1], pp[2])) : new THREE.Vector3(0, 0.45, 1);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0.45, 1);
    dir.normalize();
    dir.y += 0.42;
    dir.normalize();
    const sph = new THREE.Spherical().setFromVector3(dir);
    const to: Orbit = { target, radius: viewDistance(data, focus), theta: sph.theta, phi: Math.min(Math.max(sph.phi, 0.2), Math.PI - 0.2) };
    if (!orbit.current || reducedMotion) {
      orbit.current = to;
      tween.current = null;
      applyOrbit(camera, to);
      invalidate();
      return;
    }
    tween.current = { from: { ...orbit.current, target: orbit.current.target.clone() }, to, start: performance.now() };
    let raf = 0;
    const step = () => {
      invalidate();
      if (tween.current) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [focusId, camera, invalidate, reducedMotion]);

  // Drag rotates; Ctrl/Cmd+wheel or a pinch dollies; dollying past a threshold changes level.
  useEffect(() => {
    const el = gl.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number } | null = null;
    let pinch = 0;
    const dolly = (factor: number) => {
      const o = orbit.current;
      if (!o) return;
      tween.current = null;
      const b = baseRef.current;
      o.radius = Math.min(Math.max(o.radius * factor, b * (DESCEND_AT - 0.05)), b * (ASCEND_AT + 0.3));
      applyOrbit(camera, o);
      invalidate();
      const { state: st, dispatch: send, data: d } = latest.current;
      if (o.radius < b * DESCEND_AT) {
        const into = st.hoverId ?? st.selectedId;
        if (into && into !== st.focusId && childrenOf(d, into).length) send({ type: 'descend', id: into });
      } else if (o.radius > b * ASCEND_AT && st.focusId && parentOf(d, st.focusId)) {
        send({ type: 'ascend' });
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!spaceGestureAllowed({ type: 'mousedown', button: e.button, ctrlKey: e.ctrlKey })) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY };
      dragged.current = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && d > 0) dolly(pinch / d);
        pinch = d;
        dragged.current = true;
        return;
      }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) dragged.current = true;
      const o = orbit.current;
      if (!o || !dragged.current) return;
      tween.current = null;
      o.theta -= (e.clientX - prev.x) * 0.005;
      o.phi = Math.min(Math.max(o.phi - (e.clientY - prev.y) * 0.005, 0.15), Math.PI - 0.15);
      applyOrbit(camera, o);
      invalidate();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (!pointers.size) {
        down = null;
        // Let this pointer's click see that it was a drag, then reset.
        setTimeout(() => {
          dragged.current = false;
        }, 0);
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!spaceGestureAllowed({ type: 'wheel', ctrlKey: e.ctrlKey, metaKey: e.metaKey })) return;
      e.preventDefault();
      dolly(Math.exp(e.deltaY * 0.0015));
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [gl, camera, invalidate, dragged]);

  // Selection, hover and label changes need a frame to re-project.
  useEffect(() => {
    invalidate();
  }, [state.selectedId, state.hoverId, labelIds, invalidate]);

  // The 30 fps timer: only while something moves.
  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => invalidate(), 1000 / TIMER_FPS);
    return () => clearInterval(id);
  }, [animate, invalidate]);

  const fps = useRef({ last: 0, slowSince: 0, frames: [] as number[] });
  const v = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const now = performance.now();
    // Camera tween.
    const tw = tween.current;
    if (tw && orbit.current) {
      const t = easeOutCubic((now - tw.start) / FLY_MS);
      orbit.current = lerpOrbit(tw.from, tw.to, t);
      applyOrbit(camera, orbit.current);
      if (t >= 1) tween.current = null;
    }

    // FPS guard: only judged while frames are expected back to back.
    const f = fps.current;
    const continuous = animate || tween.current != null;
    if (continuous && !document.hidden) {
      if (f.last && now - f.last > 250) {
        f.frames = [];
        f.slowSince = 0;
      }
      f.frames.push(now);
      while (f.frames.length && now - f.frames[0] > 1000) f.frames.shift();
      const rate = f.frames.length;
      if (now - (f.frames[0] ?? now) > 900 && rate < SLOW_FPS) {
        if (!f.slowSince) f.slowSince = now;
        if (now - f.slowSince >= SLOW_FOR_MS) {
          f.slowSince = 0;
          onSlow();
        }
      } else if (rate >= SLOW_FPS) {
        f.slowSince = 0;
      }
    } else {
      f.frames = [];
      f.slowSince = 0;
    }
    f.last = now;

    // Project labels and the panel anchor.
    const w = size.width;
    const h = size.height;
    const project = (id: string): { x: number; y: number; on: boolean; behind: boolean } | null => {
      const p = positionOf(positions, id);
      if (!p) return null;
      v.set(p[0], p[1], p[2]).project(camera);
      const behind = v.z > 1;
      const x = ((behind ? -v.x : v.x) + 1) / 2 * w;
      const y = (1 - (behind ? -v.y : v.y)) / 2 * h;
      return { x, y, on: !behind && x >= 0 && x <= w && y >= 0 && y <= h, behind };
    };
    for (const [id, el] of labelEls.current) {
      const pr = project(id);
      if (!pr) {
        el.style.display = 'none';
        continue;
      }
      const chevron = el.querySelector<HTMLElement>('[data-chevron]');
      if (pr.on) {
        el.style.display = '';
        el.style.transform = `translate(${pr.x}px, ${pr.y + 12}px) translateX(-50%)`;
        el.dataset.offscreen = '';
        if (chevron) chevron.style.display = 'none';
      } else if (askIds.has(id)) {
        // Off-screen ask: a gold chevron on the edge, pointing at it.
        const cx = w / 2;
        const cy = h / 2;
        const dx = pr.x - cx;
        const dy = pr.y - cy;
        const k = Math.min((w / 2 - 22) / Math.max(Math.abs(dx), 1e-6), (h / 2 - 22) / Math.max(Math.abs(dy), 1e-6));
        el.style.display = '';
        el.style.transform = `translate(${cx + dx * k}px, ${cy + dy * k}px) translate(-50%, -50%)`;
        el.dataset.offscreen = 'true';
        if (chevron) {
          chevron.style.display = '';
          chevron.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
        }
      } else {
        el.style.display = 'none';
      }
    }
    const anchor = anchorRef?.current;
    if (anchor) {
      const sel = latest.current.state.selectedId;
      const pr = sel ? project(sel) : null;
      const pw = anchor.offsetWidth || 340;
      const ph = anchor.offsetHeight || 200;
      if (!pr || !pr.on) {
        anchor.style.transform = `translate(${Math.max(8, w - pw - 16)}px, 64px)`;
      } else {
        const left = pr.x + pw + 40 < w ? pr.x + 28 : pr.x - pw - 28;
        const top = Math.min(Math.max(8, pr.y - 40), Math.max(8, h - ph - 8));
        anchor.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
      }
      anchor.style.visibility = 'visible';
    }
  });
  return null;
}

// ── the component ───────────────────────────────────────────────────────────

export function Space3D(props: Space3DProps) {
  const { data, visible, positions, glow, state, dispatch, matchIds, exploringId, anchorRef, onFallback } = props;
  const reducedMotion = Boolean(props.reducedMotion);
  const webgl = useMemo(() => hasWebGL(), []);
  const fellBack = useRef(false);
  const fallback = useRef(onFallback);
  fallback.current = onFallback;
  const dragged = useRef(false);
  const labelEls = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!webgl && !fellBack.current) {
      fellBack.current = true;
      fallback.current?.('no WebGL');
    }
  }, [webgl]);

  const inst = useMemo(() => buildInstances(visible, positions, { data, glow }), [visible, positions, data, glow]);

  // Labels: focus, selected, hovered, every ask, then children up to the cap (asks and
  // trouble first so the cap never hides what matters).
  const askIds = useMemo(() => new Set(inst.glowIds), [inst]);
  const labelIds = useMemo(() => {
    const ids: string[] = [];
    const add = (id: string | null) => {
      if (id && !ids.includes(id) && positions.order.has(id)) ids.push(id);
    };
    add(visible.focus.id);
    add(state.selectedId);
    add(state.hoverId);
    for (const id of inst.glowIds) add(id);
    const rank = (n: UniverseNode) =>
      (glow.counts.get(n.id) ? 0 : 1) * 4
      + (n.health?.state === 'down' ? 0 : n.health?.state === 'degraded' ? 1 : 2);
    const kids = visible.nodes.slice(1).sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
    for (const n of kids.slice(0, LABEL_CHILD_CAP)) add(n.id);
    return ids;
  }, [visible, state.selectedId, state.hoverId, inst, glow, positions]);

  const exploring = useMemo(() => {
    if (!exploringId) return null;
    const p = positionOf(positions, exploringId);
    const node = indexUniverse(data).byId.get(exploringId);
    if (!p || !node) return null;
    const r = bodyRadius(node.level, childrenOf(data, node.id).length) * 2.4;
    return { center: p, radius: r };
  }, [exploringId, positions, data]);

  const animate = !reducedMotion && (inst.beacons.length > 0 || inst.trafficPositions.length > 0 || exploring != null);

  if (!webgl) return null;

  const byId = indexUniverse(data).byId;
  const onPick = (kind: 'click' | 'double' | 'context' | 'hover' | 'leave', id: string | null) => {
    if (kind === 'hover') dispatch({ type: 'hover', id });
    else if (kind === 'leave') dispatch({ type: 'hover', id: null });
    else if (kind === 'click') dispatch({ type: 'select', id });
    else if (kind === 'double' && id) {
      if (id === visible.focus.id || inst.ghost[inst.ids.indexOf(id)]) dispatch({ type: 'flyTo', id });
      else dispatch({ type: 'descend', id });
    } else if (kind === 'context') dispatch({ type: 'ascend' });
  };

  return (
    <div style={{ position: 'absolute', inset: 0, background: PALETTE.void }} onContextMenu={(e) => e.preventDefault()}>
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ fov: 50, near: 0.1, far: 60000, position: [0, 900, 2600] }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        style={{ position: 'absolute', inset: 0 }}
        onPointerMissed={(e) => {
          if (e.type === 'click' && !dragged.current) dispatch({ type: 'select', id: null });
          if (e.type === 'contextmenu') dispatch({ type: 'ascend' });
        }}
      >
        <SceneContents
          data={data}
          visible={visible}
          positions={positions}
          inst={inst}
          state={state}
          dispatch={dispatch}
          matchIds={matchIds}
          reducedMotion={reducedMotion}
          exploring={exploring}
          dragged={dragged}
          labelEls={labelEls}
          anchorRef={anchorRef}
          labelIds={labelIds}
          askIds={askIds}
          animate={animate}
          onPick={onPick}
          onSlow={() => {
            if (fellBack.current) return;
            fellBack.current = true;
            fallback.current?.('slow');
          }}
        />
      </Canvas>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {labelIds.map((id) => {
          const node = byId.get(id);
          if (!node) return null;
          const asks = glow.counts.get(id) ?? 0;
          const metric = node.meta?.metric;
          const color = asks ? (glow.urgent.has(id) ? PALETTE.forge : PALETTE.gold) : PALETTE.ink;
          return (
            <div
              key={id}
              ref={(el) => {
                if (el) labelEls.current.set(id, el);
                else labelEls.current.delete(id);
              }}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                display: 'none',
                textAlign: 'center',
                whiteSpace: 'nowrap',
                fontFamily: FONTS.name,
                fontWeight: FONTS.nameWeight,
                fontSize: id === visible.focus.id ? 15 : 12,
                color,
                textShadow: '0 1px 3px #000',
                opacity: id === state.selectedId || id === state.hoverId || asks ? 1 : 0.8,
              }}
            >
              <span data-chevron style={{ display: 'none', color: PALETTE.gold, fontSize: 18 }}>➤</span>
              <div>{node.title}{asks ? ` · ${asks}` : ''}</div>
              {metric != null ? (
                <div style={{ fontFamily: FONTS.metric, fontSize: 10, color: PALETTE.quiet }}>{String(metric)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SceneContents(props: {
  data: UniverseData;
  visible: VisibleSet;
  positions: Positions;
  inst: SceneInstances;
  state: SelectionState;
  dispatch: (a: SelectionAction) => void;
  matchIds?: ReadonlySet<string>;
  reducedMotion: boolean;
  exploring: { center: [number, number, number]; radius: number } | null;
  dragged: MutableRefObject<boolean>;
  labelEls: MutableRefObject<Map<string, HTMLDivElement>>;
  anchorRef?: RefObject<HTMLDivElement | null>;
  labelIds: string[];
  askIds: ReadonlySet<string>;
  animate: boolean;
  onPick: (kind: 'click' | 'double' | 'context' | 'hover' | 'leave', id: string | null) => void;
  onSlow: () => void;
}) {
  const shared = useShared();
  const { gl, scene } = useThree();
  useEffect(() => {
    gl.setClearColor(PALETTE.void, 1);
    scene.background = null;
  }, [gl, scene]);
  return (
    <>
      <Starfield shared={shared} data={props.data} positions={props.positions} />
      <Links inst={props.inst} />
      <Bodies inst={props.inst} onPick={props.onPick} dragged={props.dragged} />
      <Glows
        shared={shared}
        inst={props.inst}
        matchIds={props.matchIds}
        selectedId={props.state.selectedId}
        reducedMotion={props.reducedMotion}
      />
      <Movers shared={shared} inst={props.inst} exploring={props.exploring} reducedMotion={props.reducedMotion} />
      <Rig
        data={props.data}
        visible={props.visible}
        positions={props.positions}
        state={props.state}
        dispatch={props.dispatch}
        reducedMotion={props.reducedMotion}
        dragged={props.dragged}
        labelEls={props.labelEls}
        anchorRef={props.anchorRef}
        labelIds={props.labelIds}
        askIds={props.askIds}
        animate={props.animate}
        onSlow={props.onSlow}
      />
    </>
  );
}
