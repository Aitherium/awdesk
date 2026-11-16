import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildProceduralIdle, IDLE_SECONDS } from './procedural-idle';

function body(names: string[]) {
  const nodes = new Map<string, THREE.Object3D>();
  for (const n of names) {
    const o = new THREE.Object3D();
    o.name = `Normalized_${n}`;
    nodes.set(n, o);
  }
  return { humanoid: { getNormalizedBoneNode: (n: string) => nodes.get(n) ?? null }, nodes };
}

const FULL = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];

describe('buildProceduralIdle: a body never stands in a T-pose', () => {
  it('builds a looping clip for a body with arms, one quaternion track per bone present', () => {
    const b = body(FULL);
    const clip = buildProceduralIdle(b);
    expect(clip).not.toBeNull();
    expect(clip!.duration).toBe(IDLE_SECONDS);
    const names = clip!.tracks.map((t) => t.name);
    expect(names).toContain('Normalized_leftUpperArm.quaternion');
    expect(names).toContain('Normalized_rightUpperArm.quaternion');
    expect(names).toContain('Normalized_head.quaternion');
    expect(names).not.toContain('Normalized_hips.quaternion');
  });

  it('lowers the arms: the mixer takes the arm bones off their T-pose', () => {
    const b = body(FULL);
    const root = new THREE.Group();
    for (const n of b.nodes.values()) root.add(n);
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(buildProceduralIdle(b)!).play();
    mixer.update(0.5);
    const left = b.nodes.get('leftUpperArm')!;
    const right = b.nodes.get('rightUpperArm')!;
    const zOf = (o: THREE.Object3D) => new THREE.Euler().setFromQuaternion(o.quaternion).z;
    expect(zOf(left)).toBeLessThan(-1.0); // ~ -68 degrees: hanging, not horizontal
    expect(zOf(right)).toBeGreaterThan(1.0);
  });

  it('breathes: the chest is not frozen across the loop', () => {
    const b = body(FULL);
    const root = new THREE.Group();
    for (const n of b.nodes.values()) root.add(n);
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(buildProceduralIdle(b)!).play();
    mixer.update(IDLE_SECONDS * 0.25);
    const a = b.nodes.get('chest')!.quaternion.x;
    mixer.update(IDLE_SECONDS * 0.5);
    const c = b.nodes.get('chest')!.quaternion.x;
    expect(Math.abs(a - c)).toBeGreaterThan(0.005);
  });

  it('returns null for a body with no arm bones (it cannot be posed: shrink it back, never show a T-pose)', () => {
    expect(buildProceduralIdle(body(['hips', 'spine', 'head']))).toBeNull();
    expect(buildProceduralIdle(body(['hips', 'leftUpperArm']))).toBeNull();
  });

  it('survives bones that are missing from an otherwise normal body', () => {
    const clip = buildProceduralIdle(body(['hips', 'leftUpperArm', 'rightUpperArm']));
    expect(clip).not.toBeNull();
    expect(clip!.tracks.length).toBe(2);
  });
});
