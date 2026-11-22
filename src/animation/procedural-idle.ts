import * as THREE from 'three';

/** The humanoid a clip is built against: only the one lookup this module needs, so the unit test
 *  hands it plain Object3Ds and no model file. */
export interface IdleHumanoid {
  humanoid: { getNormalizedBoneNode(name: string): THREE.Object3D | null | undefined };
}

export const IDLE_SECONDS = 6;
const STEPS = 24; // keyframes per bone over the loop: smooth at 30 Hz, tiny to build

/**
 * A body must NEVER stand in a T-pose (owner P0, 2026-11-16: Aither "standing huge in a T-pose
 * on top of his YouTube window"). The idle comes from a .vrma file fetched at runtime; when that
 * load fails (the file is missing for a moment during a rebuild, a body was installed without
 * its clips, a retargeting error) nothing ever played and the VRM stayed in its bind pose.
 *
 * This builds the floor: a looping idle made from the body's own humanoid bones, arms lowered to
 * the sides with a slow breath and a barely-there head sway. It needs no file and nothing
 * fetched, so it can run the moment the body exists and the real clip fades over it.
 *
 * Returns null when the body has no arm bones to lower (a humanoid with no shoulders cannot
 * be posed; the caller shrinks it back to its fairy instead of showing a T-pose).
 */
export function buildProceduralIdle(vrm: IdleHumanoid): THREE.AnimationClip | null {
  const bone = (name: string) => vrm.humanoid.getNormalizedBoneNode(name) ?? null;
  const leftArm = bone('leftUpperArm');
  const rightArm = bone('rightUpperArm');
  if (!leftArm || !rightArm) return null;

  const times: number[] = [];
  for (let i = 0; i <= STEPS; i += 1) times.push((i / STEPS) * IDLE_SECONDS);

  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const tracks: THREE.KeyframeTrack[] = [];
  /** One bone: (rx, ry, rz) in radians as a function of the loop phase 0..1. */
  const add = (node: THREE.Object3D | null, pose: (phase: number) => [number, number, number]) => {
    if (!node || !node.name) return;
    const values: number[] = [];
    for (let i = 0; i <= STEPS; i += 1) {
      const [x, y, z] = pose(i / STEPS);
      quat.setFromEuler(euler.set(x, y, z));
      values.push(quat.x, quat.y, quat.z, quat.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
  };

  const TAU = Math.PI * 2;
  const breath = (phase: number) => Math.sin(phase * TAU);
  const deg = (d: number) => (d * Math.PI) / 180;

  // Arms down (VRM normalized bones: the left arm lowers by -Z, the right by +Z), a soft elbow bend,
  // and a hand of the breath in the shoulders so the arms do not hang dead.
  add(leftArm, (p) => [0, 0, deg(-68) + deg(0.8) * breath(p)]);
  add(rightArm, (p) => [0, 0, deg(68) - deg(0.8) * breath(p)]);
  add(bone('leftLowerArm'), () => [0, 0, deg(-8)]);
  add(bone('rightLowerArm'), () => [0, 0, deg(8)]);
  add(bone('spine'), (p) => [deg(0.7) * breath(p), 0, 0]);
  add(bone('chest'), (p) => [deg(1.1) * breath(p), 0, 0]);
  add(bone('upperChest'), (p) => [deg(0.6) * breath(p), 0, 0]);
  add(bone('neck'), (p) => [0, deg(1.2) * Math.sin(p * TAU + 0.8), 0]);
  add(bone('head'), (p) => [deg(0.8) * Math.sin(p * TAU * 2), deg(2) * Math.sin(p * TAU + 0.8), 0]);

  if (!tracks.length) return null;
  return new THREE.AnimationClip('desk.procedural-idle', IDLE_SECONDS, tracks);
}
