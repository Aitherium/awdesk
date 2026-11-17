/**
 * The gallery's big live preview: one VRM, framed whole, turning slowly on a turntable. Drag
 * turns it, the arrow keys turn it (Left/Right) and zoom (Up/Down), and it rests facing you
 * when you let go. Plain three.js (not the scene's R3F tree): one canvas, one model at a time,
 * everything disposed on a change -- browsing 90 bodies must not leak 90 GLBs.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { applyHeightNorm } from '../hooks/useVrmLoader';
import { relaxArms } from '../thumbnails';

interface Props {
  url: string | null;
  /** Shown while nothing is loaded (a fairy, a placeholder). */
  label?: string;
}

export function Preview3D({ url, label }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const el = host.current;
    if (!el || !url) {
      setStatus('idle');
      return undefined;
    }
    setStatus('loading');
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 2, 2);
    scene.add(key);
    const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 50);
    const turntable = new THREE.Group();
    scene.add(turntable);
    let vrm: VRM | null = null;
    let yaw = 0;
    let zoom = 1;
    let dragging = false;
    let lastX = 0;
    let idleSince = performance.now();
    let target = new THREE.Vector3(0, 0.85, 0);
    let baseDistance = 4;

    const size = () => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      url,
      (gltf) => {
        if (disposed) {
          VRMUtils.deepDispose(gltf.scene);
          return;
        }
        vrm = gltf.userData.vrm as VRM;
        if (!vrm) {
          setStatus('error');
          return;
        }
        VRMUtils.rotateVRM0(vrm);
        applyHeightNorm(vrm);
        // Arms down (the thumbnails' own rig-independent choice): a T-pose pushes the frame back.
        relaxArms(vrm);
        turntable.add(vrm.scene);
        const box = new THREE.Box3().setFromObject(vrm.scene);
        const sizeV = box.getSize(new THREE.Vector3());
        target = box.getCenter(new THREE.Vector3());
        const fit = sizeV.y / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        baseDistance = fit * 1.15 + sizeV.z;
        setStatus('ready');
      },
      undefined,
      () => {
        if (!disposed) setStatus('error');
      },
    );

    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, clock.getDelta());
      if (!dragging && performance.now() - idleSince > 1500) yaw += dt * 0.45;
      turntable.rotation.y = yaw;
      const d = baseDistance / zoom;
      camera.position.set(target.x, target.y + d * 0.05, target.z + d);
      camera.lookAt(target);
      if (vrm) vrm.update(dt);
      renderer.render(scene, camera);
    };
    tick();

    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
      idleSince = performance.now();
    };
    const up = () => {
      dragging = false;
      idleSince = performance.now();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom = Math.max(0.8, Math.min(2.6, zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
      idleSince = performance.now();
    };
    const keys = (e: KeyboardEvent) => {
      if (!(e.target instanceof HTMLElement) || e.target.closest('input, select, textarea')) return;
      if (!e.altKey) return; // plain arrows walk the grid; Alt+arrows turn the model
      if (e.key === 'ArrowLeft') yaw -= 0.25;
      else if (e.key === 'ArrowRight') yaw += 0.25;
      else if (e.key === 'ArrowUp') zoom = Math.min(2.6, zoom * 1.1);
      else if (e.key === 'ArrowDown') zoom = Math.max(0.8, zoom / 1.1);
      else return;
      e.preventDefault();
      idleSince = performance.now();
    };
    const c = renderer.domElement;
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keys);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', keys);
      if (vrm) VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      c.remove();
    };
  }, [url]);

  return (
    <div className="gal-preview" ref={host} data-status={status}>
      {status !== 'ready' ? (
        <div className="gal-preview-note">
          {status === 'loading' ? 'Loading…' : status === 'error' ? 'This model would not load.' : label || 'Pick an avatar'}
        </div>
      ) : null}
    </div>
  );
}
