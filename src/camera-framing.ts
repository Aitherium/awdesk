import * as THREE from 'three';

export interface FullBodyFraming {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
}

/**
 * Where the camera's eye sits on the body: a share of its height from the feet.
 * Owner 2026-11-15: the desk looked UP at the avatar (camera at hip height, so a
 * skirt read from below). Chest-to-eye height looks level-to-slightly-down, the
 * way you see someone standing on your desk. The target stays the body's centre,
 * so the whole body is still framed.
 */
export const EYE_SHARE = 0.82;

export function calculateFullBodyFraming(
  box: THREE.Box3,
  verticalFovDegrees: number,
  aspect: number,
  margin = 1.12,
  zoom = 1,
): FullBodyFraming {
  const size = box.getSize(new THREE.Vector3());
  const target = box.getCenter(new THREE.Vector3());
  const halfVerticalFov = THREE.MathUtils.degToRad(verticalFovDegrees) / 2;
  const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * aspect);
  const depthPadding = size.z / 2;
  const heightDistance = size.y / 2 / Math.tan(halfVerticalFov);
  const widthDistance = size.x / 2 / Math.tan(halfHorizontalFov);
  const distance =
    Math.max(heightDistance, widthDistance) * margin / zoom + depthPadding;

  const eyeY = box.min.y + size.y * EYE_SHARE;
  return {
    position: new THREE.Vector3(target.x, eyeY, target.z + distance),
    target,
    distance,
  };
}
