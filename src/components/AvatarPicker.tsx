import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { decodeId, nearestIdInPatch, registeredGroup, registeredSlots, setPicker, type PickGroup } from '../hooks/avatarPick';
import { anyBoxMoved, nearAnyBox, type ScreenBox } from '../hooks/clickThrough';

/**
 * The ID-buffer pick (hooks/avatarPick.ts says why). Mounted inside the Canvas, it hands the
 * picker to the module the window-level click-through and every body's pointer handlers read.
 *
 * pickAt(): the camera is narrowed to ONE pixel (setViewOffset), every body's meshes wear a
 * flat id colour (red byte = slot number), and the scene is rendered into a 1x1 target. The
 * depth buffer makes the front-most body win; a pixel no body covers reads 0. A pick costs one
 * skinned draw of the bodies into one pixel, run at most once per pointer move.
 */

type MeshLike = THREE.Object3D & { isMesh?: boolean; material?: THREE.Material | THREE.Material[] };

const idMaterials = new Map<number, THREE.MeshBasicMaterial>();
function idMaterial(index: number): THREE.MeshBasicMaterial {
  let m = idMaterials.get(index);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false, fog: false });
    // The target is linear and 8-bit: write the byte exactly, no sRGB round trip.
    m.color.setRGB(index / 255, 0, 0, THREE.LinearSRGBColorSpace);
    idMaterials.set(index, m);
  }
  return m;
}

function meshesOf(group: PickGroup): MeshLike[] {
  const out: MeshLike[] = [];
  group.traverse((o) => {
    const mesh = o as MeshLike;
    if (mesh.isMesh && !mesh.userData?.pickProxy) out.push(mesh);
  });
  return out;
}

const worldBox = new THREE.Box3();
const corner = new THREE.Vector3();

/**
 * A group's world bounds projected to CSS pixels. `Box3.setFromObject` reads each mesh's
 * STATIC geometry bounds through its world matrix — it does not follow bone deformation,
 * which is exactly right for the click-through gate: the idle sway stays inside the box
 * plus the pick slack. A corner behind the camera makes the projection meaningless, so the
 * whole window is returned — permissive, so the gate may spend a pick but never loses a
 * clickable body.
 */
