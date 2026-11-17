import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { decodeId, registeredGroup, registeredSlots, setPicker, type PickGroup } from '../hooks/avatarPick';

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

export function AvatarPicker() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const getState = useThree((s) => s.get);

  useEffect(() => {
    let idTarget: THREE.WebGLRenderTarget | null = null;
    const ensureTarget = (w: number, h: number) => {
      if (!idTarget || idTarget.width !== w || idTarget.height !== h) {
        idTarget?.dispose();
        idTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true, samples: 0 });
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

    /** Render with `wear` (mesh -> material) applied, everything else hidden; always restores. */
    const renderIds = (
      target: THREE.WebGLRenderTarget,
      wear: Map<MeshLike, THREE.Material>,
      view: { fullW: number; fullH: number; x: number; y: number } | null,
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
        if (view) camera.setViewOffset(view.fullW, view.fullH, view.x, view.y, 1, 1);
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
    };
  }, [gl, scene, getState]);

  return null;
}
