/**
 * Hair and cloth physics (owner 2026-11-16): spring-bone colliders on every avatar's head, neck and
 * face, plus skirt / leg colliders, fixed-timestep substeps with a clamped delta, and a reset when a
 * body is moved by a jump, the window is resized or a body joins a stage.
 *
 * The three pieces are PURE or take the VRM as data so they unit-test without a renderer:
 *   - COLLIDER_PLAN / attachBodyColliders: which shapes ride on which humanoid bones (metres, bone-local)
 *   - createStepper: the accumulator that turns a frame's delta into fixed steps
 *   - createResetGate: when the chains must be put back at rest instead of integrated through a jump
 *
 * Why: the spring bones integrate the raw frame delta. A body that is dragged or re-seated moves a
 * metre in one frame; the chains lag behind, then snap through the head and the shoulders (the clipping
 * the owner saw in the hair and the skirt). Colliders keep the chains out of the body, substeps keep
 * the integration stable at any frame rate, and a reset after a jump removes the one-frame explosion.
 */

import { VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, VRMSpringBoneColliderShapeSphere } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';

type Vec3 = [number, number, number];

export interface ColliderSpec {
  /** Name for debugging and tests. */
  id: string;
  /** The humanoid bone the collider rides on. */
  bone: string;
  /** A sphere at `offset`, or a capsule from `offset` to `tail` (bone-local metres). */
  shape: 'sphere' | 'capsule';
  offset: Vec3;
  tail?: Vec3;
  radius: number;
}

/**
 * Head, neck and face first (hair falls over them), then the torso and hips (long hair and capes),
 * then the legs (a skirt hangs from the hips and rests on the thighs). Sizes are for a ~1.6 m body;
 * the model's own scale carries them (colliders are children of the bones).
 */
export const COLLIDER_PLAN: readonly ColliderSpec[] = Object.freeze([
  { id: 'head', bone: 'head', shape: 'sphere', offset: [0, 0.07, 0.0], radius: 0.105 },
  { id: 'face', bone: 'head', shape: 'sphere', offset: [0, 0.045, 0.065], radius: 0.07 },
  { id: 'neck', bone: 'neck', shape: 'capsule', offset: [0, 0.0, 0], tail: [0, 0.07, 0], radius: 0.052 },
  { id: 'chest', bone: 'chest', shape: 'capsule', offset: [-0.06, 0.04, 0], tail: [0.06, 0.04, 0], radius: 0.115 },
  { id: 'upper-chest', bone: 'upperChest', shape: 'capsule', offset: [-0.07, 0.03, 0], tail: [0.07, 0.03, 0], radius: 0.115 },
  { id: 'spine', bone: 'spine', shape: 'capsule', offset: [-0.05, 0.05, 0], tail: [0.05, 0.05, 0], radius: 0.105 },
  { id: 'hips', bone: 'hips', shape: 'capsule', offset: [-0.07, 0.03, 0], tail: [0.07, 0.03, 0], radius: 0.125 },
  { id: 'left-thigh', bone: 'leftUpperLeg', shape: 'capsule', offset: [0, 0, 0], tail: [0, -0.34, 0], radius: 0.088 },
  { id: 'right-thigh', bone: 'rightUpperLeg', shape: 'capsule', offset: [0, 0, 0], tail: [0, -0.34, 0], radius: 0.088 },
  { id: 'left-shin', bone: 'leftLowerLeg', shape: 'capsule', offset: [0, 0, 0], tail: [0, -0.34, 0], radius: 0.065 },
  { id: 'right-shin', bone: 'rightLowerLeg', shape: 'capsule', offset: [0, 0, 0], tail: [0, -0.34, 0], radius: 0.065 },
]);

/** The shape of the plan for a humanoid that lacks some bones: only specs whose bone exists. */
export function planFor(has: (bone: string) => boolean): ColliderSpec[] {
  return COLLIDER_PLAN.filter((spec) => has(spec.bone));
}

export interface AttachResult {
  attached: string[];
  joints: number;
  skipped: boolean;
}

/**
 * Add the plan's colliders to a VRM and make every spring chain collide with them. Idempotent
 * (a flag on userData): a character switch or a re-ready never doubles them. A body with no spring
 * chains gets nothing (nothing to collide).
 */
