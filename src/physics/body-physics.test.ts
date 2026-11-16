import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { COLLIDER_PLAN, attachBodyColliders, createResetGate, createStepper, planFor } from './body-physics';

function fakeVrm(bones: string[], joints = 3) {
  const nodes = new Map<string, THREE.Object3D>(bones.map((b) => [b, new THREE.Object3D()]));
  const scene = new THREE.Object3D();
  const set = new Set(Array.from({ length: joints }, () => ({ colliderGroups: [] as unknown[] })));
  const vrm = {
    scene,
    humanoid: { getNormalizedBoneNode: (b: string) => nodes.get(b) ?? null },
    springBoneManager: { joints: set },
  } as unknown as VRM;
  return { vrm, nodes, set };
}

describe('body colliders', () => {
  it('the plan covers head, neck, face, torso, hips and both legs', () => {
    const ids = COLLIDER_PLAN.map((c) => c.id);
    for (const need of ['head', 'face', 'neck', 'hips', 'left-thigh', 'right-thigh', 'left-shin', 'right-shin']) expect(ids).toContain(need);
    expect(COLLIDER_PLAN.every((c) => c.radius > 0.03 && c.radius < 0.2)).toBe(true);
  });
  it('a humanoid that lacks bones only gets the colliders it can carry', () => {
    expect(planFor((b) => b === 'head').map((c) => c.id)).toEqual(['head', 'face']);
  });
  it('attaches every collider to its bone and makes every chain collide with the group, once', () => {
    const all = Array.from(new Set(COLLIDER_PLAN.map((c) => c.bone)));
    const { vrm, nodes, set } = fakeVrm(all, 4);
    const out = attachBodyColliders(vrm);
    expect(out.skipped).toBe(false);
    expect(out.attached).toHaveLength(COLLIDER_PLAN.length);
    expect(out.joints).toBe(4);
    expect(nodes.get('head')!.children.map((c) => c.name)).toEqual(['desk-collider-head', 'desk-collider-face']);
    for (const joint of set) expect((joint as { colliderGroups: unknown[] }).colliderGroups).toHaveLength(1);
    const again = attachBodyColliders(vrm);
    expect(again.skipped).toBe(true);
    for (const joint of set) expect((joint as { colliderGroups: unknown[] }).colliderGroups).toHaveLength(1);
  });
  it('a body with no spring chains gets nothing', () => {
    const { vrm } = fakeVrm(['head'], 0);
    expect(attachBodyColliders(vrm).attached).toEqual(['head', 'face']);
  });
});

describe('fixed timestep', () => {
  it('turns a frame into exact steps and carries the remainder', () => {
    const s = createStepper({ dt: 0.01, maxFrame: 0.1, maxSteps: 8 });
    expect(s.advance(0.035)).toEqual([0.01, 0.01, 0.01]);
    expect(s.pending()).toBeCloseTo(0.005, 6);
    expect(s.advance(0.006)).toHaveLength(1);
  });
  it('clamps a stall: a one-second frame is a maxFrame, never a one-second step', () => {
    const s = createStepper({ dt: 1 / 90, maxFrame: 1 / 30, maxSteps: 4 });
    const steps = s.advance(1);
    expect(steps.length).toBeLessThanOrEqual(3);
    expect(steps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 / 30 + 1e-9);
  });
  it('caps the step count so a slow frame does not become a slower one', () => {
    const s = createStepper({ dt: 0.001, maxFrame: 1, maxSteps: 4 });
    expect(s.advance(0.5)).toHaveLength(4);
    expect(s.pending()).toBeLessThan(0.001);
  });
  it('ignores junk deltas', () => {
    const s = createStepper();
    expect(s.advance(NaN)).toEqual([]);
    expect(s.advance(-1)).toEqual([]);
  });
});

describe('reset gate', () => {
  const pose = { x: 0, y: 0, z: 0, scale: 1, width: 600, height: 950, stageSeq: 0 };
  it('the first frame never resets, a drag that follows the pointer never resets', () => {
    const g = createResetGate();
    expect(g.shouldReset(pose)).toBe(false);
    for (let i = 1; i <= 20; i += 1) expect(g.shouldReset({ ...pose, x: i * 0.03 })).toBe(false);
  });
  it('a jump (place-avatar, arrange, a drop) resets once', () => {
    const g = createResetGate();
    g.shouldReset(pose);
    expect(g.shouldReset({ ...pose, x: 1.5 })).toBe(true);
    expect(g.shouldReset({ ...pose, x: 1.5 })).toBe(false);
  });
  it('a resize, a scale jump and a stage join or leave each reset', () => {
    const g = createResetGate();
    g.shouldReset(pose);
    expect(g.shouldReset({ ...pose, width: 800 })).toBe(true);
    expect(g.shouldReset({ ...pose, width: 800, scale: 1.5 })).toBe(true);
    expect(g.shouldReset({ ...pose, width: 800, scale: 1.5, stageSeq: 1 })).toBe(true);
    expect(g.shouldReset({ ...pose, width: 800, scale: 1.52, stageSeq: 1 })).toBe(false);
  });
});