function projectedBoxOf(group: THREE.Object3D, camera: THREE.PerspectiveCamera, rect: DOMRect): ScreenBox | null {
  worldBox.setFromObject(group);
  if (worldBox.isEmpty()) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    corner
      .set(
        i & 1 ? worldBox.max.x : worldBox.min.x,
        i & 2 ? worldBox.max.y : worldBox.min.y,
        i & 4 ? worldBox.max.z : worldBox.min.z,
      )
      .applyMatrix4(camera.matrixWorldInverse);
    if (corner.z >= -camera.near) return { x: 0, y: 0, w: rect.width, h: rect.height };
    corner.applyMatrix4(camera.projectionMatrix);
    const sx = (corner.x * 0.5 + 0.5) * rect.width;
    const sy = (-corner.y * 0.5 + 0.5) * rect.height;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  if (!Number.isFinite(minX) || maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function AvatarPicker() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const getState = useThree((s) => s.get);

  useEffect(() => {
    let idTarget: THREE.WebGLRenderTarget | null = null;
    // The click-through's patch pick runs every move and the exact pick every press: each keeps its own
    // target so they never re-create one another's.
    let patchTarget: THREE.WebGLRenderTarget | null = null;
    const makeTarget = (w: number, h: number) =>
      new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true, samples: 0 });
    const ensureTarget = (w: number, h: number) => {
      if (!idTarget || idTarget.width !== w || idTarget.height !== h) {
        idTarget?.dispose();
        idTarget = makeTarget(w, h);
      }
      return idTarget;
    };
    // The silhouette has its OWN target, multisampled: the pick needs exact id bytes (no
    // antialiasing), the outline needs the opposite -- fractional coverage at the edge, so
    // the ring drawn from it is smooth (hooks/avatarPick.ts outlineRing). three resolves the
    // samples at the end of render(), and readRenderTargetPixels reads the resolved texture.
    let silTarget: THREE.WebGLRenderTarget | null = null;
    const ensureSilhouetteTarget = (w: number, h: number) => {
      if (!silTarget || silTarget.width !== w || silTarget.height !== h) {
        silTarget?.dispose();
        silTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true, samples: 4 });
      }
      return silTarget;
    };
    const ensurePatch = (size: number) => {
      if (!patchTarget || patchTarget.width !== size) {
        patchTarget?.dispose();
        patchTarget = makeTarget(size, size);
      }
      return patchTarget;
    };

    // -- the cheap gate for the window's click-through (hooks/clickThrough.ts) --------------
    // Re-picking is a full skinned render + a synchronous readback. It must not run while the
    // cursor is over empty pixels, so the window asks two cheap questions instead: "is the
    // point near a body's projected box" and "did a body move". The boxes are cached for a
    // tick (the resting re-check runs every 120 ms), recomputed from world bounds, not bones.
    const BOX_TTL_MS = 120;
    const BOX_MOVE_EPSILON_PX = 1;
    const MOVED_RECENT_MS = 300;
    let boxes: ScreenBox[] = [];
    let boxesAt = 0;
    let movedAt = 0;
    const refreshBoxes = () => {
      const now = performance.now();
      if (boxesAt && now - boxesAt < BOX_TTL_MS) return;
      boxesAt = now;
      const camera = getState().camera as THREE.PerspectiveCamera;
      const canvas = gl.domElement;
      const rect = canvas.getBoundingClientRect();
      const next: ScreenBox[] = [];
      if (camera && rect.width > 0 && rect.height > 0) {
        for (const slotId of registeredSlots()) {
          const group = registeredGroup(slotId);
          if (!group) continue;
          const box = projectedBoxOf(group as unknown as THREE.Object3D, camera, rect);
          if (box) next.push(box);
        }
      }
      if (anyBoxMoved(boxes, next, BOX_MOVE_EPSILON_PX)) movedAt = now;
      boxes = next;
    };

    /** Render with `wear` (mesh -> material) applied, everything else hidden; always restores. */
    const renderIds = (
      target: THREE.WebGLRenderTarget,
      wear: Map<MeshLike, THREE.Material>,
      view: { fullW: number; fullH: number; x: number; y: number; w?: number; h?: number } | null,
    ) => {
      const camera = getState().camera as THREE.PerspectiveCamera;
      const swapped: Array<[MeshLike, THREE.Material | THREE.Material[] | undefined]> = [];
      const hidden: THREE.Object3D[] = [];
      const wearing = new Set(wear.keys());
      // Hide every mesh that is not one of the bodies being drawn (the grab proxies, anything else).
      scene.traverse((o) => {
        const m = o as MeshLike;
        if (m.isMesh && !wearing.has(m) && m.visible) { m.visible = false; hidden.push(m); }
      });
      for (const [mesh, material] of wear) {
        swapped.push([mesh, mesh.material]);
        const count = Array.isArray(mesh.material) ? mesh.material.length : 1;
        mesh.material = count > 1 ? new Array(count).fill(material) : material;
      }
      const hadView = camera.view?.enabled === true;
      const prevView = hadView ? { ...camera.view! } : null;
      const prevTarget = gl.getRenderTarget();
      const prevAlpha = gl.getClearAlpha();
      const prevColor = gl.getClearColor(new THREE.Color());
      const prevAuto = gl.autoClear;
      try {
        if (view) camera.setViewOffset(view.fullW, view.fullH, view.x, view.y, view.w ?? 1, view.h ?? 1);
        gl.setRenderTarget(target);
        gl.autoClear = true;
        gl.setClearColor(0x000000, 0);
        gl.clear();
        gl.render(scene, camera);
      } finally {
        gl.setRenderTarget(prevTarget);
        gl.setClearColor(prevColor, prevAlpha);
        gl.autoClear = prevAuto;
        if (view) {
          if (prevView) camera.setViewOffset(prevView.fullWidth, prevView.fullHeight, prevView.offsetX, prevView.offsetY, prevView.width, prevView.height);
          else camera.clearViewOffset();
        }
        for (const [mesh, material] of swapped) mesh.material = material as THREE.Material;
        for (const o of hidden) o.visible = true;
      }
    };

    const api = {
      /** Cheap: near any body's projected screen box (see refreshBoxes). Never throws. */
      near(clientX: number, clientY: number, slack = 0): boolean {
        try {
          refreshBoxes();
          return nearAnyBox(clientX, clientY, boxes, slack);
        } catch {
          return true; // an unknown scene must cost a pick, never a clickable body
        }
      },
      /** Cheap: did any body's box move in the last 300 ms? */
      moved(): boolean {
        try {
          refreshBoxes();
          return performance.now() - movedAt < MOVED_RECENT_MS;
        } catch {
          return true;
        }
      },
      pickAt(clientX: number, clientY: number): string | null {
        const slots = registeredSlots();
        if (!slots.length) return null;
        const canvas = gl.domElement;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const x = Math.floor(clientX - rect.left);
        const y = Math.floor(clientY - rect.top);
        if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
        const wear = new Map<MeshLike, THREE.Material>();
        slots.forEach((slotId, i) => {
          const group = registeredGroup(slotId);
          if (!group) return;
          for (const mesh of meshesOf(group)) wear.set(mesh, idMaterial(i + 1));
        });
        const target = ensureTarget(1, 1);
        try {
          renderIds(target, wear, { fullW: Math.round(rect.width), fullH: Math.round(rect.height), x, y });
          const px = new Uint8Array(4);
          gl.readRenderTargetPixels(target, 0, 0, 1, 1, px);
          const index = decodeId(px, slots.length);
          return index ? slots[index - 1] : null;
        } catch {
          return null;
        }
      },
      pickNear(clientX: number, clientY: number, radius: number): string | null {
        const slots = registeredSlots();
        if (!slots.length) return null;
        const canvas = gl.domElement;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const r = Math.max(0, Math.min(16, Math.round(radius)));
        const size = r * 2 + 1;
        const x = Math.floor(clientX - rect.left);
        const y = Math.floor(clientY - rect.top);
        if (x < -r || y < -r || x >= rect.width + r || y >= rect.height + r) return null;
        const wear = new Map<MeshLike, THREE.Material>();
        slots.forEach((slotId, i) => {
          const group = registeredGroup(slotId);
          if (!group) return;
          for (const mesh of meshesOf(group)) wear.set(mesh, idMaterial(i + 1));
        });
        const target = ensurePatch(size);
        try {
          // The patch centred on the pointer: (x - r, y - r) .. (x + r, y + r) of the full view.
          renderIds(target, wear, { fullW: Math.round(rect.width), fullH: Math.round(rect.height), x: x - r, y: y - r, w: size, h: size });
          const px = new Uint8Array(size * size * 4);
          gl.readRenderTargetPixels(target, 0, 0, size, size, px);
          const index = nearestIdInPatch(px, size, slots.length);
          return index ? slots[index - 1] : null;
        } catch {
          return null;
        }
      },
      silhouette(slotId: string, scale = 0.5) {
        const group = registeredGroup(slotId);
        if (!group) return null;
        const canvas = gl.domElement;
        const w = Math.max(8, Math.round(canvas.clientWidth * scale));
        const h = Math.max(8, Math.round(canvas.clientHeight * scale));
        const wear = new Map<MeshLike, THREE.Material>();
        for (const mesh of meshesOf(group)) wear.set(mesh, idMaterial(1));
        const target = ensureSilhouetteTarget(w, h);
        try {
          renderIds(target, wear, null);
          const px = new Uint8Array(w * h * 4);
          gl.readRenderTargetPixels(target, 0, 0, w, h, px);
          // readRenderTargetPixels is bottom-up; flip into screen order while taking alpha.
          const alpha = new Uint8Array(w * h);
          for (let row = 0; row < h; row += 1) {
            const src = (h - 1 - row) * w * 4;
            for (let col = 0; col < w; col += 1) alpha[row * w + col] = px[src + col * 4 + 3];
          }
          return { width: w, height: h, alpha };
        } catch {
          return null;
        }
      },
    };
    setPicker(api);
    return () => {
      setPicker(null);
      idTarget?.dispose();
      idTarget = null;
      silTarget?.dispose();
      silTarget = null;
      patchTarget?.dispose();
      patchTarget = null;
    };
  }, [gl, scene, getState]);

  return null;
}