export function attachBodyColliders(vrm: VRM): AttachResult {
  const manager = vrm.springBoneManager;
  const done = vrm.scene.userData as { __deskColliders?: boolean };
  if (!manager || done.__deskColliders) return { attached: [], joints: 0, skipped: true };
  const humanoid = vrm.humanoid;
  if (!humanoid) return { attached: [], joints: 0, skipped: true };
  const colliders: VRMSpringBoneCollider[] = [];
  const attached: string[] = [];
  for (const spec of planFor((b) => Boolean(humanoid.getNormalizedBoneNode(b as never)))) {
    const node = humanoid.getNormalizedBoneNode(spec.bone as never);
    if (!node) continue;
    const offset = new THREE.Vector3(...spec.offset);
    const shape = spec.shape === 'sphere' || !spec.tail
      ? new VRMSpringBoneColliderShapeSphere({ radius: spec.radius, offset })
      : new VRMSpringBoneColliderShapeCapsule({ radius: spec.radius, offset, tail: new THREE.Vector3(...spec.tail) });
    const collider = new VRMSpringBoneCollider(shape);
    collider.name = `desk-collider-${spec.id}`;
    node.add(collider);
    colliders.push(collider);
    attached.push(spec.id);
  }
  if (!colliders.length) return { attached, joints: 0, skipped: true };
  const group = { colliders, name: 'desk-body' };
  let joints = 0;
  for (const joint of manager.joints) {
    if (!joint.colliderGroups.includes(group)) joint.colliderGroups.push(group);
    joints += 1;
  }
  done.__deskColliders = true;
  return { attached, joints, skipped: false };
}

// -- fixed timestep ---------------------------------------------------------------------

export interface StepperOptions {
  /** The fixed step (seconds). */
  dt?: number;
  /** A frame longer than this is a stall, not elapsed time: it is clamped. */
  maxFrame?: number;
  /** Never more than this many steps in one frame (a slow frame must not become a slower one). */
  maxSteps?: number;
}

/**
 * A fixed-timestep accumulator: advance(delta) returns the list of steps to integrate this frame
 * (each exactly `dt`), the frame delta clamped to `maxFrame` first and the step count to `maxSteps`.
 * The remainder carries to the next frame, so the average rate is exact.
 */
export function createStepper({ dt = 1 / 90, maxFrame = 1 / 30, maxSteps = 4 }: StepperOptions = {}) {
  let acc = 0;
  return {
    advance(delta: number): number[] {
      const d = Number.isFinite(delta) && delta > 0 ? Math.min(delta, maxFrame) : 0;
      acc += d;
      const steps: number[] = [];
      while (acc >= dt && steps.length < maxSteps) {
        steps.push(dt);
        acc -= dt;
      }
      if (steps.length >= maxSteps && acc >= dt) acc = acc % dt; // drop what the cap could not run
      return steps;
    },
    reset() { acc = 0; },
    pending: () => acc,
  };
}

// -- reset after a jump ------------------------------------------------------------------

export interface GateOptions {
  /** A body that moves more than this (world units) in one frame was moved by something other than the pointer. */
  jump?: number;
  /** A scale change bigger than this ratio (an arrangement resizing a body). */
  scaleRatio?: number;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  scale: number;
  /** The window / canvas size in px. */
  width: number;
  height: number;
  /** Bumped by the caller when the body joined or left a stage. */
  stageSeq?: number;
}

/**
 * Decides when the spring chains must be reset to rest instead of integrated: a position jump (a
 * place-avatar, an arrange, a drop), a scale jump, a window resize, a stage join or leave. A drag
 * that follows the pointer moves a few centimetres per frame and never trips it, so hair still
 * swings when the owner moves a body by hand.
 */
export function createResetGate({ jump = 0.35, scaleRatio = 0.2 }: GateOptions = {}) {
  let last: Pose | null = null;
  return {
    shouldReset(now: Pose): boolean {
      const prev = last;
      last = { ...now };
      if (!prev) return false;
      if (Math.hypot(now.x - prev.x, now.y - prev.y, now.z - prev.z) > jump) return true;
      if (prev.scale > 0 && Math.abs(now.scale - prev.scale) / prev.scale > scaleRatio) return true;
      if (now.width !== prev.width || now.height !== prev.height) return true;
      return (now.stageSeq ?? 0) !== (prev.stageSeq ?? 0);
    },
    forget() { last = null; },
  };
}

// -- stage membership, as the physics sees it ---------------------------------------------

let seq = 0;
/** Bumped whenever a stage's membership changes (Scene's `stage-groups` handler): every body resets once. */
export function bumpStageSeq(): number {
  seq += 1;
  return seq;
}
export function stageSeq(): number {
  return seq;
}
